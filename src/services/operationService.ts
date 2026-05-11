import { PoolConnection, RowDataPacket } from "mysql2/promise";

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
  insertConflictLog,
  insertOperationRecord,
  OperationRow,
  upsertGraphicFieldVersion
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

type DbOperationType = "create" | "update" | "delete";
type ConflictType = "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation";

type OperationMeta = {
  operationId?: string;
  baseVersion?: number;
  lamportTime?: number;
  clientId?: string;
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
): Required<OperationMeta> & { operationId: string } => {
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
  return { operationId, baseVersion, lamportTime, clientId };
};

const assertSessionAccess = async (sessionId: number, userId: number): Promise<number> => {
  const currentVersion = await findSessionCurrentVersion(sessionId);
  if (currentVersion === null) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(sessionId, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  return currentVersion;
};

const markRedoHistoryAsInvalid = async (connection: PoolConnection, userId: number, sessionId: number): Promise<void> => {
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
  for (const fieldName of fields) {
    await upsertGraphicFieldVersion(
      {
        sessionId,
        objectKey,
        fieldName,
        lamportTime,
        serverVersion,
        clientId,
        updatedBy: userId
      },
      connection
    );
  }
};

const toUpdatePatch = (graphic: GraphicVO): UpdateGraphicDTO => ({
  positionX: graphic.positionX,
  positionY: graphic.positionY,
  width: graphic.width ?? undefined,
  height: graphic.height ?? undefined,
  strokeColor: graphic.strokeColor,
  fillColor: graphic.fillColor ?? undefined,
  strokeWidth: graphic.strokeWidth,
  textContent: graphic.textContent ?? undefined,
  fontSize: graphic.fontSize ?? undefined,
  pathPoints: graphic.pathPoints ?? undefined,
  zIndex: graphic.zIndex
});

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
    graphicCount: toNumber(row.graphic_count),
    ...(typeof row.created_by === "number" ? { createdBy: row.created_by } : {}),
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
    resolvedResult: Record<string, unknown>;
    conflictType: ConflictType;
  },
  options?: OperationWriteOptions
): Promise<number> => {
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
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "create_graphic", data.objectKey, meta);

  const existing = await findGraphicByObjectKey(sessionId, data.objectKey, true);
  if (existing && existing.is_deleted === 0) {
    throw new OperationServiceError("GRAPHIC_EXISTS", "图形对象已存在");
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      return {
        operationRecordId: toNumber(duplicated.id),
        resolved: {
          operationId: normalizedMeta.operationId,
          objectKey: data.objectKey,
          operationType: "create_graphic",
          serverVersion: toNumber(duplicated.server_version, toNumber(duplicated.version)),
          conflictType: "duplicate_operation",
          appliedFields: [],
          rejectedFields: [],
          resolveReason: "duplicate_operation_ignored"
        }
      };
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    let graphicId: number;
    if (existing && existing.is_deleted === 1) {
      await connection.execute(
        `UPDATE graphic_objects
         SET is_deleted = 0, deleted_version = NULL, deleted_by = NULL, deleted_at = NULL,
             object_type = ?, position_x = ?, position_y = ?, width = ?, height = ?,
             stroke_color = ?, fill_color = ?, stroke_width = ?, text_content = ?, font_size = ?, path_points = ?,
             z_index = ?, version = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          data.objectType,
          data.positionX,
          data.positionY,
          data.width ?? null,
          data.height ?? null,
          data.strokeColor,
          data.fillColor ?? null,
          data.strokeWidth,
          data.textContent ?? null,
          data.fontSize ?? null,
          data.pathPoints ? JSON.stringify(data.pathPoints) : null,
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
          fillColor: data.fillColor ?? null,
          strokeWidth: data.strokeWidth,
          textContent: data.textContent ?? null,
          fontSize: data.fontSize ?? null,
          pathPoints: data.pathPoints ? JSON.stringify(data.pathPoints) : null,
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
      resolvedResult,
      conflictType: "none"
    }, options);

    await connection.commit();
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
    throw error;
  } finally {
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
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "update_graphic", objectKey, meta);
  const patchKeys = Object.keys(patch).filter((item) => typeof (patch as Record<string, unknown>)[item] !== "undefined");
  if (patchKeys.length === 0) {
    throw new OperationServiceError("INVALID_ARGUMENT", "更新参数不能为空");
  }

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      return {
        operationRecordId: toNumber(duplicated.id),
        resolved: {
          operationId: normalizedMeta.operationId,
          objectKey,
          operationType: "update_graphic",
          serverVersion: toNumber(duplicated.server_version, toNumber(duplicated.version)),
          conflictType: "duplicate_operation",
          appliedFields: [],
          rejectedFields: [],
          resolveReason: "duplicate_operation_ignored"
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
      resolvedResult,
      conflictType: mergeResult.conflictType
    }, options);

    if (mergeResult.conflictType !== "none" || mergeResult.rejectedFields.length > 0) {
      for (const fieldName of mergeResult.rejectedFields) {
        await insertConflictLog(
          {
            operationRefId: operationRecordId,
            operationId: normalizedMeta.operationId,
            sessionId,
            objectKey,
            conflictType: mergeResult.conflictType,
            fieldName,
            currentValue: (mergeResult.targetGraphic as unknown as Record<string, unknown>)[fieldName],
            incomingValue: (patch as Record<string, unknown>)[fieldName],
            resolvedValue: (toUpdatePatch(updatedGraphic) as Record<string, unknown>)[fieldName],
            resolveStrategy: "lamport_then_client_id"
          },
          connection
        );
      }
    }

    await connection.commit();
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
    if (error instanceof CrdtMergeServiceError) {
      if (error.code === "GRAPHIC_NOT_FOUND") {
        throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      throw new OperationServiceError("GRAPHIC_NOT_FOUND", "图形对象已删除");
    }
    throw error;
  } finally {
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
  const currentVersion = await assertSessionAccess(sessionId, userId);
  const normalizedMeta = normalizeMeta(currentVersion, "delete_graphic", objectKey, meta);

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const duplicated = await findOperationByOperationId(sessionId, normalizedMeta.operationId, connection);
    if (duplicated) {
      await connection.commit();
      return {
        operationRecordId: toNumber(duplicated.id),
        resolved: {
          operationId: normalizedMeta.operationId,
          objectKey,
          operationType: "delete_graphic",
          serverVersion: toNumber(duplicated.server_version, toNumber(duplicated.version)),
          conflictType: "duplicate_operation",
          appliedFields: [],
          rejectedFields: [],
          resolveReason: "duplicate_operation_ignored"
        }
      };
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
      resolvedResult,
      conflictType: "delete_wins"
    }, options);

    await connection.commit();
    return {
      deletedObjectKey: objectKey,
      operationRecordId,
      resolved: {
        operationId: normalizedMeta.operationId,
        objectKey,
        operationType: "delete_graphic",
        serverVersion: nextVersion,
        conflictType: "delete_wins",
        appliedFields: ["delete"],
        rejectedFields: [],
        resolveReason: "delete_tombstone_applied"
      }
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
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

  const [total, rows] = await Promise.all([
    countOperationsByTimelineQuery({
      sessionId: session.id,
      fromVersion: query.fromVersion,
      toVersion: query.toVersion,
      userId: query.userId,
      operationType: query.operationType,
      conflictType: query.conflictType,
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
  userId: number
): Promise<SessionSnapshotItemVO> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  const graphics = await findGraphicsBySessionId(session.id);
  const currentVersion = toNumber(session.current_version);
  const snapshotData = {
    sessionId: session.id,
    sessionKey: session.session_key,
    version: currentVersion,
    graphics
  };
  const snapshotId = await insertCanvasSnapshot({
    sessionId: session.id,
    version: currentVersion,
    snapshotData,
    graphicCount: graphics.length,
    createdBy: userId
  });

  return {
    id: snapshotId,
    sessionId: session.id,
    version: currentVersion,
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
    objectTypeRaw === "path"
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
    ...(typeof graphic.fillColor === "string" ? { fillColor: graphic.fillColor } : {}),
    strokeWidth: toNumber(graphic.strokeWidth, 1),
    ...(typeof graphic.textContent === "string" ? { textContent: graphic.textContent } : {}),
    ...(typeof graphic.fontSize === "number" ? { fontSize: graphic.fontSize } : {}),
    ...(pathPoints && pathPoints.length > 0 ? { pathPoints } : {}),
    zIndex: toNumber(graphic.zIndex)
  };
};

const graphicToUpdatePatch = (graphic: Record<string, unknown>): UpdateGraphicDTO => {
  const patch: UpdateGraphicDTO = {
    positionX: toNumber(graphic.positionX),
    positionY: toNumber(graphic.positionY),
    strokeColor: typeof graphic.strokeColor === "string" ? graphic.strokeColor : "#000000",
    strokeWidth: toNumber(graphic.strokeWidth, 1),
    zIndex: toNumber(graphic.zIndex)
  };
  if (typeof graphic.width === "number") {
    patch.width = graphic.width;
  }
  if (typeof graphic.height === "number") {
    patch.height = graphic.height;
  }
  if (typeof graphic.fillColor === "string") {
    patch.fillColor = graphic.fillColor;
  }
  if (typeof graphic.textContent === "string") {
    patch.textContent = graphic.textContent;
  }
  if (typeof graphic.fontSize === "number") {
    patch.fontSize = graphic.fontSize;
  }
  if (Array.isArray(graphic.pathPoints)) {
    patch.pathPoints = graphic.pathPoints
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  }
  return patch;
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
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new OperationServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(session.id, userId);
  if (!member || member.membership_status !== "active") {
    throw new OperationServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  const previousVersion = toNumber(session.current_version);
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > previousVersion) {
    throw new OperationServiceError("INVALID_ARGUMENT", "目标版本无效");
  }

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
    const key = typeof resolvedGraphic.objectKey === "string" ? resolvedGraphic.objectKey : op.objectKey;
    if (key) {
      replayMap.set(key, resolvedGraphic);
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

  const restoreClientId = `restore_${session.id}_${Date.now()}`;
  let lamport = Date.now();
  const bumpLamport = (): number => {
    lamport += 1;
    return lamport;
  };
  const nextMeta = (operationType: "create_graphic" | "update_graphic" | "delete_graphic", objectKey: string) => ({
    operationId: `${operationType}_${objectKey}_restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

    const currentSerialized = JSON.stringify(currentGraphic);
    const targetSerialized = JSON.stringify(targetGraphic);
    if (currentSerialized === targetSerialized) {
      continue;
    }
    await updateGraphic(
      session.id,
      userId,
      objectKey,
      graphicToUpdatePatch(targetGraphic),
      nextMeta("update_graphic", objectKey)
    );
    updatedCount += 1;
  }

  for (const [objectKey] of currentMap) {
    if (targetMap.has(objectKey)) {
      continue;
    }
    await deleteGraphic(session.id, userId, objectKey, nextMeta("delete_graphic", objectKey));
    deletedCount += 1;
  }

  const latestSession = await findSessionBySessionKey(sessionKey);
  const restoredVersion = latestSession ? toNumber(latestSession.current_version) : previousVersion;
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
  object_type: "line" | "rect" | "circle" | "text" | "path";
  position_x: number | string;
  position_y: number | string;
  width: number | string | null;
  height: number | string | null;
  stroke_color: string;
  fill_color: string | null;
  stroke_width: number | string;
  text_content: string | null;
  font_size: number | null;
  path_points: string | null;
  z_index: number;
  version: number | string;
  creator_id: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const parsePathPoints = (value: unknown): Array<{ x: number; y: number }> | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const points = parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
    return points.length > 0 ? points : null;
  } catch (_error) {
    return null;
  }
};

const findGraphicsBySessionId = async (sessionId: number): Promise<Record<string, unknown>[]> => {
  const [rows] = await dbPool.query<GraphicSnapshotRow[]>(
    `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
            stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
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
    fillColor: row.fill_color,
    strokeWidth: toNumber(row.stroke_width),
    textContent: row.text_content,
    fontSize: row.font_size,
    pathPoints: parsePathPoints(row.path_points),
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
