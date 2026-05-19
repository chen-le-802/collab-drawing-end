import { dbPool } from "../config/db";
import { env } from "../config/env";
import { emitAlert } from "./alertService";

let timer: NodeJS.Timeout | null = null;

const runCheck = async (): Promise<void> => {
  try {
    await dbPool.query("SELECT 1");
  } catch (error) {
    emitAlert({
      key: "db.connection.error",
      level: "error",
      message: "数据库连接巡检失败",
      detail: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
};

export const startDbHealthcheck = (): void => {
  if (!env.dbHealthcheckEnabled) {
    return;
  }
  if (timer) {
    return;
  }
  const intervalMs = Math.max(5, env.dbHealthcheckIntervalSeconds) * 1000;
  timer = setInterval(() => {
    void runCheck();
  }, intervalMs);
};

export const stopDbHealthcheck = (): void => {
  if (!timer) {
    return;
  }
  clearInterval(timer);
  timer = null;
};
