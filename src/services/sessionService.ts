import { randomBytes } from "crypto";

import { dbPool } from "../config/db";
import { env } from "../config/env";
import { graphicService } from "./graphicService";
import {
  countSessionsByCreator,
  countUserJoinedSessions,
  deleteSessionById,
  deleteSessionMembersBySessionId,
  findSessionBySessionKey,
  findSessionMember,
  findSessionMemberPreviewsBySessionIds,
  findSessionMembersBySessionId,
  findSessionMembersBySessionIdWithHistory,
  findSessionsByCreator,
  findUserJoinedSessions,
  insertSession,
  insertSessionMember,
  SessionMemberRow,
  SessionRow,
  setSessionMemberActiveStatus,
  setSessionMemberLeftStatus,
  setSessionMemberRole,
  setSessionMemberRemovedStatus,
  setSessionCreator,
  touchSessionMemberActiveAt
} from "../models/sessionModel";
import { GraphicVO, MemberVO, SessionDetailVO, SessionJoinVO, SessionMemberPreviewVO, SessionVO } from "../types";

const SESSION_KEY_BYTE_LENGTH = 32;
const SESSION_CREATOR_ROLE = 2;
const SESSION_MEMBER_ROLE = 1;
const ONLINE_TIMEOUT_SECONDS = env.sessionOnlineTimeoutSeconds;

// service 层业务异常。controller 会把这里的错误码映射到统一 HTTP code。
export class SessionServiceError extends Error {
  constructor(
    public readonly code: "SESSION_NOT_FOUND" | "SESSION_FORBIDDEN",
    message: string
  ) {
    super(message);
    this.name = "SessionServiceError";
  }
}

type SessionListResult = {
  list: SessionVO[];
  total: number;
  page: number;
  pageSize: number;
};

// 统一处理 MySQL 的 Date/string 时间字段，输出 ISO 字符串给前端。
const toIsoString = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

// MySQL 聚合字段在某些配置下可能返回 string，这里统一转 number。
const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// SessionRow -> SessionVO 的集中转换，避免字段映射散落在业务逻辑中。
const toSessionVO = (row: SessionRow): SessionVO => {
  return {
    sessionId: row.id,
    sessionKey: row.session_key,
    name: row.name,
    creatorId: row.creator_id,
    creatorName: row.creator_name ?? undefined,
    status: row.status,
    memberCount: typeof row.member_count === "undefined" ? undefined : toNumber(row.member_count),
    onlineMemberCount: typeof row.online_member_count === "undefined" ? undefined : toNumber(row.online_member_count),
    currentVersion: toNumber(row.current_version),
    createdAt: toIsoString(row.created_at)
  };
};

const toMemberVO = (row: SessionMemberRow): MemberVO => {
  const lastActiveValue = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;
  const isOnline = row.online_status === 1 && lastActiveValue >= Date.now() - ONLINE_TIMEOUT_SECONDS * 1000;
  return {
    userId: row.user_id,
    username: row.username ?? "",
    ...(row.avatar ? { avatar: row.avatar } : {}),
    role: row.role,
    onlineStatus: isOnline ? 1 : 0,
    joinedAt: toIsoString(row.joined_at),
    ...(row.membership_status ? { membershipStatus: row.membership_status } : {}),
    ...(row.left_at ? { leftAt: toIsoString(row.left_at) } : {}),
    ...(row.removed_at ? { removedAt: toIsoString(row.removed_at) } : {})
  };
};

const toMemberPreviewVO = (row: SessionMemberRow): SessionMemberPreviewVO => {
  return {
    userId: row.user_id,
    username: row.username ?? "",
    isOnline: row.online_status === 1,
    ...(row.avatar ? { avatar: row.avatar } : {})
  };
};

// 会话不存在统一抛 3001 对应异常。
const assertSessionExists = async (sessionKey: string): Promise<SessionRow> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new SessionServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  return session;
};

// 成员权限统一断言：不是成员则抛 2003 对应异常。
const assertSessionMember = async (sessionId: number, userId: number): Promise<SessionMemberRow> => {
  const member = await findSessionMember(sessionId, userId);
  if (!member) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (member.membership_status !== "active") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  return member;
};

// 删除会话仅允许创建者执行。
const assertSessionCreator = (session: SessionRow, userId: number): void => {
  if (session.creator_id !== userId) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话删除权限");
  }
};

const generateSessionKey = (): string => {
  // 与需求保持一致：crypto.randomBytes(32).toString("hex")
  return randomBytes(SESSION_KEY_BYTE_LENGTH).toString("hex");
};

export const createSessionForUser = async (name: string, creatorId: number): Promise<SessionVO> => {
  // 创建会话和创建者入会必须原子化，避免只写入一半的数据。
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();

    const sessionKey = generateSessionKey();
    const sessionId = await insertSession(sessionKey, name, creatorId, connection);
    await insertSessionMember(sessionId, creatorId, SESSION_CREATOR_ROLE, 1, connection);

    await connection.commit();

    // 复用查询逻辑组装返回结构，保证返回字段与详情接口一致。
    const session = await findSessionBySessionKey(sessionKey);
    if (!session) {
      throw new SessionServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    return toSessionVO({
      ...session,
      member_count: 1
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const getUserSessionList = async (
  userId: number,
  page: number,
  pageSize: number,
  status?: number,
  creatorId?: number
): Promise<SessionListResult> => {
  // 未传 creatorId 时按“我参与的会话”查询；传 creatorId 时按“指定创建者会话”查询。
  const [total, sessions] = typeof creatorId === "number"
    ? await Promise.all([
        countSessionsByCreator(creatorId, status),
        findSessionsByCreator(creatorId, page, pageSize, status, ONLINE_TIMEOUT_SECONDS)
      ])
    : await Promise.all([
      countUserJoinedSessions(userId, status),
      findUserJoinedSessions(userId, page, pageSize, status, ONLINE_TIMEOUT_SECONDS)
    ]);

  const sessionIds = sessions.map((item) => item.id);
  const previewRows = await findSessionMemberPreviewsBySessionIds(sessionIds, ONLINE_TIMEOUT_SECONDS, 4);
  const previewMap = new Map<number, SessionMemberRow[]>();
  previewRows.forEach((row) => {
    const group = previewMap.get(row.session_id) ?? [];
    group.push(row);
    previewMap.set(row.session_id, group);
  });

  const listWithMemberPreviews = sessions.map((sessionRow) => ({
    ...toSessionVO(sessionRow),
    memberPreviews: (previewMap.get(sessionRow.id) ?? []).map(toMemberPreviewVO)
  }));

  return {
    list: listWithMemberPreviews,
    total,
    page,
    pageSize
  };
};

export const getSessionDetailForUser = async (
  sessionKey: string,
  userId: number,
  includeHistory = false
): Promise<SessionDetailVO> => {
  const session = await assertSessionExists(sessionKey);
  // 非成员禁止查看详情，按 2003 返回。
  await assertSessionMember(session.id, userId);

  const members = includeHistory
    ? await findSessionMembersBySessionIdWithHistory(session.id)
    : await findSessionMembersBySessionId(session.id);

  return {
    ...toSessionVO({
      ...session,
      member_count: members.length
    }),
    currentVersion: toNumber(session.current_version),
    members: members.map(toMemberVO)
  };
};

const getSessionGraphicsSnapshot = async (_sessionId: number): Promise<GraphicVO[]> => {
  // join 会话时返回当前画布全量数据。
  const snapshot = await graphicService.getGraphics(_sessionId);
  return snapshot.graphics;
};

export const joinSessionForUser = async (sessionKey: string, userId: number): Promise<SessionJoinVO> => {
  const session = await assertSessionExists(sessionKey);
  const existsMember = await findSessionMember(session.id, userId);
  if (existsMember && existsMember.membership_status === "removed") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (existsMember && (existsMember.membership_status === "left" || existsMember.membership_status === "active")) {
    // 软退出后再次加入采用状态恢复，保证历史记录可追溯。
    await setSessionMemberActiveStatus(session.id, userId);
  } else {
    // 新成员默认普通角色，在线状态置为 1。
    await insertSessionMember(session.id, userId, SESSION_MEMBER_ROLE, 1);
  }

  const graphics = await getSessionGraphicsSnapshot(session.id);

  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    name: session.name,
    currentVersion: toNumber(session.current_version),
    graphics
  };
};

export const leaveSessionForUser = async (sessionKey: string, userId: number): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  if (session.creator_id === userId) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "创建者不能退出会话，请删除会话");
  }
  await assertSessionMember(session.id, userId);
  // leave 语义：软退出，成员从“我加入”列表移除，但保留历史记录。
  await setSessionMemberLeftStatus(session.id, userId);
};

export const removeSessionMemberForCreator = async (
  sessionKey: string,
  operatorUserId: number,
  targetUserId: number
): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  assertSessionCreator(session, operatorUserId);

  if (targetUserId === session.creator_id) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能移除创建者");
  }

  const targetMember = await findSessionMember(session.id, targetUserId);
  if (!targetMember || targetMember.membership_status === "removed") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  await setSessionMemberRemovedStatus(session.id, targetUserId);
};

export const transferSessionCreatorForUser = async (
  sessionKey: string,
  operatorUserId: number,
  targetUserId: number
): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  assertSessionCreator(session, operatorUserId);

  if (targetUserId === operatorUserId) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能转让给自己");
  }

  const targetMember = await findSessionMember(session.id, targetUserId);
  if (!targetMember || targetMember.membership_status !== "active") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "目标用户不是当前会话成员");
  }

  const operatorMember = await assertSessionMember(session.id, operatorUserId);

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    await setSessionCreator(session.id, targetUserId, connection);
    await setSessionMemberRole(session.id, targetUserId, SESSION_CREATOR_ROLE, connection);
    await setSessionMemberRole(session.id, operatorMember.user_id, SESSION_MEMBER_ROLE, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const heartbeatSessionForUser = async (sessionKey: string, userId: number): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  await assertSessionMember(session.id, userId);
  await touchSessionMemberActiveAt(session.id, userId);
};

export const deleteSessionForUser = async (sessionKey: string, userId: number): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  assertSessionCreator(session, userId);

  // 删除会话和成员关系需要原子化，保证删除后不可访问。
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    await deleteSessionMembersBySessionId(session.id, connection);
    await deleteSessionById(session.id, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};
