import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";
import {
  findGraphicByObjectKey,
  findSessionCurrentVersion,
  GraphicRow,
  incrementSessionVersion,
  insertGraphicObject,
  softDeleteGraphicById,
  updateGraphicObjectById
} from "../models/graphicModel";
import { CollaborativeOperationType, OperationVO } from "../types";

type UndoRedoResult = {
  success: boolean;
  operation?: OperationVO;
  currentVersion: number;
};

type OperationType = "create" | "update" | "delete";

type GraphicSnapshot = {
  objectKey: string;
  objectType: "line" | "rect" | "circle" | "text" | "path";
  positionX: number;
  positionY: number;
  width: number | null;
  height: number | null;
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  zIndex: number;
  textContent: string | null;
  fontSize: number | null;
  pathPoints: Array<{ x: number; y: number }> | null;
};

type OperationDataPayload = {
  objectType: "line" | "rect" | "circle" | "text" | "path";
  before: GraphicSnapshot | null;
  after: GraphicSnapshot | null;
};

type OperationRow = RowDataPacket & {
  id: number;
  session_id: number;
  user_id: number;
  object_key: string;
  operation_type: OperationType;
  operation_data: string | OperationDataPayload;
  version: number | string;
  timestamp: number;
  undoable: number;
  redoable: number;
};

type UserOperationHistoryRow = RowDataPacket & {
  id: number;
  user_id: number;
  session_id: number;
  operation_id: number;
  undo_operation_id: number | null;
  can_undo: number;
  can_redo: number;
  created_at: Date | string;
};

type HistoryWithOperation = UserOperationHistoryRow & {
  operation_type: OperationType;
  operation_data: string | OperationDataPayload;
  object_key: string;
};

type UndoServiceErrorCode =
  | "NO_UNDOABLE_OPERATION"
  | "NO_REDOABLE_OPERATION"
  | "BROKEN_OPERATION_DATA"
  | "GRAPHIC_NOT_FOUND"
  | "SESSION_NOT_FOUND";

export class UndoServiceError extends Error {
  constructor(public readonly code: UndoServiceErrorCode, message: string) {
    super(message);
    this.name = "UndoServiceError";
  }
}

export interface UndoService {
  undo(sessionId: number, userId: number): Promise<UndoRedoResult>;
  redo(sessionId: number, userId: number): Promise<UndoRedoResult>;
  recordOperation(userId: number, sessionId: number, operationId: number, undoOperationId?: number): Promise<void>;
  updateUndoRedoStatus(historyId: number, canUndo: boolean, canRedo: boolean): Promise<void>;
}

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toGraphicSnapshot = (row: GraphicRow): GraphicSnapshot => {
  let pathPoints: Array<{ x: number; y: number }> | null = null;
  if (typeof row.path_points === "string" && row.path_points.trim().length > 0) {
    try {
      const parsed = JSON.parse(row.path_points) as unknown;
      if (Array.isArray(parsed)) {
        const points = parsed
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
          .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
        pathPoints = points.length > 0 ? points : null;
      }
    } catch (_error) {
      pathPoints = null;
    }
  }
  return {
    objectKey: row.object_key,
    objectType: row.object_type,
    positionX: toNumber(row.position_x),
    positionY: toNumber(row.position_y),
    width: row.width === null ? null : toNumber(row.width),
    height: row.height === null ? null : toNumber(row.height),
    strokeColor: row.stroke_color,
    fillColor: row.fill_color,
    strokeWidth: toNumber(row.stroke_width),
    zIndex: row.z_index,
    textContent: row.text_content,
    fontSize: row.font_size,
    pathPoints
  };
};

const parseOperationData = (value: string | OperationDataPayload): OperationDataPayload | null => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as OperationDataPayload;
    } catch (_error) {
      return null;
    }
  }
  return value;
};

const findLatestUndoHistory = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number
): Promise<HistoryWithOperation | null> => {
  const [rows] = await connection.query<HistoryWithOperation[]>(
    `SELECT h.id, h.user_id, h.session_id, h.operation_id, h.undo_operation_id, h.can_undo, h.can_redo, h.created_at,
            o.operation_type, o.operation_data, o.object_key
     FROM user_operation_history h
     INNER JOIN operations o ON o.id = h.operation_id
     WHERE h.user_id = ? AND h.session_id = ? AND h.can_undo = 1
     ORDER BY h.id DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, sessionId]
  );
  return rows[0] ?? null;
};

const findLatestRedoHistory = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number
): Promise<HistoryWithOperation | null> => {
  const [rows] = await connection.query<HistoryWithOperation[]>(
    `SELECT h.id, h.user_id, h.session_id, h.operation_id, h.undo_operation_id, h.can_undo, h.can_redo, h.created_at,
            o.operation_type, o.operation_data, o.object_key
     FROM user_operation_history h
     INNER JOIN operations o ON o.id = h.operation_id
     WHERE h.user_id = ? AND h.session_id = ? AND h.can_redo = 1
     ORDER BY h.id DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, sessionId]
  );
  return rows[0] ?? null;
};

const insertOperation = async (
  connection: PoolConnection,
  sessionId: number,
  userId: number,
  objectKey: string,
  operationType: OperationType,
  operationData: OperationDataPayload,
  version: number
): Promise<number> => {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO operations (session_id, user_id, object_key, operation_type, operation_data, version, timestamp, undoable, redoable)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [sessionId, userId, objectKey, operationType, JSON.stringify(operationData), version, Date.now()]
  );
  return result.insertId;
};

const applySnapshotAsCreate = async (
  connection: PoolConnection,
  sessionId: number,
  userId: number,
  snapshot: GraphicSnapshot,
  version: number
): Promise<void> => {
  await insertGraphicObject(
    {
      sessionId,
      objectKey: snapshot.objectKey,
      objectType: snapshot.objectType,
      positionX: snapshot.positionX,
      positionY: snapshot.positionY,
      width: snapshot.width,
      height: snapshot.height,
      strokeColor: snapshot.strokeColor,
      fillColor: snapshot.fillColor,
      strokeWidth: snapshot.strokeWidth,
      textContent: snapshot.textContent,
      fontSize: snapshot.fontSize,
      pathPoints: snapshot.pathPoints ? JSON.stringify(snapshot.pathPoints) : null,
      zIndex: snapshot.zIndex,
      version,
      creatorId: userId
    },
    connection
  );
};

const applySnapshotAsUpdate = async (
  connection: PoolConnection,
  graphicId: number,
  snapshot: GraphicSnapshot,
  version: number
): Promise<void> => {
  await updateGraphicObjectById(
    graphicId,
    {
      positionX: snapshot.positionX,
      positionY: snapshot.positionY,
      width: snapshot.width,
      height: snapshot.height,
      strokeColor: snapshot.strokeColor,
      fillColor: snapshot.fillColor,
      strokeWidth: snapshot.strokeWidth,
      textContent: snapshot.textContent,
      fontSize: snapshot.fontSize,
      pathPoints: snapshot.pathPoints ? JSON.stringify(snapshot.pathPoints) : null,
      zIndex: snapshot.zIndex
    },
    version,
    connection
  );
};

const buildOperationVO = (
  operationId: number,
  sessionId: number,
  userId: number,
  objectKey: string,
  operationType: CollaborativeOperationType,
  version: number,
  data: Record<string, unknown>
): OperationVO => {
  return {
    operationId,
    sessionId,
    userId,
    objectKey,
    operationType,
    version,
    timestamp: Date.now(),
    data
  };
};

const undoImpl = async (sessionId: number, userId: number): Promise<UndoRedoResult> => {
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const history = await findLatestUndoHistory(connection, userId, sessionId);
    if (!history) {
      throw new UndoServiceError("NO_UNDOABLE_OPERATION", "无可撤销操作");
    }

    const operationData = parseOperationData(history.operation_data);
    if (!operationData) {
      throw new UndoServiceError("BROKEN_OPERATION_DATA", "操作记录损坏");
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new UndoServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    const objectKey = history.object_key;
    const currentGraphic = await findGraphicByObjectKey(sessionId, objectKey, true, connection);

    let inverseType: OperationType;
    let inverseData: OperationDataPayload;
    let broadcastType: CollaborativeOperationType;
    let broadcastPayload: Record<string, unknown>;

    if (history.operation_type === "create") {
      if (!currentGraphic || currentGraphic.is_deleted === 1) {
        throw new UndoServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      await softDeleteGraphicById(currentGraphic.id, nextVersion, connection);
      inverseType = "delete";
      inverseData = {
        objectType: currentGraphic.object_type,
        before: toGraphicSnapshot(currentGraphic),
        after: null
      };
      broadcastType = "delete_graphic";
      broadcastPayload = { objectKey };
    } else if (history.operation_type === "delete") {
      const restore = operationData.before;
      if (!restore) {
        throw new UndoServiceError("BROKEN_OPERATION_DATA", "删除操作缺少快照");
      }
      if (currentGraphic && currentGraphic.is_deleted === 0) {
        await applySnapshotAsUpdate(connection, currentGraphic.id, restore, nextVersion);
      } else if (currentGraphic && currentGraphic.is_deleted === 1) {
        await connection.execute(
          `UPDATE graphic_objects
           SET is_deleted = 0, object_type = ?, position_x = ?, position_y = ?, width = ?, height = ?,
               stroke_color = ?, fill_color = ?, stroke_width = ?, z_index = ?, text_content = ?, font_size = ?, path_points = ?,
               version = ?, updated_at = NOW()
           WHERE id = ?`,
          [
            restore.objectType,
            restore.positionX,
            restore.positionY,
            restore.width,
            restore.height,
            restore.strokeColor,
            restore.fillColor,
            restore.strokeWidth,
            restore.zIndex,
            restore.textContent,
            restore.fontSize,
            restore.pathPoints ? JSON.stringify(restore.pathPoints) : null,
            nextVersion,
            currentGraphic.id
          ]
        );
      } else {
        await applySnapshotAsCreate(connection, sessionId, userId, restore, nextVersion);
      }
      inverseType = "create";
      inverseData = {
        objectType: restore.objectType,
        before: null,
        after: restore
      };
      broadcastType = "create_graphic";
      broadcastPayload = { ...restore };
    } else {
      const restore = operationData.before;
      if (!restore || !currentGraphic || currentGraphic.is_deleted === 1) {
        throw new UndoServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      await applySnapshotAsUpdate(connection, currentGraphic.id, restore, nextVersion);
      inverseType = "update";
      inverseData = {
        objectType: restore.objectType,
        before: operationData.after,
        after: restore
      };
      broadcastType = "update_graphic";
      broadcastPayload = { ...restore };
    }

    const inverseOperationId = await insertOperation(
      connection,
      sessionId,
      userId,
      objectKey,
      inverseType,
      inverseData,
      nextVersion
    );

    await connection.execute(
      "UPDATE user_operation_history SET can_undo = 0, can_redo = 1, undo_operation_id = ? WHERE id = ?",
      [inverseOperationId, history.id]
    );

    await connection.commit();
    return {
      success: true,
      currentVersion: nextVersion,
      operation: buildOperationVO(
        inverseOperationId,
        sessionId,
        userId,
        objectKey,
        broadcastType,
        nextVersion,
        broadcastPayload
      )
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const redoImpl = async (sessionId: number, userId: number): Promise<UndoRedoResult> => {
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const history = await findLatestRedoHistory(connection, userId, sessionId);
    if (!history) {
      throw new UndoServiceError("NO_REDOABLE_OPERATION", "无可重做操作");
    }

    const redoData = parseOperationData(history.operation_data);
    if (!redoData) {
      throw new UndoServiceError("BROKEN_OPERATION_DATA", "重做操作数据损坏");
    }

    const nextVersion = await incrementSessionVersion(sessionId, connection);
    if (nextVersion === null) {
      throw new UndoServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    const objectKey = history.object_key;
    const currentGraphic = await findGraphicByObjectKey(sessionId, objectKey, true, connection);

    let broadcastType: CollaborativeOperationType;
    let broadcastPayload: Record<string, unknown>;
    if (history.operation_type === "delete") {
      if (!currentGraphic || currentGraphic.is_deleted === 1) {
        throw new UndoServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      await softDeleteGraphicById(currentGraphic.id, nextVersion, connection);
      broadcastType = "delete_graphic";
      broadcastPayload = { objectKey };
    } else if (history.operation_type === "create") {
      const snapshot = redoData.after;
      if (!snapshot) {
        throw new UndoServiceError("BROKEN_OPERATION_DATA", "重做创建缺少快照");
      }
      if (currentGraphic && currentGraphic.is_deleted === 1) {
        await connection.execute(
          `UPDATE graphic_objects
           SET is_deleted = 0, object_type = ?, position_x = ?, position_y = ?, width = ?, height = ?,
               stroke_color = ?, fill_color = ?, stroke_width = ?, z_index = ?, text_content = ?, font_size = ?, path_points = ?,
               version = ?, updated_at = NOW()
           WHERE id = ?`,
          [
            snapshot.objectType,
            snapshot.positionX,
            snapshot.positionY,
            snapshot.width,
            snapshot.height,
            snapshot.strokeColor,
            snapshot.fillColor,
            snapshot.strokeWidth,
            snapshot.zIndex,
            snapshot.textContent,
            snapshot.fontSize,
            snapshot.pathPoints ? JSON.stringify(snapshot.pathPoints) : null,
            nextVersion,
            currentGraphic.id
          ]
        );
      } else if (!currentGraphic) {
        await applySnapshotAsCreate(connection, sessionId, userId, snapshot, nextVersion);
      } else {
        await applySnapshotAsUpdate(connection, currentGraphic.id, snapshot, nextVersion);
      }
      broadcastType = "create_graphic";
      broadcastPayload = { ...snapshot };
    } else {
      const snapshot = redoData.after;
      if (!snapshot || !currentGraphic || currentGraphic.is_deleted === 1) {
        throw new UndoServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }
      await applySnapshotAsUpdate(connection, currentGraphic.id, snapshot, nextVersion);
      broadcastType = "update_graphic";
      broadcastPayload = { ...snapshot };
    }

    await connection.execute(
      "UPDATE user_operation_history SET can_undo = 1, can_redo = 0 WHERE id = ?",
      [history.id]
    );

    await connection.commit();
    return {
      success: true,
      currentVersion: nextVersion,
      operation: buildOperationVO(
        history.operation_id,
        sessionId,
        userId,
        objectKey,
        broadcastType,
        nextVersion,
        broadcastPayload
      )
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const recordOperation = async (
  userId: number,
  sessionId: number,
  operationId: number,
  undoOperationId?: number
): Promise<void> => {
  await dbPool.execute(
    `INSERT INTO user_operation_history (user_id, session_id, operation_id, undo_operation_id, can_undo, can_redo)
     VALUES (?, ?, ?, ?, 1, 0)`,
    [userId, sessionId, operationId, undoOperationId ?? null]
  );
};

const updateUndoRedoStatus = async (historyId: number, canUndo: boolean, canRedo: boolean): Promise<void> => {
  await dbPool.execute(
    "UPDATE user_operation_history SET can_undo = ?, can_redo = ? WHERE id = ?",
    [canUndo ? 1 : 0, canRedo ? 1 : 0, historyId]
  );
};

export const undoService: UndoService = {
  undo: undoImpl,
  redo: redoImpl,
  recordOperation,
  updateUndoRedoStatus
};
