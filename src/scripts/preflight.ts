import mysql from "mysql2/promise";
import { createClient } from "redis";

import { env } from "../config/env";

type CheckLevel = "basic" | "full";

type CheckResult = {
  ok: boolean;
  messages: string[];
};

const parseLevel = (): CheckLevel => {
  const level = (process.argv[2] ?? "basic").toLowerCase();
  if (level !== "basic" && level !== "full") {
    throw new Error(`不支持的检查模式：${level}。可选值：basic / full`);
  }
  return level;
};

const pushError = (messages: string[], text: string): void => {
  messages.push(`ERROR: ${text}`);
};

const pushWarn = (messages: string[], text: string): void => {
  messages.push(`WARN: ${text}`);
};

const pushOk = (messages: string[], text: string): void => {
  messages.push(`OK: ${text}`);
};

const checkRequiredStrings = (): CheckResult => {
  const messages: string[] = [];
  const required: Array<{ key: string; value: string }> = [
    { key: "DB_HOST", value: env.dbHost },
    { key: "DB_USER", value: env.dbUser },
    { key: "DB_NAME", value: env.dbName },
    { key: "JWT_SECRET", value: env.jwtSecret }
  ];

  for (const item of required) {
    if (!item.value || !item.value.trim()) {
      pushError(messages, `${item.key} 未配置`);
      continue;
    }
    pushOk(messages, `${item.key} 已配置`);
  }

  return {
    ok: !messages.some((m) => m.startsWith("ERROR")),
    messages
  };
};

const checkProductionSecurity = (): CheckResult => {
  const messages: string[] = [];
  if (!env.isProduction) {
    pushWarn(messages, "当前非 production 环境，生产硬规则仅做提示");
    return { ok: true, messages };
  }

  if (!env.jwtSecret || env.jwtSecret.trim().length < 32) {
    pushError(messages, "生产环境 JWT_SECRET 长度需 >= 32");
  } else {
    pushOk(messages, "生产环境 JWT_SECRET 强度通过");
  }

  if (env.redisEnabled && !env.redisPassword) {
    pushError(messages, "生产环境启用 Redis 时必须配置 REDIS_PASSWORD");
  } else if (env.redisEnabled) {
    pushOk(messages, "生产环境 Redis 密码已配置");
  } else {
    pushWarn(messages, "生产环境 REDIS_ENABLED=false（可运行，但不支持多实例广播）");
  }

  if (env.avatarMaxSizeMb > 5) {
    pushWarn(messages, `AVATAR_MAX_SIZE_MB=${env.avatarMaxSizeMb} 偏大，建议 <= 5`);
  } else {
    pushOk(messages, `AVATAR_MAX_SIZE_MB=${env.avatarMaxSizeMb}`);
  }

  if (env.sessionImageMaxSizeMb > 20) {
    pushWarn(messages, `SESSION_IMAGE_MAX_SIZE_MB=${env.sessionImageMaxSizeMb} 偏大，建议 <= 20`);
  } else {
    pushOk(messages, `SESSION_IMAGE_MAX_SIZE_MB=${env.sessionImageMaxSizeMb}`);
  }

  return {
    ok: !messages.some((m) => m.startsWith("ERROR")),
    messages
  };
};

const checkNumericRanges = (): CheckResult => {
  const messages: string[] = [];
  const numbers: Array<{ key: string; value: number; min: number; max: number }> = [
    { key: "PORT", value: env.port, min: 1, max: 65535 },
    { key: "DB_PORT", value: env.dbPort, min: 1, max: 65535 },
    { key: "SESSION_ONLINE_TIMEOUT_SECONDS", value: env.sessionOnlineTimeoutSeconds, min: 10, max: 3600 },
    { key: "REDIS_PORT", value: env.redisPort, min: 1, max: 65535 },
    { key: "REDIS_ONLINE_TTL_SECONDS", value: env.redisOnlineTtlSeconds, min: 10, max: 86400 },
    { key: "REDIS_OP_DEDUPE_TTL_SECONDS", value: env.redisOpDedupeTtlSeconds, min: 30, max: 86400 },
    { key: "REDIS_SNAPSHOT_TTL_SECONDS", value: env.redisSnapshotTtlSeconds, min: 30, max: 86400 },
    { key: "AVATAR_MAX_SIZE_MB", value: env.avatarMaxSizeMb, min: 1, max: 20 },
    { key: "SESSION_IMAGE_MAX_SIZE_MB", value: env.sessionImageMaxSizeMb, min: 1, max: 50 },
    { key: "LOGIN_RATE_LIMIT_WINDOW_SECONDS", value: env.loginRateLimitWindowSeconds, min: 1, max: 3600 },
    { key: "LOGIN_RATE_LIMIT_MAX", value: env.loginRateLimitMax, min: 1, max: 10000 },
    { key: "INVITE_RATE_LIMIT_WINDOW_SECONDS", value: env.inviteRateLimitWindowSeconds, min: 1, max: 3600 },
    { key: "INVITE_RATE_LIMIT_MAX", value: env.inviteRateLimitMax, min: 1, max: 10000 },
    { key: "EXPORT_RATE_LIMIT_WINDOW_SECONDS", value: env.exportRateLimitWindowSeconds, min: 1, max: 3600 },
    { key: "EXPORT_RATE_LIMIT_MAX", value: env.exportRateLimitMax, min: 1, max: 10000 },
    { key: "DB_HEALTHCHECK_INTERVAL_SECONDS", value: env.dbHealthcheckIntervalSeconds, min: 5, max: 3600 },
    { key: "DB_BACKUP_RETENTION_DAYS", value: env.backupRetentionDays, min: 1, max: 3650 },
    { key: "DB_BACKUP_SCHEDULE_MINUTES", value: env.backupScheduleMinutes, min: 10, max: 10080 }
  ];

  for (const item of numbers) {
    if (!Number.isFinite(item.value)) {
      pushError(messages, `${item.key} 不是有效数字`);
      continue;
    }
    if (item.value < item.min || item.value > item.max) {
      pushWarn(messages, `${item.key}=${item.value} 超出推荐范围 [${item.min}, ${item.max}]`);
      continue;
    }
    pushOk(messages, `${item.key}=${item.value}`);
  }

  return {
    ok: !messages.some((m) => m.startsWith("ERROR")),
    messages
  };
};

const checkRedisConfig = (): CheckResult => {
  const messages: string[] = [];
  if (!env.redisEnabled) {
    pushWarn(messages, "REDIS_ENABLED=false，将使用单机降级模式（可部署，但不支持多实例广播）");
    return { ok: true, messages };
  }

  if (!env.redisHost.trim()) {
    pushError(messages, "REDIS_ENABLED=true 但 REDIS_HOST 为空");
  } else {
    pushOk(messages, `REDIS_HOST=${env.redisHost}`);
  }

  if (!env.redisWsChannel.trim()) {
    pushError(messages, "REDIS_ENABLED=true 但 REDIS_WS_CHANNEL 为空");
  } else {
    pushOk(messages, `REDIS_WS_CHANNEL=${env.redisWsChannel}`);
  }

  return {
    ok: !messages.some((m) => m.startsWith("ERROR")),
    messages
  };
};

const checkMysqlConnection = async (): Promise<CheckResult> => {
  const messages: string[] = [];
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: env.dbHost,
      port: env.dbPort,
      user: env.dbUser,
      password: env.dbPassword,
      database: env.dbName,
      connectTimeout: 4000
    });
    await connection.query("SELECT 1");
    pushOk(messages, "MySQL 连接成功");
    return { ok: true, messages };
  } catch (error) {
    pushError(
      messages,
      `MySQL 连接失败：${error instanceof Error ? error.message : String(error)}`
    );
    return { ok: false, messages };
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

const checkRedisConnection = async (): Promise<CheckResult> => {
  const messages: string[] = [];
  if (!env.redisEnabled) {
    pushWarn(messages, "Redis 连通性检查跳过（REDIS_ENABLED=false）");
    return { ok: true, messages };
  }

  const authPart = env.redisPassword ? `:${encodeURIComponent(env.redisPassword)}@` : "";
  const client = createClient({
    url: `redis://${authPart}${env.redisHost}:${env.redisPort}/${env.redisDb}`,
    socket: {
      connectTimeout: 4000
    }
  });
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== "PONG") {
      pushError(messages, `Redis PING 异常返回：${pong}`);
      return { ok: false, messages };
    }
    pushOk(messages, "Redis 连接成功");
    return { ok: true, messages };
  } catch (error) {
    pushError(
      messages,
      `Redis 连接失败：${error instanceof Error ? error.message : String(error)}`
    );
    return { ok: false, messages };
  } finally {
    if (client.isOpen) {
      await client.quit();
    }
  }
};

const printSection = (title: string, result: CheckResult): void => {
  console.log(`\n[${title}]`);
  for (const line of result.messages) {
    console.log(line);
  }
};

const main = async (): Promise<void> => {
  const level = parseLevel();
  const results: CheckResult[] = [];

  console.log(`preflight 模式：${level}`);

  const requiredResult = checkRequiredStrings();
  results.push(requiredResult);
  printSection("必填配置", requiredResult);

  const numberResult = checkNumericRanges();
  results.push(numberResult);
  printSection("数值范围", numberResult);

  const redisConfigResult = checkRedisConfig();
  results.push(redisConfigResult);
  printSection("Redis 配置", redisConfigResult);

  const productionSecurityResult = checkProductionSecurity();
  results.push(productionSecurityResult);
  printSection("生产安全", productionSecurityResult);

  if (level === "full") {
    const mysqlResult = await checkMysqlConnection();
    results.push(mysqlResult);
    printSection("MySQL 连通性", mysqlResult);

    const redisResult = await checkRedisConnection();
    results.push(redisResult);
    printSection("Redis 连通性", redisResult);
  } else {
    console.log("\n[连通性]");
    console.log("WARN: basic 模式不检测 MySQL/Redis 连通性，使用 `pnpm preflight:full` 可开启。");
  }

  const hasError = results.some((r) => !r.ok);
  if (hasError) {
    console.error("\npreflight 失败：存在 ERROR，请修复后再部署。");
    process.exit(1);
  }

  console.log("\npreflight 通过：可以进入迁移与部署阶段。");
};

main().catch((error) => {
  console.error(`preflight 执行异常：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
