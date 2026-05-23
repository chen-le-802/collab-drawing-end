import bcrypt from "bcryptjs";
import { RowDataPacket } from "mysql2/promise";

process.env.REDIS_ENABLED = process.env.DEMO_USE_REDIS ?? "false";

import { dbPool } from "../config/db";
import { closeRedis, initRedis, isRedisEnabled } from "../config/redis";
import { findGraphicByObjectKey } from "../models/graphicModel";
import { findOperationByOperationId } from "../models/operationModel";
import { findSessionBySessionKey, findSessionMember, insertSession, insertSessionMember } from "../models/sessionModel";
import { createUser, findUserByUsername } from "../models/userModel";
import { operationService } from "../services/operationService";

const nowTag = (): string => {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
};

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

const getRequestedSessionKey = (): string | null => {
  return getArgValue("sessionKey") ?? process.env.DEMO_SESSION_KEY?.trim() ?? null;
};

const nextId = (() => {
  let value = 0;
  return (prefix: string): string => {
    value += 1;
    return `${prefix}_${Date.now()}_${value}`;
  };
})();

const ensureUser = async (username: string): Promise<number> => {
  const existing = await findUserByUsername(username);
  if (existing) {
    return existing.id;
  }
  const passwordHash = await bcrypt.hash("Demo@123456", 10);
  return createUser(username, passwordHash);
};

const createDemoSession = async (ownerId: number): Promise<{ sessionId: number; sessionKey: string }> => {
  const sessionKey = `idem_${nowTag()}_${randomTag()}`;
  const sessionId = await insertSession(sessionKey, `幂等测试_${nowTag()}`, ownerId);
  await insertSessionMember(sessionId, ownerId, 3, 0);
  return { sessionId, sessionKey };
};

const prepareDemoSession = async (): Promise<{
  ownerId: number;
  sessionId: number;
  sessionKey: string;
  mode: "created" | "specified";
}> => {
  const userSuffix = `${nowTag()}_${randomTag()}`;
  const requestedSessionKey = getRequestedSessionKey();

  if (requestedSessionKey) {
    const session = await findSessionBySessionKey(requestedSessionKey);
    if (!session) {
      throw new Error(`指定的 sessionKey 不存在: ${requestedSessionKey}`);
    }

    const ownerId = session.creator_id;
    const ownerMember = await findSessionMember(session.id, ownerId);
    if (!ownerMember || ownerMember.membership_status !== "active") {
      throw new Error(`指定会话的创建者不是有效成员，无法用该会话生成幂等测试数据: ${requestedSessionKey}`);
    }

    return {
      ownerId,
      sessionId: session.id,
      sessionKey: session.session_key,
      mode: "specified"
    };
  }

  const ownerId = await ensureUser(`idem_owner_${userSuffix}`);
  const session = await createDemoSession(ownerId);
  return {
    ownerId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    mode: "created"
  };
};

const countOperationsByOperationId = async (sessionId: number, operationId: string): Promise<number> => {
  const [rows] = await dbPool.query<Array<{ total: number } & RowDataPacket>>(
    "SELECT COUNT(1) AS total FROM operations WHERE session_id = ? AND operation_id = ?",
    [sessionId, operationId]
  );
  return Number(rows[0]?.total ?? 0);
};

const main = async (): Promise<void> => {
  if (isRedisEnabled()) {
    await initRedis().catch((error) => {
      console.warn("[demo] Redis 初始化失败，脚本继续使用数据库兜底:", error instanceof Error ? error.message : error);
      return null;
    });
  }

  const { ownerId, sessionId, sessionKey, mode } = await prepareDemoSession();

  console.log("=== operation_id 幂等测试数据已创建 ===");
  console.log(`mode: ${mode === "specified" ? "使用指定会话" : "自动创建会话"}`);
  console.log(`ownerId: ${ownerId}`);
  console.log(`sessionId: ${sessionId}`);
  console.log(`sessionKey: ${sessionKey}`);

  const objectKey = nextId("obj_idempotency");
  const created = await operationService.createGraphic(
    sessionId,
    ownerId,
    {
      objectKey,
      objectType: "rect",
      positionX: 100,
      positionY: 120,
      width: 180,
      height: 100,
      strokeColor: "#111111",
      fillColor: "#ffffff",
      strokeWidth: 2,
      zIndex: 1
    },
    {
      operationId: nextId("op_create_idempotency"),
      clientId: "client_A",
      baseVersion: 0,
      lamportTime: 100
    }
  );

  const duplicateOperationId = nextId("op_duplicate_update");
  const updatePatch = { positionX: 360, fillColor: "#409eff" };

  const first = await operationService.updateGraphic(
    sessionId,
    ownerId,
    objectKey,
    updatePatch,
    {
      operationId: duplicateOperationId,
      clientId: "client_A",
      baseVersion: created.resolved.serverVersion,
      lamportTime: 200
    }
  );

  const second = await operationService.updateGraphic(
    sessionId,
    ownerId,
    objectKey,
    updatePatch,
    {
      operationId: duplicateOperationId,
      clientId: "client_A",
      baseVersion: created.resolved.serverVersion,
      lamportTime: 200
    }
  );

  const operationCount = await countOperationsByOperationId(sessionId, duplicateOperationId);
  const storedOperation = await findOperationByOperationId(sessionId, duplicateOperationId);
  const finalGraphic = await findGraphicByObjectKey(sessionId, objectKey, true);

  console.log("\n=== CT-06 幂等处理验证 ===");
  console.log(`duplicateOperationId: ${duplicateOperationId}`);
  console.log(`first.serverVersion: ${first.resolved.serverVersion}`);
  console.log(`first.conflictType: ${first.resolved.conflictType}`);
  console.log(`first.resolveReason: ${first.resolved.resolveReason}`);
  console.log(`second.serverVersion: ${second.resolved.serverVersion}`);
  console.log(`second.conflictType: ${second.resolved.conflictType}`);
  console.log(`second.resolveReason: ${second.resolved.resolveReason}`);
  console.log(`operations.count(operation_id): ${operationCount}`);
  console.log(`stored.operationRecordId: ${storedOperation?.id ?? "-"}`);
  console.log(`final.positionX: ${finalGraphic?.position_x ?? "-"}`);
  console.log(`final.fillColor: ${finalGraphic?.fill_color ?? "-"}`);

  const passed = second.resolved.conflictType === "duplicate_operation"
    && second.resolved.serverVersion === first.resolved.serverVersion
    && operationCount === 1
    && Number(finalGraphic?.position_x ?? 0) === updatePatch.positionX;

  console.log("\n=== 测试结论 ===");
  console.log(passed ? "CT-06 PASS：重复 operation_id 被识别为幂等请求，版本和操作记录未重复写入。" : "CT-06 FAIL：幂等处理结果不符合预期，请检查服务端实现。");
  console.log("\n=== 页面查看方式 ===");
  console.log(`登录演示用户或会话成员后进入会话 ${sessionKey}，可结合操作日志/冲突日志和本脚本输出作为 CT-06 测试依据。`);
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
