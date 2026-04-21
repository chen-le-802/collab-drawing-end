import { Request, Response } from "express";

import { getSessionGraphicsBySessionKey, GraphicServiceError } from "../services/graphicService";
import { ApiResponse } from "../types";

type AuthRequest = Request & {
  user?: {
    userId: number;
  };
};

// session_key 为 32 字节随机数转 hex，固定 64 位十六进制字符串。
const SESSION_KEY_REG = /^[a-f0-9]{64}$/i;

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

// 增量同步参数：sinceVersion 必须是 >= 0 的整数。
const parseSinceVersion = (value: unknown): number | null => {
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

// controller 统一收口业务异常到约定错误码。
const mapServiceError = (res: Response, error: unknown): void => {
  if (error instanceof GraphicServiceError) {
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

  send(res, { code: 4001, message: "服务器错误", data: null });
};

export const getSessionGraphics = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    const sessionKey = req.params.sessionKey;
    if (typeof sessionKey !== "string" || !SESSION_KEY_REG.test(sessionKey)) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const sinceVersion = parseSinceVersion(req.query.sinceVersion);
    if (typeof req.query.sinceVersion !== "undefined" && sinceVersion === null) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    // 由 service 校验成员权限并按 version 返回全量/增量图形。
    const result = await getSessionGraphicsBySessionKey(sessionKey, userId, sinceVersion ?? undefined);
    send(res, { code: 0, message: "获取成功", data: result });
  } catch (error) {
    mapServiceError(res, error);
  }
};
