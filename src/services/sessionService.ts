import { randomBytes } from "crypto";

import { dbPool } from "../config/db";
import { env } from "../config/env";
import { graphicService } from "./graphicService";
import {
  countActiveSessionInvitesBySessionId,
  consumeSessionInvite,
  countSessionsByCreator,
  countUserJoinedSessions,
  deleteSessionById,
  deleteSessionMembersBySessionId,
  findSessionBySessionKey,
  findSessionInviteByToken,
  findSessionInvitesBySessionId,
  findSessionMember,
  findSessionMemberPreviewsBySessionIds,
  findSessionMembersBySessionId,
  findSessionMembersBySessionIdWithHistory,
  findSessionsByCreator,
  findUserJoinedSessions,
  insertSessionInvite,
  insertSession,
  insertSessionMember,
  setSessionPausedStatus,
  setSessionStatus,
  SessionMemberRow,
  SessionRow,
  setSessionMemberActiveStatus,
  setSessionMemberLeftStatus,
  setSessionMemberRole,
  setSessionMemberRemovedStatus,
  setSessionInviteDisabled,
  touchSessionMemberActiveAt
} from "../models/sessionModel";
import {
  GraphicVO,
  MemberVO,
  SessionCloseVO,
  SessionDetailVO,
  SessionInviteCreateVO,
  SessionInviteItemVO,
  SessionInviteListVO,
  SessionInviteStatus,
  SessionJoinVO,
  SessionMemberPreviewVO,
  SessionPauseVO,
  SessionVO
} from "../types";

const SESSION_KEY_BYTE_LENGTH = 32;
const SESSION_ROLE_VIEWER = 0;
const SESSION_ROLE_EDITOR = 1;
const SESSION_ROLE_MANAGER = 2;
const SESSION_ROLE_OWNER = 3;
const INVITE_TOKEN_BYTE_LENGTH = 24;
const DEFAULT_INVITE_EXPIRE_HOURS = 24 * 7;
const DEFAULT_INVITE_MAX_USES = 1;
const MAX_ACTIVE_INVITES_PER_SESSION = 30;
const ONLINE_TIMEOUT_SECONDS = env.sessionOnlineTimeoutSeconds;
const SESSION_ROLE_MUTABLE_FOR_OWNER_SET = new Set<number>([SESSION_ROLE_VIEWER, SESSION_ROLE_EDITOR, SESSION_ROLE_MANAGER]);
const SESSION_ROLE_MUTABLE_FOR_MANAGER_SET = new Set<number>([SESSION_ROLE_VIEWER, SESSION_ROLE_EDITOR]);
const SESSION_ROLE_INVITABLE_BY_OWNER_SET = new Set<number>([SESSION_ROLE_VIEWER, SESSION_ROLE_EDITOR, SESSION_ROLE_MANAGER]);
const SESSION_ROLE_INVITABLE_BY_MANAGER_SET = new Set<number>([SESSION_ROLE_VIEWER, SESSION_ROLE_EDITOR]);

// service 层业务异常。controller 会把这里的错误码映射到统一 HTTP code。
export class SessionServiceError extends Error {
  constructor(
    public readonly code:
      | "SESSION_NOT_FOUND"
      | "SESSION_FORBIDDEN"
      | "INVALID_ARGUMENT"
      | "SESSION_INVITE_REQUIRED"
      | "SESSION_INVITE_INVALID",
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
  const hasLastOperationAt = typeof row.last_operation_at !== "undefined" && row.last_operation_at !== null;
  return {
    sessionId: row.id,
    sessionKey: row.session_key,
    name: row.name,
    creatorId: row.creator_id,
    creatorName: row.creator_name ?? undefined,
    status: row.status,
    isPaused: row.is_paused === 1,
    memberCount: typeof row.member_count === "undefined" ? undefined : toNumber(row.member_count),
    onlineMemberCount: typeof row.online_member_count === "undefined" ? undefined : toNumber(row.online_member_count),
    currentVersion: toNumber(row.current_version),
    ...(hasLastOperationAt ? { lastOperationAt: new Date(toNumber(row.last_operation_at)).toISOString() } : {}),
    ...(typeof row.last_operation_user_id === "number" ? { lastOperationUserId: row.last_operation_user_id } : {}),
    ...(row.last_operation_user_name ? { lastOperationUserName: row.last_operation_user_name } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
};

const toMemberVO = (row: SessionMemberRow): MemberVO => {
  const lastActiveValue = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;
  const isOnline = row.online_status === 1 && lastActiveValue >= Date.now() - ONLINE_TIMEOUT_SECONDS * 1000;
  const role = Number.isInteger(row.role) && row.role >= 0 && row.role <= 3 ? row.role : SESSION_ROLE_EDITOR;
  return {
    userId: row.user_id,
    username: row.username ?? "",
    ...(row.avatar ? { avatar: row.avatar } : {}),
    role,
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
const assertSessionOwner = (session: SessionRow, userId: number): void => {
  if (session.creator_id !== userId) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话删除权限");
  }
};

const assertSessionPauseManagePermission = (session: SessionRow, member: SessionMemberRow, userId: number): void => {
  // 暂停/恢复属于治理能力：房主与管理员可操作。
  const isOwner = userId === session.creator_id || member.role === SESSION_ROLE_OWNER;
  const isManager = member.role === SESSION_ROLE_MANAGER;
  if (!isOwner && !isManager) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无画布暂停权限");
  }
};

const assertSessionImageUploadPermission = (session: SessionRow, member: SessionMemberRow, userId: number): void => {
  // 图片上传开放给 owner/manager/editor，viewer 保持只读。
  const isOwner = userId === session.creator_id || member.role === SESSION_ROLE_OWNER;
  const isManager = member.role === SESSION_ROLE_MANAGER;
  const isEditor = member.role === SESSION_ROLE_EDITOR;
  if (!isOwner && !isManager && !isEditor) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无图片上传权限");
  }
};

const assertInviteCreatePermission = (
  session: SessionRow,
  member: SessionMemberRow,
  userId: number,
  role: number
): void => {
  // 邀请创建权限定在 owner/manager，避免普通编辑者随意扩散会话权限。
  const isOwner = userId === session.creator_id || member.role === SESSION_ROLE_OWNER;
  const isManager = member.role === SESSION_ROLE_MANAGER;
  if (!isOwner && !isManager) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无邀请权限");
  }

  const allowedRoleSet = isOwner ? SESSION_ROLE_INVITABLE_BY_OWNER_SET : SESSION_ROLE_INVITABLE_BY_MANAGER_SET;
  // manager 不能邀请 manager，防止横向提权。
  if (!allowedRoleSet.has(role)) {
    throw new SessionServiceError("INVALID_ARGUMENT", "角色参数错误");
  }
};

const generateInviteToken = (): string => {
  return randomBytes(INVITE_TOKEN_BYTE_LENGTH).toString("hex");
};

const isDuplicateEntryError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const maybe = error as { code?: unknown; errno?: unknown };
  return maybe.code === "ER_DUP_ENTRY" || maybe.errno === 1062;
};

const resolveSessionInviteStatus = (invite: {
  status: "active" | "disabled";
  max_uses: number | null;
  used_count: number;
  expires_at: Date | string | null;
}): SessionInviteStatus => {
  // disabled 需要细分：超次 used、过期 expired、手动作废 revoked。
  if (invite.status === "disabled") {
    if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
      return "used";
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
      return "expired";
    }
    return "revoked";
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
    return "expired";
  }
  if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
    return "used";
  }
  return "active";
};

const toSessionInviteItemVO = (
  sessionKey: string,
  invite: {
    id: number;
    invite_token: string;
    role: number;
    status: "active" | "disabled";
    max_uses: number | null;
    used_count: number;
    created_by: number;
    created_at: Date | string;
    expires_at: Date | string | null;
  }
): SessionInviteItemVO => {
  const resolvedStatus = resolveSessionInviteStatus(invite);
  return {
    id: invite.id,
    inviteToken: invite.invite_token,
    role: invite.role,
    status: resolvedStatus,
    maxUses: invite.max_uses,
    usedCount: invite.used_count,
    createdBy: invite.created_by,
    createdAt: toIsoString(invite.created_at),
    ...(invite.expires_at ? { expiresAt: toIsoString(invite.expires_at) } : {}),
    ...(resolvedStatus === "active" ? { invitePath: `/session/${sessionKey}?inviteToken=${invite.invite_token}` } : {})
  };
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
    await insertSessionMember(sessionId, creatorId, SESSION_ROLE_OWNER, 1, connection);

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
export const createSessionInviteForOperator = async (
  sessionKey: string,
  operatorUserId: number,
  role: number,
  options?: {
    maxUses?: number;
    expiresInHours?: number;
  }
): Promise<SessionInviteCreateVO> => {
  const session = await assertSessionExists(sessionKey);
  if (session.status !== 1) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "会话已结束，不能创建邀请");
  }
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  assertInviteCreatePermission(session, operatorMember, operatorUserId, role);

  const maxUses = typeof options?.maxUses === "number" ? options.maxUses : DEFAULT_INVITE_MAX_USES;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
    throw new SessionServiceError("INVALID_ARGUMENT", "邀请码次数参数错误");
  }
  const expiresInHours = typeof options?.expiresInHours === "number" ? options.expiresInHours : DEFAULT_INVITE_EXPIRE_HOURS;
  if (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 24 * 30) {
    throw new SessionServiceError("INVALID_ARGUMENT", "邀请码有效期参数错误");
  }
  const activeInviteCount = await countActiveSessionInvitesBySessionId(session.id);
  // 会话级邀请码数量上限，避免运营误操作生成过多长期有效链接。
  if (activeInviteCount >= MAX_ACTIVE_INVITES_PER_SESSION) {
    throw new SessionServiceError("INVALID_ARGUMENT", "当前有效邀请码过多，请先作废部分邀请码");
  }
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  let inviteToken = "";
  let created = false;
  // token 碰撞概率极低，但这里仍做最多 3 次重试。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    inviteToken = generateInviteToken();
    try {
      await insertSessionInvite(session.id, inviteToken, role, operatorUserId, maxUses, expiresAt);
      created = true;
      break;
    } catch (error) {
      if (!isDuplicateEntryError(error) || attempt === 2) {
        throw error;
      }
    }
  }
  if (!created || !inviteToken) {
    throw new SessionServiceError("INVALID_ARGUMENT", "创建邀请失败");
  }

  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    inviteToken,
    role,
    maxUses,
    expiresAt: expiresAt.toISOString(),
    invitePath: `/session/${session.session_key}?inviteToken=${inviteToken}`
  };
};

export const uploadSessionImageForOperator = async (
  sessionKey: string,
  operatorUserId: number
): Promise<{ sessionId: number; sessionKey: string }> => {
  const session = await assertSessionExists(sessionKey);
  if (session.status !== 1) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "会话已结束，不能上传图片");
  }
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  assertSessionImageUploadPermission(session, operatorMember, operatorUserId);

  return {
    sessionId: session.id,
    sessionKey: session.session_key
  };
};

export const getSessionInviteListForOperator = async (
  sessionKey: string,
  operatorUserId: number,
  options?: {
    includeUsed?: boolean;
  }
): Promise<SessionInviteListVO> => {
  const session = await assertSessionExists(sessionKey);
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  const isOwner = operatorUserId === session.creator_id || operatorMember.role === SESSION_ROLE_OWNER;
  const isManager = operatorMember.role === SESSION_ROLE_MANAGER;
  if (!isOwner && !isManager) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无邀请权限");
  }

  const rows = await findSessionInvitesBySessionId(session.id);
  const includeUsed = options?.includeUsed === true;
  const list = rows
    .map((item) => toSessionInviteItemVO(session.session_key, item))
    .filter((item) => (includeUsed ? true : item.status !== "used"));

  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    list
  };
};

export const revokeSessionInviteForOperator = async (
  sessionKey: string,
  operatorUserId: number,
  inviteId: number
): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  const isOwner = operatorUserId === session.creator_id || operatorMember.role === SESSION_ROLE_OWNER;
  const isManager = operatorMember.role === SESSION_ROLE_MANAGER;
  if (!isOwner && !isManager) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无邀请权限");
  }

  const changed = await setSessionInviteDisabled(session.id, inviteId);
  if (!changed) {
    throw new SessionServiceError("SESSION_NOT_FOUND", "邀请码不存在或已失效");
  }
};

export const joinSessionForUser = async (
  sessionKey: string,
  userId: number,
  inviteToken?: string
): Promise<SessionJoinVO> => {
  const session = await assertSessionExists(sessionKey);
  const existsMember = await findSessionMember(session.id, userId);
  if (existsMember && existsMember.membership_status === "removed") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (existsMember && (existsMember.membership_status === "left" || existsMember.membership_status === "active")) {
    // 软退出后再次加入采用状态恢复，保证历史记录可追溯。
    await setSessionMemberActiveStatus(session.id, userId);
  } else {
    if (!inviteToken) {
      throw new SessionServiceError("SESSION_INVITE_REQUIRED", "请使用邀请链接加入会话");
    }

    const invite = await findSessionInviteByToken(inviteToken);
    if (!invite || invite.session_id !== session.id) {
      throw new SessionServiceError("SESSION_INVITE_INVALID", "邀请链接无效或已过期");
    }

    const inviteExpired = invite.expires_at ? new Date(invite.expires_at).getTime() <= Date.now() : false;
    const inviteExhausted = invite.max_uses !== null && invite.used_count >= invite.max_uses;
    if (invite.status !== "active" || inviteExpired || inviteExhausted) {
      throw new SessionServiceError("SESSION_INVITE_INVALID", "邀请链接无效或已过期");
    }

    // 消耗邀请码 + 写成员关系同事务提交，避免并发场景超发。
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const consumed = await consumeSessionInvite(invite.id, connection);
      if (!consumed) {
        throw new SessionServiceError("SESSION_INVITE_INVALID", "邀请链接无效或已过期");
      }
      await insertSessionMember(session.id, userId, invite.role, 1, connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntryError(error)) {
        const concurrentMember = await findSessionMember(session.id, userId);
        if (concurrentMember && concurrentMember.membership_status !== "removed") {
          await setSessionMemberActiveStatus(session.id, userId);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    } finally {
      connection.release();
    }
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
  // leave 采用软退出：保留历史协作记录，便于后续追溯与重新加入。
  await setSessionMemberLeftStatus(session.id, userId);
};

export const removeSessionMemberForCreator = async (
  sessionKey: string,
  operatorUserId: number,
  targetUserId: number
): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  const isOwnerOperator = operatorUserId === session.creator_id || operatorMember.role === SESSION_ROLE_OWNER;
  const isManagerOperator = operatorMember.role === SESSION_ROLE_MANAGER;
  if (!isOwnerOperator && !isManagerOperator) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无成员移除权限");
  }

  if (targetUserId === session.creator_id) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能移除创建者");
  }

  const targetMember = await findSessionMember(session.id, targetUserId);
  if (!targetMember || targetMember.membership_status === "removed") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (targetMember.role === SESSION_ROLE_OWNER) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能移除房主");
  }
  if (isManagerOperator && targetMember.role >= SESSION_ROLE_MANAGER) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "管理员不能移除房主或其他管理员");
  }

  await setSessionMemberRemovedStatus(session.id, targetUserId);
};

export const heartbeatSessionForUser = async (sessionKey: string, userId: number): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  const member = await assertSessionMember(session.id, userId);
  if (member.online_status !== 1) {
    // HTTP 心跳可作为“页面恢复活跃”的信号，确保成员状态从离线恢复为在线。
    await setSessionMemberActiveStatus(session.id, userId);
  }
  await touchSessionMemberActiveAt(session.id, userId);
};

export const deleteSessionForUser = async (sessionKey: string, userId: number): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  assertSessionOwner(session, userId);

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

export const setSessionMemberRoleForOperator = async (
  sessionKey: string,
  operatorUserId: number,
  targetUserId: number,
  role: number
): Promise<void> => {
  const session = await assertSessionExists(sessionKey);
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  const isOwnerOperator = operatorUserId === session.creator_id || operatorMember.role === SESSION_ROLE_OWNER;
  const isManagerOperator = operatorMember.role === SESSION_ROLE_MANAGER;
  if (!isOwnerOperator && !isManagerOperator) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无角色管理权限");
  }

  const allowedRoleSet = isOwnerOperator
    ? SESSION_ROLE_MUTABLE_FOR_OWNER_SET
    : SESSION_ROLE_MUTABLE_FOR_MANAGER_SET;
  if (!allowedRoleSet.has(role)) {
    throw new SessionServiceError("INVALID_ARGUMENT", "角色参数错误");
  }
  // 避免“自改权限”造成权限管理混乱。
  if (targetUserId === operatorUserId) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能修改自己的角色");
  }

  const targetMember = await findSessionMember(session.id, targetUserId);
  if (!targetMember || targetMember.membership_status !== "active") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "目标用户不是当前会话成员");
  }
  if (targetUserId === session.creator_id || targetMember.role === SESSION_ROLE_OWNER) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "不能修改会话创建者角色");
  }
  if (isManagerOperator && targetMember.role === SESSION_ROLE_MANAGER) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "管理员不能修改其他管理员角色");
  }
  await setSessionMemberRole(session.id, targetUserId, role);
};

export const setSessionPausedForOperator = async (
  sessionKey: string,
  operatorUserId: number,
  isPaused: boolean
): Promise<SessionPauseVO> => {
  const session = await assertSessionExists(sessionKey);
  const operatorMember = await assertSessionMember(session.id, operatorUserId);
  assertSessionPauseManagePermission(session, operatorMember, operatorUserId);
  if (session.status !== 1) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "会话已结束，不能暂停或恢复");
  }

  // 写完后重新读取，确保返回的是最终状态（含并发修改后的真实值）。
  await setSessionPausedStatus(session.id, isPaused ? 1 : 0);
  const latest = await assertSessionExists(sessionKey);
  return {
    sessionId: latest.id,
    sessionKey: latest.session_key,
    isPaused: latest.is_paused === 1
  };
};

export const closeSessionForOwner = async (
  sessionKey: string,
  operatorUserId: number
): Promise<SessionCloseVO> => {
  const session = await assertSessionExists(sessionKey);
  assertSessionOwner(session, operatorUserId);
  if (session.status !== 1) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "会话已结束，不能重复结束");
  }
  await setSessionStatus(session.id, 0);
  await setSessionPausedStatus(session.id, 0);
  const latest = await assertSessionExists(sessionKey);
  return {
    sessionId: latest.id,
    sessionKey: latest.session_key,
    status: latest.status
  };
};
