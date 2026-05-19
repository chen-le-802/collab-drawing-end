import { createWriteStream, promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

import { env } from "../config/env";

const pad = (num: number): string => String(num).padStart(2, "0");

const formatFileTime = (date: Date): string => {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
};

const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

const buildOutputPath = (): string => {
  const safeDbName = env.dbName || "unknown_db";
  const fileName = `${safeDbName}_${formatFileTime(new Date())}.sql`;
  return path.resolve(process.cwd(), env.backupDir, fileName);
};

const runMysqldump = async (outputPath: string): Promise<void> => {
  // 通过环境变量注入密码，避免出现在命令行参数里。
  const args = [
    "--host",
    env.dbHost,
    "--port",
    String(env.dbPort),
    "--user",
    env.dbUser,
    "--single-transaction",
    "--routines",
    "--triggers",
    "--databases",
    env.dbName
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("mysqldump", args, {
      env: {
        ...process.env,
        MYSQL_PWD: env.dbPassword
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const writer = createWriteStream(outputPath);
    child.stdout.pipe(writer);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      writer.end();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `mysqldump 退出码 ${code}`));
    });
  });
};

const cleanOldBackups = async (backupDirPath: string): Promise<void> => {
  const retentionMs = Math.max(1, env.backupRetentionDays) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const entries = await fs.readdir(backupDirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sql")) {
      continue;
    }
    const absPath = path.join(backupDirPath, entry.name);
    const stat = await fs.stat(absPath);
    if (now - stat.mtimeMs > retentionMs) {
      await fs.unlink(absPath);
      console.log(`[backup] 已清理过期备份：${entry.name}`);
    }
  }
};

const runOnce = async (): Promise<void> => {
  if (!env.dbName) {
    throw new Error("未配置 DB_NAME，无法执行数据库备份");
  }
  const backupDirPath = path.resolve(process.cwd(), env.backupDir);
  await ensureDir(backupDirPath);

  const outputPath = buildOutputPath();
  console.log(`[backup] 开始导出：${outputPath}`);
  await runMysqldump(outputPath);
  await cleanOldBackups(backupDirPath);
  console.log("[backup] 备份完成");
};

const runDaemon = async (): Promise<void> => {
  await runOnce();
  const intervalMs = Math.max(10, env.backupScheduleMinutes) * 60 * 1000;
  setInterval(() => {
    void runOnce().catch((error) => {
      console.error("[backup] 定时备份失败：", error instanceof Error ? error.message : String(error));
    });
  }, intervalMs);
  console.log(`[backup] 已启动定时备份，间隔 ${Math.max(10, env.backupScheduleMinutes)} 分钟`);
};

const main = async (): Promise<void> => {
  const mode = (process.argv[2] ?? "once").toLowerCase();
  if (mode === "once") {
    await runOnce();
    return;
  }
  if (mode === "daemon") {
    await runDaemon();
    return;
  }
  throw new Error(`不支持的备份模式：${mode}。可选值：once / daemon`);
};

main().catch((error) => {
  console.error(`[backup] 执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
