import bcrypt from "bcryptjs";

process.env.REDIS_ENABLED = process.env.DEMO_USE_REDIS ?? "false";

import { dbPool } from "../config/db";
import { closeRedis, initRedis, isRedisEnabled } from "../config/redis";
import { createUser, findUserByUsername } from "../models/userModel";
import { findSessionBySessionKey, findSessionMember, insertSession, insertSessionMember } from "../models/sessionModel";
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

const createDemoSession = async (ownerId: number, editorId: number): Promise<{ sessionId: number; sessionKey: string }> => {
  const sessionKey = `demo_${nowTag()}_${randomTag()}`;
  const sessionId = await insertSession(sessionKey, `冲突演示_${nowTag()}`, ownerId);
  await insertSessionMember(sessionId, ownerId, 3, 0);
  await insertSessionMember(sessionId, editorId, 1, 0);
  return { sessionId, sessionKey };
};

const prepareDemoSession = async (): Promise<{
  ownerId: number;
  editorId: number;
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
      throw new Error(`指定会话的创建者不是有效成员，无法用该会话生成演示冲突: ${requestedSessionKey}`);
    }

    const editorId = await ensureUser(`demo_editor_${userSuffix}`);
    const editorMember = await findSessionMember(session.id, editorId);
    if (!editorMember) {
      await insertSessionMember(session.id, editorId, 1, 0);
    }

    return {
      ownerId,
      editorId,
      sessionId: session.id,
      sessionKey: session.session_key,
      mode: "specified"
    };
  }

  const ownerId = await ensureUser(`demo_owner_${userSuffix}`);
  const editorId = await ensureUser(`demo_editor_${userSuffix}`);
  const session = await createDemoSession(ownerId, editorId);
  return {
    ownerId,
    editorId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    mode: "created"
  };
};

const printResolved = (title: string, result: Awaited<ReturnType<typeof operationService.updateGraphic>>): void => {
  console.log(`\n${title}`);
  console.log(`  operationId: ${result.resolved.operationId}`);
  console.log(`  serverVersion: ${result.resolved.serverVersion}`);
  console.log(`  conflictType: ${result.resolved.conflictType}`);
  console.log(`  appliedFields: ${result.resolved.appliedFields.join(", ") || "-"}`);
  console.log(`  rejectedFields: ${result.resolved.rejectedFields.join(", ") || "-"}`);
  console.log(`  resolveReason: ${result.resolved.resolveReason}`);
};

const main = async (): Promise<void> => {
  if (isRedisEnabled()) {
    await initRedis().catch((error) => {
      console.warn("[demo] Redis 初始化失败，脚本继续使用数据库兜底:", error instanceof Error ? error.message : error);
      return null;
    });
  }

  const { ownerId, editorId, sessionId, sessionKey, mode } = await prepareDemoSession();

  console.log("=== 协作冲突演示数据已创建 ===");
  console.log(`mode: ${mode === "specified" ? "使用指定会话" : "自动创建会话"}`);
  console.log(`ownerId: ${ownerId}`);
  console.log(`editorId: ${editorId}`);
  console.log(`sessionId: ${sessionId}`);
  console.log(`sessionKey: ${sessionKey}`);

  const fieldObjectKey = nextId("obj_field_conflict");
  const createdForFieldConflict = await operationService.createGraphic(
    sessionId,
    ownerId,
    {
      objectKey: fieldObjectKey,
      objectType: "rect",
      positionX: 80,
      positionY: 80,
      width: 160,
      height: 90,
      strokeColor: "#111111",
      fillColor: "#ffffff",
      strokeWidth: 2,
      zIndex: 1
    },
    {
      operationId: nextId("op_create_field_conflict"),
      clientId: "client_A",
      baseVersion: 0,
      lamportTime: 100
    }
  );

  const fieldConflictWin = await operationService.updateGraphic(
    sessionId,
    ownerId,
    fieldObjectKey,
    { positionX: 260 },
    {
      operationId: nextId("op_field_win"),
      clientId: "client_A",
      baseVersion: createdForFieldConflict.resolved.serverVersion,
      lamportTime: 200
    }
  );

  const fieldConflictLose = await operationService.updateGraphic(
    sessionId,
    editorId,
    fieldObjectKey,
    { positionX: 520 },
    {
      operationId: nextId("op_field_lose"),
      clientId: "client_B",
      baseVersion: createdForFieldConflict.resolved.serverVersion,
      lamportTime: 150
    }
  );

  printResolved("字段冲突演示：B 基于旧版本修改同一字段，Lamport 较小，因此被拒绝", fieldConflictLose);
  console.log(`  对比：A 的更新结果 conflictType=${fieldConflictWin.resolved.conflictType}, positionX=260`);

  const mergeObjectKey = nextId("obj_field_merge");
  const createdForMerge = await operationService.createGraphic(
    sessionId,
    ownerId,
    {
      objectKey: mergeObjectKey,
      objectType: "rect",
      positionX: 100,
      positionY: 260,
      width: 180,
      height: 100,
      strokeColor: "#111111",
      fillColor: "#ffffff",
      strokeWidth: 2,
      zIndex: 2
    },
    {
      operationId: nextId("op_create_field_merge"),
      clientId: "client_A",
      baseVersion: 0,
      lamportTime: 300
    }
  );

  await operationService.updateGraphic(
    sessionId,
    ownerId,
    mergeObjectKey,
    { positionX: 320 },
    {
      operationId: nextId("op_merge_move"),
      clientId: "client_A",
      baseVersion: createdForMerge.resolved.serverVersion,
      lamportTime: 400
    }
  );

  const fieldMerge = await operationService.updateGraphic(
    sessionId,
    editorId,
    mergeObjectKey,
    { fillColor: "#ff4d4f" },
    {
      operationId: nextId("op_merge_color"),
      clientId: "client_B",
      baseVersion: createdForMerge.resolved.serverVersion,
      lamportTime: 450
    }
  );

  printResolved("字段合并演示：B 基于旧版本修改不同字段，系统自动合并", fieldMerge);

  const deleteObjectKey = nextId("obj_delete_wins");
  const createdForDelete = await operationService.createGraphic(
    sessionId,
    ownerId,
    {
      objectKey: deleteObjectKey,
      objectType: "rect",
      positionX: 120,
      positionY: 440,
      width: 180,
      height: 100,
      strokeColor: "#111111",
      fillColor: "#ffffff",
      strokeWidth: 2,
      zIndex: 3
    },
    {
      operationId: nextId("op_create_delete_wins"),
      clientId: "client_A",
      baseVersion: 0,
      lamportTime: 500
    }
  );

  await operationService.deleteGraphic(
    sessionId,
    ownerId,
    deleteObjectKey,
    {
      operationId: nextId("op_delete_wins_delete"),
      clientId: "client_A",
      baseVersion: createdForDelete.resolved.serverVersion,
      lamportTime: 600
    }
  );

  const deleteWins = await operationService.updateGraphic(
    sessionId,
    editorId,
    deleteObjectKey,
    { positionX: 999 },
    {
      operationId: nextId("op_delete_wins_stale_update"),
      clientId: "client_B",
      baseVersion: createdForDelete.resolved.serverVersion,
      lamportTime: 700
    }
  );

  printResolved("删除优先演示：A 删除后，B 基于旧版本更新，系统拒绝旧更新", deleteWins);

  const conflictLogs = await operationService.getSessionConflictLogsBySessionKey(sessionKey, ownerId, 0, 50);
  console.log("\n=== 冲突日志 ===");
  conflictLogs.conflicts.forEach((item, index) => {
    console.log(
      `${index + 1}. id=${item.id}, type=${item.conflictType}, object=${item.objectKey}, field=${item.fieldName ?? "-"}, strategy=${item.resolveStrategy}`
    );
    console.log(`   current=${JSON.stringify(item.currentValue)}, incoming=${JSON.stringify(item.incomingValue)}, resolved=${JSON.stringify(item.resolvedValue)}`);
  });

  console.log("\n=== 页面查看方式 ===");
  console.log(`登录任意演示用户后进入会话 ${sessionKey}，点击“更多操作 -> 冲突日志”即可查看这些记录。`);
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
