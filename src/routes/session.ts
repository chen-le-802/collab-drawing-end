import { Router } from "express";

import {
  createSession,
  deleteSession,
  getSessionDetail,
  getSessionList,
  heartbeatSession,
  joinSession,
  leaveSession
} from "../controllers/sessionController";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// 会话模块所有接口都要求登录态。
router.use(authMiddleware);

router.post("/", createSession);
router.get("/", getSessionList);
router.get("/:sessionKey", getSessionDetail);
router.post("/:sessionKey/join", joinSession);
router.post("/:sessionKey/heartbeat", heartbeatSession);
router.post("/:sessionKey/leave", leaveSession);
router.delete("/:sessionKey", deleteSession);

export default router;
