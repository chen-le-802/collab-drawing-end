import { env } from "../config/env";

type AlertLevel = "warn" | "error";

type AlertEvent = {
  key: string;
  level: AlertLevel;
  message: string;
  detail?: Record<string, unknown>;
};

const lastAlertAt = new Map<string, number>();

const shouldEmit = (key: string): boolean => {
  const now = Date.now();
  const throttleMs = Math.max(1, env.alertThrottleSeconds) * 1000;
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < throttleMs) {
    return false;
  }
  lastAlertAt.set(key, now);
  return true;
};

export const emitAlert = (event: AlertEvent): void => {
  if (!shouldEmit(event.key)) {
    return;
  }
  const payload = {
    type: "system_alert",
    key: event.key,
    level: event.level,
    message: event.message,
    detail: event.detail ?? null,
    timestamp: new Date().toISOString()
  };
  const text = JSON.stringify(payload);
  if (event.level === "error") {
    console.error(text);
    return;
  }
  console.warn(text);
};
