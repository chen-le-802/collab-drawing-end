export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
}

export interface UserVO {
  id: number;
  username: string;
  role: number;
  status: number;
  createdAt: string;
  updatedAt: string;
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

export interface GraphicVO {
  [key: string]: unknown;
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
