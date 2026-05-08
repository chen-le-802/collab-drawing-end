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
  objectKey: string;
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
  objectKey: string;
}

export interface UndoRedoData {
  sessionKey: string;
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

export type ErrorPayload = {
  code: number;
  message: string;
  originalType: string;
};
