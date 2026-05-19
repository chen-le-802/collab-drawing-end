import { env } from "../config/env";
import { getRedisClient, isRedisReady } from "../config/redis";

type GraphicsCachePayload = {
  currentVersion: number;
  graphics: unknown[];
  cachedAt: number;
};

const buildSnapshotKey = (sessionId: number): string => `snapshot:session:${sessionId}`;

export const getSessionGraphicsCache = async (sessionId: number): Promise<GraphicsCachePayload | null> => {
  if (!env.redisEnabled || !isRedisReady()) {
    return null;
  }
  const client = getRedisClient();
  if (!client) {
    return null;
  }
  const raw = await client.get(buildSnapshotKey(sessionId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GraphicsCachePayload;
    if (
      typeof parsed?.currentVersion !== "number" ||
      !Array.isArray(parsed?.graphics) ||
      typeof parsed?.cachedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const setSessionGraphicsCache = async (
  sessionId: number,
  payload: { currentVersion: number; graphics: unknown[] }
): Promise<void> => {
  if (!env.redisEnabled || !isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  const value: GraphicsCachePayload = {
    currentVersion: payload.currentVersion,
    graphics: payload.graphics,
    cachedAt: Date.now()
  };
  await client.set(buildSnapshotKey(sessionId), JSON.stringify(value), {
    EX: env.redisSnapshotTtlSeconds
  });
};

export const invalidateSessionGraphicsCache = async (sessionId: number): Promise<void> => {
  if (!env.redisEnabled || !isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  await client.del(buildSnapshotKey(sessionId));
};

