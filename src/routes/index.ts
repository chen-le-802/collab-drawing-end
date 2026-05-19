import { Router } from "express";
import graphicRouter from "./graphic";
import userRouter from "./user";
import sessionRouter from "./session";

const router = Router();

// 这是一个最小健康检查接口。
// 以后服务启动后，如果你想先确认服务通没通，可以直接访问：
// GET http://localhost:3000/api/health
router.get("/health", (_req, res) => {
  res.status(200).json({ code: 0, message: "OK", data: null });
});

// 兼容单复数两种用户路由前缀，避免前端历史版本调用失败。
router.use("/v1/user", userRouter);
router.use("/v1/users", userRouter);
// graphics 嵌套路由依赖上层 :sessionKey 参数（mergeParams=true）。
router.use("/v1/sessions/:sessionKey/graphics", graphicRouter);
router.use("/v1/sessions", sessionRouter);

export default router;
