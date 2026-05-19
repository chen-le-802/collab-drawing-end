import { createClient } from "redis";

import { env } from "./env";
import { emitAlert } from "../services/alertService";

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let redisReady = false;
// 防止并发重复初始化：首次初始化期间复用同一个 Promise。
let initOnce: Promise<RedisClient | null> | null = null;

const buildRedisUrl = (): string => {
  // 兼容带密码与无密码 Redis 场景。
  const authPart = env.redisPassword ? `:${encodeURIComponent(env.redisPassword)}@` : "";
  return `redis://${authPart}${env.redisHost}:${env.redisPort}/${env.redisDb}`;
};

const bindEvents = (client: RedisClient): void => {
  // ready/end/reconnecting/error 统一维护 redisReady 状态，供上层快速判定可用性。
  client.on("ready", () => {
    redisReady = true;
    console.log("[redis] ready");
  });
  client.on("end", () => {
    redisReady = false;
    console.log("[redis] connection ended");
    emitAlert({
      key: "redis.connection.end",
      level: "warn",
      message: "Redis 连接已断开"
    });
  });
  client.on("reconnecting", () => {
    redisReady = false;
    emitAlert({
      key: "redis.connection.reconnecting",
      level: "warn",
      message: "Redis 正在重连"
    });
  });
  client.on("error", (error) => {
    redisReady = false;
    console.error("[redis] error:", error instanceof Error ? error.message : error);
    emitAlert({
      key: "redis.connection.error",
      level: "error",
      message: "Redis 连接异常",
      detail: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
  });
};

export const isRedisEnabled = (): boolean => env.redisEnabled;

export const isRedisReady = (): boolean => env.redisEnabled && redisReady && !!redisClient;

export const getRedisClient = (): RedisClient | null => redisClient;

export const initRedis = async (): Promise<RedisClient | null> => {
  if (!env.redisEnabled) {
    // 未开启 Redis 时直接返回 null，调用方按降级逻辑处理。
    return null;
  }
  if (redisClient) {
    return redisClient;
  }
  if (initOnce) {
    return initOnce;
  }

  initOnce = (async () => {
    const client = createClient({
      url: buildRedisUrl()
    });
    bindEvents(client);
    await client.connect();
    redisClient = client;
    return client;
  })();

  try {
    return await initOnce;
  } finally {
    // 初始化完成后释放 initOnce，便于后续必要时重新初始化。
    initOnce = null;
  }
};

export const closeRedis = async (): Promise<void> => {
  if (!redisClient) {
    return;
  }
  const client = redisClient;
  redisClient = null;
  redisReady = false;
  try {
    await client.quit();
  } catch {
    // quit 失败时兜底强制断开，避免进程退出被连接阻塞。
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
};
