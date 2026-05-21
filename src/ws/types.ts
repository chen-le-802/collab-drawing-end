import WebSocket from "ws";

import { GraphicVO, MemberVO } from "../types";

// 客户端 -> 服务端消息类型（统一走 WS 消息分发器处理）。
export type ClientMessageType =
  | "join_session"
  | "leave_session"
  | "create_graphic"
  | "update_graphic"
  | "delete_graphic"
  | "undo"
  | "redo"
  | "cursor_move"
  | "selection_change"
  | "ping";

export interface BaseClientMessage<T = unknown> {
  type: ClientMessageType;
  data: T;
  timestamp: number;
}

export interface JoinSessionData {
  sessionKey: string;
}

export interface LeaveSessionData {
  sessionKey: string;
}

export interface CreateGraphicData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
  objectKey: string;
  objectType: "line" | "rect" | "circle" | "text" | "path" | "image";
  positionX: number;
  positionY: number;
  width?: number;
  height?: number;
  strokeColor: string;
  lineStyle?: "solid" | "dashed";
  fillColor?: string | null;
  strokeWidth: number;
  zIndex: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: Array<{ x: number; y: number }>;
  isLocked?: boolean;
  rotation?: number;
}

export interface UpdateGraphicData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
  objectKey: string;
  patch?: {
    positionX?: number;
    positionY?: number;
    width?: number;
    height?: number;
    strokeColor?: string;
    lineStyle?: "solid" | "dashed";
    fillColor?: string | null;
    strokeWidth?: number;
    zIndex?: number;
    textContent?: string;
    fontSize?: number;
    pathPoints?: Array<{ x: number; y: number }>;
    isLocked?: boolean;
    rotation?: number;
  };
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  lineStyle?: "solid" | "dashed";
  fillColor?: string | null;
  strokeWidth?: number;
  zIndex?: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: Array<{ x: number; y: number }>;
  isLocked?: boolean;
  rotation?: number;
}

export interface DeleteGraphicData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
  objectKey: string;
}

export interface UndoRedoData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  times?: number;
}

export interface CursorMoveData {
  sessionKey: string;
  x: number;
  y: number;
}

export interface SelectionChangeData {
  sessionKey: string;
  objectKey?: string | null;
  objectKeys?: string[];
}

// 服务端 -> 客户端消息类型。
export type ServerMessageType =
  | "session_joined"
  | "session_left"
  | "session_paused"
  | "member_joined"
  | "member_left"
  | "member_status_changed"
  | "presence_cursor"
  | "presence_selection"
  | "graphic_created"
  | "graphic_updated"
  | "graphic_deleted"
  | "operation_resolved"
  | "undo_result"
  | "redo_result"
  | "error"
  | "pong";

export interface ServerMessage<T = unknown> {
  type: ServerMessageType;
  data: T;
  timestamp: number;
}

export interface WsClientData {
  userId: number;
  username: string;
  token: string;
  // 当前连接已加入的会话集合，用于断线清理和多房间广播过滤。
  joinedSessionKeys: Set<string>;
  // 会话键到会话 id 的缓存，减少同连接内重复鉴权查询。
  sessionIdCache: Map<string, number>;
  // 最近一次收到消息时间戳，用于心跳超时回收。
  lastSeenAt: number;
}

export type AuthedWebSocket = WebSocket & {
  clientData: WsClientData;
};

export type JoinSessionPayload = {
  sessionId: number;
  sessionKey: string;
  name: string;
  currentVersion: number;
  members: MemberVO[];
  graphics: GraphicVO[];
};

export type OperationResolvedPayload = {
  operationId: string;
  objectKey: string;
  operationType: "create_graphic" | "update_graphic" | "delete_graphic";
  serverVersion: number;
  // 冲突类型由后端合并策略判定，前端可据此做提示或日志展示。
  conflictType: "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation";
  appliedFields: string[];
  rejectedFields: string[];
  resolveReason: string;
};

export type ErrorPayload = {
  code: number;
  message: string;
  originalType: string;
};
