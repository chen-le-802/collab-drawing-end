import { env } from "../config/env";
import { getRedisClient, isRedisReady } from "../config/redis";

const HEARTBEAT_THROTTLE_MS = 3000;
const lastHeartbeatAt = new Map<string, number>();

// 会话在线态键：session + user 维度，TTL 过期即视为离线。
const buildOnlineKey = (sessionKey: string, userId: number): string => {
  return `online:session:${sessionKey}:${userId}`;
};

export const markOnlineHeartbeat = async (
  sessionKey: string,
  userId: number,
  options?: { force?: boolean }
): Promise<void> => {
  // Redis 未就绪时静默降级，在线态仍可由数据库 online_status 兜底。
  if (!isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  const key = buildOnlineKey(sessionKey, userId);
  const nowAt = Date.now();
  const force = options?.force === true;
  if (!force) {
    const lastAt = lastHeartbeatAt.get(key) ?? 0;
    if (nowAt - lastAt < HEARTBEAT_THROTTLE_MS) {
      return;
    }
  }
  lastHeartbeatAt.set(key, nowAt);
  // 心跳写当前时间戳并刷新 TTL，维持在线窗口。
  await client.set(key, String(nowAt), { EX: env.redisOnlineTtlSeconds });
};

export const markOffline = async (sessionKey: string, userId: number): Promise<void> => {
  if (!isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  const key = buildOnlineKey(sessionKey, userId);
  lastHeartbeatAt.delete(key);
  // 主动离开/断连时立即删键，避免 TTL 延迟导致“假在线”。
  await client.del(key);
};
