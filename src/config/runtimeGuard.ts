import { env } from "./env";

// 生产环境启动前做一次“硬性配置检查”，避免带着弱配置上线。
export const runRuntimeGuard = (): void => {
  if (!env.isProduction) {
    return;
  }

  const errors: string[] = [];
  const warns: string[] = [];

  if (!env.jwtSecret || env.jwtSecret.trim().length < 32) {
    errors.push("JWT_SECRET 未配置或长度不足（生产环境建议至少 32 字符）");
  }

  if (env.redisEnabled && !env.redisPassword) {
    errors.push("REDIS_ENABLED=true 时，生产环境必须配置 REDIS_PASSWORD");
  }

  if (env.avatarMaxSizeMb > 5) {
    warns.push(`AVATAR_MAX_SIZE_MB=${env.avatarMaxSizeMb} 偏大，建议 <= 5`);
  }
  if (env.sessionImageMaxSizeMb > 20) {
    warns.push(`SESSION_IMAGE_MAX_SIZE_MB=${env.sessionImageMaxSizeMb} 偏大，建议 <= 20`);
  }

  if (env.loginRateLimitMax > 30) {
    warns.push(`LOGIN_RATE_LIMIT_MAX=${env.loginRateLimitMax} 偏高，可能降低防爆破效果`);
  }

  for (const warning of warns) {
    console.warn(`[runtime_guard][WARN] ${warning}`);
  }

  if (errors.length > 0) {
    const detail = errors.map((item) => `- ${item}`).join("\n");
    throw new Error(`生产配置检查失败：\n${detail}`);
  }
};
