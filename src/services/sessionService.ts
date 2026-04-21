import { randomBytes } from "crypto";

import { dbPool } from "../config/db";
import {
  countSessionsByCreator,
  countUserJoinedSessions,
  deleteSessionById,
  deleteSessionMembersBySessionId,
  findSessionBySessionKey,
  findSessionMember,
  findSessionMembersBySessionId,
  findSessionsByCreator,
  findUserJoinedSessions,
  insertSession,
  insertSessionMember,
  SessionMemberRow,
  SessionRow,
  setSessionMemberOnlineStatus
} from "../models/sessionModel";
import { GraphicVO, MemberVO, SessionDetailVO, SessionJoinVO, SessionVO } from "../types";

const SESSION_KEY_BYTE_LENGTH = 32;
const SESSION_CREATOR_ROLE = 2;
const SESSION_MEMBER_ROLE = 1;

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
    currentVersion: toNumber(row.current_version),
    createdAt: toIsoString(row.created_at)
  };
};

const toMemberVO = (row: SessionMemberRow): MemberVO => {
  return {
    userId: row.user_id,
    username: row.username ?? "",
    role: row.role,
    onlineStatus: row.online_status,
    joinedAt: toIsoString(row.joined_at)
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
        findSessionsByCreator(creatorId, page, pageSize, status)
      ])
    : await Promise.all([
        countUserJoinedSessions(userId, status),
        findUserJoinedSessions(userId, page, pageSize, status)
      ]);

  return {
    list: sessions.map(toSessionVO),
    total,
    page,
    pageSize
  };
};

export const getSessionDetailForUser = async (sessionKey: string, userId: number): Promise<SessionDetailVO> => {
  const session = await assertSessionExists(sessionKey);
  // 非成员禁止查看详情，按 2003 返回。
  await assertSessionMember(session.id, userId);

  const members = await findSessionMembersBySessionId(session.id);

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
  // 当前仓库尚未包含图形存储模块，这里先返回空数组，保持接口结构稳定。
  return [];
};

export const joinSessionForUser = async (sessionKey: string, userId: number): Promise<SessionJoinVO> => {
  const session = await assertSessionExists(sessionKey);
  const existsMember = await findSessionMember(session.id, userId);
  if (existsMember) {
    // 幂等设计：重复加入直接成功，并把在线状态恢复为在线。
    await setSessionMemberOnlineStatus(session.id, userId, 1);
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
  await assertSessionMember(session.id, userId);
  // leave 仅更新在线状态，保留成员历史记录。
  await setSessionMemberOnlineStatus(session.id, userId, 0);
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
