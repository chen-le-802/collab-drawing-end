import { Router } from "express";

import {
  createSessionSnapshot,
  createSessionInvite,
  getSessionInviteList,
  revokeSessionInvite,
  uploadSessionImage,
  createSession,
  closeSession,
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
  updateSessionPausedStatus,
  updateSessionMemberRole
} from "../controllers/sessionController";
import { authMiddleware } from "../middleware/auth";
import { sessionImageUploadMiddleware } from "../middleware/sessionImageUpload";
import { byUserOrIp, createRateLimitMiddleware } from "../middleware/rateLimit";
import { env } from "../config/env";

const router = Router();

// 会话模块所有接口都要求登录态。
router.use(authMiddleware);

// 会话基础能力：创建、列表、详情。
router.post("/", createSession);
router.get("/", getSessionList);
router.get("/:sessionKey", getSessionDetail);
// 协同审计能力：操作流、冲突流、回放与恢复。
router.get("/:sessionKey/operations", getSessionOperations);
router.get("/:sessionKey/operation-timeline", getSessionOperationTimeline);
router.get("/:sessionKey/conflicts", getSessionConflictLogs);
router.get("/:sessionKey/snapshots", getSessionSnapshots);
router.get(
  "/:sessionKey/replay",
  createRateLimitMiddleware({
    keyPrefix: "export_replay",
    windowSeconds: env.exportRateLimitWindowSeconds,
    maxRequests: env.exportRateLimitMax,
    getScopeKey: byUserOrIp,
    errorMessage: "导出/回放请求过于频繁，请稍后再试"
  }),
  getSessionReplay
);
router.post("/:sessionKey/restore-version", restoreSessionVersion);
router.post("/:sessionKey/snapshots", createSessionSnapshot);
// 邀请与图片上传能力。
router.post(
  "/:sessionKey/invites",
  createRateLimitMiddleware({
    keyPrefix: "invite",
    windowSeconds: env.inviteRateLimitWindowSeconds,
    maxRequests: env.inviteRateLimitMax,
    getScopeKey: byUserOrIp,
    errorMessage: "邀请操作过于频繁，请稍后再试"
  }),
  createSessionInvite
);
router.get("/:sessionKey/invites", getSessionInviteList);
router.post("/:sessionKey/invites/:inviteId/revoke", revokeSessionInvite);
router.post("/:sessionKey/images", sessionImageUploadMiddleware, uploadSessionImage);
// 成员协作生命周期能力。
router.post("/:sessionKey/join", joinSession);
router.post("/:sessionKey/heartbeat", heartbeatSession);
router.post("/:sessionKey/leave", leaveSession);
router.post("/:sessionKey/members/:userId/remove", removeSessionMember);
router.post("/:sessionKey/members/:userId/role", updateSessionMemberRole);
// 会话治理能力。
router.post("/:sessionKey/pause", updateSessionPausedStatus);
router.post("/:sessionKey/close", closeSession);
router.delete("/:sessionKey", deleteSession);

export default router;
