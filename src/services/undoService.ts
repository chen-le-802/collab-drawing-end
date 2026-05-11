import { PoolConnection, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";
import { findSessionCurrentVersion } from "../models/graphicModel";
import { findSessionMember } from "../models/sessionModel";
import { CollaborativeOperationType, GraphicVO, OperationVO } from "../types";
import { operationService, OperationServiceError } from "./operationService";

type UndoRedoResult = {
  success: boolean;
  operation?: OperationVO;
  resolvedOperationId?: string;
  currentVersion: number;
};

type UndoServiceErrorCode =
  | "NO_UNDOABLE_OPERATION"
  | "NO_REDOABLE_OPERATION"
  | "BROKEN_OPERATION_DATA"
  | "GRAPHIC_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_FORBIDDEN";

type HistoryOperationRow = RowDataPacket & {
  history_id: number;
  operation_record_id: number;
  operation_id: string | null;
  session_id: number;
  user_id: number;
  object_key: string;
  operation_type: "create" | "update" | "delete";
  operation_data: unknown;
  resolved_result: unknown;
  server_version: number | string | null;
};

type OperationResolvedResult = {
  graphic?: Record<string, unknown>;
  beforeGraphic?: Record<string, unknown>;
  deletedGraphic?: Record<string, unknown>;
};

type HistoryLookupKind = "undo" | "redo";

type UndoRedoMeta = {
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
};

type NormalizedUndoRedoMeta = {
  operationId: string;
  clientId: string;
  baseVersion: number;
  lamportTime: number;
};

export class UndoServiceError extends Error {
  constructor(public readonly code: UndoServiceErrorCode, message: string) {
    super(message);
    this.name = "UndoServiceError";
  }
}

export interface UndoService {
  undo(sessionId: number, userId: number, meta?: UndoRedoMeta): Promise<UndoRedoResult>;
  redo(sessionId: number, userId: number, meta?: UndoRedoMeta): Promise<UndoRedoResult>;
}

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const randomOpSuffix = (): string => `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const normalizeUndoRedoMeta = (
  kind: HistoryLookupKind,
  fallbackOperationId: string,
  fallbackBaseVersion: number,
  raw?: UndoRedoMeta
): NormalizedUndoRedoMeta => {
  const operationId = typeof raw?.operationId === "string" && raw.operationId.trim().length > 0
    ? raw.operationId.trim()
    : `${kind}_${fallbackOperationId}_${randomOpSuffix()}`;
  const clientId = typeof raw?.clientId === "string" && raw.clientId.trim().length > 0
    ? raw.clientId.trim()
    : "undo_service";
  const baseVersion = Number.isInteger(raw?.baseVersion) && (raw?.baseVersion ?? -1) >= 0
    ? Number(raw?.baseVersion)
    : fallbackBaseVersion;
  const lamportTime = Number.isInteger(raw?.lamportTime) && (raw?.lamportTime ?? -1) >= 0
    ? Number(raw?.lamportTime)
    : Date.now();
  return { operationId, clientId, baseVersion, lamportTime };
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

const toResolvedResult = (value: unknown): OperationResolvedResult => {
  return toObject(value) as OperationResolvedResult;
};

const toPathPoints = (value: unknown): Array<{ x: number; y: number }> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const points = value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  return points.length > 0 ? points : undefined;
};

const toGraphicVOFromUnknown = (value: unknown): GraphicVO | null => {
  if (!isRecord(value)) {
    return null;
  }
  const objectKey = typeof value.objectKey === "string" ? value.objectKey : "";
  const objectType = typeof value.objectType === "string" ? value.objectType : "line";
  if (!objectKey) {
    return null;
  }
  return {
    id: toNumber(value.id),
    sessionId: toNumber(value.sessionId),
    objectKey,
    objectType: (objectType as GraphicVO["objectType"]) || "line",
    positionX: toNumber(value.positionX),
    positionY: toNumber(value.positionY),
    width: typeof value.width === "number" ? value.width : null,
    height: typeof value.height === "number" ? value.height : null,
    strokeColor: typeof value.strokeColor === "string" ? value.strokeColor : "#000000",
    fillColor: typeof value.fillColor === "string" ? value.fillColor : null,
    strokeWidth: toNumber(value.strokeWidth, 1),
    textContent: typeof value.textContent === "string" ? value.textContent : null,
    fontSize: typeof value.fontSize === "number" ? value.fontSize : null,
    pathPoints: toPathPoints(value.pathPoints) ?? null,
    zIndex: toNumber(value.zIndex),
    version: toNumber(value.version),
    creatorId: toNumber(value.creatorId),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
};

const ensureSessionAndMember = async (sessionId: number, userId: number): Promise<void> => {
  const currentVersion = await findSessionCurrentVersion(sessionId);
  if (currentVersion === null) {
    throw new UndoServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(sessionId, userId);
  if (!member || member.membership_status !== "active") {
    throw new UndoServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
};

const findHistoryByKind = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number,
  kind: HistoryLookupKind
): Promise<HistoryOperationRow | null> => {
  const stateField = kind === "undo" ? "can_undo" : "can_redo";
  const [rows] = await connection.query<HistoryOperationRow[]>(
    `SELECT h.id AS history_id, h.operation_id AS operation_record_id,
            o.operation_id, o.session_id, o.user_id, o.object_key, o.operation_type, o.operation_data,
            o.resolved_result, o.server_version
     FROM user_operation_history h
     INNER JOIN operations o ON o.id = h.operation_id
     WHERE h.user_id = ? AND h.session_id = ? AND h.${stateField} = 1
     ORDER BY h.id DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, sessionId]
  );
  return rows[0] ?? null;
};

const getHistoryLocked = async (
  userId: number,
  sessionId: number,
  kind: HistoryLookupKind
): Promise<HistoryOperationRow> => {
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const history = await findHistoryByKind(connection, userId, sessionId, kind);
    if (!history) {
      throw new UndoServiceError(
        kind === "undo" ? "NO_UNDOABLE_OPERATION" : "NO_REDOABLE_OPERATION",
        kind === "undo" ? "无可撤销操作" : "无可重做操作"
      );
    }
    await connection.commit();
    return history;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const buildOperationVO = (
  operationRecordId: number,
  sessionId: number,
  userId: number,
  objectKey: string,
  operationType: CollaborativeOperationType,
  version: number,
  data: Record<string, unknown>
): OperationVO => {
  return {
    operationId: operationRecordId,
    sessionId,
    userId,
    objectKey,
    operationType,
    version,
    timestamp: Date.now(),
    data
  };
};

const toUpdatePatchFromGraphic = (graphic: GraphicVO): Record<string, unknown> => ({
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

const markUndoHistoryDone = async (
  userId: number,
  sessionId: number,
  historyId: number,
  inverseOperationRecordId: number
): Promise<void> => {
  await dbPool.execute(
    "UPDATE user_operation_history SET can_undo = 0, can_redo = 1, undo_operation_id = ? WHERE id = ? AND user_id = ? AND session_id = ?",
    [inverseOperationRecordId, historyId, userId, sessionId]
  );
};

const markRedoHistoryDone = async (
  userId: number,
  sessionId: number,
  historyId: number
): Promise<void> => {
  await dbPool.execute(
    "UPDATE user_operation_history SET can_undo = 1, can_redo = 0 WHERE id = ? AND user_id = ? AND session_id = ?",
    [historyId, userId, sessionId]
  );
};

const mapOperationServiceError = (error: OperationServiceError): UndoServiceError => {
  if (error.code === "SESSION_NOT_FOUND") {
    return new UndoServiceError("SESSION_NOT_FOUND", error.message);
  }
  if (error.code === "SESSION_FORBIDDEN") {
    return new UndoServiceError("SESSION_FORBIDDEN", error.message);
  }
  if (error.code === "GRAPHIC_NOT_FOUND") {
    return new UndoServiceError("GRAPHIC_NOT_FOUND", error.message);
  }
  return new UndoServiceError("BROKEN_OPERATION_DATA", error.message);
};

const applyUndoByHistory = async (
  history: HistoryOperationRow,
  userId: number,
  normalizedMeta: NormalizedUndoRedoMeta
): Promise<UndoRedoResult> => {
  const resolved = toResolvedResult(history.resolved_result);
  const currentGraphic = toGraphicVOFromUnknown(resolved.graphic);
  const beforeGraphic = toGraphicVOFromUnknown(resolved.beforeGraphic);
  const deletedGraphic = toGraphicVOFromUnknown(resolved.deletedGraphic);
  const objectKey = history.object_key;

  if (history.operation_type === "create") {
    if (!currentGraphic) {
      throw new UndoServiceError("BROKEN_OPERATION_DATA", "创建操作缺少当前图形快照");
    }
    const result = await operationService.deleteGraphic(
      history.session_id,
      userId,
      objectKey,
      {
        operationId: normalizedMeta.operationId,
        clientId: normalizedMeta.clientId,
        baseVersion: normalizedMeta.baseVersion,
        lamportTime: normalizedMeta.lamportTime
      },
      { skipUserHistory: true }
    );
    return {
      success: true,
      resolvedOperationId: result.resolved.operationId,
      currentVersion: result.resolved.serverVersion,
      operation: buildOperationVO(
        result.operationRecordId ?? 0,
        history.session_id,
        userId,
        objectKey,
        "delete_graphic",
        result.resolved.serverVersion,
        { objectKey }
      )
    };
  }

  if (history.operation_type === "delete") {
    if (!deletedGraphic) {
      throw new UndoServiceError("BROKEN_OPERATION_DATA", "删除操作缺少已删图形快照");
    }
    const result = await operationService.createGraphic(
      history.session_id,
      userId,
      {
        objectKey: deletedGraphic.objectKey,
        objectType: deletedGraphic.objectType,
        positionX: deletedGraphic.positionX,
        positionY: deletedGraphic.positionY,
        width: deletedGraphic.width ?? undefined,
        height: deletedGraphic.height ?? undefined,
        strokeColor: deletedGraphic.strokeColor,
        fillColor: deletedGraphic.fillColor ?? undefined,
        strokeWidth: deletedGraphic.strokeWidth,
        textContent: deletedGraphic.textContent ?? undefined,
        fontSize: deletedGraphic.fontSize ?? undefined,
        pathPoints: deletedGraphic.pathPoints ?? undefined,
        zIndex: deletedGraphic.zIndex
      },
      {
        operationId: normalizedMeta.operationId,
        clientId: normalizedMeta.clientId,
        baseVersion: normalizedMeta.baseVersion,
        lamportTime: normalizedMeta.lamportTime
      },
      { skipUserHistory: true }
    );
    return {
      success: true,
      resolvedOperationId: result.resolved.operationId,
      currentVersion: result.resolved.serverVersion,
      operation: buildOperationVO(
        result.operationRecordId ?? 0,
        history.session_id,
        userId,
        objectKey,
        "create_graphic",
        result.resolved.serverVersion,
        result.graphic ? { ...result.graphic } : { objectKey }
      )
    };
  }

  if (!beforeGraphic) {
    throw new UndoServiceError("BROKEN_OPERATION_DATA", "更新操作缺少变更前图形");
  }
  const result = await operationService.updateGraphic(
    history.session_id,
    userId,
    objectKey,
    toUpdatePatchFromGraphic(beforeGraphic),
    {
      operationId: normalizedMeta.operationId,
      clientId: normalizedMeta.clientId,
      baseVersion: normalizedMeta.baseVersion,
      lamportTime: normalizedMeta.lamportTime
    },
    { skipUserHistory: true }
  );
  return {
    success: true,
    resolvedOperationId: result.resolved.operationId,
    currentVersion: result.resolved.serverVersion,
    operation: buildOperationVO(
      result.operationRecordId ?? 0,
      history.session_id,
      userId,
      objectKey,
      "update_graphic",
      result.resolved.serverVersion,
      result.graphic ? { ...result.graphic } : { objectKey }
    )
  };
};

const applyRedoByHistory = async (
  history: HistoryOperationRow,
  userId: number,
  normalizedMeta: NormalizedUndoRedoMeta
): Promise<UndoRedoResult> => {
  const operationData = toObject(history.operation_data);
  const objectKey = history.object_key;

  if (history.operation_type === "create") {
    const payload = operationData;
    const result = await operationService.createGraphic(
      history.session_id,
      userId,
      {
        objectKey,
        objectType: (payload.objectType as GraphicVO["objectType"]) ?? "line",
        positionX: toNumber(payload.positionX),
        positionY: toNumber(payload.positionY),
        width: typeof payload.width === "number" ? payload.width : undefined,
        height: typeof payload.height === "number" ? payload.height : undefined,
        strokeColor: typeof payload.strokeColor === "string" ? payload.strokeColor : "#000000",
        fillColor: typeof payload.fillColor === "string" ? payload.fillColor : undefined,
        strokeWidth: toNumber(payload.strokeWidth, 1),
        textContent: typeof payload.textContent === "string" ? payload.textContent : undefined,
        fontSize: typeof payload.fontSize === "number" ? payload.fontSize : undefined,
        pathPoints: toPathPoints(payload.pathPoints),
        zIndex: toNumber(payload.zIndex)
      },
      {
        operationId: normalizedMeta.operationId,
        clientId: normalizedMeta.clientId,
        baseVersion: normalizedMeta.baseVersion,
        lamportTime: normalizedMeta.lamportTime
      },
      { skipUserHistory: true }
    );
    return {
      success: true,
      resolvedOperationId: result.resolved.operationId,
      currentVersion: result.resolved.serverVersion,
      operation: buildOperationVO(
        result.operationRecordId ?? 0,
        history.session_id,
        userId,
        objectKey,
        "create_graphic",
        result.resolved.serverVersion,
        result.graphic ? { ...result.graphic } : { objectKey }
      )
    };
  }

  if (history.operation_type === "delete") {
    const result = await operationService.deleteGraphic(
      history.session_id,
      userId,
      objectKey,
      {
        operationId: normalizedMeta.operationId,
        clientId: normalizedMeta.clientId,
        baseVersion: normalizedMeta.baseVersion,
        lamportTime: normalizedMeta.lamportTime
      },
      { skipUserHistory: true }
    );
    return {
      success: true,
      resolvedOperationId: result.resolved.operationId,
      currentVersion: result.resolved.serverVersion,
      operation: buildOperationVO(
        result.operationRecordId ?? 0,
        history.session_id,
        userId,
        objectKey,
        "delete_graphic",
        result.resolved.serverVersion,
        { objectKey }
      )
    };
  }

  const result = await operationService.updateGraphic(
    history.session_id,
    userId,
    objectKey,
    operationData,
    {
      operationId: normalizedMeta.operationId,
      clientId: normalizedMeta.clientId,
      baseVersion: normalizedMeta.baseVersion,
      lamportTime: normalizedMeta.lamportTime
    },
    { skipUserHistory: true }
  );
  return {
    success: true,
    resolvedOperationId: result.resolved.operationId,
    currentVersion: result.resolved.serverVersion,
    operation: buildOperationVO(
      result.operationRecordId ?? 0,
      history.session_id,
      userId,
      objectKey,
      "update_graphic",
      result.resolved.serverVersion,
      result.graphic ? { ...result.graphic } : { objectKey }
    )
  };
};

const undoImpl = async (sessionId: number, userId: number, meta?: UndoRedoMeta): Promise<UndoRedoResult> => {
  await ensureSessionAndMember(sessionId, userId);
  const history = await getHistoryLocked(userId, sessionId, "undo");
  const fallbackOperationId = history.operation_id ?? String(history.operation_record_id);
  const normalizedMeta = normalizeUndoRedoMeta("undo", fallbackOperationId, toNumber(history.server_version), meta);
  try {
    const result = await applyUndoByHistory(history, userId, normalizedMeta);
    await markUndoHistoryDone(userId, sessionId, history.history_id, result.operation?.operationId ?? 0);
    return result;
  } catch (error) {
    if (error instanceof OperationServiceError) {
      throw mapOperationServiceError(error);
    }
    throw error;
  }
};

const redoImpl = async (sessionId: number, userId: number, meta?: UndoRedoMeta): Promise<UndoRedoResult> => {
  await ensureSessionAndMember(sessionId, userId);
  const history = await getHistoryLocked(userId, sessionId, "redo");
  const fallbackOperationId = history.operation_id ?? String(history.operation_record_id);
  const normalizedMeta = normalizeUndoRedoMeta("redo", fallbackOperationId, toNumber(history.server_version), meta);
  try {
    const result = await applyRedoByHistory(history, userId, normalizedMeta);
    await markRedoHistoryDone(userId, sessionId, history.history_id);
    return result;
  } catch (error) {
    if (error instanceof OperationServiceError) {
      throw mapOperationServiceError(error);
    }
    throw error;
  }
};

export const undoService: UndoService = {
  undo: undoImpl,
  redo: redoImpl
};
