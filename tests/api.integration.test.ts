import request from "supertest";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import app from "../src/app";
import { dbPool } from "../src/config/db";
import { env } from "../src/config/env";
import { operationService } from "../src/services/operationService";
import { undoService } from "../src/services/undoService";

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
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
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

    const firstJoinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token));
    expect(firstJoinRes.body.code).toBe(0);

    const secondJoinRes = await request(app)
      .post(`/api/v1/sessions/${sessionKey}/join`)
      .set(authHeader(joiner.token));
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
