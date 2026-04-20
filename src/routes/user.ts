import { Router } from "express";
import { getMe, login, logout, register } from "../controllers/userController";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// 用户注册
router.post("/register", register);
// 用户登录
router.post("/login", login);
// 获取当前登录用户信息（需鉴权）
router.get("/me", authMiddleware, getMe);
// 退出登录（需鉴权）
router.post("/logout", authMiddleware, logout);

export default router;
