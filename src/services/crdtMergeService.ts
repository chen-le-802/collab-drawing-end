import { PoolConnection } from "mysql2/promise";

import { findGraphicByObjectKey, GraphicRow } from "../models/graphicModel";
import { FieldVersionRow, findGraphicFieldVersions } from "../models/operationModel";
import { GraphicObjectType, GraphicVO, PathPoint, UpdateGraphicDTO } from "../types";

export type ConflictType = "none" | "field_merge" | "field_conflict" | "delete_wins" | "duplicate_operation";

export type CrdtContext = {
  sessionId: number;
  objectKey: string;
  userId: number;
  operationId: string;
  baseVersion: number;
  lamportTime: number;
  clientId: string;
  nextVersion: number;
};

export type CrdtMergeResult = {
  mergedPatch: UpdateGraphicDTO;
  appliedFields: string[];
  rejectedFields: string[];
  conflictType: ConflictType;
  resolveReason: string;
  targetGraphic: GraphicRow;
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const FIELD_MAP: Record<string, keyof UpdateGraphicDTO> = {
  positionX: "positionX",
  positionY: "positionY",
  width: "width",
  height: "height",
  strokeColor: "strokeColor",
  fillColor: "fillColor",
  strokeWidth: "strokeWidth",
  textContent: "textContent",
  fontSize: "fontSize",
  pathPoints: "pathPoints",
  zIndex: "zIndex"
};

const parsePathPoints = (value: unknown): PathPoint[] | null => {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const points = value
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({ x: toNumber(item.x), y: toNumber(item.y) }))
      .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
    return points.length > 0 ? points : null;
  }
  if (typeof value === "string") {
    try {
      return parsePathPoints(JSON.parse(value));
    } catch (_error) {
      return null;
    }
  }
  return null;
};

const toGraphicVO = (row: GraphicRow): GraphicVO => {
  return {
    id: row.id,
    sessionId: row.session_id,
    objectKey: row.object_key,
    objectType: row.object_type,
    positionX: toNumber(row.position_x),
    positionY: toNumber(row.position_y),
    width: row.width === null ? null : toNumber(row.width),
    height: row.height === null ? null : toNumber(row.height),
    strokeColor: row.stroke_color,
    fillColor: row.fill_color,
    strokeWidth: toNumber(row.stroke_width),
    textContent: row.text_content,
    fontSize: row.font_size,
    pathPoints: parsePathPoints(row.path_points),
    zIndex: row.z_index,
    version: toNumber(row.version),
    creatorId: row.creator_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString()
  };
};

const rowValueByField = (graphic: GraphicVO, fieldName: keyof UpdateGraphicDTO): unknown => {
  return graphic[fieldName];
};

const resolveFieldConflict = (
  incomingLamport: number,
  incomingClientId: string,
  currentVersion: FieldVersionRow | undefined
): { takeIncoming: boolean; reason: string } => {
  if (!currentVersion) {
    return { takeIncoming: true, reason: "field_init" };
  }
  const currentLamport = toNumber(currentVersion.lamport_time);
  if (incomingLamport > currentLamport) {
    return { takeIncoming: true, reason: "lamport_gt" };
  }
  if (incomingLamport < currentLamport) {
    return { takeIncoming: false, reason: "lamport_lt" };
  }
  const currentClientId = currentVersion.client_id ?? "";
  if (incomingClientId >= currentClientId) {
    return { takeIncoming: true, reason: "lamport_eq_client_tie_win" };
  }
  return { takeIncoming: false, reason: "lamport_eq_client_tie_lose" };
};

export class CrdtMergeServiceError extends Error {
  constructor(
    public readonly code: "GRAPHIC_NOT_FOUND" | "GRAPHIC_DELETED",
    message: string
  ) {
    super(message);
    this.name = "CrdtMergeServiceError";
  }
}

export type CrdtMergeService = {
  mergeUpdatePatch(context: CrdtContext, patch: UpdateGraphicDTO, connection: PoolConnection): Promise<CrdtMergeResult>;
  toGraphicVO(row: GraphicRow): GraphicVO;
};

const mergeUpdatePatch = async (
  context: CrdtContext,
  patch: UpdateGraphicDTO,
  connection: PoolConnection
): Promise<CrdtMergeResult> => {
  const target = await findGraphicByObjectKey(context.sessionId, context.objectKey, true, connection);
  if (!target) {
    throw new CrdtMergeServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
  }
  if (target.is_deleted === 1) {
    throw new CrdtMergeServiceError("GRAPHIC_DELETED", "图形对象已删除");
  }

  const currentGraphic = toGraphicVO(target);
  const currentFieldVersions = await findGraphicFieldVersions(context.sessionId, context.objectKey, connection);
  const fieldVersionMap = new Map<string, FieldVersionRow>();
  currentFieldVersions.forEach((item) => fieldVersionMap.set(item.field_name, item));

  const mergedPatch: UpdateGraphicDTO = {};
  const appliedFields: string[] = [];
  const rejectedFields: string[] = [];
  let hasFieldConflict = false;

  const patchEntries = Object.entries(patch) as Array<[keyof UpdateGraphicDTO, unknown]>;
  patchEntries.forEach(([fieldName, nextValue]) => {
    if (typeof nextValue === "undefined") {
      return;
    }
    const fieldVersion = fieldVersionMap.get(fieldName);
    const decision = resolveFieldConflict(context.lamportTime, context.clientId, fieldVersion);
    if (decision.takeIncoming) {
      (mergedPatch[fieldName] as unknown) = nextValue;
      appliedFields.push(fieldName);
    } else {
      rejectedFields.push(fieldName);
      hasFieldConflict = true;
      // Keep existing value explicitly so downstream persistence doesn't null-out field.
      (mergedPatch[fieldName] as unknown) = rowValueByField(currentGraphic, fieldName);
    }
  });

  const hasOutdatedBase = context.baseVersion < currentGraphic.version;
  const conflictType: ConflictType = hasFieldConflict
    ? "field_conflict"
    : hasOutdatedBase
      ? "field_merge"
      : "none";

  const resolveReason = hasFieldConflict
    ? "field_conflict_resolved_by_lamport"
    : hasOutdatedBase
      ? "outdated_base_version_merged"
      : "no_conflict";

  return {
    mergedPatch,
    appliedFields,
    rejectedFields,
    conflictType,
    resolveReason,
    targetGraphic: target
  };
};

export const crdtMergeService: CrdtMergeService = {
  mergeUpdatePatch,
  toGraphicVO
};

export const CRDT_FIELD_NAMES: Array<keyof UpdateGraphicDTO> = Object.keys(FIELD_MAP) as Array<keyof UpdateGraphicDTO>;
export const CRDT_GRAPHIC_TYPES: GraphicObjectType[] = ["line", "rect", "circle", "text", "path"];

