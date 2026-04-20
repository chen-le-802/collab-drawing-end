import { NextFunction, Request, Response } from "express";

import { ApiResponse, AuthPayload } from "../types";
import { verifyTokenAndGetUserId } from "../services/authService";

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

// 从 Authorization 头中提取 Bearer token。
// 格式必须是：Authorization: Bearer <token>
const extractBearerToken = (authorization?: string): string | null => {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    send(res, { code: 2001, message: "未登录", data: null });
    return;
  }

  const userId = await verifyTokenAndGetUserId(token);
  if (!userId) {
    send(res, { code: 2002, message: "登录已过期", data: null });
    return;
  }

  // 鉴权通过后，把 userId 挂到 req.user，供后续业务处理器读取。
  (req as Request & { user: AuthPayload; authToken: string }).user = { userId };
  (req as Request & { user: AuthPayload; authToken: string }).authToken = token;
  next();
};
