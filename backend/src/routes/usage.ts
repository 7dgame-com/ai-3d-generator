/**
 * Usage 路由
 *
 * 所有路由均需要：
 *   1. auth 中间件（JWT 验证）
 *   2. requirePermission('view-usage') 中间件（权限验证）
 */

import { Router, Request, Response } from 'express';
import { auth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getUsageSummary, getUsageHistory } from '../controllers/usage';
import { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get(
  '/',
  auth,
  requirePermission('view-usage'),
  (req: Request, res: Response) => getUsageSummary(req as AuthenticatedRequest, res)
);

router.get(
  '/history',
  auth,
  requirePermission('view-usage'),
  (req: Request, res: Response) => getUsageHistory(req as AuthenticatedRequest, res)
);

export default router;
