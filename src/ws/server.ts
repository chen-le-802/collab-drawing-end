import { IncomingMessage } from "http";
import { URL } from "url";

import jwt from "jsonwebtoken";
import { Server as HttpServer } from "node:http";
import WebSocket, { VerifyClientCallbackAsync, WebSocketServer } from "ws";

import { env } from "../config/env";
import { closeRedis, initRedis, isRedisEnabled } from "../config/redis";
import { findValidAuthTokenByToken } from "../models/authTokenModel";
import { findUserById } from "../models/userModel";
import { AuthPayload } from "../types";
import { closeWsSubscriber, initWsSubscriber } from "./pubsub";
import { createWsHandler } from "./handler";
import { AuthedWebSocket } from "./types";

// 握手鉴权结果结构：只有 ok=true 且 userId/username/token 完整时才允许升级 WS。
type VerifyResult = {
  ok: boolean;
  userId?: number;
  username?: string;
  token?: string;
};

// WebSocket 固定入口与连接存活检查间隔。
const WS_PATH = "/ws";
const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;
// 对外广播能力依赖的当前 handler 引用（用于 HTTP 侧触发 WS 广播）。
let currentWsHandler: ReturnType<typeof createWsHandler> | null = null;

// 解析升级请求 URL。解析失败时返回 null，后续走鉴权失败分支。
const parseRequestUrl = (req: IncomingMessage): URL | null => {
  if (!req.url) {
    return null;
  }

  try {
    return new URL(req.url, "http://localhost");
  } catch (_error) {
    return null;
  }
};

// 从握手请求中执行 WS 鉴权：
// 1) 校验路径必须是 /ws
// 2) 提取 query token
// 3) JWT 验签
// 4) auth_tokens 表二次校验（支持服务端主动失效）
// 5) 校验用户存在
// 通过才允许升级连接。
const verifyTokenFromRequest = async (req: IncomingMessage): Promise<VerifyResult> => {
  const parsedUrl = parseRequestUrl(req);
  if (!parsedUrl || parsedUrl.pathname !== WS_PATH) {
    return { ok: false };
  }

  const token = parsedUrl.searchParams.get("token");
  if (!token) {
    return { ok: false };
  }

  try {
    // WS 鉴权与 HTTP 登录态共用 JWT + token 表双重校验，支持服务端主动失效。
    const decoded = jwt.verify(token, env.jwtSecret) as AuthPayload;
    const storedToken = await findValidAuthTokenByToken(token);
    if (!storedToken || storedToken.userId !== decoded.userId) {
      return { ok: false };
    }

    const user = await findUserById(decoded.userId);
    if (!user) {
      return { ok: false };
    }

    return {
      ok: true,
      userId: decoded.userId,
      username: user.username,
      token
    };
  } catch (_error) {
    return { ok: false };
  }
};

// ws.verifyClient 回调包装：
// 使用 WeakMap 暂存鉴权结果，待 connection 事件里初始化 clientData。
const toVerifyClient = (
  authCache: WeakMap<IncomingMessage, { userId: number; username: string; token: string }>
): VerifyClientCallbackAsync => {
  return async (info, done): Promise<void> => {
    const result = await verifyTokenFromRequest(info.req);
    if (!result.ok || typeof result.userId !== "number" || !result.username || !result.token) {
      done(false, 401, "Unauthorized");
      return;
    }

    authCache.set(info.req, {
      userId: result.userId,
      username: result.username,
      token: result.token
    });
    done(true);
  };
};

// 初始化 WebSocket 服务：
// 创建 rooms（房间索引）
// 创建 userConnections（用户连接索引）
// 创建 handler = createWsHandler(...)
// 如启用 Redis，订阅跨节点广播
// 创建 WebSocketServer
export const initWebSocketServer = (httpServer: HttpServer): WebSocketServer => {
  const authCache = new WeakMap<IncomingMessage, { userId: number; username: string; token: string }>();
  const rooms = new Map<string, Set<AuthedWebSocket>>();
  const userConnections = new Map<number, Set<AuthedWebSocket>>();
  const handler = createWsHandler({ rooms, userConnections });
  currentWsHandler = handler;

  if (isRedisEnabled()) {
    // 多实例模式：订阅 Redis 广播，把其他节点的 WS 消息转发到本节点房间。
    void initRedis()
      .then(async () => {
        await initWsSubscriber({
          onMessage: (payload) => {
            handler.handleRedisBroadcast(payload);
          }
        });
      })
      .catch((error) => {
        console.error("[redis] init failed:", error instanceof Error ? error.message : error);
      });
  }

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    verifyClient: toVerifyClient(authCache)
  });

//   每次新连接：
// 取鉴权缓存
// 初始化 ws.clientData（userId、joinedSessionKeys、sessionIdCache、lastSeenAt）
// handler.recordConnection(ws)
// 如 URL 带 sessionKey -> autoJoinIfNeeded
// 绑定 message/close/error 事件，分别交给 handler
  wsServer.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    // verifyClient 已通过，此处从缓存取鉴权结果并挂到 ws.clientData。
    const clientData = authCache.get(req);
    if (!clientData) {
      socket.close(1008, "Unauthorized");
      return;
    }

    const ws = socket as AuthedWebSocket;
    ws.clientData = {
      userId: clientData.userId,
      username: clientData.username,
      token: clientData.token,
      // 同一连接可能加入多个会话，记录其房间集合用于清理与广播过滤。
      joinedSessionKeys: new Set<string>(),
      // sessionKey -> sessionId 缓存，减少重复数据库访问。
      sessionIdCache: new Map<string, number>(),
      // 最近一次活动时间，用于心跳超时回收。
      lastSeenAt: Date.now()
    };
    handler.recordConnection(ws);

    const url = parseRequestUrl(req);
    const sessionKey = url?.searchParams.get("sessionKey") ?? null;
    // 支持连接时携带 sessionKey 自动入房，减少前端一次额外 join 往返。
    void handler.autoJoinIfNeeded(ws, sessionKey);

    ws.on("message", async (raw) => {
      await handler.handleMessage(ws, raw);
    });

    ws.on("close", async () => {
      await handler.handleClose(ws);
    });

    ws.on("error", () => {
      ws.terminate();
    });
  });

  const heartbeatTimer = setInterval(() => {
    // 定期回收长时间无心跳连接，防止僵尸连接占用房间状态。
    handler.cleanExpiredConnections();
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  wsServer.on("close", () => {
    // 服务关闭时，清理本地定时器与 Redis 相关资源。
    clearInterval(heartbeatTimer);
    void closeWsSubscriber();
    void closeRedis();
  });

  return wsServer;
};

// 供 HTTP 业务层调用：会话暂停状态变化时，主动触发 WS 广播。
export const broadcastSessionPausedEvent = async (sessionKey: string, userId: number): Promise<void> => {
  if (!currentWsHandler) {
    return;
  }
  await currentWsHandler.broadcastSessionPaused(sessionKey, userId);
};

// 供 HTTP 业务层调用：会话恢复成功后，通知在线成员进行画布补偿同步。
export const broadcastSessionRestoredEvent = (
  sessionKey: string,
  payload: {
    targetVersion: number;
    restoredVersion: number;
    operatorUserId: number;
    operatorUsername: string;
    createdCount: number;
    updatedCount: number;
    deletedCount: number;
  }
): void => {
  if (!currentWsHandler) {
    return;
  }
  currentWsHandler.broadcastSessionRestored(sessionKey, {
    sessionKey,
    ...payload
  });
};

// 供 HTTP 业务层调用：成员在线状态变化时，通过 handler 统一广播路径下发。
export const broadcastSessionMemberStatusChangedEvent = (
  sessionKey: string,
  payload: { userId: number; username: string; onlineStatus: 0 | 1 }
): void => {
  if (!currentWsHandler) {
    return;
  }
  currentWsHandler.handleRedisBroadcast({
    sessionKey,
    messageType: "member_status_changed",
    data: {
      sessionKey,
      userId: payload.userId,
      username: payload.username,
      onlineStatus: payload.onlineStatus
    }
  });
};
