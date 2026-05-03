export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
}

export interface UserVO {
  id: number;
  username: string;
  avatar?: string;
  role: number;
  status: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileDTO {
  username?: string;
  avatar?: string;
}

export interface AuthToken {
  id: number;
  userId: number;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthPayload {
  userId: number;
}

export type GraphicObjectType = "line" | "rect" | "circle" | "text";

export interface GraphicVO {
  id: number;
  sessionId: number;
  objectKey: string;
  objectType: GraphicObjectType;
  positionX: number;
  positionY: number;
  width: number | null;
  height: number | null;
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  textContent: string | null;
  fontSize: number | null;
  zIndex: number;
  version: number;
  creatorId: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGraphicDTO {
  objectKey: string;
  objectType: GraphicObjectType;
  positionX: number;
  positionY: number;
  width?: number;
  height?: number;
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
  textContent?: string;
  fontSize?: number;
  zIndex: number;
}

export interface UpdateGraphicDTO {
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: number;
  textContent?: string;
  fontSize?: number;
  zIndex?: number;
}

export interface SessionVO {
  sessionId: number;
  sessionKey: string;
  name: string;
  creatorId: number;
  creatorName?: string;
  status: number;
  memberCount?: number;
  currentVersion?: number;
  createdAt: string;
}

export interface MemberVO {
  userId: number;
  username: string;
  role: number;
  onlineStatus: number;
  joinedAt: string;
}

export interface SessionDetailVO extends SessionVO {
  members: MemberVO[];
  currentVersion: number;
}

export interface SessionJoinVO {
  sessionId: number;
  sessionKey: string;
  name: string;
  currentVersion: number;
  graphics: GraphicVO[];
}
