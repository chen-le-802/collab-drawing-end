import { createClient } from "redis";

import { env } from "../config/env";
import { getRedisClient, isRedisReady } from "../config/redis";
import { ServerMessageType } from "./types";

type RedisBroadcastPayload = {
  sessionKey: string;
  messageType: ServerMessageType;
  data: unknown;
  // 发送方实例标识，用于订阅端自过滤，避免同实例重复消费。
  senderInstanceId: string;
};

type SubscribeOptions = {
  onMessage: (payload: { sessionKey: string; messageType: ServerMessageType; data: unknown }) => void;
};

type RedisClient = ReturnType<typeof createClient>;

let subscriberClient: RedisClient | null = null;
// 进程级实例 ID：多实例部署下用于识别消息来源。
const instanceId = `ws_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;

const buildRedisUrl = (): string => {
  // 兼容带密码与无密码 Redis 场景。
  const authPart = env.redisPassword ? `:${encodeURIComponent(env.redisPassword)}@` : "";
  return `redis://${authPart}${env.redisHost}:${env.redisPort}/${env.redisDb}`;
};

export const getWsPubSubInstanceId = (): string => instanceId;

export const publishWsBroadcast = async (
  sessionKey: string,
  messageType: ServerMessageType,
  data: unknown
): Promise<void> => {
  // Redis 不可用时静默降级为“仅本实例广播”。
  if (!isRedisReady()) {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  const payload: RedisBroadcastPayload = {
    sessionKey,
    messageType,
    data,
    senderInstanceId: instanceId
  };
  // 统一用单频道分发，消息体包含 sessionKey 由接收端再路由到房间。
  await client.publish(env.redisWsChannel, JSON.stringify(payload));
};

export const initWsSubscriber = async (options: SubscribeOptions): Promise<void> => {
  if (!env.redisEnabled) {
    return;
  }
  if (subscriberClient) {
    // 防止重复初始化订阅连接。
    return;
  }
  subscriberClient = createClient({ url: buildRedisUrl() });
  subscriberClient.on("error", (error) => {
    console.error("[redis-subscriber] error:", error instanceof Error ? error.message : error);
  });
  await subscriberClient.connect();
  await subscriberClient.subscribe(env.redisWsChannel, (message) => {
    try {
      const parsed = JSON.parse(message) as Partial<RedisBroadcastPayload>;
      // 忽略自己发出的消息，避免本地广播后再被订阅回流一次。
      if (!parsed || parsed.senderInstanceId === instanceId) {
        return;
      }
      if (typeof parsed.sessionKey !== "string" || typeof parsed.messageType !== "string") {
        return;
      }
      options.onMessage({
        sessionKey: parsed.sessionKey,
        messageType: parsed.messageType as ServerMessageType,
        data: parsed.data
      });
    } catch {
      // ignore broken payload
    }
  });
};

export const closeWsSubscriber = async (): Promise<void> => {
  if (!subscriberClient) {
    return;
  }
  const client = subscriberClient;
  subscriberClient = null;
  try {
    await client.quit();
  } catch {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
};
