import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";

type QueryExecutor = {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
};

const getExecutor = (connection?: PoolConnection): QueryExecutor => {
  return connection ?? dbPool;
};

export type DbOperationType = "create" | "update" | "delete";
export type ConflictType = "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation";

export type OperationRow = RowDataPacket & {
  id: number;
  version: number | string;
  operation_id: string | null;
  session_id: number;
  user_id: number;
  object_key: string;
  operation_type: DbOperationType;
  operation_data: unknown;
  base_version: number | string;
  server_version: number | string | null;
  lamport_time: number | string;
  client_id: string | null;
  resolved_result: unknown;
  conflict_type: ConflictType;
  timestamp: number;
};

export type OperationTimelineQuery = {
  sessionId: number;
  fromVersion?: number;
  toVersion?: number;
  userId?: number;
  operationType?: DbOperationType;
  conflictType?: ConflictType;
  offset: number;
  limit: number;
};

const buildTimelineWhere = (query: OperationTimelineQuery): { where: string; params: Array<number | string> } => {
  const clauses: string[] = ["session_id = ?"];
  const params: Array<number | string> = [query.sessionId];

  if (typeof query.fromVersion === "number") {
    clauses.push("server_version >= ?");
    params.push(query.fromVersion);
  }
  if (typeof query.toVersion === "number") {
    clauses.push("server_version <= ?");
    params.push(query.toVersion);
  }
  if (typeof query.userId === "number") {
    clauses.push("user_id = ?");
    params.push(query.userId);
  }
  if (typeof query.operationType === "string") {
    clauses.push("operation_type = ?");
    params.push(query.operationType);
  }
  if (typeof query.conflictType === "string") {
    clauses.push("conflict_type = ?");
    params.push(query.conflictType);
  }

  return {
    where: clauses.join(" AND "),
    params
  };
};

export const findOperationsBySessionSinceVersion = async (
  sessionId: number,
  sinceVersion: number,
  limit = 500
): Promise<OperationRow[]> => {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 500;
  const [rows] = await dbPool.query<OperationRow[]>(
    `SELECT id, version, operation_id, session_id, user_id, object_key, operation_type, operation_data,
            base_version, server_version, lamport_time, client_id, resolved_result, conflict_type, timestamp
     FROM operations
     WHERE session_id = ? AND server_version > ?
     ORDER BY server_version ASC, id ASC
     LIMIT ?`,
    [sessionId, sinceVersion, safeLimit]
  );
  return rows;
};

export const findOperationsBySessionVersionRange = async (
  sessionId: number,
  startVersionExclusive: number,
  endVersionInclusive: number,
  limit = 5000
): Promise<OperationRow[]> => {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 5000;
  const [rows] = await dbPool.query<OperationRow[]>(
    `SELECT id, version, operation_id, session_id, user_id, object_key, operation_type, operation_data,
            base_version, server_version, lamport_time, client_id, resolved_result, conflict_type, timestamp
     FROM operations
     WHERE session_id = ? AND server_version > ? AND server_version <= ?
     ORDER BY server_version ASC, id ASC
     LIMIT ?`,
    [sessionId, startVersionExclusive, endVersionInclusive, safeLimit]
  );
  return rows;
};

export const countOperationsByTimelineQuery = async (query: OperationTimelineQuery): Promise<number> => {
  const { where, params } = buildTimelineWhere(query);
  const [rows] = await dbPool.query<Array<{ total: number } & RowDataPacket>>(
    `SELECT COUNT(1) AS total
     FROM operations
     WHERE ${where}`,
    params
  );
  return Number(rows[0]?.total ?? 0);
};

export const findOperationsByTimelineQuery = async (query: OperationTimelineQuery): Promise<OperationRow[]> => {
  const { where, params } = buildTimelineWhere(query);
  const [rows] = await dbPool.query<OperationRow[]>(
    `SELECT id, version, operation_id, session_id, user_id, object_key, operation_type, operation_data,
            base_version, server_version, lamport_time, client_id, resolved_result, conflict_type, timestamp
     FROM operations
     WHERE ${where}
     ORDER BY server_version DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset]
  );
  return rows;
};

export type InsertOperationInput = {
  operationId: string;
  sessionId: number;
  userId: number;
  objectKey: string;
  operationType: DbOperationType;
  operationData: Record<string, unknown>;
  baseVersion: number;
  serverVersion: number;
  lamportTime: number;
  clientId: string;
  resolvedResult: Record<string, unknown>;
  conflictType: ConflictType;
};

export const findOperationByOperationId = async (
  sessionId: number,
  operationId: string,
  connection?: PoolConnection
): Promise<OperationRow | null> => {
  const executor = getExecutor(connection);
  const [rows] = await executor.query<OperationRow[]>(
    `SELECT id, version, operation_id, session_id, user_id, object_key, operation_type, operation_data,
            base_version, server_version, lamport_time, client_id, resolved_result, conflict_type, timestamp
     FROM operations
     WHERE session_id = ? AND operation_id = ?
     LIMIT 1`,
    [sessionId, operationId]
  );
  return rows[0] ?? null;
};

export const insertOperationRecord = async (
  input: InsertOperationInput,
  connection?: PoolConnection
): Promise<number> => {
  const executor = getExecutor(connection);
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO operations (
      operation_id, session_id, user_id, object_key, operation_type, operation_data,
      base_version, server_version, version, lamport_time, client_id,
      resolved_result, conflict_type, resolved_at, timestamp, undoable, redoable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 1, 0)`,
    [
      input.operationId,
      input.sessionId,
      input.userId,
      input.objectKey,
      input.operationType,
      JSON.stringify(input.operationData),
      input.baseVersion,
      input.serverVersion,
      input.serverVersion,
      input.lamportTime,
      input.clientId,
      JSON.stringify(input.resolvedResult),
      input.conflictType,
      Date.now()
    ]
  );
  return result.insertId;
};

export type UpsertFieldVersionInput = {
  sessionId: number;
  objectKey: string;
  fieldName: string;
  lamportTime: number;
  serverVersion: number;
  clientId: string;
  updatedBy: number;
};

export const upsertGraphicFieldVersion = async (
  input: UpsertFieldVersionInput,
  connection?: PoolConnection
): Promise<void> => {
  const executor = getExecutor(connection);
  await executor.execute(
    `INSERT INTO graphic_field_versions (
      session_id, object_key, field_name, lamport_time, server_version, client_id, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      lamport_time = VALUES(lamport_time),
      server_version = VALUES(server_version),
      client_id = VALUES(client_id),
      updated_by = VALUES(updated_by),
      updated_at = NOW()`,
    [
      input.sessionId,
      input.objectKey,
      input.fieldName,
      input.lamportTime,
      input.serverVersion,
      input.clientId,
      input.updatedBy
    ]
  );
};

export type FieldVersionRow = RowDataPacket & {
  field_name: string;
  lamport_time: number | string;
  server_version: number | string;
  client_id: string | null;
};

export const findGraphicFieldVersions = async (
  sessionId: number,
  objectKey: string,
  connection?: PoolConnection
): Promise<FieldVersionRow[]> => {
  const executor = getExecutor(connection);
  const [rows] = await executor.query<FieldVersionRow[]>(
    `SELECT field_name, lamport_time, server_version, client_id
     FROM graphic_field_versions
     WHERE session_id = ? AND object_key = ?`,
    [sessionId, objectKey]
  );
  return rows;
};

export type InsertConflictLogInput = {
  operationRefId?: number;
  operationId: string;
  sessionId: number;
  objectKey: string;
  conflictType: ConflictType;
  fieldName?: string;
  currentValue?: unknown;
  incomingValue?: unknown;
  resolvedValue?: unknown;
  resolveStrategy: string;
};

export type ConflictLogRow = RowDataPacket & {
  id: number;
  operation_ref_id: number | null;
  operation_id: string | null;
  session_id: number;
  object_key: string;
  conflict_type: ConflictType;
  field_name: string | null;
  current_value: unknown;
  incoming_value: unknown;
  resolved_value: unknown;
  resolve_strategy: string;
  created_at: Date | string;
};

export const insertConflictLog = async (
  input: InsertConflictLogInput,
  connection?: PoolConnection
): Promise<void> => {
  const executor = getExecutor(connection);
  await executor.execute(
    `INSERT INTO conflict_logs (
      operation_ref_id, operation_id, session_id, object_key, conflict_type, field_name,
      current_value, incoming_value, resolved_value, resolve_strategy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.operationRefId ?? null,
      input.operationId,
      input.sessionId,
      input.objectKey,
      input.conflictType,
      input.fieldName ?? null,
      typeof input.currentValue === "undefined" ? null : JSON.stringify(input.currentValue),
      typeof input.incomingValue === "undefined" ? null : JSON.stringify(input.incomingValue),
      typeof input.resolvedValue === "undefined" ? null : JSON.stringify(input.resolvedValue),
      input.resolveStrategy
    ]
  );
};

export const findConflictLogsBySession = async (
  sessionId: number,
  sinceId: number,
  limit = 100
): Promise<ConflictLogRow[]> => {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const [rows] = await dbPool.query<ConflictLogRow[]>(
    `SELECT id, operation_ref_id, operation_id, session_id, object_key, conflict_type, field_name,
            current_value, incoming_value, resolved_value, resolve_strategy, created_at
     FROM conflict_logs
     WHERE session_id = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [sessionId, sinceId, safeLimit]
  );
  return rows;
};
