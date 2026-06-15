import bcrypt from "bcryptjs";
import { RowDataPacket } from "mysql2/promise";

process.env.REDIS_ENABLED = process.env.DEMO_USE_REDIS ?? "false";

import { dbPool } from "../config/db";
import { closeRedis, initRedis, isRedisEnabled } from "../config/redis";
import { findSessionBySessionKey, findSessionMember, insertSession, insertSessionMember } from "../models/sessionModel";
import { createUser, findUserByUsername } from "../models/userModel";
import { operationService } from "../services/operationService";

const nowTag = (): string => new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const randomTag = (): string => Math.random().toString(36).slice(2, 8);

const getArgValue = (name: string): string | null => {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length).trim() || null;
  }
  const index = args.findIndex((arg) => arg === `--${name}`);
  if (index >= 0) {
    return args[index + 1]?.trim() || null;
  }
  return null;
};

const hasHelpFlag = (): boolean => {
  return process.argv.includes("--help") || process.argv.includes("-h");
};

const printUsage = (): void => {
  console.log("Usage: pnpm run demo:concurrency -- [--clients=10] [--ops=10] [--sessionKey=<sessionKey>]");
  console.log("");
  console.log("Options:");
  console.log("  --clients     模拟客户端数量，默认 10，最大 20");
  console.log("  --ops         每个客户端创建并更新的图元数量，默认 10，最大 100");
  console.log("  --sessionKey  可选，指定已有会话；不传则自动创建测试会话");
};

const parsePositiveIntegerArg = (name: string, fallback: number): number => {
  const raw = getArgValue(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getRequestedSessionKey = (): string | null => {
  return getArgValue("sessionKey") ?? process.env.DEMO_SESSION_KEY?.trim() ?? null;
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureUser = async (username: string): Promise<number> => {
  const existing = await findUserByUsername(username);
  if (existing) {
    return existing.id;
  }
  const passwordHash = await bcrypt.hash("Demo@123456", 10);
  return createUser(username, passwordHash);
};

const createDemoSession = async (
  ownerId: number,
  editorIds: number[],
  runTag: string
): Promise<{ sessionId: number; sessionKey: string }> => {
  const sessionKey = `conc_${runTag}_${randomTag()}`;
  const sessionId = await insertSession(sessionKey, `并发冒烟测试_${runTag}`, ownerId);
  await insertSessionMember(sessionId, ownerId, 3, 0);
  for (const editorId of editorIds) {
    await insertSessionMember(sessionId, editorId, 1, 0);
  }
  return { sessionId, sessionKey };
};

const prepareDemoSession = async (
  clientCount: number,
  runTag: string
): Promise<{
  ownerId: number;
  editorIds: number[];
  sessionId: number;
  sessionKey: string;
  mode: "created" | "specified";
}> => {
  const requestedSessionKey = getRequestedSessionKey();
  const ownerId = await ensureUser(`conc_owner_${runTag}`);
  const editorIds: number[] = [];
  for (let i = 0; i < clientCount; i += 1) {
    editorIds.push(await ensureUser(`conc_editor_${i + 1}_${runTag}`));
  }

  if (requestedSessionKey) {
    const session = await findSessionBySessionKey(requestedSessionKey);
    if (!session) {
      throw new Error(`指定的 sessionKey 不存在: ${requestedSessionKey}`);
    }

    const ownerMember = await findSessionMember(session.id, session.creator_id);
    if (!ownerMember || ownerMember.membership_status !== "active") {
      throw new Error(`指定会话的创建者不是有效成员，无法执行并发测试: ${requestedSessionKey}`);
    }

    for (const editorId of editorIds) {
      const member = await findSessionMember(session.id, editorId);
      if (!member) {
        await insertSessionMember(session.id, editorId, 1, 0);
      }
    }

    return {
      ownerId: session.creator_id,
      editorIds,
      sessionId: session.id,
      sessionKey: session.session_key,
      mode: "specified"
    };
  }

  const session = await createDemoSession(ownerId, editorIds, runTag);
  return {
    ownerId,
    editorIds,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    mode: "created"
  };
};

const getSessionCurrentVersion = async (sessionId: number): Promise<number> => {
  const [rows] = await dbPool.query<Array<{ current_version: number | string } & RowDataPacket>>(
    "SELECT current_version FROM sessions WHERE id = ? LIMIT 1",
    [sessionId]
  );
  return toNumber(rows[0]?.current_version);
};

const countOperationsByRunTag = async (
  sessionId: number,
  runTag: string
): Promise<{
  total: number;
  distinctOperations: number;
  minVersion: number;
  maxVersion: number;
  distinctVersions: number;
}> => {
  const [rows] = await dbPool.query<Array<{
    total: number | string;
    distinct_operations: number | string;
    min_version: number | string | null;
    max_version: number | string | null;
    distinct_versions: number | string;
  } & RowDataPacket>>(
    `SELECT COUNT(1) AS total,
            COUNT(DISTINCT operation_id) AS distinct_operations,
            MIN(server_version) AS min_version,
            MAX(server_version) AS max_version,
            COUNT(DISTINCT server_version) AS distinct_versions
     FROM operations
     WHERE session_id = ? AND operation_id LIKE ?`,
    [sessionId, `op_conc_${runTag}_%`]
  );
  const row = rows[0];
  return {
    total: toNumber(row?.total),
    distinctOperations: toNumber(row?.distinct_operations),
    minVersion: toNumber(row?.min_version),
    maxVersion: toNumber(row?.max_version),
    distinctVersions: toNumber(row?.distinct_versions)
  };
};

const countGraphicsByRunTag = async (sessionId: number, runTag: string): Promise<number> => {
  const [rows] = await dbPool.query<Array<{ total: number | string } & RowDataPacket>>(
    "SELECT COUNT(1) AS total FROM graphic_objects WHERE session_id = ? AND object_key LIKE ? AND is_deleted = 0",
    [sessionId, `obj_conc_${runTag}_%`]
  );
  return toNumber(rows[0]?.total);
};

const runClientOperations = async (
  sessionId: number,
  userId: number,
  runTag: string,
  clientIndex: number,
  operationsPerClient: number
): Promise<void> => {
  for (let opIndex = 0; opIndex < operationsPerClient; opIndex += 1) {
    const objectKey = `obj_conc_${runTag}_c${clientIndex}_o${opIndex}`;
    const baseLamport = Date.now() + clientIndex * 1000 + opIndex * 10;
    const created = await operationService.createGraphic(
      sessionId,
      userId,
      {
        objectKey,
        objectType: "rect",
        positionX: 80 + clientIndex * 40,
        positionY: 80 + opIndex * 24,
        width: 120,
        height: 70,
        strokeColor: "#111111",
        fillColor: "#ffffff",
        strokeWidth: 2,
        zIndex: clientIndex * operationsPerClient + opIndex + 1
      },
      {
        operationId: `op_conc_${runTag}_c${clientIndex}_o${opIndex}_create`,
        clientId: `client_conc_${clientIndex}`,
        baseVersion: 0,
        lamportTime: baseLamport
      }
    );

    await operationService.updateGraphic(
      sessionId,
      userId,
      objectKey,
      {
        positionX: 160 + clientIndex * 40,
        fillColor: opIndex % 2 === 0 ? "#409eff" : "#67c23a"
      },
      {
        operationId: `op_conc_${runTag}_c${clientIndex}_o${opIndex}_update`,
        clientId: `client_conc_${clientIndex}`,
        baseVersion: created.resolved.serverVersion,
        lamportTime: baseLamport + 1
      }
    );
  }
};

const main = async (): Promise<void> => {
  if (hasHelpFlag()) {
    printUsage();
    return;
  }

  if (isRedisEnabled()) {
    await initRedis().catch((error) => {
      console.warn("[demo] Redis 初始化失败，脚本继续使用数据库兜底:", error instanceof Error ? error.message : error);
      return null;
    });
  }

  const clientCount = Math.min(parsePositiveIntegerArg("clients", 10), 20);
  const operationsPerClient = Math.min(parsePositiveIntegerArg("ops", 10), 100);
  const runTag = `${nowTag()}_${randomTag()}`;
  const { editorIds, sessionId, sessionKey, mode } = await prepareDemoSession(clientCount, runTag);
  const initialVersion = await getSessionCurrentVersion(sessionId);
  const expectedGraphics = clientCount * operationsPerClient;
  const expectedOperations = expectedGraphics * 2;
  const startedAt = Date.now();
  const failures: Array<{ clientIndex: number; message: string }> = [];

  console.log("=== 多客户端并发冒烟测试已启动 ===");
  console.log(`mode: ${mode === "specified" ? "使用指定会话" : "自动创建会话"}`);
  console.log(`sessionId: ${sessionId}`);
  console.log(`sessionKey: ${sessionKey}`);
  console.log(`clients: ${clientCount}`);
  console.log(`opsPerClient: ${operationsPerClient}`);
  console.log(`expectedGraphics: ${expectedGraphics}`);
  console.log(`expectedOperations: ${expectedOperations}`);
  console.log(`initialVersion: ${initialVersion}`);

  await Promise.all(editorIds.map(async (userId, index) => {
    try {
      await runClientOperations(sessionId, userId, runTag, index + 1, operationsPerClient);
    } catch (error) {
      failures.push({
        clientIndex: index + 1,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }));

  const durationMs = Date.now() - startedAt;
  const finalVersion = await getSessionCurrentVersion(sessionId);
  const operationStats = await countOperationsByRunTag(sessionId, runTag);
  const graphicCount = await countGraphicsByRunTag(sessionId, runTag);
  const expectedMinVersion = initialVersion + 1;
  const expectedMaxVersion = initialVersion + expectedOperations;
  const passed = failures.length === 0
    && finalVersion - initialVersion === expectedOperations
    && operationStats.total === expectedOperations
    && operationStats.distinctOperations === expectedOperations
    && operationStats.distinctVersions === expectedOperations
    && operationStats.minVersion === expectedMinVersion
    && operationStats.maxVersion === expectedMaxVersion
    && graphicCount === expectedGraphics;

  console.log("\n=== CT-07 多客户端并发操作验证 ===");
  console.log(`durationMs: ${durationMs}`);
  console.log(`avgMsPerOperation: ${(durationMs / expectedOperations).toFixed(2)}`);
  console.log(`finalVersion: ${finalVersion}`);
  console.log(`versionDelta: ${finalVersion - initialVersion}`);
  console.log(`operations.total: ${operationStats.total}`);
  console.log(`operations.distinctOperationId: ${operationStats.distinctOperations}`);
  console.log(`operations.versionRange: ${operationStats.minVersion}-${operationStats.maxVersion}`);
  console.log(`operations.distinctVersions: ${operationStats.distinctVersions}`);
  console.log(`graphics.activeCount: ${graphicCount}`);
  console.log(`failures: ${failures.length}`);
  failures.forEach((failure) => {
    console.log(`  client ${failure.clientIndex}: ${failure.message}`);
  });

  console.log("\n=== 测试结论 ===");
  console.log(passed
    ? "CT-07 PASS：多个模拟客户端并发提交创建和更新操作时，服务端版本连续推进，操作记录未重复，最终图元状态可正常读取。"
    : "CT-07 FAIL：并发操作结果不符合预期，请检查服务端版本推进、操作去重或图元写入逻辑。");
  console.log("\n=== 页面查看方式 ===");
  console.log(`登录会话成员后进入会话 ${sessionKey}，可结合操作历史和本脚本输出作为 CT-07 测试依据。`);
};

main()
  .catch((error) => {
    console.error("[demo] 运行失败:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {
      // ignore
    });
    await dbPool.end().catch(() => {
      // ignore
    });
  });
