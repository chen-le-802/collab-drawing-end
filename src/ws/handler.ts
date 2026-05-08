import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import WebSocket from "ws";

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
import {
  findSessionBySessionKey,
  findSessionMember,
  findSessionMembersBySessionId,
  setSessionMemberLeftStatus,
  setSessionMemberOnlineStatus,
  SessionMemberRow
} from "../models/sessionModel";
import { findUserById } from "../models/userModel";
import { graphicService, GraphicServiceError } from "../services/graphicService";
import { getSessionDetailForUser, SessionServiceError } from "../services/sessionService";
import { undoService, UndoServiceError } from "../services/undoService";
import { MemberVO } from "../types";
import {
  AuthedWebSocket,
  BaseClientMessage,
  CreateGraphicData,
  DeleteGraphicData,
  ErrorPayload,
  JoinSessionData,
  JoinSessionPayload,
  LeaveSessionData,
  ServerMessage,
  ServerMessageType,
  UndoRedoData,
  UpdateGraphicData
} from "./types";

type OperationType = "create" | "update" | "delete";

type WsErrorCode = 1001 | 2001 | 2002 | 3001 | 3002 | 4001;

type OperationDataPayload = {
  objectType: "line" | "rect" | "circle" | "text" | "path";
  before: GraphicSnapshot | null;
  after: GraphicSnapshot | null;
};

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

type WsContext = {
  rooms: Map<string, Set<AuthedWebSocket>>;
  userConnections: Map<number, Set<AuthedWebSocket>>;
};

const SESSION_KEY_REG = /^[a-f0-9]{64}$/i;
const MAX_PAYLOAD_SIZE = 1024 * 1024;

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

const toMemberVO = (row: SessionMemberRow): MemberVO => {
  return {
    userId: row.user_id,
    username: row.username ?? "",
    ...(row.avatar ? { avatar: row.avatar } : {}),
    role: row.role,
    onlineStatus: row.online_status,
    joinedAt: row.joined_at instanceof Date ? row.joined_at.toISOString() : new Date(row.joined_at).toISOString()
  };
};

const now = (): number => Date.now();

const createServerMessage = <T>(type: ServerMessageType, data: T): ServerMessage<T> => ({
  type,
  data,
  timestamp: now()
});

const safeSend = <T>(ws: AuthedWebSocket, type: ServerMessageType, data: T): void => {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(createServerMessage(type, data)));
};

const sendError = (ws: AuthedWebSocket, originalType: string, code: WsErrorCode, message: string): void => {
  const payload: ErrorPayload = { code, message, originalType };
  safeSend(ws, "error", payload);
};

const parseMessage = (raw: WebSocket.RawData): BaseClientMessage | null => {
  let normalized = "";
  if (Buffer.isBuffer(raw)) {
    if (raw.byteLength > MAX_PAYLOAD_SIZE) {
      return null;
    }
    normalized = raw.toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    if (raw.byteLength > MAX_PAYLOAD_SIZE) {
      return null;
    }
    normalized = Buffer.from(raw).toString("utf8");
  } else {
    const merged = Buffer.concat(raw);
    if (merged.byteLength > MAX_PAYLOAD_SIZE) {
      return null;
    }
    normalized = merged.toString("utf8");
  }

  try {
    const parsed = JSON.parse(normalized) as BaseClientMessage;
    if (!parsed || typeof parsed.type !== "string" || typeof parsed.timestamp !== "number") {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
};

const broadcastRoom = <T>(
  context: WsContext,
  sessionKey: string,
  messageType: ServerMessageType,
  data: T,
  exclude?: AuthedWebSocket
): void => {
  const room = context.rooms.get(sessionKey);
  if (!room || room.size === 0) {
    return;
  }

  room.forEach((client) => {
    if (exclude && client === exclude) {
      return;
    }
    safeSend(client, messageType, data);
  });
};

const normalizeOriginalType = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "unknown";
  }
  return value;
};

const requireSessionKey = (sessionKey: unknown): string | null => {
  if (typeof sessionKey !== "string" || !SESSION_KEY_REG.test(sessionKey)) {
    return null;
  }
  return sessionKey;
};

const joinRoom = (context: WsContext, sessionKey: string, ws: AuthedWebSocket): void => {
  const room = context.rooms.get(sessionKey) ?? new Set<AuthedWebSocket>();
  room.add(ws);
  context.rooms.set(sessionKey, room);
  ws.clientData.joinedSessionKeys.add(sessionKey);
};

const leaveRoom = (context: WsContext, sessionKey: string, ws: AuthedWebSocket): void => {
  const room = context.rooms.get(sessionKey);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      context.rooms.delete(sessionKey);
    }
  }
  ws.clientData.joinedSessionKeys.delete(sessionKey);
};

const recordConnection = (context: WsContext, ws: AuthedWebSocket): void => {
  const group = context.userConnections.get(ws.clientData.userId) ?? new Set<AuthedWebSocket>();
  group.add(ws);
  context.userConnections.set(ws.clientData.userId, group);
};

const clearConnection = (context: WsContext, ws: AuthedWebSocket): void => {
  const group = context.userConnections.get(ws.clientData.userId);
  if (group) {
    group.delete(ws);
    if (group.size === 0) {
      context.userConnections.delete(ws.clientData.userId);
    }
  }
};

const assertSessionMemberAccess = async (sessionKey: string, userId: number): Promise<{ sessionId: number }> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new SessionServiceError("SESSION_NOT_FOUND", "会话不存在");
  }

  const member = await findSessionMember(session.id, userId);
  if (!member) {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
  if (member.membership_status !== "active") {
    throw new SessionServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }

  return { sessionId: session.id };
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
    [sessionId, userId, objectKey, operationType, JSON.stringify(operationData), version, now()]
  );
  return result.insertId;
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
  operationId: number
): Promise<void> => {
  await connection.execute(
    "INSERT INTO user_operation_history (user_id, session_id, operation_id, undo_operation_id, can_undo, can_redo) VALUES (?, ?, ?, NULL, 1, 0)",
    [userId, sessionId, operationId]
  );
};


const mapBusinessError = (error: unknown): { code: WsErrorCode; message: string } => {
  if (error instanceof SessionServiceError) {
    if (error.code === "SESSION_NOT_FOUND") {
      return { code: 3001, message: "会话不存在" };
    }
    if (error.code === "SESSION_FORBIDDEN") {
      return { code: 2001, message: "无会话访问权限" };
    }
  }

  if (error instanceof GraphicServiceError) {
    if (error.code === "INVALID_ARGUMENT") {
      return { code: 1001, message: "参数错误" };
    }
    if (error.code === "SESSION_NOT_FOUND" || error.code === "GRAPHIC_NOT_FOUND") {
      return { code: 3001, message: "资源不存在" };
    }
    if (error.code === "GRAPHIC_EXISTS") {
      return { code: 3002, message: "资源已存在" };
    }
    if (error.code === "SESSION_FORBIDDEN") {
      return { code: 2001, message: "无会话访问权限" };
    }
  }

  if (error instanceof UndoServiceError) {
    if (error.code === "SESSION_NOT_FOUND" || error.code === "GRAPHIC_NOT_FOUND") {
      return { code: 3001, message: error.message };
    }
    if (error.code === "NO_UNDOABLE_OPERATION" || error.code === "NO_REDOABLE_OPERATION") {
      return { code: 2002, message: error.message };
    }
    if (error.code === "BROKEN_OPERATION_DATA") {
      return { code: 4001, message: error.message };
    }
  }

  return { code: 4001, message: "服务器错误" };
};

const onJoinSession = async (context: WsContext, ws: AuthedWebSocket, payload: JoinSessionData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey) {
    sendError(ws, "join_session", 1001, "参数错误");
    return;
  }

  const access = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);
  await setSessionMemberOnlineStatus(access.sessionId, ws.clientData.userId, 1);
  const detail = await getSessionDetailForUser(sessionKey, ws.clientData.userId);
  const graphicSnapshot = await graphicService.getGraphics(access.sessionId);
  joinRoom(context, sessionKey, ws);

  const joinedPayload: JoinSessionPayload = {
    sessionId: detail.sessionId,
    sessionKey: detail.sessionKey,
    name: detail.name,
    currentVersion: detail.currentVersion,
    members: detail.members,
    graphics: graphicSnapshot.graphics
  };
  safeSend(ws, "session_joined", joinedPayload);

  broadcastRoom(
    context,
    sessionKey,
    "member_joined",
    {
      sessionKey,
      userId: ws.clientData.userId,
      username: ws.clientData.username
    },
    ws
  );
};

const onLeaveSession = async (context: WsContext, ws: AuthedWebSocket, payload: LeaveSessionData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey) {
    sendError(ws, "leave_session", 1001, "参数错误");
    return;
  }

  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    sendError(ws, "leave_session", 3001, "会话不存在");
    return;
  }

  const existsMember = await findSessionMember(session.id, ws.clientData.userId);
  if (!existsMember || existsMember.membership_status !== "active") {
    sendError(ws, "leave_session", 2001, "无会话访问权限");
    return;
  }

  await setSessionMemberLeftStatus(session.id, ws.clientData.userId);
  leaveRoom(context, sessionKey, ws);
  safeSend(ws, "session_left", { sessionKey });

  broadcastRoom(context, sessionKey, "member_left", {
    sessionKey,
    userId: ws.clientData.userId,
    username: ws.clientData.username
  });
};

const onCreateGraphic = async (context: WsContext, ws: AuthedWebSocket, payload: CreateGraphicData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey || typeof payload.objectKey !== "string") {
    sendError(ws, "create_graphic", 1001, "参数错误");
    return;
  }

  const { sessionId } = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);

  const created = await graphicService.createGraphic(sessionId, ws.clientData.userId, {
    objectKey: payload.objectKey,
    objectType: payload.objectType,
    positionX: payload.positionX,
    positionY: payload.positionY,
    width: payload.width,
    height: payload.height,
    strokeColor: payload.strokeColor,
    fillColor: payload.fillColor,
    strokeWidth: payload.strokeWidth,
    zIndex: payload.zIndex,
    textContent: payload.textContent,
    fontSize: payload.fontSize,
    pathPoints: payload.pathPoints
  });

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const operationData: OperationDataPayload = {
      objectType: created.objectType,
      before: null,
      after: {
        objectKey: created.objectKey,
        objectType: created.objectType,
        positionX: created.positionX,
        positionY: created.positionY,
        width: created.width,
        height: created.height,
        strokeColor: created.strokeColor,
        fillColor: created.fillColor,
        strokeWidth: created.strokeWidth,
        zIndex: created.zIndex,
        textContent: created.textContent,
        fontSize: created.fontSize,
        pathPoints: created.pathPoints
      }
    };
    const operationId = await insertOperation(
      connection,
      sessionId,
      ws.clientData.userId,
      created.objectKey,
      "create",
      operationData,
      created.version
    );
    await markRedoHistoryAsInvalid(connection, ws.clientData.userId, sessionId);
    await insertUserOperationHistory(connection, ws.clientData.userId, sessionId, operationId);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  broadcastRoom(context, sessionKey, "graphic_created", created, ws);
};

const onUpdateGraphic = async (context: WsContext, ws: AuthedWebSocket, payload: UpdateGraphicData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey || typeof payload.objectKey !== "string") {
    sendError(ws, "update_graphic", 1001, "参数错误");
    return;
  }

  const { sessionId } = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);
  const before = await findGraphicByObjectKey(sessionId, payload.objectKey, true);
  if (!before || before.is_deleted === 1) {
    sendError(ws, "update_graphic", 3001, "图形对象不存在");
    return;
  }

  const updated = await graphicService.updateGraphic(sessionId, ws.clientData.userId, payload.objectKey, {
    positionX: payload.positionX,
    positionY: payload.positionY,
    width: payload.width,
    height: payload.height,
    strokeColor: payload.strokeColor,
    fillColor: payload.fillColor,
    strokeWidth: payload.strokeWidth,
    zIndex: payload.zIndex,
    textContent: payload.textContent,
    fontSize: payload.fontSize,
    pathPoints: payload.pathPoints
  });

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const operationData: OperationDataPayload = {
      objectType: updated.objectType,
      before: toGraphicSnapshot(before),
      after: {
        objectKey: updated.objectKey,
        objectType: updated.objectType,
        positionX: updated.positionX,
        positionY: updated.positionY,
        width: updated.width,
        height: updated.height,
        strokeColor: updated.strokeColor,
        fillColor: updated.fillColor,
        strokeWidth: updated.strokeWidth,
        zIndex: updated.zIndex,
        textContent: updated.textContent,
        fontSize: updated.fontSize,
        pathPoints: updated.pathPoints
      }
    };
    const operationId = await insertOperation(
      connection,
      sessionId,
      ws.clientData.userId,
      updated.objectKey,
      "update",
      operationData,
      updated.version
    );
    await markRedoHistoryAsInvalid(connection, ws.clientData.userId, sessionId);
    await insertUserOperationHistory(connection, ws.clientData.userId, sessionId, operationId);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  broadcastRoom(context, sessionKey, "graphic_updated", updated, ws);
};

const onDeleteGraphic = async (context: WsContext, ws: AuthedWebSocket, payload: DeleteGraphicData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey || typeof payload.objectKey !== "string") {
    sendError(ws, "delete_graphic", 1001, "参数错误");
    return;
  }

  const { sessionId } = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);
  const before = await findGraphicByObjectKey(sessionId, payload.objectKey, true);
  if (!before || before.is_deleted === 1) {
    sendError(ws, "delete_graphic", 3001, "图形对象不存在");
    return;
  }

  await graphicService.deleteGraphic(sessionId, ws.clientData.userId, payload.objectKey);
  const currentVersion = await findSessionCurrentVersion(sessionId);

  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const operationData: OperationDataPayload = {
      objectType: before.object_type,
      before: toGraphicSnapshot(before),
      after: null
    };
    const operationId = await insertOperation(
      connection,
      sessionId,
      ws.clientData.userId,
      payload.objectKey,
      "delete",
      operationData,
      typeof currentVersion === "number" ? currentVersion : 0
    );
    await markRedoHistoryAsInvalid(connection, ws.clientData.userId, sessionId);
    await insertUserOperationHistory(connection, ws.clientData.userId, sessionId, operationId);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  broadcastRoom(context, sessionKey, "graphic_deleted", { objectKey: payload.objectKey }, ws);
};

const resolveUndoRedoState = async (
  connection: PoolConnection,
  userId: number,
  sessionId: number
): Promise<{ canUndo: boolean; canRedo: boolean }> => {
  const [rows] = await connection.query<Array<{ canUndo: number; canRedo: number } & RowDataPacket>>(
    `SELECT
       MAX(CASE WHEN can_undo = 1 THEN 1 ELSE 0 END) AS canUndo,
       MAX(CASE WHEN can_redo = 1 THEN 1 ELSE 0 END) AS canRedo
     FROM user_operation_history
     WHERE user_id = ? AND session_id = ?`,
    [userId, sessionId]
  );
  const row = rows[0];
  return {
    canUndo: !!row?.canUndo,
    canRedo: !!row?.canRedo
  };
};


const onUndo = async (context: WsContext, ws: AuthedWebSocket, payload: UndoRedoData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey) {
    sendError(ws, "undo", 1001, "参数错误");
    return;
  }
  const { sessionId } = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);
  const result = await undoService.undo(sessionId, ws.clientData.userId);
  if (!result.success) {
    sendError(ws, "undo", 4001, "撤销失败");
    return;
  }

  const connection = await dbPool.getConnection();
  let state: { canUndo: boolean; canRedo: boolean } = { canUndo: false, canRedo: false };
  try {
    state = await resolveUndoRedoState(connection, ws.clientData.userId, sessionId);
  } finally {
    connection.release();
  }

  if (result.operation) {
    if (result.operation.operationType === "create_graphic") {
      broadcastRoom(context, sessionKey, "graphic_created", result.operation.data, ws);
    } else if (result.operation.operationType === "update_graphic") {
      broadcastRoom(context, sessionKey, "graphic_updated", result.operation.data, ws);
    } else {
      broadcastRoom(context, sessionKey, "graphic_deleted", { objectKey: result.operation.objectKey }, ws);
    }
  }

  safeSend(ws, "undo_result", {
    success: true,
    sessionKey,
    operation: result.operation,
    currentVersion: result.currentVersion,
    operationId: result.operation?.operationId ?? 0,
    undoOperationId: result.operation?.operationId ?? 0,
    canUndo: state.canUndo,
    canRedo: state.canRedo
  });
};

const onRedo = async (context: WsContext, ws: AuthedWebSocket, payload: UndoRedoData): Promise<void> => {
  const sessionKey = requireSessionKey(payload?.sessionKey);
  if (!sessionKey) {
    sendError(ws, "redo", 1001, "参数错误");
    return;
  }
  const { sessionId } = await assertSessionMemberAccess(sessionKey, ws.clientData.userId);
  const result = await undoService.redo(sessionId, ws.clientData.userId);
  if (!result.success) {
    sendError(ws, "redo", 4001, "重做失败");
    return;
  }

  const connection = await dbPool.getConnection();
  let state: { canUndo: boolean; canRedo: boolean } = { canUndo: false, canRedo: false };
  try {
    state = await resolveUndoRedoState(connection, ws.clientData.userId, sessionId);
  } finally {
    connection.release();
  }

  if (result.operation) {
    if (result.operation.operationType === "create_graphic") {
      broadcastRoom(context, sessionKey, "graphic_created", result.operation.data, ws);
    } else if (result.operation.operationType === "update_graphic") {
      broadcastRoom(context, sessionKey, "graphic_updated", result.operation.data, ws);
    } else {
      broadcastRoom(context, sessionKey, "graphic_deleted", { objectKey: result.operation.objectKey }, ws);
    }
  }

  safeSend(ws, "redo_result", {
    success: true,
    sessionKey,
    operation: result.operation,
    currentVersion: result.currentVersion,
    operationId: result.operation?.operationId ?? 0,
    redoOperationId: result.operation?.operationId ?? 0,
    canUndo: state.canUndo,
    canRedo: state.canRedo
  });
};

const onPing = (ws: AuthedWebSocket): void => {
  safeSend(ws, "pong", {});
};

export const createWsHandler = (context: WsContext) => {
  return {
    recordConnection: (ws: AuthedWebSocket): void => {
      recordConnection(context, ws);
    },

    handleMessage: async (ws: AuthedWebSocket, rawMessage: WebSocket.RawData): Promise<void> => {
      ws.clientData.lastSeenAt = now();
      const message = parseMessage(rawMessage);
      if (!message) {
        sendError(ws, "unknown", 1001, "消息格式错误");
        return;
      }

      const originalType = normalizeOriginalType(message.type);
      try {
        switch (message.type) {
          case "join_session":
            await onJoinSession(context, ws, message.data as JoinSessionData);
            return;
          case "leave_session":
            await onLeaveSession(context, ws, message.data as LeaveSessionData);
            return;
          case "create_graphic":
            await onCreateGraphic(context, ws, message.data as CreateGraphicData);
            return;
          case "update_graphic":
            await onUpdateGraphic(context, ws, message.data as UpdateGraphicData);
            return;
          case "delete_graphic":
            await onDeleteGraphic(context, ws, message.data as DeleteGraphicData);
            return;
          case "undo":
            await onUndo(context, ws, message.data as UndoRedoData);
            return;
          case "redo":
            await onRedo(context, ws, message.data as UndoRedoData);
            return;
          case "ping":
            onPing(ws);
            return;
          default:
            sendError(ws, originalType, 1001, "消息类型不支持");
        }
      } catch (error) {
        const mapped = mapBusinessError(error);
        const fallbackMessage = error instanceof Error ? error.message : mapped.message;
        sendError(ws, originalType, mapped.code, fallbackMessage || mapped.message);
      }
    },

    handleClose: async (ws: AuthedWebSocket): Promise<void> => {
      clearConnection(context, ws);

      const userId = ws.clientData.userId;
      const [onlineRows] = await dbPool.query<Array<{ session_key: string } & RowDataPacket>>(
        `SELECT s.session_key
         FROM session_members sm
         INNER JOIN sessions s ON s.id = sm.session_id
         WHERE sm.user_id = ? AND sm.membership_status = 'active' AND sm.online_status = 1`,
        [userId]
      );
      const sessionKeys = onlineRows.map((item) => item.session_key);

      for (const sessionKey of sessionKeys) {
        try {
          const session = await findSessionBySessionKey(sessionKey);
          if (!session) {
            leaveRoom(context, sessionKey, ws);
            continue;
          }

          const sameUserConnectionAlive = Array.from(context.userConnections.get(userId) ?? []).some((item) => {
            return item.clientData.joinedSessionKeys.has(sessionKey) && item.readyState === WebSocket.OPEN;
          });
          if (sameUserConnectionAlive) {
            leaveRoom(context, sessionKey, ws);
            continue;
          }

          await setSessionMemberOnlineStatus(session.id, userId, 0);
          broadcastRoom(context, sessionKey, "member_left", {
            sessionKey,
            userId,
            username: ws.clientData.username
          });
        } catch (_error) {
          // 忽略单个会话清理失败，继续处理其他会话。
        }
      }

      Array.from(ws.clientData.joinedSessionKeys).forEach((sessionKey) => {
        leaveRoom(context, sessionKey, ws);
      });
    },

    autoJoinIfNeeded: async (ws: AuthedWebSocket, sessionKey?: string | null): Promise<void> => {
      const normalized = requireSessionKey(sessionKey);
      if (!normalized) {
        return;
      }

      try {
        await onJoinSession(context, ws, { sessionKey: normalized });
      } catch (_error) {
        sendError(ws, "join_session", 3001, "自动加入会话失败");
      }
    },

    cleanExpiredConnections: (): void => {
      const timeoutMs = 30 * 1000;
      const nowAt = now();
      context.userConnections.forEach((connections) => {
        connections.forEach((client) => {
          if (client.readyState !== WebSocket.OPEN) {
            client.terminate();
            return;
          }
          if (nowAt - client.clientData.lastSeenAt > timeoutMs) {
            client.terminate();
          }
        });
      });
    },

    getOnlineMembersSnapshot: async (sessionKey: string): Promise<MemberVO[]> => {
      const session = await findSessionBySessionKey(sessionKey);
      if (!session) {
        return [];
      }
      const members = await findSessionMembersBySessionId(session.id);
      const userIds = members.map((item) => item.user_id);
      const userRows = await Promise.all(userIds.map(async (userId) => findUserById(userId)));
      return members.map((member, index) => {
        const user = userRows[index];
        return {
          userId: member.user_id,
          username: user?.username ?? "",
          ...(user?.avatar ? { avatar: user.avatar } : {}),
          role: member.role,
          onlineStatus: member.online_status,
          joinedAt: member.joined_at instanceof Date ? member.joined_at.toISOString() : new Date(member.joined_at).toISOString()
        };
      });
    }
  };
};
