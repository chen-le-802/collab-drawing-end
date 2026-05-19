import { Router } from "express";
import { getMe, getProfile, login, logout, postChangePassword, putProfile, register, uploadAvatar } from "../controllers/userController";
import { authMiddleware } from "../middleware/auth";
import { avatarUploadMiddleware } from "../middleware/avatarUpload";
import { byIp, createRateLimitMiddleware } from "../middleware/rateLimit";
import { env } from "../config/env";

const router = Router();

// 用户注册
router.post("/register", register);
// 用户登录
router.post(
  "/login",
  createRateLimitMiddleware({
    keyPrefix: "login",
    windowSeconds: env.loginRateLimitWindowSeconds,
    maxRequests: env.loginRateLimitMax,
    getScopeKey: byIp,
    errorMessage: "登录过于频繁，请稍后再试"
  }),
  login
);
// 获取当前登录用户信息（需鉴权）
router.get("/me", authMiddleware, getMe);
// 获取个人中心信息（需鉴权）
router.get("/profile", authMiddleware, getProfile);
// 更新个人中心信息（需鉴权）
router.put("/profile", authMiddleware, putProfile);
// 修改登录密码（需鉴权）
router.post("/change-password", authMiddleware, postChangePassword);
// 上传头像（需鉴权）
router.post("/avatar", authMiddleware, avatarUploadMiddleware, uploadAvatar);
// 退出登录（需鉴权）
router.post("/logout", authMiddleware, logout);

export default router;
