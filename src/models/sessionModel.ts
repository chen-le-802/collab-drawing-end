import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";

type QueryExecutor = {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
};

export type SessionRow = RowDataPacket & {
  id: number;
  session_key: string;
  name: string;
  creator_id: number;
  creator_name?: string | null;
  status: number;
  current_version: number;
  member_count?: number;
  online_member_count?: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SessionMemberRow = RowDataPacket & {
  id: number;
  session_id: number;
  user_id: number;
  role: number;
  online_status: number;
  joined_at: Date | string;
  last_active_at?: Date | string;
  username?: string;
  avatar?: string | null;
};

type TotalRow = RowDataPacket & {
  total: number;
};

// 支持在事务连接和普通连接之间复用同一套 SQL 方法。
const getExecutor = (connection?: PoolConnection): QueryExecutor => {
  return connection ?? dbPool;
};

export const insertSession = async (
  sessionKey: string,
  name: string,
  creatorId: number,
  connection?: PoolConnection
): Promise<number> => {
  const executor = getExecutor(connection);
  // 新建会话默认活跃(status=1)，版本从 0 开始。
  const [result] = await executor.execute<ResultSetHeader>(
    "INSERT INTO sessions (session_key, name, creator_id, status, current_version) VALUES (?, ?, ?, 1, 0)",
    [sessionKey, name, creatorId]
  );
  return result.insertId;
};

export const insertSessionMember = async (
  sessionId: number,
  userId: number,
  role: number,
  onlineStatus: number,
  connection?: PoolConnection
): Promise<number> => {
  const executor = getExecutor(connection);
  // join 行为写入成员表，同时刷新 last_active_at。
  const [result] = await executor.execute<ResultSetHeader>(
    "INSERT INTO session_members (session_id, user_id, role, online_status, last_active_at) VALUES (?, ?, ?, ?, NOW())",
    [sessionId, userId, role, onlineStatus]
  );
  return result.insertId;
};

export const findSessionBySessionKey = async (sessionKey: string): Promise<SessionRow | null> => {
  // 关联创建者用户名，避免上层再次查 users 表。
  const [rows] = await dbPool.query<SessionRow[]>(
    `SELECT s.id, s.session_key, s.name, s.creator_id, u.username AS creator_name, s.status, s.current_version, s.created_at, s.updated_at
     FROM sessions s
     LEFT JOIN users u ON u.id = s.creator_id
     WHERE s.session_key = ?
     LIMIT 1`,
    [sessionKey]
  );
  return rows[0] ?? null;
};

export const findSessionMember = async (sessionId: number, userId: number): Promise<SessionMemberRow | null> => {
  const [rows] = await dbPool.query<SessionMemberRow[]>(
    "SELECT id, session_id, user_id, role, online_status, joined_at, last_active_at FROM session_members WHERE session_id = ? AND user_id = ? LIMIT 1",
    [sessionId, userId]
  );
  return rows[0] ?? null;
};

export const setSessionMemberOnlineStatus = async (
  sessionId: number,
  userId: number,
  onlineStatus: number
): Promise<void> => {
  // leave 或断开连接时仅更新在线状态，不删除记录。
  await dbPool.execute<ResultSetHeader>(
    "UPDATE session_members SET online_status = ?, last_active_at = NOW() WHERE session_id = ? AND user_id = ?",
    [onlineStatus, sessionId, userId]
  );
};

export const touchSessionMemberActiveAt = async (sessionId: number, userId: number): Promise<void> => {
  // 心跳上报只刷新活跃时间，避免覆盖在线状态位。
  await dbPool.execute<ResultSetHeader>(
    "UPDATE session_members SET last_active_at = NOW() WHERE session_id = ? AND user_id = ?",
    [sessionId, userId]
  );
};

export const deleteSessionMembersBySessionId = async (
  sessionId: number,
  connection?: PoolConnection
): Promise<void> => {
  const executor = getExecutor(connection);
  // 删除会话前先清理成员关联，避免残留脏数据。
  await executor.execute<ResultSetHeader>("DELETE FROM session_members WHERE session_id = ?", [sessionId]);
};

export const deleteSessionById = async (sessionId: number, connection?: PoolConnection): Promise<void> => {
  const executor = getExecutor(connection);
  await executor.execute<ResultSetHeader>("DELETE FROM sessions WHERE id = ?", [sessionId]);
};

export const countUserJoinedSessions = async (userId: number, status?: number): Promise<number> => {
  const hasStatusFilter = typeof status === "number";

  const sql = hasStatusFilter
    ? `SELECT COUNT(DISTINCT s.id) AS total
       FROM session_members sm
       INNER JOIN sessions s ON s.id = sm.session_id
       WHERE sm.user_id = ? AND sm.online_status = 1 AND s.status = ?`
    : `SELECT COUNT(DISTINCT s.id) AS total
       FROM session_members sm
       INNER JOIN sessions s ON s.id = sm.session_id
       WHERE sm.user_id = ? AND sm.online_status = 1`;

  const params = hasStatusFilter ? [userId, status] : [userId];
  const [rows] = await dbPool.query<TotalRow[]>(sql, params);
  // COUNT 在部分驱动配置下会返回 string，这里统一转 number。
  return Number(rows[0]?.total ?? 0);
};

export const countSessionsByCreator = async (creatorId: number, status?: number): Promise<number> => {
  const hasStatusFilter = typeof status === "number";

  const sql = hasStatusFilter
    ? "SELECT COUNT(*) AS total FROM sessions WHERE creator_id = ? AND status = ?"
    : "SELECT COUNT(*) AS total FROM sessions WHERE creator_id = ?";

  const params = hasStatusFilter ? [creatorId, status] : [creatorId];
  const [rows] = await dbPool.query<TotalRow[]>(sql, params);
  return Number(rows[0]?.total ?? 0);
};

export const findUserJoinedSessions = async (
  userId: number,
  page: number,
  pageSize: number,
  status?: number,
  onlineTimeoutSeconds = 60
): Promise<SessionRow[]> => {
  const offset = (page - 1) * pageSize;
  const hasStatusFilter = typeof status === "number";

  // 通过 LEFT JOIN + COUNT 计算每个会话成员数；GROUP BY 保证每个会话一行。
  const sql = hasStatusFilter
    ? `SELECT s.id, s.session_key, s.name, s.creator_id, u.username AS creator_name, s.status, s.current_version, s.created_at, s.updated_at, COUNT(sm_all.id) AS member_count,
              SUM(CASE WHEN sm_all.online_status = 1 AND sm_all.last_active_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) THEN 1 ELSE 0 END) AS online_member_count
       FROM session_members sm
       INNER JOIN sessions s ON s.id = sm.session_id
       LEFT JOIN users u ON u.id = s.creator_id
       LEFT JOIN session_members sm_all ON sm_all.session_id = s.id
       WHERE sm.user_id = ? AND sm.online_status = 1 AND s.status = ?
       GROUP BY s.id, s.session_key, s.name, s.creator_id, u.username, s.status, s.current_version, s.created_at, s.updated_at
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    : `SELECT s.id, s.session_key, s.name, s.creator_id, u.username AS creator_name, s.status, s.current_version, s.created_at, s.updated_at, COUNT(sm_all.id) AS member_count,
              SUM(CASE WHEN sm_all.online_status = 1 AND sm_all.last_active_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) THEN 1 ELSE 0 END) AS online_member_count
       FROM session_members sm
       INNER JOIN sessions s ON s.id = sm.session_id
       LEFT JOIN users u ON u.id = s.creator_id
       LEFT JOIN session_members sm_all ON sm_all.session_id = s.id
       WHERE sm.user_id = ? AND sm.online_status = 1
       GROUP BY s.id, s.session_key, s.name, s.creator_id, u.username, s.status, s.current_version, s.created_at, s.updated_at
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`;

  const params = hasStatusFilter
    ? [onlineTimeoutSeconds, userId, status, pageSize, offset]
    : [onlineTimeoutSeconds, userId, pageSize, offset];
  const [rows] = await dbPool.query<SessionRow[]>(sql, params);
  return rows;
};

export const findSessionsByCreator = async (
  creatorId: number,
  page: number,
  pageSize: number,
  status?: number,
  onlineTimeoutSeconds = 60
): Promise<SessionRow[]> => {
  const offset = (page - 1) * pageSize;
  const hasStatusFilter = typeof status === "number";

  // 创建者维度查询时，不要求当前登录用户是成员。
  const sql = hasStatusFilter
    ? `SELECT s.id, s.session_key, s.name, s.creator_id, u.username AS creator_name, s.status, s.current_version, s.created_at, s.updated_at, COUNT(sm.id) AS member_count,
              SUM(CASE WHEN sm.online_status = 1 AND sm.last_active_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) THEN 1 ELSE 0 END) AS online_member_count
       FROM sessions s
       LEFT JOIN users u ON u.id = s.creator_id
       LEFT JOIN session_members sm ON sm.session_id = s.id
       WHERE s.creator_id = ? AND s.status = ?
       GROUP BY s.id, s.session_key, s.name, s.creator_id, u.username, s.status, s.current_version, s.created_at, s.updated_at
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    : `SELECT s.id, s.session_key, s.name, s.creator_id, u.username AS creator_name, s.status, s.current_version, s.created_at, s.updated_at, COUNT(sm.id) AS member_count,
              SUM(CASE WHEN sm.online_status = 1 AND sm.last_active_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) THEN 1 ELSE 0 END) AS online_member_count
       FROM sessions s
       LEFT JOIN users u ON u.id = s.creator_id
       LEFT JOIN session_members sm ON sm.session_id = s.id
       WHERE s.creator_id = ?
       GROUP BY s.id, s.session_key, s.name, s.creator_id, u.username, s.status, s.current_version, s.created_at, s.updated_at
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`;

  const params = hasStatusFilter
    ? [onlineTimeoutSeconds, creatorId, status, pageSize, offset]
    : [onlineTimeoutSeconds, creatorId, pageSize, offset];
  const [rows] = await dbPool.query<SessionRow[]>(sql, params);
  return rows;
};

export const findSessionMembersBySessionId = async (sessionId: number): Promise<SessionMemberRow[]> => {
  // 创建者优先展示，再按加入时间升序，便于前端成员列表渲染。
  const [rows] = await dbPool.query<SessionMemberRow[]>(
    `SELECT sm.id, sm.session_id, sm.user_id, sm.role, sm.online_status, sm.joined_at, sm.last_active_at, u.username, u.avatar
     FROM session_members sm
     INNER JOIN users u ON u.id = sm.user_id
     WHERE sm.session_id = ?
     ORDER BY sm.role DESC, sm.joined_at ASC`,
    [sessionId]
  );
  return rows;
};

export const findSessionMemberPreviewsBySessionId = async (
  sessionId: number,
  limit = 4
): Promise<SessionMemberRow[]> => {
  // 卡片预览头像：优先创建者，再按加入时间升序，最多返回 limit 条。
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 4;
  const [rows] = await dbPool.query<SessionMemberRow[]>(
    `SELECT sm.id, sm.session_id, sm.user_id, sm.role, sm.online_status, sm.joined_at, u.username, u.avatar
     FROM session_members sm
     INNER JOIN users u ON u.id = sm.user_id
     WHERE sm.session_id = ?
     ORDER BY sm.role DESC, sm.joined_at ASC
     LIMIT ?`,
    [sessionId, safeLimit]
  );
  return rows;
};

export const findSessionMemberPreviewsBySessionIds = async (
  sessionIds: number[],
  onlineTimeoutSeconds = 60,
  limitPerSession = 4
): Promise<SessionMemberRow[]> => {
  if (sessionIds.length === 0) {
    return [];
  }

  const placeholders = sessionIds.map(() => "?").join(", ");
  const sql = `
    SELECT t.id, t.session_id, t.user_id, t.role, t.online_status, t.joined_at, t.last_active_at, t.username, t.avatar
    FROM (
      SELECT sm.id, sm.session_id, sm.user_id, sm.role, sm.online_status, sm.joined_at, sm.last_active_at, u.username, u.avatar,
             ROW_NUMBER() OVER (PARTITION BY sm.session_id ORDER BY sm.role DESC, sm.joined_at ASC) AS rn
      FROM session_members sm
      INNER JOIN users u ON u.id = sm.user_id
      WHERE sm.session_id IN (${placeholders})
    ) t
    WHERE t.rn <= ?
    ORDER BY t.session_id ASC, t.role DESC, t.joined_at ASC
  `;

  const params = [...sessionIds, limitPerSession];
  const [rows] = await dbPool.query<SessionMemberRow[]>(sql, params);
  const threshold = Date.now() - onlineTimeoutSeconds * 1000;
  return rows.map((row) => {
    const lastActiveValue = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;
    const isOnline = row.online_status === 1 && lastActiveValue >= threshold;
    return {
      ...row,
      online_status: isOnline ? 1 : 0
    };
  });
};
