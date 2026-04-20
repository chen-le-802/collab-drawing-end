import dotenv from "dotenv";

// 读取项目根目录下的 .env 文件并注入到 process.env。
dotenv.config();

// 把字符串环境变量安全地转成数字。
// 如果没有配置，或者配置值不是合法数字，就回退到默认值。
const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// 统一导出环境变量配置。
// 后续其他模块都从这里拿配置，不要直接到处写 process.env.xxx。
export const env = {
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
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d"
};
