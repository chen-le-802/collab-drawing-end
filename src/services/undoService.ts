import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createHash } from "crypto";

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

const MAX_DB_ID_LENGTH = 64;

const normalizeDbId = (raw: string, maxLength = MAX_DB_ID_LENGTH): string => {
  const value = raw.trim();
  if (value.length <= maxLength) {
    return value;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 12);
  const prefixLen = Math.max(1, maxLength - hash.length - 1);
  return `${value.slice(0, prefixLen)}_${hash}`;
};

// 用于生成兜底 operationId，避免 undo/redo 在缺少前端元信息时写库失败。
const randomOpSuffix = (): string => `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const normalizeUndoRedoMeta = (
  kind: HistoryLookupKind,
  fallbackOperationId: string,
  fallbackBaseVersion: number,
  raw?: UndoRedoMeta
): NormalizedUndoRedoMeta => {
  // operationId/clientId/baseVersion/lamportTime 四元组统一在服务层补全，
  // 这样不管是 HTTP 还是 WS 入口都能复用同一套撤销重做逻辑。
  const operationIdRaw = typeof raw?.operationId === "string" && raw.operationId.trim().length > 0
    ? raw.operationId.trim()
    : `${kind}_${fallbackOperationId}_${randomOpSuffix()}`;
  const operationId = normalizeDbId(operationIdRaw);
  const clientIdRaw = typeof raw?.clientId === "string" && raw.clientId.trim().length > 0
    ? raw.clientId.trim()
    : "undo_service";
  const clientId = normalizeDbId(clientIdRaw);
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
  const normalizedObjectType = (
    objectType === "line" ||
    objectType === "rect" ||
    objectType === "circle" ||
    objectType === "text" ||
    objectType === "path" ||
    objectType === "image"
  ) ? objectType : "line";
  if (!objectKey) {
    return null;
  }
  return {
    id: toNumber(value.id),
    sessionId: toNumber(value.sessionId),
    objectKey,
    objectType: normalizedObjectType as GraphicVO["objectType"],
    positionX: toNumber(value.positionX),
    positionY: toNumber(value.positionY),
    width: typeof value.width === "number" ? value.width : null,
    height: typeof value.height === "number" ? value.height : null,
    strokeColor: typeof value.strokeColor === "string" ? value.strokeColor : "#000000",
    lineStyle: value.lineStyle === "dashed" ? "dashed" : "solid",
    fillColor: typeof value.fillColor === "string" ? value.fillColor : null,
    strokeWidth: toNumber(value.strokeWidth, 1),
    textContent: typeof value.textContent === "string" ? value.textContent : null,
    fontSize: typeof value.fontSize === "number" ? value.fontSize : null,
    pathPoints: toPathPoints(value.pathPoints) ?? null,
    isLocked: value.isLocked === true || value.isLocked === 1,
    rotation: toNumber(value.rotation),
    zIndex: toNumber(value.zIndex),
    version: toNumber(value.version),
    creatorId: toNumber(value.creatorId),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
};

// 撤销/重做属于“写操作”，沿用和实时编辑一致的会话状态校验，防止越权改画布。
const ensureSessionAndMember = async (sessionId: number, userId: number): Promise<void> => {
  const currentVersion = await findSessionCurrentVersion(sessionId);
  if (currentVersion === null) {
    throw new UndoServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const [sessionRows] = await dbPool.query<Array<{ id: number; status: number; is_paused: number } & RowDataPacket>>(
    "SELECT id, status, is_paused FROM sessions WHERE id = ? LIMIT 1",
    [sessionId]
  );
  const session = sessionRows[0];
  if (!session) {
    throw new UndoServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  const member = await findSessionMember(sessionId, userId);
  if (!member || member.membership_status !== "active") {
    throw new UndoServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (session.status !== 1) {
    throw new UndoServiceError("SESSION_FORBIDDEN", "会话已结束，不能编辑画布");
  }
  if (session.is_paused === 1) {
    throw new UndoServiceError("SESSION_FORBIDDEN", "画布已暂停编辑");
  }
  if (member.role === 0) {
    throw new UndoServiceError("SESSION_FORBIDDEN", "只读成员无编辑权限");
  }
};

const findHistoryByKind = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number,
  kind: HistoryLookupKind
): Promise<HistoryOperationRow | null> => {
  const stateField = kind === "undo" ? "can_undo" : "can_redo";
  // FOR UPDATE 锁住候选历史记录，避免并发点击撤销/重做时拿到同一条记录重复执行。
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
  // resolved_result 里保存了操作时的图形快照，撤销时优先用它恢复“当时状态”。
  const resolved = toResolvedResult(history.resolved_result);
  const currentGraphic = toGraphicVOFromUnknown(resolved.graphic);
  const beforeGraphic = toGraphicVOFromUnknown(resolved.beforeGraphic);
  const deletedGraphic = toGraphicVOFromUnknown(resolved.deletedGraphic);
  const objectKey = history.object_key;

  if (history.operation_type === "create") {
    if (!currentGraphic) {
      throw new UndoServiceError("BROKEN_OPERATION_DATA", "创建操作缺少当前图形快照");
    }
    // 撤销创建 = 删除该对象。
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
    // 撤销删除 = 按删除前快照重建对象。
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
        lineStyle: deletedGraphic.lineStyle,
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
  // 撤销更新 = 回写 beforeGraphic 里的完整字段。
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
  // redo 直接复用原始 operation_data，保证和第一次执行的输入一致。
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
        lineStyle: payload.lineStyle === "dashed" ? "dashed" : "solid",
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
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const history = await findHistoryByKind(connection, userId, sessionId, "undo");
    if (!history) {
      throw new UndoServiceError("NO_UNDOABLE_OPERATION", "无可撤销操作");
    }
    const fallbackOperationId = history.operation_id ?? String(history.operation_record_id);
    const normalizedMeta = normalizeUndoRedoMeta("undo", fallbackOperationId, toNumber(history.server_version), meta);
    try {
      const result = await applyUndoByHistory(history, userId, normalizedMeta);
      // 只在真正执行成功后切换历史状态，避免异常时丢失可恢复链路。
      await connection.execute(
        "UPDATE user_operation_history SET can_undo = 0, can_redo = 1, undo_operation_id = ? WHERE id = ? AND user_id = ? AND session_id = ?",
        [result.operation?.operationId ?? 0, history.history_id, userId, sessionId]
      );
      await connection.commit();
      return result;
    } catch (error) {
      if (error instanceof OperationServiceError) {
        throw mapOperationServiceError(error);
      }
      throw error;
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const redoImpl = async (sessionId: number, userId: number, meta?: UndoRedoMeta): Promise<UndoRedoResult> => {
  await ensureSessionAndMember(sessionId, userId);
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const history = await findHistoryByKind(connection, userId, sessionId, "redo");
    if (!history) {
      throw new UndoServiceError("NO_REDOABLE_OPERATION", "无可重做操作");
    }
    const fallbackOperationId = history.operation_id ?? String(history.operation_record_id);
    const normalizedMeta = normalizeUndoRedoMeta("redo", fallbackOperationId, toNumber(history.server_version), meta);
    try {
      const result = await applyRedoByHistory(history, userId, normalizedMeta);
      await connection.execute(
        "UPDATE user_operation_history SET can_undo = 1, can_redo = 0 WHERE id = ? AND user_id = ? AND session_id = ?",
        [history.history_id, userId, sessionId]
      );
      await connection.commit();
      return result;
    } catch (error) {
      if (error instanceof OperationServiceError) {
        throw mapOperationServiceError(error);
      }
      throw error;
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const undoService: UndoService = {
  undo: undoImpl,
  redo: redoImpl
};
