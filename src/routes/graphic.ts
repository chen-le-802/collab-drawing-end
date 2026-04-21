import { Router } from "express";

import { getSessionGraphics } from "../controllers/graphicController";
import { authMiddleware } from "../middleware/auth";

const router = Router({ mergeParams: true });

// 图形查询接口需要登录，且服务层会再次校验会话成员权限。
router.use(authMiddleware);

// GET /api/v1/sessions/:sessionKey/graphics
// Query: sinceVersion?（不传全量，传入则增量）。
router.get("/", getSessionGraphics);

export default router;
