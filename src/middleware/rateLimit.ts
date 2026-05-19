import { NextFunction, Request, Response } from "express";

import { env } from "../config/env";
import { ApiResponse } from "../types";

type AuthRequest = Request & {
  user?: {
    userId: number;
  };
};

type RateLimitOptions = {
  keyPrefix: string;
  windowSeconds: number;
  maxRequests: number;
  getScopeKey: (req: Request) => string;
  errorMessage: string;
};

type CounterItem = {
  count: number;
  expiresAt: number;
};

const counters = new Map<string, CounterItem>();

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

// 惰性清理过期计数，避免 Map 长时间增长。
const cleanupExpiredCounters = (now: number): void => {
  for (const [key, item] of counters) {
    if (item.expiresAt <= now) {
      counters.delete(key);
    }
  }
};

const getClientIp = (req: Request): string => {
  const fromForward = req.headers["x-forwarded-for"];
  if (typeof fromForward === "string" && fromForward.trim()) {
    return fromForward.split(",")[0].trim();
  }
  if (Array.isArray(fromForward) && fromForward.length > 0) {
    return String(fromForward[0]);
  }
  return req.ip || "unknown";
};

export const createRateLimitMiddleware = (options: RateLimitOptions) => {
  const safeWindowMs = Math.max(1, Math.floor(options.windowSeconds * 1000));
  const safeMaxRequests = Math.max(1, Math.floor(options.maxRequests));

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!env.rateLimitEnabled) {
      next();
      return;
    }
    const now = Date.now();
    cleanupExpiredCounters(now);

    const scopeKey = options.getScopeKey(req);
    const key = `${options.keyPrefix}:${scopeKey}`;
    const existing = counters.get(key);

    if (!existing || existing.expiresAt <= now) {
      counters.set(key, {
        count: 1,
        expiresAt: now + safeWindowMs
      });
      next();
      return;
    }

    if (existing.count >= safeMaxRequests) {
      send(res, { code: 1010, message: options.errorMessage, data: null });
      return;
    }

    existing.count += 1;
    counters.set(key, existing);
    next();
  };
};

export const byIp = (req: Request): string => getClientIp(req);

export const byUserOrIp = (req: Request): string => {
  const authReq = req as AuthRequest;
  if (authReq.user?.userId) {
    return `u:${authReq.user.userId}`;
  }
  return `ip:${getClientIp(req)}`;
};
