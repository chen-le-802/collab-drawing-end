import { PoolConnection } from "mysql2/promise";

import { dbPool } from "../config/db";
import {
  findActiveGraphicsBySessionId,
  findGraphicById,
  findGraphicByObjectKey,
  findSessionCurrentVersion,
  GraphicRow,
  incrementSessionVersion,
  insertGraphicObject,
  softDeleteGraphicById,
  updateGraphicObjectById
} from "../models/graphicModel";
import { findSessionBySessionKey, findSessionMember } from "../models/sessionModel";
import { CreateGraphicDTO, GraphicObjectType, GraphicVO, UpdateGraphicDTO } from "../types";

type GraphicsResult = {
  graphics: GraphicVO[];
  currentVersion: number;
};

const GRAPHIC_TYPES: GraphicObjectType[] = ["line", "rect", "circle", "text"];

// 统一图形模块业务异常，controller 根据 code 映射 API 错误码。
export class GraphicServiceError extends Error {
  constructor(
    public readonly code: "SESSION_NOT_FOUND" | "SESSION_FORBIDDEN" | "GRAPHIC_NOT_FOUND" | "GRAPHIC_EXISTS" | "INVALID_ARGUMENT",
    message: string
  ) {
    super(message);
    this.name = "GraphicServiceError";
  }
}

export interface GraphicService {
  createGraphic(sessionId: number, userId: number, data: CreateGraphicDTO): Promise<GraphicVO>;
  updateGraphic(sessionId: number, userId: number, objectKey: string, data: UpdateGraphicDTO): Promise<GraphicVO>;
  deleteGraphic(sessionId: number, userId: number, objectKey: string): Promise<void>;
  getGraphics(sessionId: number, sinceVersion?: number): Promise<GraphicsResult>;
}

// 兼容 MySQL decimal/string 数值字段，统一转换为 number。
const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toIsoString = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

// 数据库行到 VO 的统一映射，避免字段转换散落在业务流程中。
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
    zIndex: row.z_index,
    version: toNumber(row.version),
    creatorId: row.creator_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
};

const assertFiniteNumber = (value: unknown, fieldName: string): void => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GraphicServiceError("INVALID_ARGUMENT", `${fieldName} 参数错误`);
  }
};

const assertString = (value: unknown, fieldName: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GraphicServiceError("INVALID_ARGUMENT", `${fieldName} 参数错误`);
  }
};

// 图形写操作依赖会话存在，优先在 service 层拦截。
const assertSessionExists = async (sessionId: number): Promise<void> => {
  const sessionVersion = await findSessionCurrentVersion(sessionId);
  if (sessionVersion === null) {
    throw new GraphicServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
};

// 图形读写都要求会话成员权限。
const assertSessionMember = async (sessionId: number, userId: number): Promise<void> => {
  const member = await findSessionMember(sessionId, userId);
  if (!member) {
    throw new GraphicServiceError("SESSION_FORBIDDEN", "无会话访问权限");
  }
};

// 每次图形变更都推进会话版本，确保增量同步可按 version 拉取。
const getNextVersion = async (sessionId: number, connection: PoolConnection): Promise<number> => {
  const nextVersion = await incrementSessionVersion(sessionId, connection);
  if (nextVersion === null) {
    throw new GraphicServiceError("SESSION_NOT_FOUND", "会话不存在");
  }
  return nextVersion;
};

// 创建图形参数校验：类型、坐标、样式字段都在这里统一收口。
const normalizeCreateGraphicData = (data: CreateGraphicDTO): CreateGraphicDTO => {
  assertString(data.objectKey, "objectKey");
  if (!GRAPHIC_TYPES.includes(data.objectType)) {
    throw new GraphicServiceError("INVALID_ARGUMENT", "objectType 参数错误");
  }
  assertFiniteNumber(data.positionX, "positionX");
  assertFiniteNumber(data.positionY, "positionY");
  assertString(data.strokeColor, "strokeColor");
  assertFiniteNumber(data.strokeWidth, "strokeWidth");
  assertFiniteNumber(data.zIndex, "zIndex");

  if (typeof data.width !== "undefined") {
    assertFiniteNumber(data.width, "width");
  }
  if (typeof data.height !== "undefined") {
    assertFiniteNumber(data.height, "height");
  }
  if (typeof data.fillColor !== "undefined" && data.fillColor !== null) {
    assertString(data.fillColor, "fillColor");
  }
  if (typeof data.textContent !== "undefined" && data.textContent !== null && typeof data.textContent !== "string") {
    throw new GraphicServiceError("INVALID_ARGUMENT", "textContent 参数错误");
  }
  if (typeof data.fontSize !== "undefined") {
    assertFiniteNumber(data.fontSize, "fontSize");
  }

  return data;
};

// 更新图形参数校验：至少包含一个可更新字段。
const normalizeUpdateGraphicData = (data: UpdateGraphicDTO): UpdateGraphicDTO => {
  const keys = Object.keys(data) as Array<keyof UpdateGraphicDTO>;
  if (keys.length === 0) {
    throw new GraphicServiceError("INVALID_ARGUMENT", "更新参数不能为空");
  }

  if (typeof data.positionX !== "undefined") {
    assertFiniteNumber(data.positionX, "positionX");
  }
  if (typeof data.positionY !== "undefined") {
    assertFiniteNumber(data.positionY, "positionY");
  }
  if (typeof data.width !== "undefined") {
    assertFiniteNumber(data.width, "width");
  }
  if (typeof data.height !== "undefined") {
    assertFiniteNumber(data.height, "height");
  }
  if (typeof data.strokeColor !== "undefined") {
    assertString(data.strokeColor, "strokeColor");
  }
  if (typeof data.fillColor !== "undefined") {
    assertString(data.fillColor, "fillColor");
  }
  if (typeof data.strokeWidth !== "undefined") {
    assertFiniteNumber(data.strokeWidth, "strokeWidth");
  }
  if (typeof data.textContent !== "undefined" && typeof data.textContent !== "string") {
    throw new GraphicServiceError("INVALID_ARGUMENT", "textContent 参数错误");
  }
  if (typeof data.fontSize !== "undefined") {
    assertFiniteNumber(data.fontSize, "fontSize");
  }
  if (typeof data.zIndex !== "undefined") {
    assertFiniteNumber(data.zIndex, "zIndex");
  }

  return data;
};

const graphicServiceImpl: GraphicService = {
  async createGraphic(sessionId: number, userId: number, data: CreateGraphicDTO): Promise<GraphicVO> {
    const normalizedData = normalizeCreateGraphicData(data);
    await assertSessionExists(sessionId);
    await assertSessionMember(sessionId, userId);

    const existsGraphic = await findGraphicByObjectKey(sessionId, normalizedData.objectKey, true);
    if (existsGraphic) {
      // object_key 由调用方生成，服务层只做唯一性保护。
      throw new GraphicServiceError("GRAPHIC_EXISTS", "图形对象已存在");
    }

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      // 版本号递增和图形写入放在同一事务中，避免版本与数据不一致。
      const nextVersion = await getNextVersion(sessionId, connection);

      const graphicId = await insertGraphicObject(
        {
          sessionId,
          objectKey: normalizedData.objectKey,
          objectType: normalizedData.objectType,
          positionX: normalizedData.positionX,
          positionY: normalizedData.positionY,
          width: typeof normalizedData.width === "number" ? normalizedData.width : null,
          height: typeof normalizedData.height === "number" ? normalizedData.height : null,
          strokeColor: normalizedData.strokeColor,
          fillColor: typeof normalizedData.fillColor === "string" ? normalizedData.fillColor : null,
          strokeWidth: normalizedData.strokeWidth,
          textContent: typeof normalizedData.textContent === "string" ? normalizedData.textContent : null,
          fontSize: typeof normalizedData.fontSize === "number" ? normalizedData.fontSize : null,
          zIndex: normalizedData.zIndex,
          version: nextVersion,
          creatorId: userId
        },
        connection
      );

      await connection.commit();

      const createdGraphic = await findGraphicById(graphicId);
      if (!createdGraphic) {
        throw new GraphicServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }

      return toGraphicVO(createdGraphic);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async updateGraphic(sessionId: number, userId: number, objectKey: string, data: UpdateGraphicDTO): Promise<GraphicVO> {
    assertString(objectKey, "objectKey");
    const normalizedData = normalizeUpdateGraphicData(data);
    await assertSessionExists(sessionId);
    await assertSessionMember(sessionId, userId);

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const targetGraphic = await findGraphicByObjectKey(sessionId, objectKey, true, connection);
      if (!targetGraphic || targetGraphic.is_deleted === 1) {
        throw new GraphicServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }

      // 更新图形时也要推进会话版本，供协同增量同步使用。
      const nextVersion = await getNextVersion(sessionId, connection);
      await updateGraphicObjectById(
        targetGraphic.id,
        {
          positionX: normalizedData.positionX,
          positionY: normalizedData.positionY,
          width: typeof normalizedData.width === "number" ? normalizedData.width : undefined,
          height: typeof normalizedData.height === "number" ? normalizedData.height : undefined,
          strokeColor: normalizedData.strokeColor,
          fillColor: typeof normalizedData.fillColor === "string" ? normalizedData.fillColor : undefined,
          strokeWidth: normalizedData.strokeWidth,
          textContent: typeof normalizedData.textContent === "string" ? normalizedData.textContent : undefined,
          fontSize: typeof normalizedData.fontSize === "number" ? normalizedData.fontSize : undefined,
          zIndex: normalizedData.zIndex
        },
        nextVersion,
        connection
      );

      await connection.commit();

      const updatedGraphic = await findGraphicById(targetGraphic.id);
      if (!updatedGraphic) {
        throw new GraphicServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }

      return toGraphicVO(updatedGraphic);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async deleteGraphic(sessionId: number, userId: number, objectKey: string): Promise<void> {
    assertString(objectKey, "objectKey");
    await assertSessionExists(sessionId);
    await assertSessionMember(sessionId, userId);

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();

      const targetGraphic = await findGraphicByObjectKey(sessionId, objectKey, true, connection);
      if (!targetGraphic || targetGraphic.is_deleted === 1) {
        throw new GraphicServiceError("GRAPHIC_NOT_FOUND", "图形对象不存在");
      }

      // 删除采用软删除，保留历史对象供审计和回放。
      const nextVersion = await getNextVersion(sessionId, connection);
      await softDeleteGraphicById(targetGraphic.id, nextVersion, connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getGraphics(sessionId: number, sinceVersion?: number): Promise<GraphicsResult> {
    const currentVersion = await findSessionCurrentVersion(sessionId);
    if (currentVersion === null) {
      throw new GraphicServiceError("SESSION_NOT_FOUND", "会话不存在");
    }

    const graphicsRows = await findActiveGraphicsBySessionId(sessionId, sinceVersion);
    return {
      currentVersion,
      // 仅返回 is_deleted=0 的对象；增量由 model 层按 version 过滤。
      graphics: graphicsRows.map(toGraphicVO)
    };
  }
};

// 给 WebSocket 模块使用的服务对象。
export const graphicService: GraphicService = graphicServiceImpl;

// 提供给 HTTP 层的会话 key 查询入口（包含会话成员权限校验）。
export const getSessionGraphicsBySessionKey = async (
  sessionKey: string,
  userId: number,
  sinceVersion?: number
): Promise<GraphicsResult> => {
  const session = await findSessionBySessionKey(sessionKey);
  if (!session) {
    throw new GraphicServiceError("SESSION_NOT_FOUND", "会话不存在");
  }

  // HTTP 层按 session_key 定位会话后复用同一套图形服务逻辑。
  await assertSessionMember(session.id, userId);
  return graphicService.getGraphics(session.id, sinceVersion);
};

export const createGraphic = graphicService.createGraphic.bind(graphicService);
export const updateGraphic = graphicService.updateGraphic.bind(graphicService);
export const deleteGraphic = graphicService.deleteGraphic.bind(graphicService);
export const getGraphics = graphicService.getGraphics.bind(graphicService);
