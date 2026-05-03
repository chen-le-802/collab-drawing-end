import fs from "fs";
import path from "path";
import { NextFunction, Request, Response } from "express";
import multer from "multer";

import { ApiResponse, AuthPayload } from "../types";

const AVATAR_MAX_SIZE = 2 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const uploadDir = path.resolve(process.cwd(), "uploads", "avatars");

const send = <T>(res: Response, payload: ApiResponse<T>): Response => {
  return res.status(200).json(payload);
};

const ensureUploadDir = (): void => {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const authReq = req as Request & { user?: AuthPayload };
    const userId = authReq.user?.userId ?? 0;
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `avatar_${userId}_${Date.now()}${ext.toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: AVATAR_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      cb(new Error("仅支持 JPG/JPEG、PNG、WEBP 格式头像"));
      return;
    }
    cb(null, true);
  }
});

export const avatarUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      send(res, { code: 1001, message: "头像图片大小不能超过 2MB", data: null });
      return;
    }

    send(res, { code: 1001, message: error instanceof Error ? error.message : "头像上传失败", data: null });
  });
};
