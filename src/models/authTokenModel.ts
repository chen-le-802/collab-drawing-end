import { ResultSetHeader, RowDataPacket } from "mysql2";

import { dbPool } from "../config/db";
import { AuthToken } from "../types";

type AuthTokenRow = RowDataPacket & {
  id: number;
  user_id: number;
  token: string;
  expires_at: Date | string;
  created_at: Date | string;
};

const toAuthToken = (row: AuthTokenRow): AuthToken => {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
  };
};

export const createAuthToken = async (userId: number, token: string, expiresAt: Date): Promise<void> => {
  await dbPool.execute<ResultSetHeader>(
    "INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
    [userId, token, expiresAt]
  );
};

export const findAuthTokenByToken = async (token: string): Promise<AuthToken | null> => {
  const [rows] = await dbPool.query<AuthTokenRow[]>(
    "SELECT id, user_id, token, expires_at, created_at FROM auth_tokens WHERE token = ? LIMIT 1",
    [token]
  );
  const row = rows[0];
  return row ? toAuthToken(row) : null;
};

export const findValidAuthTokenByToken = async (token: string): Promise<AuthToken | null> => {
  const [rows] = await dbPool.query<AuthTokenRow[]>(
    "SELECT id, user_id, token, expires_at, created_at FROM auth_tokens WHERE token = ? AND expires_at > NOW() LIMIT 1",
    [token]
  );
  const row = rows[0];
  return row ? toAuthToken(row) : null;
};

export const deleteAuthTokensByUserId = async (userId: number): Promise<void> => {
  await dbPool.execute<ResultSetHeader>("DELETE FROM auth_tokens WHERE user_id = ?", [userId]);
};
