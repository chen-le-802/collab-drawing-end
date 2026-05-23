import { PoolConnection, RowDataPacket } from "mysql2/promise";

import { env } from "../config/env";
import { getRedisClient, isRedisReady } from "../config/redis";
import { dbPool } from "../config/db";
import {
  findGraphicById,
  findGraphicByObjectKey,
  incrementSessionVersion,
  insertGraphicObject,
  findSessionCurrentVersion,
  softDeleteGraphicById,
  updateGraphicObjectById
} from "../models/graphicModel";
import {
  countOperationsByTimelineQuery,
  ConflictLogRow,
  findOperationByOperationId,
  findConflictLogsBySession,
  findOperationsBySessionVersionRange,
  findOperationsBySessionSinceVersion,
  findOperationsByTimelineQuery,
  insertConflictLogsBatch,
  insertOperationRecord,
  OperationRow,
  upsertGraphicFieldVersionsBatch
} from "../models/operationModel";
import { findSessionBySessionKey, findSessionMember } from "../models/sessionModel";
import { crdtMergeService, CrdtMergeServiceError, CRDT_FIELD_NAMES } from "./crdtMergeService";
import {
  CreateGraphicDTO,
  GraphicVO,
  SessionConflictLogItemVO,
  SessionConflictLogsVO,
  SessionOperationTimelineQuery,
  SessionOperationTimelineVO,
  SessionReplayVO,
  SessionRestoreVersionVO,
  SessionSnapshotItemVO,
  SessionSnapshotsVO,
  SessionOperationItemVO,
  SessionOperationsSyncVO,
  UpdateGraphicDTO
} from "../types";
import {
  CanvasSnapshotRow,
  findLatestSnapshotBySessionAtOrBeforeVersion,
  findSnapshotsBySession,
  insertCanvasSnapshot
} from "../models/snapshotModel";
import { invalidateSessionGraphicsCache } from "./snapshotCacheService";

type DbOperationType = "create" | "update" | "delete";
type ConflictType = "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation";

type OperationMeta = {
  operationId?: string;
  baseVersion?: number;
  lamportTime?: number;
  clientId?: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
};

type NormalizedOperationMeta = {
  operationId: string;
  baseVersion: number;
  lamportTime: number;
  clientId: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
};

type OperationResolved = {
  operationId: string;
  objectKey: string;
  operationType: "create_graphic" | "update_graphic" | "delete_graphic";
  serverVersion: number;
  conflictType: ConflictType;
  appliedFields: string[];
  rejectedFields: string[];
  resolveReason: string;
};

type OperationApplyResult = {
  graphic?: GraphicVO;
  deletedObjectKey?: string;
  operationRecordId?: number;
  resolved: OperationResolved;
};

type OperationWriteOptions = {
  skipUserHistory?: boolean;
};

type OperationServiceErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_FORBIDDEN"
  | "GRAPHIC_NOT_FOUND"
  | "GRAPHIC_EXISTS"
  | "INVALID_ARGUMENT";

export class OperationServiceError extends Error {
  constructor(public readonly code: OperationServiceErrorCode, message: string) {
    super(message);
    this.name = "OperationServiceError";
  }
}

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
};

type PerfMetricPayload = Record<string, string | number | boolean>;

const perfNow = (): number => {
  return Date.now();
};

const logPerfMetric = (name: string, payload: PerfMetricPayload): void => {
  if (!env.perfMetricsEnabled) {
    return;
  }
  const metrics = Object.entries(payload)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[perf] ${name} ${metrics}`);
};

// Redis 幂等键：同一个 operationId 在 TTL 窗口内只应被执行一次。
const buildOpDedupeKey = (operationId: string): string => `op:dedupe:${operationId}`;

const tryAcquireOpDedupe = async (operationId: string): Promise<"acquired" | "exists" | "disabled"> => {
  // Redis 不可用时降级到数据库唯一键去重，避免功能不可用。
  if (!env.redisEnabled || !isRedisReady()) {
    return "disabled";
  }
  const client = getRedisClient();
  if (!client) {
    return "disabled";
  }
  const result = await client.set(buildOpDedupeKey(operationId), "processing", {
    NX: true,
    EX: env.redisOpDedupeTtlSeconds
  });
  return result === "OK" ? "acquired" : "exists";
};

const markOpDedupeDone = async (operationId: string): Promise<void> => {
  if (!env.redisEnabled || !isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  await client.set(buildOpDedupeKey(operationId), "done", {
    EX: env.redisOpDedupeTtlSeconds
  });
};

const releaseOpDedupe = async (operationId: string): Promise<void> => {
  if (!env.redisEnabled || !isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  await client.del(buildOpDedupeKey(operationId));
};

const isDuplicateEntryError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  return String((error as { code?: string }).code ?? "") === "ER_DUP_ENTRY";
};

const buildDuplicateApplyResult = (
  duplicated: OperationRow,
  operationId: string,
  objectKey: string,
  operationType: "create_graphic" | "update_graphic" | "delete_graphic"
): OperationApplyResult => {
  // 幂等返回：重复请求直接复用已落库操作，不再重复推进版本号。
  return {
    operationRecordId: toNumber(duplicated.id),
    resolved: {
      operationId,
      objectKey,
      operationType,
      serverVersion: toNumber(duplicated.server_version, toNumber(duplicated.version)),
      conflictType: "duplicate_operation",
      appliedFields: [],
      rejectedFields: [],
      resolveReason: "duplicate_operation_ignored"
    }
  };
};

const waitDuplicatedOperation = async (sessionId: number, operationId: string): Promise<OperationRow | null> => {
  // 首次请求可能仍在事务中，短轮询等待它提交后再返回幂等结果。
  for (let i = 0; i < 5; i += 1) {
    const duplicated = await findOperationByOperationId(sessionId, operationId);
    if (duplicated) {
      return duplicated;
    }
    await sleep(80);
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const toObject = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
};

const toObjectArray = (value: unknown): Record<string, unknown>[] => {
  const parsed = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value) as unknown;
      } catch (_error) {
        return [];
      }
    })()
    : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is Record<string, unknown> => isRecord(item));
};

const randomOpId = (): string => `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const normalizeMeta = (
  sessionCurrentVersion: number,
  operationType: "create_graphic" | "update_graphic" | "delete_graphic",
  objectKey: string,
  raw?: OperationMeta
): NormalizedOperationMeta => {
  // 统一补齐协同元信息，兼容旧客户端缺字段的情况。
  const operationId = typeof raw?.operationId === "string" && raw.operationId.trim().length > 0
    ? raw.operationId.trim()
    : `${operationType}_${objectKey}_${randomOpId()}`;
  const baseVersion = Number.isInteger(raw?.baseVersion) && (raw?.baseVersion ?? -1) >= 0
    ? Number(raw?.baseVersion)
    : sessionCurrentVersion;
  const lamportTime = Number.isInteger(raw?.lamportTime) && (raw?.lamportTime ?? -1) >= 0
    ? Number(raw?.lamportTime)
    : Date.now();
  const clientId = typeof raw?.clientId === "string" && raw.clientId.trim().length > 0
    ? raw.clientId.trim()
    : "legacy_client";
  const batchId = typeof raw?.batchId === "string" && raw.batchId.trim().length > 0
    ? raw.batchId.trim()
    : undefined;
  const batchIndex = Number.isInteger(raw?.batchIndex) && Number(raw?.batchIndex) >= 0
    ? Number(raw?.batchIndex)
    : undefined;
  const batchSize = Number.isInteger(raw?.batchSize) && Number(raw?.batchSize) > 0
    ? Number(raw?.batchSize)
    : undefined;
  const batchLabel = typeof raw?.batchLabel === "string" && raw.batchLabel.trim().length > 0
    ? raw.batchLabel.trim()
    : undefined;
  return { operationId, baseVersion, lamportTime, clientId, batchId, batchIndex, batchSize, batchLabel };
};

const assertSessionAccess = async (sessionId: number, userId: number): Promise<number> => {
  const sessionVersion = await findSessionCurrentVersion(sessionId);
  if (sessionVersion === null) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const session = await dbPool.query<Array<{ status: number; is_paused: number } & RowDataPacket>>(
    "SELECT status, is_paused FROM sessions WHERE id = ? LIMIT 1",
    [sessionId]
  );
  const status = session[0]?.[0]?.status ?? 1;
  const isPaused = (session[0]?.[0]?.is_paused ?? 0) === 1;
  const member = await findSessionMember(sessionId, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (status !== 1) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "会话已结束，不能编辑画布");
  }
  if (isPaused) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "画布已暂停编辑");
  }
  if (member.role === 0) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "只读成员无编辑权限");
  }
  // 返回当前版本，供后续生成默认 baseVersion。
  return sessionVersion;
};

const markRedoHistoryAsInvalid = async (connection: PoolConnection, userId: number, sessionId: number): Promise<void> => {
  // 出现新操作后，旧的 redo 链需要全部失效。
  await connection.execute(
    "UPDATE user_operation_history SET can_redo = 0 WHERE user_id = ? AND session_id = ? AND can_redo = 1",
    [userId, sessionId]
  );
};

const insertUserOperationHistory = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number,
  operationRecordId: number
): Promise<void> => {
  // 记录用户历史，供后续 undo/redo 定位最近可操作项。
  await connection.execute(
    "INSERT INTO user_operation_history (user_id, session_id, operation_id, undo_operation_id, can_undo, can_redo) VALUES (?, ?, ?, NULL, 1, 0)",
    [userId, sessionId, operationRecordId]
  );
};

const updateFieldVersions = async (
  connection: PoolConnection,
  sessionId: number,
  objectKey: string,
  userId: number,
  clientId: string,
  lamportTime: number,
  serverVersion: number,
  fields: string[]
): Promise<void> => {
  // CRDT 字段级版本推进，支撑并发冲突合并策略。
  await upsertGraphicFieldVersionsBatch(
    fields.map((fieldName) => ({
      sessionId,
      objectKey,
      fieldName,
      lamportTime,
      serverVersion,
      clientId,
      updatedBy: userId
    })),
    connection
  );
};

const toUpdatePatch = (graphic: GraphicVO): UpdateGraphicDTO => ({
  positionX: graphic.positionX,
  positionY: graphic.positionY,
  width: graphic.width ?? undefined,
  height: graphic.height ?? undefined,
  strokeColor: graphic.strokeColor,
  lineStyle: graphic.lineStyle,
  fillColor: graphic.fillColor ?? undefined,
  strokeWidth: graphic.strokeWidth,
  textContent: graphic.textContent ?? undefined,
  fontSize: graphic.fontSize ?? undefined,
  pathPoints: graphic.pathPoints ?? undefined,
  isLocked: graphic.isLocked,
  rotation: graphic.rotation,
  zIndex: graphic.zIndex
});

const getGraphicFieldValue = (graphic: GraphicVO, fieldName: string): unknown => {
  return (toUpdatePatch(graphic) as Record<string, unknown>)[fieldName];
};

const toSessionOperationItemVO = (row: OperationRow): SessionOperationItemVO => {
  return {
    id: row.id,
    ...(typeof row.operation_id === "string" && row.operation_id.length > 0 ? { operationId: row.operation_id } : {}),
    sessionId: row.session_id,
    userId: row.user_id,
    objectKey: row.object_key,
    operationType: row.operation_type,
    operationData: toObject(row.operation_data),
    baseVersion: toNumber(row.base_version),
    serverVersion: toNumber(row.server_version, toNumber(row.version)),
    lamportTime: toNumber(row.lamport_time),
    ...(typeof row.client_id === "string" && row.client_id.length > 0 ? { clientId: row.client_id } : {}),
    ...(typeof row.batch_id === "string" && row.batch_id.length > 0 ? { batchId: row.batch_id } : {}),
    ...(typeof row.batch_index !== "undefined" && row.batch_index !== null ? { batchIndex: toNumber(row.batch_index) } : {}),
    ...(typeof row.batch_size !== "undefined" && row.batch_size !== null ? { batchSize: toNumber(row.batch_size) } : {}),
    ...(typeof row.batch_label === "string" && row.batch_label.length > 0 ? { batchLabel: row.batch_label } : {}),
    ...(isRecord(row.resolved_result) || typeof row.resolved_result === "string"
      ? { resolvedResult: toObject(row.resolved_result) }
      : {}),
    conflictType: row.conflict_type,
    timestamp: toNumber(row.timestamp)
  };
};

const toIsoString = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const toUnknownJson = (value: unknown): unknown => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch (_error) {
      return value;
    }
  }
  return value;
};

const toSessionConflictLogItemVO = (row: ConflictLogRow): SessionConflictLogItemVO => {
  return {
    id: row.id,
    ...(typeof row.operation_ref_id === "number" ? { operationRefId: row.operation_ref_id } : {}),
    ...(typeof row.operation_id === "string" && row.operation_id.length > 0 ? { operationId: row.operation_id } : {}),
    sessionId: row.session_id,
    objectKey: row.object_key,
    conflictType: row.conflict_type,
    ...(typeof row.field_name === "string" && row.field_name.length > 0 ? { fieldName: row.field_name } : {}),
    ...(typeof row.current_value !== "undefined" && row.current_value !== null
      ? { currentValue: toUnknownJson(row.current_value) }
      : {}),
    ...(typeof row.incoming_value !== "undefined" && row.incoming_value !== null
      ? { incomingValue: toUnknownJson(row.incoming_value) }
      : {}),
    ...(typeof row.resolved_value !== "undefined" && row.resolved_value !== null
      ? { resolvedValue: toUnknownJson(row.resolved_value) }
      : {}),
    resolveStrategy: row.resolve_strategy,
    createdAt: toIsoString(row.created_at)
  };
};

const toSessionSnapshotItemVO = (row: CanvasSnapshotRow): SessionSnapshotItemVO => {
  return {
    id: row.id,
    sessionId: row.session_id,
    version: toNumber(row.version),
    ...(typeof row.snapshot_name === "string" && row.snapshot_name.trim().length > 0 ? { snapshotName: row.snapshot_name } : {}),
    graphicCount: toNumber(row.graphic_count),
    ...(typeof row.created_by === "number" ? { createdBy: row.created_by } : {}),
    ...(typeof row.created_by_name === "string" && row.created_by_name.trim().length > 0
      ? { createdByName: row.created_by_name }
      : {}),
    createdAt: toIsoString(row.created_at)
  };
};

const insertOperationAndHistory = async (
  connection: PoolConnection,
  input: {
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
    batchId?: string;
    batchIndex?: number;
    batchSize?: number;
    batchLabel?: string;
    resolvedResult: Record<string, unknown>;
    conflictType: ConflictType;
  },
  options?: OperationWriteOptions
): Promise<number> => {
  // 保证 operation 与历史记录在同一事务中写入，避免链路断裂。
  const operationRecordId = await insertOperationRecord(input, connection);
  if (options?.skipUserHistory) {
    return operationRecordId;
  }
  await markRedoHistoryAsInvalid(connection, input.userId, input.sessionId);
  await insertUserOperationHistory(connection, input.userId, input.sessionId, operationRecordId);
  return operationRecordId;
};

const createGraphic = async (
  sessionId: number,
  userId: number,
  data: CreateGraphicDTO,
  meta?: OperationMeta,
  options?: OperationWriteOptions
): Promise<OperationApplyResult> => {
  const metricStart = perfNow();
  let metricPayload: PerfMetricPayload = { sessionId, result: "ok" };
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "create_graphic", data.objectKey, meta);
  // 先做 Redis 侧幂等锁，减少重复请求冲击数据库。
  const dedupeState = await tryAcquireOpDedupe(normalizedMeta.operationId).catch(() => "disabled" as const);
  const dedupeOwned = dedupeState === "acquired";
    if (dedupeState === "exists") {
      const duplicated = await waitDuplicatedOperation(sessionId, normalizedMeta.operationId);
      if (duplicated) {
        metricPayload = { ...metricPayload, dedupe: "redis_exists", duplicateHit: true, result: "duplicate" };
        return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, data.objectKey, "create_graphic");
      }
    }

  const existing = await findGraphicByObjectKey(sessionId, data.objectKey, true);
  if (existing && existing.is_deleted === 0) {
    if (dedupeOwned) {
      await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    throw new OperationServiceError("GRAPHIC_EXISTS", "图形对象已存在");
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    // 再做数据库侧二次幂等校验，兜住 Redis 异常场景。
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      metricPayload = { ...metricPayload, dedupe: "db_exists", duplicateHit: true, result: "duplicate" };
      return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, data.objectKey, "create_graphic");
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    let graphicId: number;
    if (existing && existing.is_deleted === 1) {
      // 同 objectKey 的软删除对象允许“复活”，保证 objectKey 语义稳定。
      await connection.execute(
        `UPDATE graphic_objects
         SET is_deleted = 0, deleted_version = NULL, deleted_by = NULL, deleted_at = NULL,
             object_type = ?, position_x = ?, position_y = ?, width = ?, height = ?,
             stroke_color = ?, line_style = ?, fill_color = ?, stroke_width = ?, text_content = ?, font_size = ?, path_points = ?, is_locked = ?, rotation = ?,
             z_index = ?, version = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          data.objectType,
          data.positionX,
          data.positionY,
          data.width ?? null,
          data.height ?? null,
          data.strokeColor,
          data.lineStyle === "dashed" ? "dashed" : "solid",
          data.fillColor ?? null,
          data.strokeWidth,
          data.textContent ?? null,
          data.fontSize ?? null,
          data.pathPoints ? JSON.stringify(data.pathPoints) : null,
          data.isLocked === true ? 1 : 0,
          typeof data.rotation === "number" ? data.rotation : 0,
          data.zIndex,
          nextVersion,
          existing.id
        ]
      );
      graphicId = existing.id;
    } else {
      graphicId = await insertGraphicObject(
        {
          sessionId,
          objectKey: data.objectKey,
          objectType: data.objectType,
          positionX: data.positionX,
          positionY: data.positionY,
          width: data.width ?? null,
          height: data.height ?? null,
          strokeColor: data.strokeColor,
          lineStyle: data.lineStyle === "dashed" ? "dashed" : "solid",
          fillColor: data.fillColor ?? null,
          strokeWidth: data.strokeWidth,
          textContent: data.textContent ?? null,
          fontSize: data.fontSize ?? null,
          pathPoints: data.pathPoints ? JSON.stringify(data.pathPoints) : null,
          isLocked: data.isLocked === true,
          rotation: typeof data.rotation === "number" ? data.rotation : 0,
          zIndex: data.zIndex,
          version: nextVersion,
          creatorId: userId
        },
        connection
      );
    }

    const createdRow = await findGraphicById(graphicId, connection);
    if (!createdRow) {
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
    }
    const createdGraphic = crdtMergeService.toGraphicVO(createdRow);
    const allFields = CRDT_FIELD_NAMES.map((item) => item as string);
    // 创建对象默认视为所有字段都已被本次操作写入。
    await updateFieldVersions(
      connection,
      sessionId,
      createdGraphic.objectKey,
      userId,
      normalizedMeta.clientId,
      normalizedMeta.lamportTime,
      nextVersion,
      allFields
    );

    const resolvedResult = {
      operationType: "create_graphic",
      graphic: createdGraphic,
      appliedFields: allFields
    };
    const operationRecordId = await insertOperationAndHistory(connection, {
      operationId: normalizedMeta.operationId,
      sessionId,
      userId,
      objectKey: createdGraphic.objectKey,
      operationType: "create",
      operationData: { ...data },
      baseVersion: normalizedMeta.baseVersion,
      serverVersion: nextVersion,
      lamportTime: normalizedMeta.lamportTime,
      clientId: normalizedMeta.clientId,
      batchId: normalizedMeta.batchId,
      batchIndex: normalizedMeta.batchIndex,
      batchSize: normalizedMeta.batchSize,
      batchLabel: normalizedMeta.batchLabel,
      resolvedResult,
      conflictType: "none"
    }, options);

    await connection.commit();
    await invalidateSessionGraphicsCache(sessionId).catch(() => {
      // ignore redis cache error
    });
    if (dedupeOwned) {
      await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    return {
      graphic: createdGraphic,
      operationRecordId,
      resolved: {
        operationId: normalizedMeta.operationId,
        objectKey: createdGraphic.objectKey,
        operationType: "create_graphic",
        serverVersion: nextVersion,
        conflictType: "none",
        appliedFields: allFields,
        rejectedFields: [],
        resolveReason: "created"
      }
    };
  } catch (error) {
    await connection.rollback();
    if (isDuplicateEntryError(error)) {
      const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId).catch(() => null);
      if (duplicated) {
        if (dedupeOwned) {
          await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
            // ignore redis failure
          });
        }
        metricPayload = { ...metricPayload, dedupe: "db_unique_fallback", duplicateHit: true, result: "duplicate" };
        return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, data.objectKey, "create_graphic");
      }
    }
    if (dedupeOwned) {
      await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    metricPayload = { ...metricPayload, result: "error" };
    throw error;
  } finally {
    logPerfMetric("operation.createGraphic", {
      ...metricPayload,
      durationMs: perfNow() - metricStart
    });
    connection.release();
  }
};

const updateGraphic = async (
  sessionId: number,
  userId: number,
  objectKey: string,
  patch: UpdateGraphicDTO,
  meta?: OperationMeta,
  options?: OperationWriteOptions
): Promise<OperationApplyResult> => {
  const metricStart = perfNow();
  let metricPayload: PerfMetricPayload = { sessionId, result: "ok" };
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "update_graphic", objectKey, meta);
  // 更新操作同样使用 operationId 去重，避免前端重试造成重复写入。
  const dedupeState = await tryAcquireOpDedupe(normalizedMeta.operationId).catch(() => "disabled" as const);
  const dedupeOwned = dedupeState === "acquired";
  if (dedupeState === "exists") {
    const duplicated = await waitDuplicatedOperation(sessionId, normalizedMeta.operationId);
    if (duplicated) {
      metricPayload = { ...metricPayload, dedupe: "redis_exists", duplicateHit: true, result: "duplicate" };
      return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "update_graphic");
    }
  }
  const patchKeys = Object.keys(patch).filter((item) => typeof (patch as Record<string, unknown>)[item] !== "undefined");
  if (patchKeys.length === 0) {
    if (dedupeOwned) {
      await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    throw new OperationServiceError("INVALID_ARGUMENT", "更新参数不能为空");
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      metricPayload = { ...metricPayload, dedupe: "db_exists", duplicateHit: true, result: "duplicate" };
      return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "update_graphic");
    }

    const target = await findGraphicByObjectKey(sessionId, objectKey, true, connection);
    if (!target) {
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
    }
    if (target.is_deleted === 1) {
      // 对象已被并发删除时，按 tombstone 规则拒绝更新并记录冲突。
      const beforeGraphic = crdtMergeService.toGraphicVO(target);
      const nextVersion = await incrementSessionVersion(sessionId, connection);
      if (nextVersion === null) {
        throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
      }
      const resolvedResult = {
        operationType: "update_graphic",
        objectKey,
        beforeGraphic,
        appliedFields: [],
        rejectedFields: patchKeys,
        resolveReason: "delete_tombstone_blocked_update"
      };
      const operationRecordId = await insertOperationAndHistory(connection, {
        operationId: normalizedMeta.operationId,
        sessionId,
        userId,
        objectKey,
        operationType: "update",
        operationData: { ...patch },
        baseVersion: normalizedMeta.baseVersion,
        serverVersion: nextVersion,
        lamportTime: normalizedMeta.lamportTime,
        clientId: normalizedMeta.clientId,
        batchId: normalizedMeta.batchId,
        batchIndex: normalizedMeta.batchIndex,
        batchSize: normalizedMeta.batchSize,
        batchLabel: normalizedMeta.batchLabel,
        resolvedResult,
        conflictType: "delete_wins"
      }, options);

      await insertConflictLogsBatch(
        patchKeys.map((fieldName) => ({
          operationRefId: operationRecordId,
          operationId: normalizedMeta.operationId,
          sessionId,
          objectKey,
          conflictType: "delete_wins" as const,
          fieldName,
          currentValue: getGraphicFieldValue(beforeGraphic, fieldName),
          incomingValue: (patch as Record<string, unknown>)[fieldName],
          resolvedValue: null,
          resolveStrategy: "delete_wins_tombstone"
        })),
        connection
      );

      await connection.commit();
      return {
        operationRecordId,
        resolved: {
          operationId: normalizedMeta.operationId,
          objectKey,
          operationType: "update_graphic",
          serverVersion: nextVersion,
          conflictType: "delete_wins",
          appliedFields: [],
          rejectedFields: patchKeys,
          resolveReason: "delete_tombstone_blocked_update"
        }
      };
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    const mergeResult = await crdtMergeService.mergeUpdatePatch(
      {
        sessionId,
        objectKey,
        userId,
        operationId: normalizedMeta.operationId,
        baseVersion: normalizedMeta.baseVersion,
        lamportTime: normalizedMeta.lamportTime,
        clientId: normalizedMeta.clientId,
        nextVersion
      },
      patch,
      connection
    );

    await updateGraphicObjectById(
      mergeResult.targetGraphic.id,
      {
        positionX: mergeResult.mergedPatch.positionX,
        positionY: mergeResult.mergedPatch.positionY,
        width: typeof mergeResult.mergedPatch.width === "number" || mergeResult.mergedPatch.width === null
          ? mergeResult.mergedPatch.width
          : undefined,
        height: typeof mergeResult.mergedPatch.height === "number" || mergeResult.mergedPatch.height === null
          ? mergeResult.mergedPatch.height
          : undefined,
        strokeColor: mergeResult.mergedPatch.strokeColor,
        lineStyle: typeof mergeResult.mergedPatch.lineStyle === "string" ? mergeResult.mergedPatch.lineStyle : undefined,
        fillColor: typeof mergeResult.mergedPatch.fillColor === "string" || mergeResult.mergedPatch.fillColor === null
          ? mergeResult.mergedPatch.fillColor
          : undefined,
        strokeWidth: mergeResult.mergedPatch.strokeWidth,
        textContent: typeof mergeResult.mergedPatch.textContent === "string" || mergeResult.mergedPatch.textContent === null
          ? mergeResult.mergedPatch.textContent
          : undefined,
        fontSize: typeof mergeResult.mergedPatch.fontSize === "number" || mergeResult.mergedPatch.fontSize === null
          ? mergeResult.mergedPatch.fontSize
          : undefined,
        pathPoints: Array.isArray(mergeResult.mergedPatch.pathPoints)
          ? JSON.stringify(mergeResult.mergedPatch.pathPoints)
          : mergeResult.mergedPatch.pathPoints === null
            ? null
            : undefined,
        isLocked: typeof mergeResult.mergedPatch.isLocked === "boolean" ? mergeResult.mergedPatch.isLocked : undefined,
        rotation: typeof mergeResult.mergedPatch.rotation === "number" ? mergeResult.mergedPatch.rotation : undefined,
        zIndex: mergeResult.mergedPatch.zIndex
      },
      nextVersion,
      connection
    );

    const updatedRow = await findGraphicById(mergeResult.targetGraphic.id, connection);
    if (!updatedRow) {
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
    }
    const updatedGraphic = crdtMergeService.toGraphicVO(updatedRow);

    await updateFieldVersions(
      connection,
      sessionId,
      objectKey,
      userId,
      normalizedMeta.clientId,
      normalizedMeta.lamportTime,
      nextVersion,
      mergeResult.appliedFields
    );

    const beforeGraphic = crdtMergeService.toGraphicVO(mergeResult.targetGraphic);
    const resolvedResult = {
      operationType: "update_graphic",
      beforeGraphic,
      graphic: updatedGraphic,
      appliedFields: mergeResult.appliedFields,
      rejectedFields: mergeResult.rejectedFields
    };
    const operationRecordId = await insertOperationAndHistory(connection, {
      operationId: normalizedMeta.operationId,
      sessionId,
      userId,
      objectKey,
      operationType: "update",
      operationData: { ...patch },
      baseVersion: normalizedMeta.baseVersion,
      serverVersion: nextVersion,
      lamportTime: normalizedMeta.lamportTime,
      clientId: normalizedMeta.clientId,
      batchId: normalizedMeta.batchId,
      batchIndex: normalizedMeta.batchIndex,
      batchSize: normalizedMeta.batchSize,
      batchLabel: normalizedMeta.batchLabel,
      resolvedResult,
      conflictType: mergeResult.conflictType
    }, options);

    if (mergeResult.conflictType !== "none" || mergeResult.rejectedFields.length > 0) {
      // 字段冲突会写入 conflict_logs，便于后续排查“谁覆盖了谁”。
      await insertConflictLogsBatch(
        mergeResult.rejectedFields.map((fieldName) => ({
          operationRefId: operationRecordId,
          operationId: normalizedMeta.operationId,
          sessionId,
          objectKey,
          conflictType: mergeResult.conflictType,
          fieldName,
          currentValue: getGraphicFieldValue(beforeGraphic, fieldName),
          incomingValue: (patch as Record<string, unknown>)[fieldName],
          resolvedValue: getGraphicFieldValue(updatedGraphic, fieldName),
          resolveStrategy: "lamport_then_client_id"
        })),
        connection
      );
    }

    await connection.commit();
    await invalidateSessionGraphicsCache(sessionId).catch(() => {
      // ignore redis cache error
    });
    if (dedupeOwned) {
      await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    return {
      graphic: updatedGraphic,
      operationRecordId,
      resolved: {
        operationId: normalizedMeta.operationId,
        objectKey,
        operationType: "update_graphic",
        serverVersion: nextVersion,
        conflictType: mergeResult.conflictType,
        appliedFields: mergeResult.appliedFields,
        rejectedFields: mergeResult.rejectedFields,
        resolveReason: mergeResult.resolveReason
      }
    };
  } catch (error) {
    await connection.rollback();
    if (isDuplicateEntryError(error)) {
      const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId).catch(() => null);
      if (duplicated) {
        if (dedupeOwned) {
          await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
            // ignore redis failure
          });
        }
        metricPayload = { ...metricPayload, dedupe: "db_unique_fallback", duplicateHit: true, result: "duplicate" };
        return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "update_graphic");
      }
    }
    if (error instanceof CrdtMergeServiceError) {
      if (dedupeOwned) {
        await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
          // ignore redis failure
        });
      }
      if (error.code === "GRAPHIC_NOT_FOUND") {
        throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象已删除");
    }
    if (dedupeOwned) {
      await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    metricPayload = { ...metricPayload, result: "error" };
    throw error;
  } finally {
    logPerfMetric("operation.updateGraphic", {
      ...metricPayload,
      patchFieldCount: patchKeys.length,
      durationMs: perfNow() - metricStart
    });
    connection.release();
  }
};

const deleteGraphic = async (
  sessionId: number,
  userId: number,
  objectKey: string,
  meta?: OperationMeta,
  options?: OperationWriteOptions
): Promise<OperationApplyResult> => {
  const metricStart = perfNow();
  let metricPayload: PerfMetricPayload = { sessionId, result: "ok" };
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "delete_graphic", objectKey, meta);
  // 删除也要幂等：重复删除不应反复推进版本。
  const dedupeState = await tryAcquireOpDedupe(normalizedMeta.operationId).catch(() => "disabled" as const);
  const dedupeOwned = dedupeState === "acquired";
  if (dedupeState === "exists") {
    const duplicated = await waitDuplicatedOperation(sessionId, normalizedMeta.operationId);
    if (duplicated) {
      metricPayload = { ...metricPayload, dedupe: "redis_exists", duplicateHit: true, result: "duplicate" };
      return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "delete_graphic");
    }
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      metricPayload = { ...metricPayload, dedupe: "db_exists", duplicateHit: true, result: "duplicate" };
      return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "delete_graphic");
    }

    const target = await findGraphicByObjectKey(sessionId, objectKey, true, connection);
    if (!target) {
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
    }
    if (target.is_deleted === 1) {
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    await softDeleteGraphicById(target.id, nextVersion, connection);
    // 额外记录删除版本与操作者，方便版本回放与审计。
    await connection.execute(
      `UPDATE graphic_objects
       SET deleted_version = ?, deleted_by = ?, deleted_at = NOW()
       WHERE id = ?`,
      [nextVersion, userId, target.id]
    );

    const deletedGraphic = crdtMergeService.toGraphicVO(target);
    const resolvedResult = {
      operationType: "delete_graphic",
      objectKey,
      deletedGraphic
    };
    const operationRecordId = await insertOperationAndHistory(connection, {
      operationId: normalizedMeta.operationId,
      sessionId,
      userId,
      objectKey,
      operationType: "delete",
      operationData: { objectKey },
      baseVersion: normalizedMeta.baseVersion,
      serverVersion: nextVersion,
      lamportTime: normalizedMeta.lamportTime,
      clientId: normalizedMeta.clientId,
      batchId: normalizedMeta.batchId,
      batchIndex: normalizedMeta.batchIndex,
      batchSize: normalizedMeta.batchSize,
      batchLabel: normalizedMeta.batchLabel,
      resolvedResult,
      conflictType: "none"
    }, options);

    await connection.commit();
    await invalidateSessionGraphicsCache(sessionId).catch(() => {
      // ignore redis cache error
    });
    if (dedupeOwned) {
      await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    return {
      deletedObjectKey: objectKey,
      operationRecordId,
      resolved: {
        operationId: normalizedMeta.operationId,
        objectKey,
        operationType: "delete_graphic",
        serverVersion: nextVersion,
        conflictType: "none",
        appliedFields: ["delete"],
        rejectedFields: [],
        resolveReason: "deleted"
      }
    };
  } catch (error) {
    await connection.rollback();
    if (isDuplicateEntryError(error)) {
      const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId).catch(() => null);
      if (duplicated) {
        if (dedupeOwned) {
          await markOpDedupeDone(normalizedMeta.operationId).catch(() => {
            // ignore redis failure
          });
        }
        metricPayload = { ...metricPayload, dedupe: "db_unique_fallback", duplicateHit: true, result: "duplicate" };
        return buildDuplicateApplyResult(duplicated, normalizedMeta.operationId, objectKey, "delete_graphic");
      }
    }
    if (dedupeOwned) {
      await releaseOpDedupe(normalizedMeta.operationId).catch(() => {
        // ignore redis failure
      });
    }
    metricPayload = { ...metricPayload, result: "error" };
    throw error;
  } finally {
    logPerfMetric("operation.deleteGraphic", {
      ...metricPayload,
      durationMs: perfNow() - metricStart
    });
    connection.release();
  }
};

const getSessionOperationsBySessionKey = async (
  sessionKey: string,
  userId: number,
  sinceVersion: number
): Promise<SessionOperationsSyncVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }

  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  const operations = await findOperationsBySessionSinceVersion(session.id, sinceVersion);
  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    sinceVersion,
    currentVersion: toNumber(session.current_version),
    operations: operations.map(toSessionOperationItemVO)
  };
};

const getSessionOperationTimelineBySessionKey = async (
  sessionKey: string,
  userId: number,
  query: SessionOperationTimelineQuery
): Promise<SessionOperationTimelineVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }

  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  if (
    typeof query.fromVersion === "number" &&
    typeof query.toVersion === "number" &&
    query.fromVersion > query.toVersion
  ) {
    throw new OperationServiceError("INVALID_ARGUMENT", "版本区间参数错误");
  }

  const page = Number.isInteger(query.page) && query.page > 0 ? query.page : 1;
  const pageSize = Number.isInteger(query.pageSize) && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;
  const offset = (page - 1) * pageSize;

  type RestoreAgg = {
    restoreClientId: string;
    sessionId: number;
    userId: number;
    baseVersion: number;
    targetVersion: number | null;
    restoredVersion: number;
    timestamp: number;
    createdCount: number;
    updatedCount: number;
    deletedCount: number;
  };

  const parseRestoreTargetVersion = (clientId: string): number | null => {
    const matched = clientId.match(/^restore_\d+_tv_(\d+)_/);
    if (!matched) {
      return null;
    }
    const parsed = Number(matched[1]);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const aggregateRestoreRows = (rows: OperationRow[]): RestoreAgg[] => {
    const groups = new Map<string, RestoreAgg>();
    rows.forEach((row) => {
      const rawClientId = typeof row.client_id === "string" ? row.client_id : "";
      const rawOperationId = typeof row.operation_id === "string" ? row.operation_id : "";
      const restoreClientId = rawClientId.startsWith("restore_")
        ? rawClientId
        : (rawOperationId.startsWith("rs_") ? `restore_by_op_${rawOperationId}` : "");
      if (!restoreClientId) {
        return;
      }
      const current = groups.get(restoreClientId);
      const createdInc = row.operation_type === "create" ? 1 : 0;
      const updatedInc = row.operation_type === "update" ? 1 : 0;
      const deletedInc = row.operation_type === "delete" ? 1 : 0;
      if (!current) {
        groups.set(restoreClientId, {
          restoreClientId,
          sessionId: row.session_id,
          userId: row.user_id,
          baseVersion: toNumber(row.base_version),
          targetVersion: parseRestoreTargetVersion(rawClientId),
          restoredVersion: toNumber(row.server_version, toNumber(row.version)),
          timestamp: toNumber(row.timestamp),
          createdCount: createdInc,
          updatedCount: updatedInc,
          deletedCount: deletedInc
        });
        return;
      }
      current.baseVersion = Math.min(current.baseVersion, toNumber(row.base_version));
      current.restoredVersion = Math.max(current.restoredVersion, toNumber(row.server_version, toNumber(row.version)));
      current.timestamp = Math.max(current.timestamp, toNumber(row.timestamp));
      current.createdCount += createdInc;
      current.updatedCount += updatedInc;
      current.deletedCount += deletedInc;
    });
    return Array.from(groups.values()).sort((a, b) => b.timestamp - a.timestamp);
  };

  const toRestoreTimelineVO = (items: RestoreAgg[], startIndex = 0): SessionOperationItemVO[] => {
    return items.map((item, idx) => ({
      id: -(startIndex + idx + 1),
      operationId: `restore_event_${item.restoreClientId}`,
      sessionId: item.sessionId,
      userId: item.userId,
      objectKey: "__restore_snapshot__",
      operationType: "update",
      operationData: {
        __systemEvent: "restore_version",
        ...(typeof item.targetVersion === "number" ? { targetVersion: item.targetVersion } : {}),
        previousVersion: item.baseVersion,
        restoredVersion: item.restoredVersion,
        createdCount: item.createdCount,
        updatedCount: item.updatedCount,
        deletedCount: item.deletedCount
      },
      baseVersion: item.baseVersion,
      serverVersion: item.restoredVersion,
      lamportTime: item.timestamp,
      clientId: "system_restore_event",
      resolvedResult: {},
      conflictType: "none",
      timestamp: item.timestamp
    }));
  };

  if (query.operationType === "restore") {
    const restoreRows = await findOperationsByTimelineQuery({
      sessionId: session.id,
      fromVersion: query.fromVersion,
      toVersion: query.toVersion,
      userId: query.userId,
      conflictType: query.conflictType,
      restoreFilter: "only",
      offset: 0,
      limit: 10000
    });
    const aggregated = aggregateRestoreRows(restoreRows);
    const paged = aggregated.slice(offset, offset + pageSize);
    const list = toRestoreTimelineVO(paged, offset);

    return {
      sessionId: session.id,
      sessionKey: session.session_key,
      currentVersion: toNumber(session.current_version),
      page,
      pageSize,
      total: aggregated.length,
      list
    };
  }

  if (typeof query.operationType === "undefined") {
    const [normalTotal, normalRows, restoreRows] = await Promise.all([
      countOperationsByTimelineQuery({
        sessionId: session.id,
        fromVersion: query.fromVersion,
        toVersion: query.toVersion,
        userId: query.userId,
        conflictType: query.conflictType,
        restoreFilter: "exclude",
        offset: 0,
        limit: pageSize
      }),
      findOperationsByTimelineQuery({
        sessionId: session.id,
        fromVersion: query.fromVersion,
        toVersion: query.toVersion,
        userId: query.userId,
        conflictType: query.conflictType,
        restoreFilter: "exclude",
        offset: 0,
        limit: 10000
      }),
      findOperationsByTimelineQuery({
        sessionId: session.id,
        fromVersion: query.fromVersion,
        toVersion: query.toVersion,
        userId: query.userId,
        conflictType: query.conflictType,
        restoreFilter: "only",
        offset: 0,
        limit: 10000
      })
    ]);

    const restoreAgg = aggregateRestoreRows(restoreRows);
    const restoreList = toRestoreTimelineVO(restoreAgg, 0);
    const normalList = normalRows.map(toSessionOperationItemVO);
    const merged = [...normalList, ...restoreList].sort((a, b) => b.timestamp - a.timestamp);
    const paged = merged.slice(offset, offset + pageSize);

    return {
      sessionId: session.id,
      sessionKey: session.session_key,
      currentVersion: toNumber(session.current_version),
      page,
      pageSize,
      total: normalTotal + restoreAgg.length,
      list: paged
    };
  }

  const [total, rows] = await Promise.all([
    countOperationsByTimelineQuery({
      sessionId: session.id,
      fromVersion: query.fromVersion,
      toVersion: query.toVersion,
      userId: query.userId,
      operationType: query.operationType,
      conflictType: query.conflictType,
      restoreFilter: "exclude",
      offset,
      limit: pageSize
    }),
    findOperationsByTimelineQuery({
      sessionId: session.id,
      fromVersion: query.fromVersion,
      toVersion: query.toVersion,
      userId: query.userId,
      operationType: query.operationType,
      conflictType: query.conflictType,
      restoreFilter: "exclude",
      offset,
      limit: pageSize
    })
  ]);

  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    currentVersion: toNumber(session.current_version),
    page,
    pageSize,
    total,
    list: rows.map(toSessionOperationItemVO)
  };
};

const getSessionConflictLogsBySessionKey = async (
  sessionKey: string,
  userId: number,
  sinceId: number,
  limit: number
): Promise<SessionConflictLogsVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }

  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  const safeSinceId = Number.isInteger(sinceId) && sinceId >= 0 ? sinceId : 0;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const rows = await findConflictLogsBySession(session.id, safeSinceId, safeLimit);
  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    sinceId: safeSinceId,
    limit: safeLimit,
    conflicts: rows.map(toSessionConflictLogItemVO)
  };
};

const createSessionSnapshotBySessionKey = async (
  sessionKey: string,
  userId: number,
  snapshotName?: string
): Promise<SessionSnapshotItemVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (member.role === 0) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "只读成员无创建快照权限");
  }

  const graphics = await findGraphicsBySessionId(session.id);
  const currentVersion = toNumber(session.current_version);
  const normalizedSnapshotName = typeof snapshotName === "string" && snapshotName.trim().length > 0
    ? snapshotName.trim()
    : `快照 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  const snapshotData = {
    sessionId: session.id,
    sessionKey: session.session_key,
    version: currentVersion,
    graphics
  };
  const snapshotId = await insertCanvasSnapshot({
    sessionId: session.id,
    version: currentVersion,
    snapshotName: normalizedSnapshotName,
    snapshotData,
    graphicCount: graphics.length,
    createdBy: userId
  });

  return {
    id: snapshotId,
    sessionId: session.id,
    version: currentVersion,
    snapshotName: normalizedSnapshotName,
    graphicCount: graphics.length,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
};

const getSessionSnapshotsBySessionKey = async (
  sessionKey: string,
  userId: number,
  limit: number
): Promise<SessionSnapshotsVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const rows = await findSnapshotsBySession(session.id, safeLimit);
  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    currentVersion: toNumber(session.current_version),
    snapshots: rows.map(toSessionSnapshotItemVO)
  };
};

const getSessionReplayByVersion = async (
  sessionKey: string,
  userId: number,
  targetVersion: number
): Promise<SessionReplayVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  const currentVersion = toNumber(session.current_version);
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > currentVersion) {
    throw new OperationServiceError("INVALID_ARGUMENT", "目标版本无效");
  }

  const baseSnapshotRow = await findLatestSnapshotBySessionAtOrBeforeVersion(session.id, targetVersion);
  const baseVersion = baseSnapshotRow ? toNumber(baseSnapshotRow.version) : 0;
  const operations = await findOperationsBySessionVersionRange(session.id, baseVersion, targetVersion);
  const baseSnapshotData = (() => {
    if (!baseSnapshotRow) {
      return undefined;
    }
    const parsed = toObject(baseSnapshotRow.snapshot_data);
    const version = toNumber(parsed.version, toNumber(baseSnapshotRow.version));
    const graphics = toObjectArray(parsed.graphics);
    return { version, graphics };
  })();
  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    targetVersion,
    ...(baseSnapshotRow ? { baseSnapshot: toSessionSnapshotItemVO(baseSnapshotRow) } : {}),
    ...(baseSnapshotData ? { baseSnapshotData } : {}),
    operations: operations.map(toSessionOperationItemVO)
  };
};

const getObjectValue = (value: unknown): Record<string, unknown> => {
  return isRecord(value) ? value : {};
};

const graphicToCreateDTO = (graphic: Record<string, unknown>): CreateGraphicDTO | null => {
  const objectKey = typeof graphic.objectKey === "string" ? graphic.objectKey : "";
  const objectTypeRaw = typeof graphic.objectType === "string" ? graphic.objectType : "line";
  if (!objectKey) {
    return null;
  }
  const objectType = (
    objectTypeRaw === "line" ||
    objectTypeRaw === "rect" ||
    objectTypeRaw === "circle" ||
    objectTypeRaw === "text" ||
    objectTypeRaw === "path" ||
    objectTypeRaw === "image"
  ) ? objectTypeRaw : "line";

  const pathPoints = Array.isArray(graphic.pathPoints)
    ? graphic.pathPoints
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    : undefined;

  return {
    objectKey,
    objectType,
    positionX: toNumber(graphic.positionX),
    positionY: toNumber(graphic.positionY),
    ...(typeof graphic.width === "number" ? { width: graphic.width } : {}),
    ...(typeof graphic.height === "number" ? { height: graphic.height } : {}),
    strokeColor: typeof graphic.strokeColor === "string" ? graphic.strokeColor : "#000000",
    ...(graphic.lineStyle === "dashed" || graphic.lineStyle === "solid" ? { lineStyle: graphic.lineStyle } : {}),
    ...(typeof graphic.fillColor === "string" ? { fillColor: graphic.fillColor } : {}),
    strokeWidth: toNumber(graphic.strokeWidth, 1),
    ...(typeof graphic.textContent === "string" ? { textContent: graphic.textContent } : {}),
    ...(typeof graphic.fontSize === "number" ? { fontSize: graphic.fontSize } : {}),
    ...(pathPoints && pathPoints.length > 0 ? { pathPoints } : {}),
    ...(typeof graphic.isLocked === "boolean" ? { isLocked: graphic.isLocked } : {}),
    ...(typeof graphic.rotation === "number" ? { rotation: graphic.rotation } : {}),
    zIndex: toNumber(graphic.zIndex)
  };
};

// 恢复版本需要支持把字段“清空”为 null，故这里使用宽松 patch 类型。
const graphicToUpdatePatch = (graphic: Record<string, unknown>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {
    positionX: toNumber(graphic.positionX),
    positionY: toNumber(graphic.positionY),
    strokeColor: typeof graphic.strokeColor === "string" ? graphic.strokeColor : "#000000",
    ...(graphic.lineStyle === "dashed" || graphic.lineStyle === "solid" ? { lineStyle: graphic.lineStyle } : {}),
    strokeWidth: toNumber(graphic.strokeWidth, 1),
    zIndex: toNumber(graphic.zIndex)
  };
  if (typeof graphic.width === "number") {
    patch.width = graphic.width;
  } else if (graphic.width === null) {
    patch.width = null;
  }
  if (typeof graphic.height === "number") {
    patch.height = graphic.height;
  } else if (graphic.height === null) {
    patch.height = null;
  }
  if (typeof graphic.fillColor === "string") {
    patch.fillColor = graphic.fillColor;
  } else if (graphic.fillColor === null) {
    patch.fillColor = null;
  }
  if (graphic.lineStyle === "dashed" || graphic.lineStyle === "solid") {
    patch.lineStyle = graphic.lineStyle;
  }
  if (typeof graphic.textContent === "string") {
    patch.textContent = graphic.textContent;
  } else if (graphic.textContent === null) {
    patch.textContent = null;
  }
  if (typeof graphic.fontSize === "number") {
    patch.fontSize = graphic.fontSize;
  } else if (graphic.fontSize === null) {
    patch.fontSize = null;
  }
  if (Array.isArray(graphic.pathPoints)) {
    patch.pathPoints = graphic.pathPoints
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  } else if (graphic.pathPoints === null) {
    patch.pathPoints = null;
  }
  if (typeof graphic.isLocked === "boolean") {
    patch.isLocked = graphic.isLocked;
  }
  if (typeof graphic.rotation === "number") {
    patch.rotation = graphic.rotation;
  }
  return patch;
};

const toComparableGraphicState = (graphic: Record<string, unknown>): Record<string, unknown> => {
  const objectTypeRaw = typeof graphic.objectType === "string" ? graphic.objectType : "line";
  const objectType = (
    objectTypeRaw === "line" ||
    objectTypeRaw === "rect" ||
    objectTypeRaw === "circle" ||
    objectTypeRaw === "text" ||
    objectTypeRaw === "path" ||
    objectTypeRaw === "image"
  ) ? objectTypeRaw : "line";
  const pathPoints = Array.isArray(graphic.pathPoints)
    ? graphic.pathPoints
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    : null;

  return {
    objectType,
    positionX: toNumber(graphic.positionX),
    positionY: toNumber(graphic.positionY),
    width: typeof graphic.width === "number" ? graphic.width : null,
    height: typeof graphic.height === "number" ? graphic.height : null,
    strokeColor: typeof graphic.strokeColor === "string" ? graphic.strokeColor : "#000000",
    lineStyle: graphic.lineStyle === "dashed" ? "dashed" : "solid",
    fillColor: typeof graphic.fillColor === "string" ? graphic.fillColor : null,
    strokeWidth: toNumber(graphic.strokeWidth, 1),
    textContent: typeof graphic.textContent === "string" ? graphic.textContent : null,
    fontSize: typeof graphic.fontSize === "number" ? graphic.fontSize : null,
    pathPoints,
    isLocked: graphic.isLocked === true || graphic.isLocked === 1,
    rotation: typeof graphic.rotation === "number" ? graphic.rotation : toNumber(graphic.rotation),
    zIndex: toNumber(graphic.zIndex)
  };
};

const normalizeObjectType = (value: unknown): "line" | "rect" | "circle" | "text" | "path" | "image" => {
  if (value === "rect" || value === "circle" || value === "text" || value === "path" || value === "image") {
    return value;
  }
  return "line";
};

const buildGraphicsMapByObjectKey = (graphics: Record<string, unknown>[]): Map<string, Record<string, unknown>> => {
  const map = new Map<string, Record<string, unknown>>();
  graphics.forEach((item) => {
    const objectKey = typeof item.objectKey === "string" ? item.objectKey : "";
    if (objectKey) {
      map.set(objectKey, item);
    }
  });
  return map;
};

const restoreSessionByVersion = async (
  sessionKey: string,
  userId: number,
  targetVersion: number
): Promise<SessionRestoreVersionVO> => {
  // 版本恢复属于高风险写操作：仅管理员/房主可执行，且会话必须可编辑。
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (session.status !== 1) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "会话已结束，不能编辑画布");
  }
  if (session.is_paused === 1) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "画布已暂停编辑");
  }
  if (member.role < 2) {
    throw new OperationServiceError("SESSION_FORBIDDEN", "仅管理员和房主可恢复历史版本");
  }
  const previousVersion = toNumber(session.current_version);
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > previousVersion) {
    throw new OperationServiceError("INVALID_ARGUMENT", "目标版本无效");
  }

  // 回放 targetVersion 的结果即“目标画布状态”。
  const replay = await getSessionReplayByVersion(sessionKey, userId, targetVersion);
  const replayMap = new Map<string, Record<string, unknown>>();
  const baseGraphics = replay.baseSnapshotData?.graphics ?? [];
  baseGraphics.forEach((item) => {
    const next = getObjectValue(item);
    const objectKey = typeof next.objectKey === "string" ? next.objectKey : "";
    if (objectKey) {
      replayMap.set(objectKey, next);
    }
  });
  replay.operations.forEach((op) => {
    if (op.operationType === "delete") {
      replayMap.delete(op.objectKey);
      return;
    }
    const resolvedGraphic = getObjectValue(op.resolvedResult?.graphic);
    const resolvedObjectKey = typeof resolvedGraphic.objectKey === "string" ? resolvedGraphic.objectKey : "";
    // 仅当 resolved graphic 携带有效 objectKey 时才直接采用，避免把空对象写入回放状态。
    if (resolvedObjectKey) {
      replayMap.set(resolvedObjectKey, resolvedGraphic);
      return;
    }
    const patch = getObjectValue(op.operationData);
    if (op.operationType === "create") {
      replayMap.set(op.objectKey, { objectKey: op.objectKey, ...patch });
      return;
    }
    const current = replayMap.get(op.objectKey);
    if (!current) {
      return;
    }
    replayMap.set(op.objectKey, { ...current, ...patch, objectKey: op.objectKey });
  });

  const targetGraphics = Array.from(replayMap.values());
  const currentGraphics = await findGraphicsBySessionId(session.id);
  const targetMap = buildGraphicsMapByObjectKey(targetGraphics);
  const currentMap = buildGraphicsMapByObjectKey(currentGraphics);

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  // 恢复过程中产生一批系统操作，用 restore_* 元信息统一标识。
  const restoreClientId = `restore_${session.id}_tv_${targetVersion}_${Date.now()}`;
  let lamport = Date.now();
  let restoreOpSeq = 0;
  const bumpLamport = (): number => {
    lamport += 1;
    return lamport;
  };
  const buildRestoreOperationId = (operationType: "create_graphic" | "update_graphic" | "delete_graphic"): string => {
    const opCode = operationType === "create_graphic" ? "c" : operationType === "update_graphic" ? "u" : "d";
    restoreOpSeq += 1;
    const seq = restoreOpSeq.toString(36);
    const compactRand = Math.random().toString(36).slice(2, 6);
    // 控制在 64 字符以内，避免写 operations.operation_id(varchar(64)) 报错。
    return `rs_${session.id}_${opCode}_${Date.now().toString(36)}_${seq}_${compactRand}`;
  };
  const nextMeta = (operationType: "create_graphic" | "update_graphic" | "delete_graphic", objectKey: string) => ({
    operationId: buildRestoreOperationId(operationType),
    clientId: restoreClientId,
    baseVersion: previousVersion,
    lamportTime: bumpLamport()
  });

  for (const [objectKey, targetGraphic] of targetMap) {
    const currentGraphic = currentMap.get(objectKey);
    if (!currentGraphic) {
      const createDTO = graphicToCreateDTO(targetGraphic);
      if (!createDTO) {
        continue;
      }
      await createGraphic(session.id, userId, createDTO, nextMeta("create_graphic", objectKey));
      createdCount += 1;
      continue;
    }

    // 图元类型发生变化时不能仅做 patch 更新（patch 不包含 objectType），
    // 需先删后建，确保真正恢复到目标版本的图元类型与结构。
    const currentObjectType = normalizeObjectType(currentGraphic.objectType);
    const targetObjectType = normalizeObjectType(targetGraphic.objectType);
    if (currentObjectType !== targetObjectType) {
      await deleteGraphic(session.id, userId, objectKey, nextMeta("delete_graphic", objectKey));
      const recreateDTO = graphicToCreateDTO({ ...targetGraphic, objectKey });
      if (recreateDTO) {
        await createGraphic(session.id, userId, recreateDTO, nextMeta("create_graphic", objectKey));
        createdCount += 1;
      }
      deletedCount += 1;
      continue;
    }

    const currentComparable = toComparableGraphicState(currentGraphic);
    const targetComparable = toComparableGraphicState(targetGraphic);
    if (JSON.stringify(currentComparable) === JSON.stringify(targetComparable)) {
      continue;
    }
    const nextPatch = graphicToUpdatePatch(targetGraphic);
    if (Object.keys(nextPatch).length === 0) {
      continue;
    }
    await updateGraphic(
      session.id,
      userId,
      objectKey,
      nextPatch as UpdateGraphicDTO,
      nextMeta("update_graphic", objectKey)
    );
    updatedCount += 1;
  }

  // 当前存在但目标版本不存在的对象，需要补删以达成状态一致。
  for (const [objectKey] of currentMap) {
    if (targetMap.has(objectKey)) {
      continue;
    }
    await deleteGraphic(session.id, userId, objectKey, nextMeta("delete_graphic", objectKey));
    deletedCount += 1;
  }

  const latestSession = await findSessionBySessionKey(sessionKey);
  const restoredVersion = latestSession ? toNumber(latestSession.current_version) : previousVersion;
  await invalidateSessionGraphicsCache(session.id).catch(() => {
    // ignore redis cache error
  });
  return {
    sessionId: session.id,
    sessionKey: session.session_key,
    targetVersion,
    previousVersion,
    restoredVersion,
    createdCount,
    updatedCount,
    deletedCount
  };
};

type GraphicSnapshotRow = RowDataPacket & {
  id: number;
  session_id: number;
  object_key: string;
  object_type: "line" | "rect" | "circle" | "text" | "path" | "image";
  position_x: number | string;
  position_y: number | string;
  width: number | string | null;
  height: number | string | null;
  stroke_color: string;
  line_style: "solid" | "dashed";
  fill_color: string | null;
  stroke_width: number | string;
  text_content: string | null;
  font_size: number | null;
  path_points: string | null;
  is_locked: number;
  rotation: number | string;
  z_index: number;
  version: number | string;
  creator_id: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const parsePathPoints = (value: unknown): Array<{ x: number; y: number }> | null => {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const points = value
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
    return points.length > 0 ? points : null;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return null;
    }
    try {
      return parsePathPoints(JSON.parse(value));
    } catch (_error) {
      return null;
    }
  }
  return null;
};

const findGraphicsBySessionId = async (sessionId: number): Promise<Record<string, unknown>[]> => {
  const [rows] = await dbPool.query<GraphicSnapshotRow[]>(
    `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
            stroke_color, line_style, fill_color, stroke_width, text_content, font_size, path_points, is_locked, rotation, z_index,
            version, creator_id, created_at, updated_at
     FROM graphic_objects
     WHERE session_id = ? AND is_deleted = 0
     ORDER BY z_index ASC, id ASC`,
    [sessionId]
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    objectKey: row.object_key,
    objectType: row.object_type,
    positionX: toNumber(row.position_x),
    positionY: toNumber(row.position_y),
    width: row.width === null ? null : toNumber(row.width),
    height: row.height === null ? null : toNumber(row.height),
    strokeColor: row.stroke_color,
    lineStyle: row.line_style === "dashed" ? "dashed" : "solid",
    fillColor: row.fill_color,
    strokeWidth: toNumber(row.stroke_width),
    textContent: row.text_content,
    fontSize: row.font_size,
    pathPoints: parsePathPoints(row.path_points),
    isLocked: row.is_locked === 1,
    rotation: toNumber(row.rotation),
    zIndex: row.z_index,
    version: toNumber(row.version),
    creatorId: row.creator_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  }));
};

export const operationService = {
  createGraphic,
  updateGraphic,
  deleteGraphic,
  getSessionOperationsBySessionKey,
  getSessionOperationTimelineBySessionKey,
  getSessionConflictLogsBySessionKey,
  createSessionSnapshotBySessionKey,
  getSessionSnapshotsBySessionKey,
  getSessionReplayByVersion
  ,
  restoreSessionByVersion
};
