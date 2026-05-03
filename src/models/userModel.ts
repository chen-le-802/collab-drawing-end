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
  await dbPool.execute<ResultSetHeader>(
    "UPDATE users SET username = ?, avatar = ? WHERE id = ?",
    [username, avatar, userId]
  );
};
