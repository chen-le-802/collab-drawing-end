import { IncomingMessage } from "http";
import { URL } from "url";

import jwt from "jsonwebtoken";
import { Server as HttpServer } from "node:http";
import WebSocket, { VerifyClientCallbackAsync, WebSocketServer } from "ws";

import { env } from "../config/env";
import { findValidAuthTokenByToken } from "../models/authTokenModel";
import { findUserById } from "../models/userModel";
import { AuthPayload } from "../types";
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
      lastSeenAt: Date.now()
    };
    handler.recordConnection(ws);

    const url = parseRequestUrl(req);
    const sessionKey = url?.searchParams.get("sessionKey") ?? null;
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
    handler.cleanExpiredConnections();
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  wsServer.on("close", () => {
    clearInterval(heartbeatTimer);
  });

  return wsServer;
};
