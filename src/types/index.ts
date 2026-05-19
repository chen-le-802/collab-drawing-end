export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
}

// -------------------------- 用户与认证 --------------------------
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

export interface UploadAvatarVO {
  url: string;
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

// -------------------------- 画布图元 --------------------------
export type GraphicObjectType = "line" | "rect" | "circle" | "text" | "path" | "image";
export type GraphicLineStyle = "solid" | "dashed";

export interface PathPoint {
  x: number;
  y: number;
}

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
  lineStyle: GraphicLineStyle;
  fillColor: string | null;
  strokeWidth: number;
  textContent: string | null;
  fontSize: number | null;
  pathPoints: PathPoint[] | null;
  isLocked: boolean;
  rotation: number;
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
  lineStyle?: GraphicLineStyle;
  fillColor?: string;
  strokeWidth: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: PathPoint[];
  isLocked?: boolean;
  rotation?: number;
  zIndex: number;
}

export interface UpdateGraphicDTO {
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  lineStyle?: GraphicLineStyle;
  fillColor?: string;
  strokeWidth?: number;
  textContent?: string;
  fontSize?: number;
  pathPoints?: PathPoint[];
  isLocked?: boolean;
  rotation?: number;
  zIndex?: number;
}

// -------------------------- 协同操作与冲突 --------------------------
export type CollaborativeOperationType = "create_graphic" | "update_graphic" | "delete_graphic";

export interface OperationVO {
  operationId: number;
  sessionId: number;
  userId: number;
  objectKey: string;
  operationType: CollaborativeOperationType;
  version: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export type CollaborationConflictType =
  | "none"
  | "field_merge"
  | "field_conflict"
  | "delete_wins"
  | "duplicate_operation";

export interface SessionOperationItemVO {
  id: number;
  operationId?: string;
  sessionId: number;
  userId: number;
  objectKey: string;
  operationType: "create" | "update" | "delete";
  operationData: Record<string, unknown>;
  baseVersion: number;
  serverVersion: number;
  lamportTime: number;
  clientId?: string;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  batchLabel?: string;
  resolvedResult?: Record<string, unknown>;
  conflictType: CollaborationConflictType;
  timestamp: number;
}

export interface SessionOperationsSyncVO {
  sessionId: number;
  sessionKey: string;
  sinceVersion: number;
  currentVersion: number;
  operations: SessionOperationItemVO[];
}

export interface SessionOperationTimelineQuery {
  fromVersion?: number;
  toVersion?: number;
  userId?: number;
  operationType?: "create" | "update" | "delete" | "restore";
  conflictType?: CollaborationConflictType;
  page: number;
  pageSize: number;
}

export interface SessionOperationTimelineVO {
  sessionId: number;
  sessionKey: string;
  currentVersion: number;
  page: number;
  pageSize: number;
  total: number;
  list: SessionOperationItemVO[];
}

export interface SessionConflictLogItemVO {
  id: number;
  operationRefId?: number;
  operationId?: string;
  sessionId: number;
  objectKey: string;
  conflictType: CollaborationConflictType;
  fieldName?: string;
  currentValue?: unknown;
  incomingValue?: unknown;
  resolvedValue?: unknown;
  resolveStrategy: string;
  createdAt: string;
}

export interface SessionConflictLogsVO {
  sessionId: number;
  sessionKey: string;
  sinceId: number;
  limit: number;
  conflicts: SessionConflictLogItemVO[];
}

// -------------------------- 快照 / 回放 / 恢复 --------------------------
export interface SessionSnapshotItemVO {
  id: number;
  sessionId: number;
  version: number;
  snapshotName?: string;
  graphicCount: number;
  createdBy?: number;
  createdByName?: string;
  createdAt: string;
}

export interface SessionSnapshotsVO {
  sessionId: number;
  sessionKey: string;
  currentVersion: number;
  snapshots: SessionSnapshotItemVO[];
}

export interface SessionReplayVO {
  sessionId: number;
  sessionKey: string;
  targetVersion: number;
  baseSnapshot?: SessionSnapshotItemVO;
  baseSnapshotData?: {
    version: number;
    graphics: Record<string, unknown>[];
  };
  operations: SessionOperationItemVO[];
}

export interface SessionRestoreVersionVO {
  sessionId: number;
  sessionKey: string;
  targetVersion: number;
  previousVersion: number;
  restoredVersion: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
}

// -------------------------- 会话与成员 --------------------------
export interface SessionVO {
  sessionId: number;
  sessionKey: string;
  name: string;
  creatorId: number;
  creatorName?: string;
  status: number;
  isPaused?: boolean;
  memberCount?: number;
  onlineMemberCount?: number;
  memberPreviews?: SessionMemberPreviewVO[];
  currentVersion?: number;
  lastOperationAt?: string;
  lastOperationUserId?: number;
  lastOperationUserName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMemberPreviewVO {
  userId: number;
  username: string;
  avatar?: string;
  isOnline: boolean;
}

export interface MemberVO {
  userId: number;
  username: string;
  avatar?: string;
  role: number;
  onlineStatus: number;
  joinedAt: string;
  membershipStatus?: "active" | "left" | "removed";
  leftAt?: string;
  removedAt?: string;
}

export interface SessionDetailVO extends SessionVO {
  members: MemberVO[];
  currentVersion: number;
}

export interface SessionPauseVO {
  sessionId: number;
  sessionKey: string;
  isPaused: boolean;
}

export interface SessionCloseVO {
  sessionId: number;
  sessionKey: string;
  status: number;
}

export interface SessionJoinVO {
  sessionId: number;
  sessionKey: string;
  name: string;
  currentVersion: number;
  graphics: GraphicVO[];
}

export interface SessionInviteCreateVO {
  sessionId: number;
  sessionKey: string;
  inviteToken: string;
  role: number;
  maxUses: number | null;
  expiresAt: string;
  invitePath: string;
}

export type SessionInviteStatus = "active" | "used" | "expired" | "revoked";

export interface SessionInviteItemVO {
  id: number;
  inviteToken: string;
  role: number;
  status: SessionInviteStatus;
  maxUses: number | null;
  usedCount: number;
  createdBy: number;
  createdAt: string;
  expiresAt?: string;
  invitePath?: string;
}

export interface SessionInviteListVO {
  sessionId: number;
  sessionKey: string;
  list: SessionInviteItemVO[];
}
