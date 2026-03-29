/**
 * Credits 路由
 *
 * GET /credits/status              — auth（当前用户额度状态）
 * GET /admin/credits/:userId       — auth + requirePermission('admin-config')（管理员查询）
 * POST /admin/recharge             — auth + requirePermission('admin-config')（管理员充值）
 */

import { Router, RequestHandler } from 'express';
import { auth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getStatusHandler, getAdminStatusHandler, rechargeHandler } from '../controllers/credits';

const router = Router();

router.post('/admin/recharge', auth, requirePermission('admin-config'), rechargeHandler as unknown as RequestHandler);
router.get('/credits/status', auth, getStatusHandler as unknown as RequestHandler);
router.get('/admin/credits/:userId', auth, requirePermission('admin-config'), getAdminStatusHandler as unknown as RequestHandler);

export default router;
