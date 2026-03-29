/**
 * CreditsController
 *
 * GET /api/credits/status          — 当前认证用户的额度状态（需求 7.3）
 * GET /api/admin/credits/:userId   — 管理员查询指定用户额度状态
 * POST /api/admin/recharge         — 管理员充值
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { creditManager } from '../services/creditManager';

export async function getStatusHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user.userId;
  try {
    const status = await creditManager.getStatus(userId);
    res.json({ data: status });
  } catch (err) {
    console.error('[CreditsController] GET /credits/status error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

export async function rechargeHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId, wallet_amount, pool_amount, total_duration, cycle_duration } = req.body as {
    userId: number;
    wallet_amount: number;
    pool_amount: number;
    total_duration: number;
    cycle_duration: number;
  };

  if (!userId) {
    res.status(400).json({ code: 4001, message: '缺少 userId 参数' });
    return;
  }

  try {
    await creditManager.recharge(userId, { wallet_amount, pool_amount, total_duration, cycle_duration });
    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 'INVALID_AMOUNT' || err.code === 'INVALID_PARAMS') {
      res.status(422).json({ code: err.code, message: err.message });
      return;
    }
    console.error('[CreditsController] POST /admin/recharge error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

export async function getAdminStatusHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = parseInt(rawUserId, 10);
  if (isNaN(userId)) {
    res.status(400).json({ code: 4001, message: '无效的用户 ID' });
    return;
  }
  try {
    const status = await creditManager.getStatus(userId);
    res.json({ data: status });
  } catch (err) {
    console.error('[CreditsController] GET /admin/credits/:userId error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}
