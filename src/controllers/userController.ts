import { Request, Response } from "express";
import { ApiResponse } from "../types";
import {
  getCurrentUser,
  loginUser,
  removeAuthTokenByUserId,
  registerUser,
  UserServiceError
} from "../services/userService";

type AuthRequest = Request & {
  user?: {
    userId: number;
  };
};

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

// 统一做输入校验，确保用户名长度在 4~20。
const isValidUsername = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  return text.length >= 4 && text.length <= 20;
};

// 密码长度限制在 6~20，规则与需求保持一致。
const isValidPassword = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  return value.length >= 6 && value.length <= 20;
};

const mapServiceError = (res: Response, error: unknown): void => {
  // controller 统一把 service 业务错误映射成 API 错误码。
  if (error instanceof UserServiceError) {
    if (error.code === "USER_EXISTS") {
      send(res, { code: 3002, message: "用户已存在", data: null });
      return;
    }
    if (error.code === "UNAUTHORIZED" || error.code === "USER_NOT_FOUND") {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }
  }

  send(res, { code: 4001, message: "服务器错误", data: null });
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body as {
      username?: unknown;
      password?: unknown;
    };

    if (!isValidUsername(username) || !isValidPassword(password)) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const normalizedUsername = username.trim();
    // 具体的查重、加密、入库逻辑都在 service 层。
    const createdUser = await registerUser(normalizedUsername, password);

    send(res, {
      code: 0,
      message: "注册成功",
      data: createdUser
    });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body as {
      username?: unknown;
      password?: unknown;
    };

    if (!isValidUsername(username) || !isValidPassword(password)) {
      send(res, { code: 1001, message: "参数错误", data: null });
      return;
    }

    const normalizedUsername = username.trim();
    // service 负责鉴权和 token 生成。
    const loginResult = await loginUser(normalizedUsername, password);

    send(res, {
      code: 0,
      message: "登录成功",
      data: loginResult
    });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    // service 负责查询当前用户并做数据转换。
    const currentUser = await getCurrentUser(userId);

    send(res, {
      code: 0,
      message: "获取成功",
      data: currentUser
    });
  } catch (error) {
    mapServiceError(res, error);
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      send(res, { code: 2001, message: "未登录", data: null });
      return;
    }

    await removeAuthTokenByUserId(userId);

    send(res, {
      code: 0,
      message: "退出成功",
      data: null
    });
  } catch (error) {
    mapServiceError(res, error);
  }
};
