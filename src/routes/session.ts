import { Router } from "express";

import {
  createSessionSnapshot,
  createSession,
  deleteSession,
  getSessionConflictLogs,
  getSessionDetail,
  getSessionOperations,
  getSessionOperationTimeline,
  getSessionReplay,
  restoreSessionVersion,
  getSessionSnapshots,
  getSessionList,
  heartbeatSession,
  joinSession,
  leaveSession,
  removeSessionMember,
  transferSessionCreator
} from "../controllers/sessionController";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// 会话模块所有接口都要求登录态。
router.use(authMiddleware);

router.post("/", createSession);
router.get("/", getSessionList);
router.get("/:sessionKey", getSessionDetail);
router.get("/:sessionKey/operations", getSessionOperations);
router.get("/:sessionKey/operation-timeline", getSessionOperationTimeline);
router.get("/:sessionKey/conflicts", getSessionConflictLogs);
router.get("/:sessionKey/snapshots", getSessionSnapshots);
router.get("/:sessionKey/replay", getSessionReplay);
router.post("/:sessionKey/restore-version", restoreSessionVersion);
router.post("/:sessionKey/snapshots", createSessionSnapshot);
router.post("/:sessionKey/join", joinSession);
router.post("/:sessionKey/heartbeat", heartbeatSession);
router.post("/:sessionKey/leave", leaveSession);
router.post("/:sessionKey/members/:userId/remove", removeSessionMember);
router.post("/:sessionKey/transfer/:userId", transferSessionCreator);
router.delete("/:sessionKey", deleteSession);

export default router;
