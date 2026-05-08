import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { dbPool } from "../config/db";

type QueryExecutor = {
  query: PoolConnection["query"];
  execute: PoolConnection["execute"];
};

type SessionVersionRow = RowDataPacket & {
  current_version: number;
};

export type GraphicRow = RowDataPacket & {
  id: number;
  session_id: number;
  object_key: string;
  object_type: "line" | "rect" | "circle" | "text" | "path";
  position_x: number | string;
  position_y: number | string;
  width: number | string | null;
  height: number | string | null;
  stroke_color: string;
  fill_color: string | null;
  stroke_width: number | string;
  text_content: string | null;
  font_size: number | null;
  path_points: string | null;
  z_index: number;
  version: number | string;
  creator_id: number;
  is_deleted: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type InsertGraphicInput = {
  sessionId: number;
  objectKey: string;
  objectType: "line" | "rect" | "circle" | "text" | "path";
  positionX: number;
  positionY: number;
  width: number | null;
  height: number | null;
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  textContent: string | null;
  fontSize: number | null;
  pathPoints: string | null;
  zIndex: number;
  version: number;
  creatorId: number;
};

export type GraphicUpdateDbPatch = {
  positionX?: number;
  positionY?: number;
  width?: number | null;
  height?: number | null;
  strokeColor?: string;
  fillColor?: string | null;
  strokeWidth?: number;
  textContent?: string | null;
  fontSize?: number | null;
  pathPoints?: string | null;
  zIndex?: number;
};

const getExecutor = (connection?: PoolConnection): QueryExecutor => {
  return connection ?? dbPool;
};

export const findSessionCurrentVersion = async (sessionId: number): Promise<number | null> => {
  const [rows] = await dbPool.query<SessionVersionRow[]>(
    "SELECT current_version FROM sessions WHERE id = ? LIMIT 1",
    [sessionId]
  );
  if (!rows[0]) {
    return null;
  }
  return Number(rows[0].current_version);
};

export const incrementSessionVersion = async (sessionId: number, connection: PoolConnection): Promise<number | null> => {
  // 先锁定会话行，再递增版本，确保并发写入时 version 顺序正确。
  const [rows] = await connection.query<SessionVersionRow[]>(
    "SELECT current_version FROM sessions WHERE id = ? FOR UPDATE",
    [sessionId]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  const nextVersion = Number(row.current_version) + 1;
  await connection.execute<ResultSetHeader>(
    "UPDATE sessions SET current_version = ?, updated_at = NOW() WHERE id = ?",
    [nextVersion, sessionId]
  );

  return nextVersion;
};

export const insertGraphicObject = async (input: InsertGraphicInput, connection?: PoolConnection): Promise<number> => {
  const executor = getExecutor(connection);
  // 图形默认以未删除状态写入，版本由 service 侧事务计算后传入。
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO graphic_objects (
      session_id, object_key, object_type, position_x, position_y, width, height,
      stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
      version, creator_id, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      input.sessionId,
      input.objectKey,
      input.objectType,
      input.positionX,
      input.positionY,
      input.width,
      input.height,
      input.strokeColor,
      input.fillColor,
      input.strokeWidth,
      input.textContent,
      input.fontSize,
      input.pathPoints,
      input.zIndex,
      input.version,
      input.creatorId
    ]
  );
  return result.insertId;
};

export const findGraphicById = async (graphicId: number, connection?: PoolConnection): Promise<GraphicRow | null> => {
  const executor = getExecutor(connection);
  const [rows] = await executor.query<GraphicRow[]>(
    `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
            stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
            version, creator_id, is_deleted, created_at, updated_at
     FROM graphic_objects
     WHERE id = ?
     LIMIT 1`,
    [graphicId]
  );
  return rows[0] ?? null;
};

export const findGraphicByObjectKey = async (
  sessionId: number,
  objectKey: string,
  includeDeleted = true,
  connection?: PoolConnection
): Promise<GraphicRow | null> => {
  const executor = getExecutor(connection);
  // includeDeleted=true 用于 update/delete 场景识别“已软删除”对象。
  const [rows] = await executor.query<GraphicRow[]>(
    `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
            stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
            version, creator_id, is_deleted, created_at, updated_at
     FROM graphic_objects
     WHERE session_id = ? AND object_key = ? ${includeDeleted ? "" : "AND is_deleted = 0"}
     LIMIT 1`,
    [sessionId, objectKey]
  );
  return rows[0] ?? null;
};

export const updateGraphicObjectById = async (
  graphicId: number,
  patch: GraphicUpdateDbPatch,
  version: number,
  connection?: PoolConnection
): Promise<void> => {
  const executor = getExecutor(connection);
  // 动态拼接更新字段，避免把未传入字段覆盖成 null。
  const fields: string[] = [];
  const params: Array<number | string | null> = [];

  if (typeof patch.positionX === "number") {
    fields.push("position_x = ?");
    params.push(patch.positionX);
  }
  if (typeof patch.positionY === "number") {
    fields.push("position_y = ?");
    params.push(patch.positionY);
  }
  if (typeof patch.width === "number" || patch.width === null) {
    fields.push("width = ?");
    params.push(patch.width);
  }
  if (typeof patch.height === "number" || patch.height === null) {
    fields.push("height = ?");
    params.push(patch.height);
  }
  if (typeof patch.strokeColor === "string") {
    fields.push("stroke_color = ?");
    params.push(patch.strokeColor);
  }
  if (typeof patch.fillColor === "string" || patch.fillColor === null) {
    fields.push("fill_color = ?");
    params.push(patch.fillColor);
  }
  if (typeof patch.strokeWidth === "number") {
    fields.push("stroke_width = ?");
    params.push(patch.strokeWidth);
  }
  if (typeof patch.textContent === "string" || patch.textContent === null) {
    fields.push("text_content = ?");
    params.push(patch.textContent);
  }
  if (typeof patch.fontSize === "number" || patch.fontSize === null) {
    fields.push("font_size = ?");
    params.push(patch.fontSize);
  }
  if (typeof patch.pathPoints === "string" || patch.pathPoints === null) {
    fields.push("path_points = ?");
    params.push(patch.pathPoints);
  }
  if (typeof patch.zIndex === "number") {
    fields.push("z_index = ?");
    params.push(patch.zIndex);
  }

  fields.push("version = ?");
  params.push(version);
  fields.push("updated_at = NOW()");
  params.push(graphicId);

  await executor.execute<ResultSetHeader>(
    `UPDATE graphic_objects SET ${fields.join(", ")} WHERE id = ?`,
    params
  );
};

export const softDeleteGraphicById = async (graphicId: number, version: number, connection?: PoolConnection): Promise<void> => {
  const executor = getExecutor(connection);
  // 软删除只标记 is_deleted，不做物理删除。
  await executor.execute<ResultSetHeader>(
    "UPDATE graphic_objects SET is_deleted = 1, version = ?, updated_at = NOW() WHERE id = ?",
    [version, graphicId]
  );
};

export const findActiveGraphicsBySessionId = async (sessionId: number, sinceVersion?: number): Promise<GraphicRow[]> => {
  const hasSince = typeof sinceVersion === "number";
  // 增量拉取走 version 排序，全量拉取走 z_index 排序，满足画布渲染顺序。
  const sql = hasSince
    ? `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
              stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
              version, creator_id, is_deleted, created_at, updated_at
       FROM graphic_objects
       WHERE session_id = ? AND is_deleted = 0 AND version > ?
       ORDER BY version ASC, id ASC`
    : `SELECT id, session_id, object_key, object_type, position_x, position_y, width, height,
              stroke_color, fill_color, stroke_width, text_content, font_size, path_points, z_index,
              version, creator_id, is_deleted, created_at, updated_at
       FROM graphic_objects
       WHERE session_id = ? AND is_deleted = 0
       ORDER BY z_index ASC, id ASC`;

  const params = hasSince ? [sessionId, sinceVersion] : [sessionId];
  const [rows] = await dbPool.query<GraphicRow[]>(sql, params);
  return rows;
};
