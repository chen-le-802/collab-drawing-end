import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { env } from "../config/env";
import { UpdateProfileDTO, UserVO } from "../types";
import { createAuthToken, deleteAuthTokensByUserId, findAuthTokenByToken } from "../models/authTokenModel";
import { createUser, findUserById, findUserByUsername, updateUserProfileById, UserRow } from "../models/userModel";

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES_SECONDS = 24 * 60 * 60;

export class UserServiceError extends Error {
  constructor(
    public readonly code: "USER_EXISTS" | "UNAUTHORIZED" | "USER_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

// service 只处理业务规则和数据读写，不关心 HTTP 协议细节。
export const registerUser = async (username: string, password: string) => {
  const existsUser = await findUserByUsername(username);
  if (existsUser) {
    throw new UserServiceError("USER_EXISTS", "用户已存在");
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const userId = await createUser(username, hashedPassword, null);

  return {
    userId,
    username,
    avatar: null
  };
};

export const loginUser = async (username: string, password: string) => {
  const user = await findUserByUsername(username);
  if (!user) {
    throw new UserServiceError("UNAUTHORIZED", "用户不存在");
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password);
  if (!isPasswordCorrect) {
    throw new UserServiceError("UNAUTHORIZED", "用户名或密码错误");
  }

  const token = jwt.sign({ userId: user.id }, env.jwtSecret, {
    expiresIn: JWT_EXPIRES_SECONDS
  });
  const expiresAtDate = new Date(Date.now() + JWT_EXPIRES_SECONDS * 1000);

  await createAuthToken(user.id, token, expiresAtDate);

  return {
    token,
    expiresAt: expiresAtDate.toISOString(),
    user: toUserVO(user)
  };
};

export const getCurrentUser = async (userId: number): Promise<UserVO> => {
  const user = await findUserById(userId);
  if (!user) {
    throw new UserServiceError("USER_NOT_FOUND", "未登录");
  }

  return toUserVO(user);
};

export const updateProfile = async (userId: number, payload: UpdateProfileDTO): Promise<UserVO> => {
  const currentUser = await findUserById(userId);
  if (!currentUser) {
    throw new UserServiceError("USER_NOT_FOUND", "未登录");
  }

  const nextUsername = payload.username !== undefined ? payload.username.trim() : currentUser.username;
  const nextAvatar = payload.avatar !== undefined ? payload.avatar : currentUser.avatar;

  if (nextUsername !== currentUser.username) {
    const existsUser = await findUserByUsername(nextUsername);
    if (existsUser && existsUser.id !== userId) {
      throw new UserServiceError("USER_EXISTS", "用户已存在");
    }
  }

  await updateUserProfileById(userId, nextUsername, nextAvatar);

  const updatedUser = await findUserById(userId);
  if (!updatedUser) {
    throw new UserServiceError("USER_NOT_FOUND", "未登录");
  }

  return toUserVO(updatedUser);
};

export const getAuthTokenByToken = findAuthTokenByToken;

export const removeAuthTokenByUserId = async (userId: number): Promise<void> => {
  await deleteAuthTokensByUserId(userId);
};

const toUserVO = (user: UserRow): UserVO => {
  return {
    id: user.id,
    username: user.username,
    ...(user.avatar ? { avatar: user.avatar } : {}),
    role: user.role,
    status: user.status,
    createdAt: user.created_at instanceof Date ? user.created_at.toISOString() : new Date(user.created_at).toISOString(),
    updatedAt: user.updated_at instanceof Date ? user.updated_at.toISOString() : new Date(user.updated_at).toISOString()
  };
};
