import WebSocket from "ws";

import { GraphicVO, MemberVO } from "../types";

export type ClientMessageType =
  | "join_session"
  | "leave_session"
  | "create_graphic"
  | "update_graphic"
  | "delete_graphic"
  | "undo"
  | "redo"
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
  objectKey: string;
  objectType: "line" | "rect" | "circle" | "text" | "path";
  positionX: number;
  positionY: number;
  width?: number;
  height?: number;
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
  zIndex: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: Array<{ x: number; y: number }>;
}

export interface UpdateGraphicData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  objectKey: string;
  patch?: {
    positionX?: number;
    positionY?: number;
    width?: number;
    height?: number;
    strokeColor?: string;
    fillColor?: string;
    strokeWidth?: number;
    zIndex?: number;
    textContent?: string;
    fontSize?: number;
    pathPoints?: Array<{ x: number; y: number }>;
  };
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: number;
  zIndex?: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: Array<{ x: number; y: number }>;
}

export interface DeleteGraphicData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
  objectKey: string;
}

export interface UndoRedoData {
  sessionKey: string;
  operationId?: string;
  clientId?: string;
  baseVersion?: number;
  lamportTime?: number;
}

export type ServerMessageType =
  | "session_joined"
  | "session_left"
  | "member_joined"
  | "member_left"
  | "member_status_changed"
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
  joinedSessionKeys: Set<string>;
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
