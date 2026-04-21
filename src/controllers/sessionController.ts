import { Request, Response } from "express";

import { ApiResponse } from "../types";
import {
  createSessionForUser,
  deleteSessionForUser,
  getSessionDetailForUser,
  getUserSessionList,
  joinSessionForUser,
  leaveSessionForUser,
  SessionServiceError
} from "../services/sessionService";

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

// controller 统一做 service -> API 错误码映射，保证响应结构稳定。
const mapServiceError = (res: Response, error: unknown): void => {
  if (error instanceof SessionServiceError) {
    if (error.code === "SESSION_NOT_FOUND") {
      send(res, { code: 3001, message: "会话不存在", data: null });
      return;
    }
    if (error.code === "SESSION_FORBIDDEN") {
      send(res, { code: 2003, message: "无会话访问权限", data: null });
      return;
    }
  }

  send(res, { code: 4001, message: "服务器错误", data: null });
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
    if (!sessionKey) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // service 内会校验成员关系，非成员返回 2003。
    const result = await getSessionDetailForUser(sessionKey, userId);
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

    // join 为幂等操作：重复加入同一会话也返回成功。
    const result = await joinSessionForUser(sessionKey, userId);
    send(res, { code: 0, message: "加入成功", data: result });
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

    // leave 只更新在线状态，不删除历史成员关系记录。
    await leaveSessionForUser(sessionKey, userId);
    send(res, { code: 0, message: "离开成功", data: null });
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
