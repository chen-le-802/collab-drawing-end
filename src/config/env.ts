import dotenv from "dotenv";

// 读取项目根目录下的 .env 文件并注入到 process.env。
dotenv.config();

// 把字符串环境变量安全地转成数字。
// 如果没有配置，或者配置值不是合法数字，就回退到默认值。
const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

// 统一导出环境变量配置。
// 后续其他模块都从这里拿配置，不要直接到处写 process.env.xxx。
export const env = {
  // 运行环境标识：development / test / production。
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",

  // 服务监听端口，默认 3000。
  port: toNumber(process.env.PORT, 3000),

  // MySQL 连接配置。
  dbHost: process.env.DB_HOST ?? "localhost",
  dbPort: toNumber(process.env.DB_PORT, 3306),
  dbUser: process.env.DB_USER ?? "root",
  dbPassword: process.env.DB_PASSWORD ?? "",
  dbName: process.env.DB_NAME ?? "",

  // JWT 相关配置。当前骨架还没用到，但后续登录认证会用到。
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",

  // 会话在线状态判定超时窗口（秒），默认 60 秒。
  sessionOnlineTimeoutSeconds: toNumber(process.env.SESSION_ONLINE_TIMEOUT_SECONDS, 60),
  // 轻量性能埋点开关：默认关闭，开启后输出核心写操作耗时日志。
  perfMetricsEnabled: toBoolean(process.env.PERF_METRICS_ENABLED, false),

  // Redis 配置（可选启用，默认关闭）。
  // 推荐部署场景：多实例 WS 广播、在线态 TTL、操作幂等去重、快照缓存。
  redisEnabled: toBoolean(process.env.REDIS_ENABLED, false),
  redisHost: process.env.REDIS_HOST ?? "127.0.0.1",
  redisPort: toNumber(process.env.REDIS_PORT, 6379),
  redisPassword: process.env.REDIS_PASSWORD ?? "",
  redisDb: toNumber(process.env.REDIS_DB, 0),
  // 在线成员心跳 TTL，过期后可视为离线。
  redisOnlineTtlSeconds: toNumber(process.env.REDIS_ONLINE_TTL_SECONDS, 90),
  // operationId 去重 TTL，防止前端重试导致重复落库。
  redisOpDedupeTtlSeconds: toNumber(process.env.REDIS_OP_DEDUPE_TTL_SECONDS, 600),
  // 多实例 WS 广播频道名。
  redisWsChannel: process.env.REDIS_WS_CHANNEL ?? "ws:broadcast",
  // 画布快照缓存 TTL（全量图形列表）。
  redisSnapshotTtlSeconds: toNumber(process.env.REDIS_SNAPSHOT_TTL_SECONDS, 120),

  // 上传体积限制（MB），生产环境建议按业务上限收紧。
  avatarMaxSizeMb: toNumber(process.env.AVATAR_MAX_SIZE_MB, 2),
  sessionImageMaxSizeMb: toNumber(process.env.SESSION_IMAGE_MAX_SIZE_MB, 10),

  // 接口限流：登录 / 邀请 / 回放导出（replay）。
  rateLimitEnabled: toBoolean(process.env.RATE_LIMIT_ENABLED, (process.env.NODE_ENV ?? "development") !== "test"),
  loginRateLimitWindowSeconds: toNumber(process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 60),
  loginRateLimitMax: toNumber(process.env.LOGIN_RATE_LIMIT_MAX, 10),
  inviteRateLimitWindowSeconds: toNumber(process.env.INVITE_RATE_LIMIT_WINDOW_SECONDS, 60),
  inviteRateLimitMax: toNumber(process.env.INVITE_RATE_LIMIT_MAX, 20),
  exportRateLimitWindowSeconds: toNumber(process.env.EXPORT_RATE_LIMIT_WINDOW_SECONDS, 60),
  exportRateLimitMax: toNumber(process.env.EXPORT_RATE_LIMIT_MAX, 30),

  // 基础可观测告警去重窗口（秒），避免同类告警刷屏。
  alertThrottleSeconds: toNumber(process.env.ALERT_THROTTLE_SECONDS, 60),

  // DB 连通性巡检（用于“DB 连接告警”）。
  dbHealthcheckEnabled: toBoolean(process.env.DB_HEALTHCHECK_ENABLED, true),
  dbHealthcheckIntervalSeconds: toNumber(process.env.DB_HEALTHCHECK_INTERVAL_SECONDS, 30),

  // 备份脚本配置。
  backupDir: process.env.DB_BACKUP_DIR ?? "backups/mysql",
  backupRetentionDays: toNumber(process.env.DB_BACKUP_RETENTION_DAYS, 7),
  backupScheduleMinutes: toNumber(process.env.DB_BACKUP_SCHEDULE_MINUTES, 1440)
};
