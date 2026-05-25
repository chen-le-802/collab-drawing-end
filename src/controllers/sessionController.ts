import { Request, Response } from "express";
import { findUserById } from "../models/userModel";
import {
  broadcastSessionMemberStatusChangedEvent,
  broadcastSessionPausedEvent,
  broadcastSessionRestoredEvent
} from "../ws/server";

import { ApiResponse } from "../types";
import {
  createSessionInviteForOperator,
  getSessionInviteListForOperator,
  revokeSessionInviteForOperator,
  createSessionForUser,
  closeSessionForOwner,
  deleteSessionForUser,
  getSessionDetailForUser,
  getUserSessionList,
  heartbeatSessionForUser,
  joinSessionForUser,
  leaveSessionForUser,
  removeSessionMemberForCreator,
  setSessionPausedForOperator,
  setSessionMemberRoleForOperator,
  uploadSessionImageForOperator,
  SessionServiceError
} from "../services/sessionService";
import { operationService, OperationServiceError } from "../services/operationService";
import { emitAlert } from "../services/alertService";

type AuthRequest = Request & {
  user?: {
    userId: number;
  };
};

// session_key 为 32 字节随机数转 hex，因此固定 64 位十六进制字符串。
const SESSION_KEY_REG = /^[a-f0-9]{64}$/i;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

// 会话名称允许前后空格，入库前会 trim；长度上限控制在 100。
const isValidSessionName = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  return text.length > 0 && text.length <= 100;
};

// 分页参数必须是正整数；未传时返回 null 交给默认值逻辑处理。
const parsePositiveInteger = (value: unknown): number | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const parsePathPositiveInteger = (value: unknown): number | null => {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

// 成员角色变更仅允许 0/1/2（viewer/editor/manager），owner 不走此入口变更。
const parseSessionMemberRole = (value: unknown): number | null => {
  const normalized = typeof value === "object" && value !== null && "role" in value
    ? (value as { role?: unknown }).role
    : value;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
    return null;
  }
  return parsed;
};

// 邀请角色同样限制在 0/1/2，避免直接邀请为 owner。
const parseSessionInviteRole = (value: unknown): number | null => {
  const normalized = typeof value === "object" && value !== null && "role" in value
    ? (value as { role?: unknown }).role
    : value;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
    return null;
  }
  return parsed;
};

const parseSessionInviteMaxUses = (value: unknown): number | null => {
  const normalized = typeof value === "object" && value !== null && "maxUses" in value
    ? (value as { maxUses?: unknown }).maxUses
    : value;
  if (typeof normalized === "undefined") {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const parseSessionInviteExpiresInHours = (value: unknown): number | null => {
  const normalized = typeof value === "object" && value !== null && "expiresInHours" in value
    ? (value as { expiresInHours?: unknown }).expiresInHours
    : value;
  if (typeof normalized === "undefined") {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const parseSessionInviteToken = (value: unknown): string | null => {
  const normalized = typeof value === "object" && value !== null && "inviteToken" in value
    ? (value as { inviteToken?: unknown }).inviteToken
    : value;
  if (typeof normalized !== "string") {
    return null;
  }
  const token = normalized.trim();
  if (!token) {
    return null;
  }
  return token;
};

// status 仅允许 0/1，避免把其他字符串误转换为数字后进入 SQL。
const parseStatus = (value: unknown): number | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  if (normalized !== "0" && normalized !== "1" && normalized !== 0 && normalized !== 1) {
    return null;
  }
  return Number(normalized);
};

const parseBooleanFlag = (value: unknown): boolean | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  if (normalized === "1" || normalized === 1 || normalized === "true" || normalized === true) {
    return true;
  }
  if (normalized === "0" || normalized === 0 || normalized === "false" || normalized === false) {
    return false;
  }
  return null;
};

const parseSessionPauseFlag = (value: unknown): boolean | null => {
  const normalized = typeof value === "object" && value !== null && "isPaused" in value
    ? (value as { isPaused?: unknown }).isPaused
    : value;
  if (normalized === true || normalized === "true" || normalized === 1 || normalized === "1") {
    return true;
  }
  if (normalized === false || normalized === "false" || normalized === 0 || normalized === "0") {
    return false;
  }
  return null;
};

// 快照名为空时交由 service 自动生成默认名；超长在 controller 先拦截。
const parseSnapshotName = (value: unknown): string | null => {
  const normalized = typeof value === "object" && value !== null && "snapshotName" in value
    ? (value as { snapshotName?: unknown }).snapshotName
    : value;
  if (typeof normalized === "undefined" || normalized === null) {
    return "";
  }
  if (typeof normalized !== "string") {
    return null;
  }
  const name = normalized.trim();
  if (!name) {
    return "";
  }
  if (name.length > 40) {
    return null;
  }
  return name;
};

const parseNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

// controller 统一做 service -> API 错误码映射，保证响应结构稳定。
const mapServiceError = (res: Response, error: unknown): void => {
  if (error instanceof OperationServiceError) {
    if (error.code === "INVALID_ARGUMENT") {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (error.code === "SESSION_NOT_FOUND" || error.code === "GRAPHIC_NOT_FOUND") {
      send(res, { code: 3001, message: "资源不存在", data: null });
      return;
    }
    if (error.code === "GRAPHIC_EXISTS") {
      send(res, { code: 3002, message: "资源已存在", data: null });
      return;
    }
    if (error.code === "SESSION_FORBIDDEN") {
      send(res, { code: 2003, message: "无会话访问权限", data: null });
      return;
    }
  }

  if (error instanceof SessionServiceError) {
    if (error.code === "INVALID_ARGUMENT") {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (error.code === "SESSION_NOT_FOUND") {
      send(res, { code: 3001, message: "会话不存在", data: null });
      return;
    }
    if (error.code === "SESSION_FORBIDDEN") {
      send(res, { code: 2003, message: "无会话访问权限", data: null });
      return;
    }
    if (error.code === "SESSION_INVITE_REQUIRED" || error.code === "SESSION_INVITE_INVALID") {
      send(res, { code: 2003, message: error.message, data: null });
      return;
    }
  }

  send(res, { code: 4001, message: "服务器错误", data: null });
  emitAlert({
    key: "api.error.4001.session",
    level: "error",
    message: "SessionController 返回 4001",
    detail: {
      error: error instanceof Error ? error.message : String(error)
    }
  });
};

export const getSessionOperations = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const sinceVersion = parseNonNegativeInteger(req.query.sinceVersion);
    if (typeof req.query.sinceVersion !== "undefined" && sinceVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.getSessionOperationsBySessionKey(sessionKey, userId, sinceVersion ?? 0);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

const parseOperationType = (value: unknown): "create" | "update" | "delete" | "restore" | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  if (normalized === "create" || normalized === "update" || normalized === "delete" || normalized === "restore") {
    return normalized;
  }
  return null;
};

const parseConflictType = (
  value: unknown
): "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation" | null => {
  if (typeof value === "undefined") {
    return null;
  }
  const normalized = Array.isArray(value) ? value[0] : value;
  if (
    normalized === "none" ||
    normalized === "field_merge" ||
    normalized === "field_conflict" ||
    normalized === "delete_wins" ||
    normalized === "duplicate_operation"
  ) {
    return normalized;
  }
  return null;
};

export const getSessionOperationTimeline = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const fromVersion = parseNonNegativeInteger(req.query.fromVersion);
    const toVersion = parseNonNegativeInteger(req.query.toVersion);
    const filterUserId = parsePositiveInteger(req.query.userId);
    const operationType = parseOperationType(req.query.operationType);
    const conflictType = parseConflictType(req.query.conflictType);
    const page = parsePositiveInteger(req.query.page);
    const pageSize = parsePositiveInteger(req.query.pageSize);

    if (typeof req.query.fromVersion !== "undefined" && fromVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.toVersion !== "undefined" && toVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.userId !== "undefined" && filterUserId === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.operationType !== "undefined" && operationType === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.conflictType !== "undefined" && conflictType === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.page !== "undefined" && page === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.pageSize !== "undefined" && pageSize === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.getSessionOperationTimelineBySessionKey(sessionKey, userId, {
      ...(typeof fromVersion === "number" ? { fromVersion } : {}),
      ...(typeof toVersion === "number" ? { toVersion } : {}),
      ...(typeof filterUserId === "number" ? { userId: filterUserId } : {}),
      ...(operationType ? { operationType } : {}),
      ...(conflictType ? { conflictType } : {}),
      page: page ?? 1,
      pageSize: pageSize ?? 20
    });
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getSessionConflictLogs = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const sinceId = parseNonNegativeInteger(req.query.sinceId);
    const limit = parsePositiveInteger(req.query.limit);
    if (typeof req.query.sinceId !== "undefined" && sinceId === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.limit !== "undefined" && limit === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.getSessionConflictLogsBySessionKey(
      sessionKey,
      userId,
      sinceId ?? 0,
      limit ?? 100
    );
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const createSessionSnapshot = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    const snapshotName = parseSnapshotName(req.body as { snapshotName?: unknown });
    if (snapshotName === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.createSessionSnapshotBySessionKey(sessionKey, userId, snapshotName || undefined);
    send(res, { code: 0, message: "创建成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getSessionSnapshots = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    const limit = parsePositiveInteger(req.query.limit);
    if (typeof req.query.limit !== "undefined" && limit === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.getSessionSnapshotsBySessionKey(sessionKey, userId, limit ?? 20);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getSessionReplay = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    const targetVersion = parseNonNegativeInteger(req.query.targetVersion);
    if (targetVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await operationService.getSessionReplayByVersion(sessionKey, userId, targetVersion);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const restoreSessionVersion = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    const targetVersion = parseNonNegativeInteger((req.body as { targetVersion?: unknown })?.targetVersion);
    if (targetVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // 恢复历史版本是“写操作”，由 service 内部继续做角色与会话状态校验。
    const result = await operationService.restoreSessionByVersion(sessionKey, userId, targetVersion);
    const operator = await findUserById(userId);
    broadcastSessionRestoredEvent(sessionKey, {
      targetVersion,
      restoredVersion: result.restoredVersion,
      operatorUserId: userId,
      operatorUsername: operator?.username ?? "",
      createdCount: result.createdCount,
      updatedCount: result.updatedCount,
      deletedCount: result.deletedCount
    });
    send(res, { code: 0, message: "恢复成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const createSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const { name } = req.body as { name?: unknown };
    if (!isValidSessionName(name)) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // 创建逻辑由 service 负责：生成 session_key、写 sessions、写 session_members。
    const result = await createSessionForUser(name.trim(), userId);
    send(res, { code: 0, message: "创建成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getSessionList = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const rawPage = parsePositiveInteger(req.query.page);
    const rawPageSize = parsePositiveInteger(req.query.pageSize);
    const rawStatus = parseStatus(req.query.status);
    const rawCreatorId = parsePositiveInteger(req.query.creatorId);

    // 只要调用方显式传参但不合法，即按参数错误返回，避免静默兜底。
    if (typeof req.query.page !== "undefined" && rawPage === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.pageSize !== "undefined" && rawPageSize === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.status !== "undefined" && rawStatus === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.creatorId !== "undefined" && rawCreatorId === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // pageSize 上限兜底，防止单次查询过大导致慢查询。
    const page = rawPage ?? DEFAULT_PAGE;
    const pageSize = Math.min(rawPageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    // creatorId 不传：查我参与的；传了：查指定创建者创建的会话。
    const result = await getUserSessionList(userId, page, pageSize, rawStatus ?? undefined, rawCreatorId ?? undefined);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

const getValidatedSessionKey = (req: Request): string | null => {
  const sessionKey = req.params.sessionKey;
  // 路由参数先拦截格式错误，减少无效 DB 查询。
  if (typeof sessionKey !== "string" || !SESSION_KEY_REG.test(sessionKey)) {
    return null;
  }
  return sessionKey;
};

export const getSessionDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    const includeHistory = parseBooleanFlag(req.query.includeHistory);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.includeHistory !== "undefined" && includeHistory === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // service 内会校验成员关系，非成员返回 2003。
    const result = await getSessionDetailForUser(sessionKey, userId, includeHistory ?? false);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const joinSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const inviteToken = parseSessionInviteToken(req.body as { inviteToken?: unknown }) ?? undefined;
    // join 为幂等操作：重复加入同一会话也返回成功。
    const result = await joinSessionForUser(sessionKey, userId, inviteToken);
    send(res, { code: 0, message: "加入成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const createSessionInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    const role = parseSessionInviteRole(req.body as { role?: unknown });
    const maxUses = parseSessionInviteMaxUses(req.body as { maxUses?: unknown });
    const expiresInHours = parseSessionInviteExpiresInHours(req.body as { expiresInHours?: unknown });
    if (!sessionKey || role === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof (req.body as { maxUses?: unknown })?.maxUses !== "undefined" && maxUses === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof (req.body as { expiresInHours?: unknown })?.expiresInHours !== "undefined" && expiresInHours === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await createSessionInviteForOperator(sessionKey, userId, role, {
      ...(typeof maxUses === "number" ? { maxUses } : {}),
      ...(typeof expiresInHours === "number" ? { expiresInHours } : {})
    });
    send(res, { code: 0, message: "邀请创建成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getSessionInviteList = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    const includeUsed = parseBooleanFlag(req.query.includeUsed);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }
    if (typeof req.query.includeUsed !== "undefined" && includeUsed === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await getSessionInviteListForOperator(sessionKey, userId, {
      includeUsed: includeUsed ?? false
    });
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const revokeSessionInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
    const sessionKey = getValidatedSessionKey(req);
    const inviteId = parsePathPositiveInteger(req.params.inviteId);
    if (!sessionKey || inviteId === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    await revokeSessionInviteForOperator(sessionKey, userId, inviteId);
    send(res, { code: 0, message: "作废成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const uploadSessionImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file?.filename) {
      send(res, { code: 1001, message: "图片文件不能为空", data: null });
      return;
    }

    const result = await uploadSessionImageForOperator(sessionKey, userId);
    send(res, {
      code: 0,
      message: "上传成功",
      data: {
        ...result,
        url: `/uploads/session-images/${file.filename}`
      }
    });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const leaveSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // leave 为软退出：从“我加入”列表移除，但保留成员历史记录。
    await leaveSessionForUser(sessionKey, userId);
    send(res, { code: 0, message: "离开成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const removeSessionMember = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    const targetUserId = parsePathPositiveInteger(req.params.userId);
    if (!sessionKey || targetUserId === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    await removeSessionMemberForCreator(sessionKey, userId, targetUserId);
    send(res, { code: 0, message: "移除成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const updateSessionMemberRole = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    const targetUserId = parsePathPositiveInteger(req.params.userId);
    const role = parseSessionMemberRole(req.body as { role?: unknown });
    if (!sessionKey || targetUserId === null || role === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    await setSessionMemberRoleForOperator(sessionKey, userId, targetUserId, role);
    send(res, { code: 0, message: "角色更新成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const updateSessionPausedStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    const isPaused = parseSessionPauseFlag(req.body as { isPaused?: unknown });
    if (!sessionKey || isPaused === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await setSessionPausedForOperator(sessionKey, userId, isPaused);
    // 暂停状态变化后广播给在线成员，前端统一刷新编辑态。
    await broadcastSessionPausedEvent(sessionKey, userId);
    send(res, { code: 0, message: "更新成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const closeSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const result = await closeSessionForOwner(sessionKey, userId);
    send(res, { code: 0, message: "结束成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const heartbeatSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    await heartbeatSessionForUser(sessionKey, userId);
    const user = await findUserById(userId);
    // 心跳成功后主动广播在线态，避免前端必须刷新才能看到在线恢复。
    broadcastSessionMemberStatusChangedEvent(sessionKey, {
      userId,
      username: user?.username ?? "",
      onlineStatus: 1
    });
    send(res, { code: 0, message: "心跳成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const deleteSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = getValidatedSessionKey(req);
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // 仅创建者可删除会话；删除后成员与会话记录一起移除。
    await deleteSessionForUser(sessionKey, userId);
    send(res, { code: 0, message: "删除成功", data: null });
  } catch (error) {
    mapServiceError(res, error);
  }
};
