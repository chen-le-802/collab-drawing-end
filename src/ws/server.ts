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

type VerifyResult = {
  ok: boolean;
  userId?: number;
  username?: string;
  token?: string;
};

const WS_PATH = "/ws";
const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;
let currentWsHandler: ReturnType<typeof createWsHandler> | null = null;

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

  wsServer.on("connection", (socket: WebSocket, req: IncomingMessage) => {
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
      joinedSessionKeys: new Set<string>(),
      sessionIdCache: new Map<string, number>(),
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
    clearInterval(heartbeatTimer);
    void closeWsSubscriber();
    void closeRedis();
  });

  return wsServer;
};

export const broadcastSessionPausedEvent = async (sessionKey: string, userId: number): Promise<void> => {
  if (!currentWsHandler) {
    return;
  }
  await currentWsHandler.broadcastSessionPaused(sessionKey, userId);
};

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
