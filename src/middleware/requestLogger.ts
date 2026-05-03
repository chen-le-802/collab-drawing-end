import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

type AuthRequest = Request & {
  user?: {
    userId: number;
  };
};

type LoggerPayload = {
  type: "http_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId: number | null;
  ip: string;
};

const REQUEST_ID_HEADER = "X-Request-Id";

const getClientIp = (req: Request): string => {
  if (typeof req.headers["x-forwarded-for"] === "string") {
    const [firstIp] = req.headers["x-forwarded-for"].split(",");
    return firstIp.trim();
  }

  if (Array.isArray(req.headers["x-forwarded-for"]) && req.headers["x-forwarded-for"].length > 0) {
    return req.headers["x-forwarded-for"][0];
  }

  return req.ip ?? "";
};

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  const requestId = randomUUID();
  const authReq = req as AuthRequest;

  res.setHeader(REQUEST_ID_HEADER, requestId);

  res.on("finish", () => {
    const payload: LoggerPayload = {
      type: "http_request",
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      userId: authReq.user?.userId ?? null,
      ip: getClientIp(req)
    };

    // 先采用控制台结构化日志，后续可无缝接入日志平台。
    console.log(JSON.stringify(payload));
  });

  next();
};

