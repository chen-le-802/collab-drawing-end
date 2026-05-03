import request from "supertest";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import app from "../src/app";
import { dbPool } from "../src/config/db";
import { env } from "../src/config/env";

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
});
