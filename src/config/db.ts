import mysql, { Pool } from "mysql2/promise";

import { env } from "./env";

// 创建 MySQL 连接池，而不是每次请求都新建连接。
// 连接池更适合后端服务场景，性能和资源利用率更稳定。
export const dbPool: Pool = mysql.createPool({
  host: env.dbHost,
  port: env.dbPort,
  user: env.dbUser,
  password: env.dbPassword,
  database: env.dbName,

  // 没有空闲连接时，允许排队等待。
  waitForConnections: true,

  // 同时最多保留的连接数。
  connectionLimit: 10,

  // 0 表示不限制排队请求数量。
  queueLimit: 0
});
