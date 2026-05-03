import { Router } from "express";
import { getMe, getProfile, login, logout, putProfile, register } from "../controllers/userController";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// 用户注册
router.post("/register", register);
// 用户登录
router.post("/login", login);
// 获取当前登录用户信息（需鉴权）
router.get("/me", authMiddleware, getMe);
// 获取个人中心信息（需鉴权）
router.get("/profile", authMiddleware, getProfile);
// 更新个人中心信息（需鉴权）
router.put("/profile", authMiddleware, putProfile);
// 退出登录（需鉴权）
router.post("/logout", authMiddleware, logout);

export default router;
