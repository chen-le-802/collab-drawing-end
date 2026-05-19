import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import mysql, { Connection, RowDataPacket } from "mysql2/promise";

import { env } from "../config/env";

type MigrationMode = "up" | "status" | "baseline";

type MigrationRow = RowDataPacket & {
  filename: string;
  checksum: string;
  applied_at: Date | string;
};

const MIGRATIONS_DIR = path.resolve(process.cwd(), "src", "migrations");
const BASELINE_FILE = "collab_drawing_db.sql";
const INCREMENTAL_SQL_PATTERN = /^\d{4}-\d{2}-\d{2}_.+\.sql$/i;

const parseMode = (): MigrationMode => {
  const mode = (process.argv[2] ?? "up").toLowerCase();
  if (mode !== "up" && mode !== "status" && mode !== "baseline") {
    throw new Error(`不支持的迁移命令：${mode}。可选值：up / status / baseline`);
  }
  return mode;
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const createMigrationConnection = async (): Promise<Connection> => {
  // 迁移脚本需要执行多条 SQL 语句，因此开启 multipleStatements。
  return mysql.createConnection({
    host: env.dbHost,
    port: env.dbPort,
    user: env.dbUser,
    password: env.dbPassword,
    database: env.dbName,
    multipleStatements: true
  });
};

const ensureMigrationTable = async (connection: Connection): Promise<void> => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT NOT NULL AUTO_INCREMENT COMMENT '记录编号',
      filename VARCHAR(255) NOT NULL COMMENT '迁移文件名',
      checksum CHAR(64) NOT NULL COMMENT '文件内容哈希',
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '执行时间',
      PRIMARY KEY (id),
      UNIQUE KEY uk_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据库迁移历史表'
  `);
};

const readSqlFile = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath, "utf8");
  return content.trim();
};

const listSqlFiles = async (): Promise<string[]> => {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const listIncrementalMigrations = async (): Promise<string[]> => {
  const sqlFiles = await listSqlFiles();
  return sqlFiles.filter((file) => INCREMENTAL_SQL_PATTERN.test(file));
};

const getAppliedMigrations = async (
  connection: Connection
): Promise<Map<string, MigrationRow>> => {
  const [rows] = await connection.query<MigrationRow[]>(
    "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY id ASC"
  );
  return new Map(rows.map((row) => [row.filename, row]));
};

const applySingleMigration = async (
  connection: Connection,
  fileName: string
): Promise<void> => {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const sql = await readSqlFile(filePath);
  if (!sql) {
    console.log(`[migrate] 跳过空文件：${fileName}`);
    return;
  }
  const checksum = sha256(sql);

  const [rows] = await connection.query<MigrationRow[]>(
    "SELECT filename, checksum FROM schema_migrations WHERE filename = ? LIMIT 1",
    [fileName]
  );
  const existing = rows[0];
  if (existing) {
    if (existing.checksum !== checksum) {
      throw new Error(
        `[migrate] 迁移文件已执行但内容发生变化：${fileName}。请新建一个增量迁移文件，不要修改已执行文件。`
      );
    }
    console.log(`[migrate] 已执行，跳过：${fileName}`);
    return;
  }

  console.log(`[migrate] 执行中：${fileName}`);
  await connection.query(sql);
  await connection.execute(
    "INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)",
    [fileName, checksum]
  );
  console.log(`[migrate] 已完成：${fileName}`);
};

const runIncrementalMigrations = async (connection: Connection): Promise<void> => {
  const files = await listIncrementalMigrations();
  if (files.length === 0) {
    console.log("[migrate] 未发现增量迁移文件（格式：YYYY-MM-DD_*.sql）。");
    return;
  }

  for (const fileName of files) {
    await applySingleMigration(connection, fileName);
  }
};

const runBaselineMigration = async (connection: Connection): Promise<void> => {
  const baselinePath = path.join(MIGRATIONS_DIR, BASELINE_FILE);
  const sql = await readSqlFile(baselinePath);
  if (!sql) {
    throw new Error(`[migrate] 基线文件为空：${BASELINE_FILE}`);
  }
  const checksum = sha256(sql);

  const [rows] = await connection.query<MigrationRow[]>(
    "SELECT filename, checksum FROM schema_migrations WHERE filename = ? LIMIT 1",
    [BASELINE_FILE]
  );
  const existing = rows[0];
  if (existing && existing.checksum === checksum) {
    console.log(`[migrate] 基线已执行，跳过：${BASELINE_FILE}`);
    return;
  }
  if (existing && existing.checksum !== checksum) {
    throw new Error(
      `[migrate] 检测到已执行过不同版本的基线文件：${BASELINE_FILE}。请确认环境后再手工处理。`
    );
  }

  console.log(`[migrate] 执行基线：${BASELINE_FILE}`);
  await connection.query(sql);
  await connection.execute(
    "INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)",
    [BASELINE_FILE, checksum]
  );
  console.log(`[migrate] 基线执行完成：${BASELINE_FILE}`);
};

const printStatus = async (connection: Connection): Promise<void> => {
  const files = await listIncrementalMigrations();
  const appliedMap = await getAppliedMigrations(connection);

  console.log("=== Migration Status ===");
  if (files.length === 0) {
    console.log("无增量迁移文件。");
    return;
  }

  for (const file of files) {
    const applied = appliedMap.get(file);
    if (applied) {
      const appliedAt =
        applied.applied_at instanceof Date
          ? applied.applied_at.toISOString().replace("T", " ").slice(0, 19)
          : String(applied.applied_at);
      console.log(`[APPLIED] ${file} @ ${appliedAt}`);
      continue;
    }
    console.log(`[PENDING] ${file}`);
  }
};

const main = async (): Promise<void> => {
  if (!env.dbName) {
    throw new Error("未配置 DB_NAME，无法执行迁移。请先在 .env 中填写数据库名。");
  }

  const mode = parseMode();
  const connection = await createMigrationConnection();
  try {
    await ensureMigrationTable(connection);

    if (mode === "status") {
      await printStatus(connection);
      return;
    }
    if (mode === "baseline") {
      await runBaselineMigration(connection);
      return;
    }
    await runIncrementalMigrations(connection);
  } finally {
    await connection.end();
  }
};

main().catch((error) => {
  console.error(`[migrate] 执行失败：${(error as Error).message}`);
  process.exit(1);
});
