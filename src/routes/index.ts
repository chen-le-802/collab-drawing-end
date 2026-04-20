import { Router } from "express";
import userRouter from "./user";

const router = Router();

// 这是一个最小健康检查接口。
// 以后服务启动后，如果你想先确认服务通没通，可以直接访问：
// GET http://localhost:3000/api/health
router.get("/health", (_req, res) => {
  res.status(200).json({ message: "OK" });
});

router.use("/user", userRouter);

export default router;
