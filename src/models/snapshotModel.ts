import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";

type QueryExecutor = {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
};

const getExecutor = (connection?: PoolConnection): QueryExecutor => {
  return connection ?? dbPool;
};

export type CanvasSnapshotRow = RowDataPacket & {
  id: number;
  session_id: number;
  version: number | string;
  snapshot_data: unknown;
  graphic_count: number | string;
  created_by: number | null;
  created_at: Date | string;
};

export type InsertCanvasSnapshotInput = {
  sessionId: number;
  version: number;
  snapshotData: Record<string, unknown>;
  graphicCount: number;
  createdBy?: number;
};

export const insertCanvasSnapshot = async (
  input: InsertCanvasSnapshotInput,
  connection?: PoolConnection
): Promise<number> => {
  const executor = getExecutor(connection);
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO canvas_snapshots (session_id, version, snapshot_data, graphic_count, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.sessionId,
      input.version,
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
  const [rows] = await dbPool.query<CanvasSnapshotRow[]>(
    `SELECT id, session_id, version, snapshot_data, graphic_count, created_by, created_at
     FROM canvas_snapshots
     WHERE session_id = ?
     ORDER BY version DESC, id DESC
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
    `SELECT id, session_id, version, snapshot_data, graphic_count, created_by, created_at
     FROM canvas_snapshots
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
  const [rows] = await dbPool.query<CanvasSnapshotRow[]>(
    `SELECT id, session_id, version, snapshot_data, graphic_count, created_by, created_at
     FROM canvas_snapshots
     WHERE session_id = ? AND version <= ?
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [sessionId, targetVersion]
  );
  return rows[0] ?? null;
};
