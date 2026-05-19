import { ResultSetHeader, RowDataPacket } from "mysql2";

import { dbPool } from "../config/db";

export type UserRow = RowDataPacket & {
  id: number;
  username: string;
  password: string;
  avatar: string | null;
  role: number;
  status: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export const findUserByUsername = async (username: string): Promise<UserRow | null> => {
  // 登录与注册查重统一走用户名索引查询。
  const [rows] = await dbPool.query<UserRow[]>(
    "SELECT id, username, password, avatar, role, status, created_at, updated_at FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  return rows[0] ?? null;
};

export const findUserById = async (userId: number): Promise<UserRow | null> => {
  const [rows] = await dbPool.query<UserRow[]>(
    "SELECT id, username, password, avatar, role, status, created_at, updated_at FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return rows[0] ?? null;
};

export const createUser = async (
  username: string,
  passwordHash: string,
  avatar: string | null = null
): Promise<number> => {
  // 密码仅保存 hash，不落明文。
  const [result] = await dbPool.execute<ResultSetHeader>(
    "INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)",
    [username, passwordHash, avatar]
  );
  return result.insertId;
};

export const updateUserProfileById = async (
  userId: number,
  username: string,
  avatar: string | null
): Promise<void> => {
  // 个人资料更新不改密码字段，避免误覆盖认证信息。
  await dbPool.execute<ResultSetHeader>(
    "UPDATE users SET username = ?, avatar = ? WHERE id = ?",
    [username, avatar, userId]
  );
};

export const updateUserPasswordById = async (userId: number, passwordHash: string): Promise<void> => {
  // 改密时刷新 updated_at，便于后续安全审计。
  await dbPool.execute<ResultSetHeader>(
    "UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?",
    [passwordHash, userId]
  );
};
