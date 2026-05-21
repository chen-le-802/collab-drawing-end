import request from "supertest";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";

import app from "../src/app";
import { dbPool } from "../src/config/db";
import { env } from "../src/config/env";
import { operationService } from "../src/services/operationService";
import { undoService } from "../src/services/undoService";
import { initWebSocketServer } from "../src/ws/server";

type AuthContext = {
  token: string;
  userId: number;
  username: string;
  password: string;
};

const isDbReady = Boolean(env.dbName);
const TEST_USER_PREFIX = "it_";

const randomText = (): string => {
  return `${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
};

const authHeader = (token: string): { Authorization: string } => {
  return { Authorization: `Bearer ${token}` };
};

type WsMessage = {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
};

type WsTestClient = {
  ws: WebSocket;
  send: (type: string, data: Record<string, unknown>) => void;
  waitFor: (predicate: (message: WsMessage) => boolean, timeoutMs?: number) => Promise<WsMessage>;
  close: () => Promise<void>;
};

const connectWsClient = async (baseUrl: string, token: string, sessionKey: string): Promise<WsTestClient> => {
  const wsUrl = `${baseUrl}?token=${encodeURIComponent(token)}&sessionKey=${encodeURIComponent(sessionKey)}`;
  const ws = new WebSocket(wsUrl);
  const messages: WsMessage[] = [];
  const pushMessage = (raw: WebSocket.RawData): void => {
    try {
      const parsed = JSON.parse(raw.toString()) as WsMessage;
      if (parsed && typeof parsed.type === "string" && typeof parsed.timestamp === "number") {
        messages.push(parsed);
      }
    } catch {
      // ignore broken payload
    }
  };

  // 先监听消息，再等待 open，避免连接建立瞬间推送的 session_joined 丢失。
  ws.on("message", pushMessage);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 6000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const waitFor = async (predicate: (message: WsMessage) => boolean, timeoutMs = 6000): Promise<WsMessage> => {
    return await new Promise<WsMessage>((resolve, reject) => {
      const fromCache = messages.find(predicate);
      if (fromCache) {
        resolve(fromCache);
        return;
      }
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("ws waitFor timeout"));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(raw.toString()) as WsMessage;
          if (!parsed || typeof parsed.type !== "string" || typeof parsed.timestamp !== "number") {
            return;
          }
          if (!predicate(parsed)) {
            return;
          }
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(parsed);
        } catch {
          // ignore broken payload
        }
      };
      ws.on("message", onMessage);
    });
  };

  return {
    ws,
    send: (type, data) => {
      ws.send(
        JSON.stringify({
          type,
          data,
          timestamp: Date.now()
        })
      );
    },
    waitFor,
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return;
      }
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  };
};

const cleanupTestData = async (): Promise<void> => {
  const [userRows] = await dbPool.query<Array<{ id: number }>>(
    "SELECT id FROM users WHERE username LIKE ?",
    [`${TEST_USER_PREFIX}%`]
  );

  if (!userRows.length) {
    return;
  }

  const userIds = userRows.map((item) => item.id);
  const placeholders = userIds.map(() => "?").join(",");

  const [sessionRows] = await dbPool.query<Array<{ id: number }>>(
    `SELECT id FROM sessions WHERE creator_id IN (${placeholders})`,
    userIds
  );

  const sessionIds = sessionRows.map((item) => item.id);
  if (sessionIds.length > 0) {
    const sessionPlaceholders = sessionIds.map(() => "?").join(",");
    await dbPool.execute(
      `DELETE FROM user_operation_history WHERE session_id IN (${sessionPlaceholders})`,
      sessionIds
    );
    await dbPool.execute(
      `DELETE FROM operations WHERE session_id IN (${sessionPlaceholders})`,
      sessionIds
    );
    await dbPool.execute(
      `DELETE FROM graphic_objects WHERE session_id IN (${sessionPlaceholders})`,
      sessionIds
    );
    await dbPool.execute(
      `DELETE FROM session_members WHERE session_id IN (${sessionPlaceholders})`,
      sessionIds
    );
    await dbPool.execute(
      `DELETE FROM sessions WHERE id IN (${sessionPlaceholders})`,
      sessionIds
    );
  }

  await dbPool.execute(
    `DELETE FROM session_members WHERE user_id IN (${placeholders})`,
    userIds
  );
  await dbPool.execute(
    `DELETE FROM auth_tokens WHERE user_id IN (${placeholders})`,
    userIds
  );
  await dbPool.execute(
    `DELETE FROM users WHERE id IN (${placeholders})`,
    userIds
  );
};

const registerAndLogin = async (): Promise<AuthContext> => {
  const username = `${TEST_USER_PREFIX}${randomText()}`;
  const password = "123456";

  const registerRes = await request(app)
    .post("/api/v1/users/register")
    .send({ username, password });
  expect(registerRes.status).toBe(200);
  expect(registerRes.body.code).toBe(0);

  const loginRes = await request(app)
    .post("/api/v1/users/login")
    .send({ username, password });
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.code).toBe(0);
  expect(typeof loginRes.body.data?.token).toBe("string");

  const token = loginRes.body.data.token as string;
  const meRes = await request(app)
    .get("/api/v1/users/me")
    .set(authHeader(token));
  expect(meRes.status).toBe(200);
  expect(meRes.body.code).toBe(0);

  return {
    token,
    userId: meRes.body.data.id,
    username,
    password
  };
};

const suite = isDbReady ? describe : describe.skip;

suite("API integration", () => {
  let wsHttpServer: HttpServer | null = null;
  let wsBaseUrl = "";

  const startWsServer = async (): Promise<void> => {
    if (wsHttpServer) {
      return;
    }
    wsHttpServer = createServer(app);
    initWebSocketServer(wsHttpServer);
    await new Promise<void>((resolve, reject) => {
      wsHttpServer!.once("error", reject);
      wsHttpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = wsHttpServer.address() as AddressInfo | null;
    if (!addr || typeof addr.port !== "number") {
      throw new Error("ws test server start failed");
    }
    wsBaseUrl = `ws://127.0.0.1:${addr.port}/ws`;
  };

  const stopWsServer = async (): Promise<void> => {
    if (!wsHttpServer) {
      return;
    }
    const server = wsHttpServer;
    wsHttpServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  const createSessionAndJoinByInvite = async (owner: AuthContext, joiner: AuthContext): Promise<{ sessionId: number; sessionKey: string }> => {
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `ws一致性_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const sessionId = createSessionRes.body.data.sessionId as number;

    const createInviteRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/invites`)
      .set(authHeader(owner.token))
      .send({ role: 1 });
    expect(createInviteRes.body.code).toBe(0);
    const inviteToken = createInviteRes.body.data.inviteToken as string;

    const joinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token))
      .send({ inviteToken });
    expect(joinRes.body.code).toBe(0);

    return { sessionId, sessionKey };
  };

  beforeAll(async () => {
    await cleanupTestData();
    await startWsServer();
  });

  afterAll(async () => {
    await cleanupTestData();
    await stopWsServer();
    await dbPool.end();
  });

  it("register/login/me/logout success and invalid token handling", async () => {
    const username = `${TEST_USER_PREFIX}${randomText()}`;
    const password = "123456";

    const registerRes = await request(app)
      .post("/api/v1/users/register")
      .send({ username, password });
    expect(registerRes.body.code).toBe(0);

    const duplicateRes = await request(app)
      .post("/api/v1/users/register")
      .send({ username, password });
    expect(duplicateRes.body.code).toBe(3002);

    const loginRes = await request(app)
      .post("/api/v1/users/login")
      .send({ username, password });
    expect(loginRes.body.code).toBe(0);
    const token = loginRes.body.data.token as string;

    const meRes = await request(app)
      .get("/api/v1/users/me")
      .set(authHeader(token));
    expect(meRes.body.code).toBe(0);
    expect(meRes.headers["x-request-id"]).toBeTruthy();

    const invalidTokenRes = await request(app)
      .get("/api/v1/users/me")
      .set(authHeader("invalid_token"));
    expect(invalidTokenRes.body.code).toBe(2002);

    const logoutRes = await request(app)
      .post("/api/v1/users/logout")
      .set(authHeader(token));
    expect(logoutRes.body.code).toBe(0);

    const meAfterLogoutRes = await request(app)
      .get("/api/v1/users/me")
      .set(authHeader(token));
    expect(meAfterLogoutRes.body.code).toBe(2002);
  });

  it("keeps /v1/user/* compatibility path for login", async () => {
    const username = `${TEST_USER_PREFIX}${randomText()}`;
    const password = "123456";

    const registerRes = await request(app)
      .post("/api/v1/users/register")
      .send({ username, password });
    expect(registerRes.body.code).toBe(0);

    const loginAliasRes = await request(app)
      .post("/api/v1/user/login")
      .send({ username, password });
    expect(loginAliasRes.body.code).toBe(0);
    expect(typeof loginAliasRes.body.data?.token).toBe("string");
  });

  it("join is idempotent and leave hides session from joined list", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionKey = createSessionRes.body.data.sessionKey as string;

    const createInviteRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/invites`)
      .set(authHeader(owner.token))
      .send({ role: 1 });
    expect(createInviteRes.body.code).toBe(0);
    const inviteToken = createInviteRes.body.data.inviteToken as string;

    const firstJoinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token))
      .send({ inviteToken });
    expect(firstJoinRes.body.code).toBe(0);

    const secondJoinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token))
      .send({ inviteToken });
    expect(secondJoinRes.body.code).toBe(0);

    const joinedListRes = await request(app)
      .get("/api/v1/sessions")
      .set(authHeader(joiner.token));
    expect(joinedListRes.body.code).toBe(0);
    const joinedKeys = (joinedListRes.body.data.list as Array<{ sessionKey: string }>).map((item) => item.sessionKey);
    expect(joinedKeys).toContain(sessionKey);

    const leaveRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/leave`)
      .set(authHeader(joiner.token));
    expect(leaveRes.body.code).toBe(0);

    const joinedListAfterLeaveRes = await request(app)
      .get("/api/v1/sessions")
      .set(authHeader(joiner.token));
    expect(joinedListAfterLeaveRes.body.code).toBe(0);
    const joinedKeysAfterLeave = (joinedListAfterLeaveRes.body.data.list as Array<{ sessionKey: string }>).map(
      (item) => item.sessionKey
    );
    expect(joinedKeysAfterLeave).not.toContain(sessionKey);
  });

  it("forbids graphics access after member leaves session", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionKey } = await createSessionAndJoinByInvite(owner, joiner);

    const leaveRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/leave`)
      .set(authHeader(joiner.token));
    expect(leaveRes.body.code).toBe(0);

    const graphicsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(joiner.token));
    expect(graphicsRes.body.code).toBe(2003);
  });

  it("returns full/incremental graphics by sinceVersion", async () => {
    const owner = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `图形会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKeyV1 = `obj_${randomText()}_v1`;
    const objectKeyV2 = `obj_${randomText()}_v2`;

    await dbPool.execute(
      `INSERT INTO graphic_objects
      (session_id, object_type, object_key, position_x, position_y, width, height, stroke_color, fill_color, stroke_width, text_content, font_size, z_index, version, creator_id, is_deleted)
      VALUES (?, 'rect', ?, 10, 10, 100, 80, '#000000', '#ffffff', 2, NULL, NULL, 1, 1, ?, 0),
             (?, 'rect', ?, 30, 30, 120, 90, '#000000', '#ffffff', 2, NULL, NULL, 2, 2, ?, 0)`,
      [sessionId, objectKeyV1, owner.userId, sessionId, objectKeyV2, owner.userId]
    );
    await dbPool.execute("UPDATE sessions SET current_version = 2 WHERE id = ?", [sessionId]);

    const fullRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(fullRes.body.code).toBe(0);
    expect(fullRes.body.data.currentVersion).toBe(2);
    const fullKeys = (fullRes.body.data.graphics as Array<{ objectKey: string }>).map((item) => item.objectKey);
    expect(fullKeys).toContain(objectKeyV1);
    expect(fullKeys).toContain(objectKeyV2);

    const incrementalRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics?sinceVersion=1`)
      .set(authHeader(owner.token));
    expect(incrementalRes.body.code).toBe(0);
    expect(incrementalRes.body.data.currentVersion).toBe(2);
    const incrementalKeys = (incrementalRes.body.data.graphics as Array<{ objectKey: string }>).map(
      (item) => item.objectKey
    );
    expect(incrementalKeys).toContain(objectKeyV2);
    expect(incrementalKeys).not.toContain(objectKeyV1);
  });

  it("returns incremental operations by sinceVersion", async () => {
    const owner = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `操作会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}`;
    const operationIdV1 = `op_${randomText()}_1`;
    const operationIdV2 = `op_${randomText()}_2`;

    await dbPool.execute(
      `INSERT INTO operations (
        operation_id, session_id, user_id, object_key, operation_type, operation_data,
        base_version, server_version, version, lamport_time, client_id, resolved_result, conflict_type, timestamp, undoable, redoable
      ) VALUES
      (?, ?, ?, ?, 'create', JSON_OBJECT('objectKey', ?, 'positionX', 10), 0, 1, 1, 1, 'it_client', JSON_OBJECT('ok', 1), 'none', UNIX_TIMESTAMP() * 1000, 1, 0),
      (?, ?, ?, ?, 'update', JSON_OBJECT('objectKey', ?, 'positionX', 20), 1, 2, 2, 2, 'it_client', JSON_OBJECT('ok', 1), 'field_merge', UNIX_TIMESTAMP() * 1000, 1, 0)`,
      [
        operationIdV1, sessionId, owner.userId, objectKey, objectKey,
        operationIdV2, sessionId, owner.userId, objectKey, objectKey
      ]
    );
    await dbPool.execute("UPDATE sessions SET current_version = 2 WHERE id = ?", [sessionId]);

    const res = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/operations?sinceVersion=1`)
      .set(authHeader(owner.token));

    expect(res.body.code).toBe(0);
    expect(res.body.data.currentVersion).toBe(2);
    expect(Array.isArray(res.body.data.operations)).toBe(true);
    expect(res.body.data.operations.length).toBe(1);
    expect(res.body.data.operations[0].operationId).toBe(operationIdV2);
    expect(res.body.data.operations[0].serverVersion).toBe(2);
  });

  it("returns session conflict logs by sinceId", async () => {
    const owner = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `冲突会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}`;
    const operationId = `op_${randomText()}_conflict`;

    const [operationResult] = await dbPool.execute<any>(
      `INSERT INTO operations (
        operation_id, session_id, user_id, object_key, operation_type, operation_data,
        base_version, server_version, version, lamport_time, client_id, resolved_result, conflict_type, timestamp, undoable, redoable
      ) VALUES
      (?, ?, ?, ?, 'update', JSON_OBJECT('objectKey', ?, 'positionX', 40), 2, 3, 3, 3, 'it_client', JSON_OBJECT('ok', 1), 'field_conflict', UNIX_TIMESTAMP() * 1000, 1, 0)`,
      [operationId, sessionId, owner.userId, objectKey, objectKey]
    );
    const operationRefId = Number(operationResult.insertId);

    await dbPool.execute(
      `INSERT INTO conflict_logs (
        operation_ref_id, operation_id, session_id, object_key, conflict_type, field_name,
        current_value, incoming_value, resolved_value, resolve_strategy
      ) VALUES (?, ?, ?, ?, 'field_conflict', 'positionX', CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), 'lamport_then_client_id')`,
      [operationRefId, operationId, sessionId, objectKey, JSON.stringify(20), JSON.stringify(40), JSON.stringify(20)]
    );

    const res = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/conflicts?sinceId=0&limit=20`)
      .set(authHeader(owner.token));

    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data.conflicts)).toBe(true);
    expect(res.body.data.conflicts.length).toBeGreaterThan(0);
    const hit = (res.body.data.conflicts as Array<Record<string, unknown>>).find(
      (item) => item.operationId === operationId
    );
    expect(hit).toBeTruthy();
    expect(hit?.conflictType).toBe("field_conflict");
    expect(hit?.fieldName).toBe("positionX");
  });

  it("creates snapshots and returns replay operations to targetVersion", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `回放会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}_replay`;

    await dbPool.execute(
      `INSERT INTO operations (
        operation_id, session_id, user_id, object_key, operation_type, operation_data,
        base_version, server_version, version, lamport_time, client_id, resolved_result, conflict_type, timestamp, undoable, redoable
      ) VALUES
      (?, ?, ?, ?, 'create', JSON_OBJECT('objectKey', ?, 'positionX', 10), 0, 1, 1, 1, 'it_client', JSON_OBJECT('ok', 1), 'none', UNIX_TIMESTAMP() * 1000, 1, 0),
      (?, ?, ?, ?, 'update', JSON_OBJECT('objectKey', ?, 'positionX', 30), 1, 2, 2, 2, 'it_client', JSON_OBJECT('ok', 1), 'field_merge', UNIX_TIMESTAMP() * 1000, 1, 0)`,
      [
        `op_${randomText()}_r1`, sessionId, owner.userId, objectKey, objectKey,
        `op_${randomText()}_r2`, sessionId, owner.userId, objectKey, objectKey
      ]
    );
    await dbPool.execute(
      `INSERT INTO graphic_objects
      (session_id, object_type, object_key, position_x, position_y, width, height, stroke_color, fill_color, stroke_width, text_content, font_size, z_index, version, creator_id, is_deleted)
      VALUES (?, 'rect', ?, 30, 20, 100, 80, '#111111', '#ffffff', 2, NULL, NULL, 1, 2, ?, 0)`,
      [sessionId, objectKey, owner.userId]
    );
    await dbPool.execute("UPDATE sessions SET current_version = 2 WHERE id = ?", [sessionId]);

    const createSnapshotRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/snapshots`)
      .set(authHeader(owner.token));
    expect(createSnapshotRes.body.code).toBe(0);
    expect(createSnapshotRes.body.data.version).toBe(2);

    const listSnapshotsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/snapshots?limit=10`)
      .set(authHeader(owner.token));
    expect(listSnapshotsRes.body.code).toBe(0);
    expect(Array.isArray(listSnapshotsRes.body.data.snapshots)).toBe(true);
    expect(listSnapshotsRes.body.data.snapshots.length).toBeGreaterThan(0);

    const replayRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/replay?targetVersion=2`)
      .set(authHeader(owner.token));
    expect(replayRes.body.code).toBe(0);
    expect(replayRes.body.data.targetVersion).toBe(2);
    expect(Array.isArray(replayRes.body.data.operations)).toBe(true);
  });

  it("creates named snapshot and returns snapshotName/createdByName in list", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `命名快照_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionKey = createSessionRes.body.data.sessionKey as string;

    const snapshotName = `评审前备份_${randomText()}`;
    const createSnapshotRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/snapshots`)
      .set(authHeader(owner.token))
      .send({ snapshotName });
    expect(createSnapshotRes.body.code).toBe(0);
    expect(createSnapshotRes.body.data.snapshotName).toBe(snapshotName);

    const listRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/snapshots?limit=10`)
      .set(authHeader(owner.token));
    expect(listRes.body.code).toBe(0);
    const first = (listRes.body.data.snapshots as Array<Record<string, unknown>>)[0];
    expect(first?.snapshotName).toBe(snapshotName);
    expect(first?.createdBy).toBe(owner.userId);
    expect(first?.createdByName).toBe(owner.username);
  });

  it("restores version successfully and returns created/updated/deleted counts", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `恢复会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}_restore`;

    await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 20,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_restore_create`,
        clientId: "it_client_restore",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 200, positionY: 210 },
      {
        operationId: `op_${randomText()}_restore_update`,
        clientId: "it_client_restore",
        baseVersion: 1,
        lamportTime: Date.now() + 1
      }
    );

    const restoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(owner.token))
      .send({ targetVersion: 1 });
    expect(restoreRes.body.code).toBe(0);
    expect(restoreRes.body.data.targetVersion).toBe(1);
    expect(restoreRes.body.data.previousVersion).toBe(2);
    expect(restoreRes.body.data.restoredVersion).toBe(3);
    expect(restoreRes.body.data.createdCount).toBe(0);
    expect(restoreRes.body.data.updatedCount).toBe(1);
    expect(restoreRes.body.data.deletedCount).toBe(0);

    const graphicsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(graphicsRes.body.code).toBe(0);
    const restoredGraphic = (graphicsRes.body.data.graphics as Array<Record<string, unknown>>).find(
      (item) => item.objectKey === objectKey
    );
    expect(restoredGraphic).toBeTruthy();
    expect(Number(restoredGraphic?.positionX)).toBe(10);
    expect(Number(restoredGraphic?.positionY)).toBe(20);
  });

  it("supports undo/redo after restore-version", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `恢复撤销会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}_restore_undo`;

    await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 20,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_restore_undo_create`,
        clientId: "it_client_restore_undo",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 200, positionY: 210 },
      {
        operationId: `op_${randomText()}_restore_undo_update`,
        clientId: "it_client_restore_undo",
        baseVersion: 1,
        lamportTime: Date.now() + 1
      }
    );

    const restoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(owner.token))
      .send({ targetVersion: 1 });
    expect(restoreRes.body.code).toBe(0);

    const undoMeta = {
      operationId: `op_${randomText()}_restore_undo_undo`,
      clientId: "it_client_restore_undo",
      baseVersion: restoreRes.body.data.restoredVersion as number,
      lamportTime: Date.now() + 2
    };
    const undoRes = await undoService.undo(sessionId, owner.userId, undoMeta);
    expect(undoRes.success).toBe(true);

    const [afterUndoRows] = await dbPool.query<Array<{ position_x: number; position_y: number }>>(
      `SELECT position_x, position_y
       FROM graphic_objects
       WHERE session_id = ? AND object_key = ? AND is_deleted = 0
       LIMIT 1`,
      [sessionId, objectKey]
    );
    expect(Number(afterUndoRows[0]?.position_x)).toBe(200);
    expect(Number(afterUndoRows[0]?.position_y)).toBe(210);

    const redoMeta = {
      operationId: `op_${randomText()}_restore_undo_redo`,
      clientId: "it_client_restore_undo",
      baseVersion: undoRes.currentVersion,
      lamportTime: Date.now() + 3
    };
    const redoRes = await undoService.redo(sessionId, owner.userId, redoMeta);
    expect(redoRes.success).toBe(true);

    const [afterRedoRows] = await dbPool.query<Array<{ position_x: number; position_y: number }>>(
      `SELECT position_x, position_y
       FROM graphic_objects
       WHERE session_id = ? AND object_key = ? AND is_deleted = 0
       LIMIT 1`,
      [sessionId, objectKey]
    );
    expect(Number(afterRedoRows[0]?.position_x)).toBe(10);
    expect(Number(afterRedoRows[0]?.position_y)).toBe(20);
  });

  it("full chain: create/update/delete -> undo/redo -> snapshot restore", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `全链路回归_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}_full_chain`;

    // 1) create
    const createResult = await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 20,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_full_create`,
        clientId: "it_client_full_chain",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );
    const versionAfterCreate = createResult.resolved.serverVersion;

    // 2) update
    const updateResult = await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 200, positionY: 210 },
      {
        operationId: `op_${randomText()}_full_update`,
        clientId: "it_client_full_chain",
        baseVersion: versionAfterCreate,
        lamportTime: Date.now() + 1
      }
    );
    const versionAfterUpdate = updateResult.resolved.serverVersion;

    // 3) snapshot at updated state
    const snapshotRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/snapshots`)
      .set(authHeader(owner.token))
      .send({ snapshotName: `全链路快照_${randomText()}` });
    expect(snapshotRes.body.code).toBe(0);
    expect(snapshotRes.body.data.version).toBe(versionAfterUpdate);

    // 4) delete
    const deleteResult = await operationService.deleteGraphic(
      sessionId,
      owner.userId,
      objectKey,
      {
        operationId: `op_${randomText()}_full_delete`,
        clientId: "it_client_full_chain",
        baseVersion: versionAfterUpdate,
        lamportTime: Date.now() + 2
      }
    );
    expect(deleteResult.deletedObjectKey).toBe(objectKey);

    const afterDeleteRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(afterDeleteRes.body.code).toBe(0);
    const afterDeleteGraphic = (afterDeleteRes.body.data.graphics as Array<Record<string, unknown>>).find(
      (item) => item.objectKey === objectKey
    );
    expect(afterDeleteGraphic).toBeFalsy();

    // 5) undo delete -> object should come back
    const undoDeleteRes = await undoService.undo(sessionId, owner.userId, {
      operationId: `op_${randomText()}_full_undo_delete`,
      clientId: "it_client_full_chain",
      baseVersion: deleteResult.resolved.serverVersion,
      lamportTime: Date.now() + 3
    });
    expect(undoDeleteRes.success).toBe(true);

    const [afterUndoDeleteRows] = await dbPool.query<Array<{ is_deleted: number; position_x: number; position_y: number }>>(
      `SELECT is_deleted, position_x, position_y
       FROM graphic_objects
       WHERE session_id = ? AND object_key = ?
       ORDER BY id DESC
       LIMIT 1`,
      [sessionId, objectKey]
    );
    expect(afterUndoDeleteRows[0]?.is_deleted).toBe(0);
    expect(Number(afterUndoDeleteRows[0]?.position_x)).toBe(200);
    expect(Number(afterUndoDeleteRows[0]?.position_y)).toBe(210);

    // 6) redo delete -> object removed again
    const redoDeleteRes = await undoService.redo(sessionId, owner.userId, {
      operationId: `op_${randomText()}_full_redo_delete`,
      clientId: "it_client_full_chain",
      baseVersion: undoDeleteRes.currentVersion,
      lamportTime: Date.now() + 4
    });
    expect(redoDeleteRes.success).toBe(true);

    const afterRedoDeleteRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(afterRedoDeleteRes.body.code).toBe(0);
    const afterRedoDeleteGraphic = (afterRedoDeleteRes.body.data.graphics as Array<Record<string, unknown>>).find(
      (item) => item.objectKey === objectKey
    );
    expect(afterRedoDeleteGraphic).toBeFalsy();

    // 7) restore snapshot version -> object should be restored to updated position
    const restoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(owner.token))
      .send({ targetVersion: versionAfterUpdate });
    expect(restoreRes.body.code).toBe(0);
    expect(restoreRes.body.data.targetVersion).toBe(versionAfterUpdate);

    const finalGraphicsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(finalGraphicsRes.body.code).toBe(0);
    const finalGraphic = (finalGraphicsRes.body.data.graphics as Array<Record<string, unknown>>).find(
      (item) => item.objectKey === objectKey
    );
    expect(finalGraphic).toBeTruthy();
    expect(Number(finalGraphic?.positionX)).toBe(200);
    expect(Number(finalGraphic?.positionY)).toBe(210);
  });

  it("keeps incremental sync consistent for other members after restore-version", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionId, sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_restore_sync`;

    await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 20,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_restore_sync_create`,
        clientId: "it_client_restore_sync",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 300, positionY: 320 },
      {
        operationId: `op_${randomText()}_restore_sync_update`,
        clientId: "it_client_restore_sync",
        baseVersion: 1,
        lamportTime: Date.now() + 1
      }
    );

    const joinerJoinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token));
    expect(joinerJoinRes.body.code).toBe(0);
    expect(joinerJoinRes.body.data.currentVersion).toBe(2);

    const restoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(owner.token))
      .send({ targetVersion: 1 });
    expect(restoreRes.body.code).toBe(0);
    expect(restoreRes.body.data.restoredVersion).toBe(3);

    const operationsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/operations?sinceVersion=2`)
      .set(authHeader(joiner.token));
    expect(operationsRes.body.code).toBe(0);
    expect(operationsRes.body.data.currentVersion).toBe(3);
    const operations = operationsRes.body.data.operations as Array<Record<string, unknown>>;
    expect(operations.length).toBeGreaterThanOrEqual(1);
    const restoreUpdate = operations.find(
      (item) => item.objectKey === objectKey && item.operationType === "update"
    );
    expect(restoreUpdate).toBeTruthy();

    const graphicsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(joiner.token));
    expect(graphicsRes.body.code).toBe(0);
    const syncedGraphic = (graphicsRes.body.data.graphics as Array<Record<string, unknown>>).find(
      (item) => item.objectKey === objectKey
    );
    expect(syncedGraphic).toBeTruthy();
    expect(Number(syncedGraphic?.positionX)).toBe(10);
    expect(Number(syncedGraphic?.positionY)).toBe(20);
  });

  it("enforces restore-version permissions: viewer/editor forbidden, manager/owner allowed", async () => {
    const owner = await registerAndLogin();
    const viewer = await registerAndLogin();
    const editor = await registerAndLogin();
    const manager = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `恢复权限会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionId = createSessionRes.body.data.sessionId as number;
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const objectKey = `obj_${randomText()}_restore_acl`;

    await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 20,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_restore_acl_create`,
        clientId: "it_client_restore_acl",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );
    await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 220, positionY: 230 },
      {
        operationId: `op_${randomText()}_restore_acl_update`,
        clientId: "it_client_restore_acl",
        baseVersion: 1,
        lamportTime: Date.now() + 1
      }
    );

    const joinByRole = async (userToken: string, role: 0 | 1 | 2): Promise<void> => {
      const inviteRes = await request(app)
        .post(`/api/v1/sessions/${sessionKey}/invites`)
        .set(authHeader(owner.token))
        .send({ role });
      expect(inviteRes.body.code).toBe(0);
      const inviteToken = inviteRes.body.data.inviteToken as string;
      const joinRes = await request(app)
        .post(`/api/v1/sessions/${sessionKey}/join`)
        .set(authHeader(userToken))
        .send({ inviteToken });
      expect(joinRes.body.code).toBe(0);
    };

    await joinByRole(viewer.token, 0);
    await joinByRole(editor.token, 1);
    await joinByRole(manager.token, 2);

    const viewerRestoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(viewer.token))
      .send({ targetVersion: 1 });
    expect(viewerRestoreRes.body.code).toBe(2003);

    const editorRestoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(editor.token))
      .send({ targetVersion: 1 });
    expect(editorRestoreRes.body.code).toBe(2003);

    const managerRestoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(manager.token))
      .send({ targetVersion: 1 });
    expect(managerRestoreRes.body.code).toBe(0);
    expect(managerRestoreRes.body.data.targetVersion).toBe(1);

    const ownerRestoreRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/restore-version`)
      .set(authHeader(owner.token))
      .send({ targetVersion: 2 });
    expect(ownerRestoreRes.body.code).toBe(0);
    expect(ownerRestoreRes.body.data.targetVersion).toBe(2);
  });

  it("undo/redo goes through operation pipeline and keeps history flags", async () => {
    const owner = await registerAndLogin();
    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `撤销会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);

    const sessionId = createSessionRes.body.data.sessionId as number;
    const objectKey = `obj_${randomText()}_undo`;

    const createResult = await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 12,
        width: 100,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_create`,
        clientId: "it_client",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );
    expect(createResult.operationRecordId).toBeTruthy();

    const updateResult = await operationService.updateGraphic(
      sessionId,
      owner.userId,
      objectKey,
      { positionX: 88, positionY: 99 },
      {
        operationId: `op_${randomText()}_update`,
        clientId: "it_client",
        baseVersion: createResult.resolved.serverVersion,
        lamportTime: Date.now() + 1
      }
    );
    expect(updateResult.operationRecordId).toBeTruthy();

    const undoMeta = {
      operationId: `op_${randomText()}_undo`,
      clientId: "it_client_undo",
      baseVersion: updateResult.resolved.serverVersion,
      lamportTime: Date.now() + 2
    };
    const undoRes = await undoService.undo(sessionId, owner.userId, undoMeta);
    expect(undoRes.success).toBe(true);
    expect(undoRes.operation?.operationType).toBe("update_graphic");
    expect(typeof undoRes.resolvedOperationId).toBe("string");
    expect(undoRes.resolvedOperationId).toBe(undoMeta.operationId);

    const [historyRowsAfterUndo] = await dbPool.query<Array<{ can_undo: number; can_redo: number }>>(
      `SELECT can_undo, can_redo
       FROM user_operation_history
       WHERE user_id = ? AND session_id = ? AND operation_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [owner.userId, sessionId, updateResult.operationRecordId!]
    );
    expect(historyRowsAfterUndo[0]?.can_undo).toBe(0);
    expect(historyRowsAfterUndo[0]?.can_redo).toBe(1);

    const redoMeta = {
      operationId: `op_${randomText()}_redo`,
      clientId: "it_client_redo",
      baseVersion: undoRes.currentVersion,
      lamportTime: Date.now() + 3
    };
    const redoRes = await undoService.redo(sessionId, owner.userId, redoMeta);
    expect(redoRes.success).toBe(true);
    expect(redoRes.operation?.operationType).toBe("update_graphic");
    expect(typeof redoRes.resolvedOperationId).toBe("string");
    expect(redoRes.resolvedOperationId).toBe(redoMeta.operationId);

    const [historyRowsAfterRedo] = await dbPool.query<Array<{ can_undo: number; can_redo: number }>>(
      `SELECT can_undo, can_redo
       FROM user_operation_history
       WHERE user_id = ? AND session_id = ? AND operation_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [owner.userId, sessionId, updateResult.operationRecordId!]
    );
    expect(historyRowsAfterRedo[0]?.can_undo).toBe(1);
    expect(historyRowsAfterRedo[0]?.can_redo).toBe(0);
  });

  it("ws consistency: selection_change should sync object selection and clear in realtime", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionId, sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_sel`;

    await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 20,
        positionY: 20,
        width: 120,
        height: 80,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_sel_create`,
        clientId: "it_ws_client",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    const clientA = await connectWsClient(wsBaseUrl, owner.token, sessionKey);
    const clientB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    await clientA.waitFor((m) => m.type === "session_joined");
    await clientB.waitFor((m) => m.type === "session_joined");

    clientA.send("selection_change", { sessionKey, objectKey });
    const selected = await clientB.waitFor(
      (m) => m.type === "presence_selection" && m.data.userId === owner.userId && m.data.objectKey === objectKey
    );
    expect(selected.data.objectKey).toBe(objectKey);

    clientA.send("selection_change", { sessionKey, objectKey: null });
    const cleared = await clientB.waitFor(
      (m) => m.type === "presence_selection" && m.data.userId === owner.userId && m.data.objectKey === null
    );
    expect(cleared.data.objectKey).toBeNull();

    await clientA.close();
    await clientB.close();
  });

  it("ws consistency: update_graphic should sync new position after drag-like update", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionId, sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_drag`;

    const created = await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 30,
        positionY: 40,
        width: 140,
        height: 90,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_drag_create`,
        clientId: "it_ws_client",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    const clientA = await connectWsClient(wsBaseUrl, owner.token, sessionKey);
    const clientB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    await clientA.waitFor((m) => m.type === "session_joined");
    await clientB.waitFor((m) => m.type === "session_joined");

    const nextX = created.graphic!.positionX + 88;
    const nextY = created.graphic!.positionY + 66;
    clientA.send("update_graphic", {
      sessionKey,
      objectKey,
      operationId: `op_${randomText()}_drag_update`,
      clientId: "it_ws_client",
      baseVersion: created.resolved.serverVersion,
      lamportTime: Date.now(),
      patch: {
        positionX: nextX,
        positionY: nextY
      }
    });

    const updated = await clientB.waitFor(
      (m) => m.type === "graphic_updated" && m.data.objectKey === objectKey && m.data.positionX === nextX && m.data.positionY === nextY
    );
    expect(updated.data.positionX).toBe(nextX);
    expect(updated.data.positionY).toBe(nextY);

    await clientA.close();
    await clientB.close();
  });

  it("ws consistency: delete then stale update keeps delete-wins and object stays deleted", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionId, sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_dw`;

    const created = await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 10,
        positionY: 10,
        width: 100,
        height: 60,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_dw_create`,
        clientId: "it_ws_client",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    const clientA = await connectWsClient(wsBaseUrl, owner.token, sessionKey);
    const clientB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    await clientA.waitFor((m) => m.type === "session_joined");
    await clientB.waitFor((m) => m.type === "session_joined");

    const deleteOpId = `op_${randomText()}_dw_delete`;
    clientA.send("delete_graphic", {
      sessionKey,
      objectKey,
      operationId: deleteOpId,
      clientId: "it_ws_client",
      baseVersion: created.resolved.serverVersion,
      lamportTime: Date.now()
    });
    await clientA.waitFor((m) => m.type === "operation_resolved" && m.data.operationId === deleteOpId);

    const staleUpdateOpId = `op_${randomText()}_dw_stale_update`;
    clientB.send("update_graphic", {
      sessionKey,
      objectKey,
      operationId: staleUpdateOpId,
      clientId: "it_ws_client",
      baseVersion: created.resolved.serverVersion,
      lamportTime: Date.now() + 1,
      patch: {
        positionX: 999
      }
    });

    const resolved = await clientB.waitFor(
      (m) => m.type === "operation_resolved" && m.data.operationId === staleUpdateOpId
    );
    expect(resolved.data.conflictType).toBe("delete_wins");

    const graphicsRes = await request(app)
      .get(`/api/v1/sessions/${sessionKey}/graphics`)
      .set(authHeader(owner.token));
    expect(graphicsRes.body.code).toBe(0);
    const keys = (graphicsRes.body.data.graphics as Array<{ objectKey: string }>).map((item) => item.objectKey);
    expect(keys).not.toContain(objectKey);

    await clientA.close();
    await clientB.close();
  });

  it("ws consistency: graphic_deleted payload includes sessionKey/userId/objectKey/currentVersion", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionId, sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_deleted_payload`;

    const created = await operationService.createGraphic(
      sessionId,
      owner.userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 48,
        positionY: 52,
        width: 110,
        height: 70,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: 1
      },
      {
        operationId: `op_${randomText()}_deleted_payload_create`,
        clientId: "it_ws_client",
        baseVersion: 0,
        lamportTime: Date.now()
      }
    );

    const clientA = await connectWsClient(wsBaseUrl, owner.token, sessionKey);
    const clientB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    await clientA.waitFor((m) => m.type === "session_joined");
    await clientB.waitFor((m) => m.type === "session_joined");

    const deleteOpId = `op_${randomText()}_deleted_payload_delete`;
    clientA.send("delete_graphic", {
      sessionKey,
      objectKey,
      operationId: deleteOpId,
      clientId: "it_ws_client",
      baseVersion: created.resolved.serverVersion,
      lamportTime: Date.now() + 1
    });

    await clientA.waitFor((m) => m.type === "operation_resolved" && m.data.operationId === deleteOpId);
    const deleted = await clientB.waitFor((m) => m.type === "graphic_deleted" && m.data.objectKey === objectKey);

    expect(deleted.data.sessionKey).toBe(sessionKey);
    expect(deleted.data.userId).toBe(owner.userId);
    expect(deleted.data.objectKey).toBe(objectKey);
    expect(typeof deleted.data.currentVersion).toBe("number");
    expect(Number(deleted.data.currentVersion)).toBeGreaterThan(created.resolved.serverVersion);

    await clientA.close();
    await clientB.close();
  });

  it("ws consistency: reconnect should recover to latest canvas state without duplicates", async () => {
    const owner = await registerAndLogin();
    const joiner = await registerAndLogin();
    const { sessionKey } = await createSessionAndJoinByInvite(owner, joiner);
    const objectKey = `obj_${randomText()}_reconn`;

    const clientA = await connectWsClient(wsBaseUrl, owner.token, sessionKey);
    const clientB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    await clientA.waitFor((m) => m.type === "session_joined");
    await clientB.waitFor((m) => m.type === "session_joined");

    await clientB.close();

    const createOpId = `op_${randomText()}_reconn_create`;
    clientA.send("create_graphic", {
      sessionKey,
      operationId: createOpId,
      clientId: "it_ws_client",
      baseVersion: 0,
      lamportTime: Date.now(),
      objectKey,
      objectType: "rect",
      positionX: 66,
      positionY: 88,
      width: 120,
      height: 70,
      strokeColor: "#111111",
      fillColor: "#ffffff",
      strokeWidth: 2,
      zIndex: 1
    });
    await clientA.waitFor((m) => m.type === "operation_resolved" && m.data.operationId === createOpId);

    const reconnectB = await connectWsClient(wsBaseUrl, joiner.token, sessionKey);
    const joined = await reconnectB.waitFor((m) => m.type === "session_joined");
    const graphics = Array.isArray(joined.data.graphics) ? joined.data.graphics : [];
    const hitCount = graphics.filter((item) => item?.objectKey === objectKey).length;
    expect(hitCount).toBe(1);

    await clientA.close();
    await reconnectB.close();
  });

  it("heartbeat refreshes member last_active_at", async () => {
    const owner = await registerAndLogin();

    const createSessionRes = await request(app)
      .post("/api/v1/sessions")
      .set(authHeader(owner.token))
      .send({ name: `心跳会话_${randomText()}` });
    expect(createSessionRes.body.code).toBe(0);
    const sessionKey = createSessionRes.body.data.sessionKey as string;
    const sessionId = createSessionRes.body.data.sessionId as number;

    const [beforeRows] = await dbPool.query<Array<{ last_active_at: Date | string }>>(
      "SELECT last_active_at FROM session_members WHERE session_id = ? AND user_id = ? LIMIT 1",
      [sessionId, owner.userId]
    );
    expect(beforeRows.length).toBe(1);
    const beforeTime = new Date(beforeRows[0].last_active_at).getTime();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const heartbeatRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/heartbeat`)
      .set(authHeader(owner.token));
    expect(heartbeatRes.body.code).toBe(0);

    const [afterRows] = await dbPool.query<Array<{ last_active_at: Date | string }>>(
      "SELECT last_active_at FROM session_members WHERE session_id = ? AND user_id = ? LIMIT 1",
      [sessionId, owner.userId]
    );
    expect(afterRows.length).toBe(1);
    const afterTime = new Date(afterRows[0].last_active_at).getTime();
    expect(afterTime).toBeGreaterThan(beforeTime);
  });
});
