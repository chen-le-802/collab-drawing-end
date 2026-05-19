import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";

type QueryExecutor = {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
};

// 统一事务/非事务执行入口，避免 SQL 方法重复实现。
const getExecutor = (connection?: PoolConnection): QueryExecutor => {
  return connection ?? dbPool;
};

export type CanvasSnapshotRow = RowDataPacket & {
  id: number;
  session_id: number;
  version: number | string;
  snapshot_name: string | null;
  snapshot_data: unknown;
  graphic_count: number | string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: Date | string;
};

export type InsertCanvasSnapshotInput = {
  sessionId: number;
  version: number;
  snapshotName: string;
  snapshotData: Record<string, unknown>;
  graphicCount: number;
  createdBy?: number;
};

export const insertCanvasSnapshot = async (
  input: InsertCanvasSnapshotInput,
  connection?: PoolConnection
): Promise<number> => {
  const executor = getExecutor(connection);
  // 快照正文以 JSON 序列化存储，记录当时完整画布状态。
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO canvas_snapshots (session_id, version, snapshot_name, snapshot_data, graphic_count, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.sessionId,
      input.version,
      input.snapshotName,
      JSON.stringify(input.snapshotData),
      input.graphicCount,
      input.createdBy ?? null
    ]
  );
  return result.insertId;
};

export const findSnapshotsBySession = async (
  sessionId: number,
  limit = 20
): Promise<CanvasSnapshotRow[]> => {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  // 快照列表按版本倒序，前端默认展示“最近快照在前”。
  const [rows] = await dbPool.query<CanvasSnapshotRow[]>(
    `SELECT cs.id, cs.session_id, cs.version, cs.snapshot_name, cs.snapshot_data, cs.graphic_count, cs.created_by, u.username AS created_by_name, cs.created_at
     FROM canvas_snapshots cs
     LEFT JOIN users u ON u.id = cs.created_by
     WHERE session_id = ?
     ORDER BY cs.version DESC, cs.id DESC
     LIMIT ?`,
    [sessionId, safeLimit]
  );
  return rows;
};

export const findSnapshotById = async (
  sessionId: number,
  snapshotId: number
): Promise<CanvasSnapshotRow | null> => {
  const [rows] = await dbPool.query<CanvasSnapshotRow[]>(
    `SELECT cs.id, cs.session_id, cs.version, cs.snapshot_name, cs.snapshot_data, cs.graphic_count, cs.created_by, u.username AS created_by_name, cs.created_at
     FROM canvas_snapshots cs
     LEFT JOIN users u ON u.id = cs.created_by
     WHERE session_id = ? AND id = ?
     LIMIT 1`,
    [sessionId, snapshotId]
  );
  return rows[0] ?? null;
};

export const findLatestSnapshotBySessionAtOrBeforeVersion = async (
  sessionId: number,
  targetVersion: number
): Promise<CanvasSnapshotRow | null> => {
  // 回放/恢复时优先找目标版本之前最近快照，减少后续 operation 回放长度。
  const [rows] = await dbPool.query<CanvasSnapshotRow[]>(
    `SELECT cs.id, cs.session_id, cs.version, cs.snapshot_name, cs.snapshot_data, cs.graphic_count, cs.created_by, u.username AS created_by_name, cs.created_at
     FROM canvas_snapshots cs
     LEFT JOIN users u ON u.id = cs.created_by
     WHERE session_id = ? AND version <= ?
     ORDER BY cs.version DESC, cs.id DESC
     LIMIT 1`,
    [sessionId, targetVersion]
  );
  return rows[0] ?? null;
};
