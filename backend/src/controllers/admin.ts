/**
 * AdminController
 *
 * GET  /api/admin/config  — 读取 API Key（脱敏返回）
 * PUT  /api/admin/config  — 验证格式 + 连通性，加密写入 system_config
 * GET  /api/admin/usage   — 全局 credit 消耗统计
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { query } from '../db/connection';
import { encrypt, decrypt } from '../services/crypto';

export const adminRouter = Router();

// ─── GET /api/admin/config ───────────────────────────────────────────────────

adminRouter.get('/config', async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await query<Array<{ value: string }>>(
      "SELECT `value` FROM system_config WHERE `key` = 'tripo3d_api_key' LIMIT 1"
    );

    if (!rows || rows.length === 0) {
      res.json({ configured: false });
      return;
    }

    let plaintext: string;
    try {
      plaintext = decrypt(rows[0].value);
    } catch {
      res.json({ configured: false });
      return;
    }

    // 脱敏：前 8 位 + ****
    const masked = plaintext.slice(0, 8) + '****';
    res.json({ configured: true, maskedKey: masked });
  } catch (err) {
    console.error('[AdminController] GET /config error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
});

// ─── PUT /api/admin/config ───────────────────────────────────────────────────

adminRouter.put('/config', async (req: Request, res: Response): Promise<void> => {
  const { apiKey } = req.body as { apiKey?: string };

  // 格式验证：tsk_ 开头，长度 >= 10
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(422).json({ code: 4001, message: '参数错误', errors: ['apiKey 不能为空'] });
    return;
  }

  if (!apiKey.startsWith('tsk_') || apiKey.length < 10) {
    res.status(422).json({
      code: 4001,
      message: '参数错误',
      errors: ['API Key 格式无效：必须以 tsk_ 开头且长度不少于 10 个字符'],
    });
    return;
  }

  // 连通性验证：调用 Tripo3D balance 接口
  try {
    await axios.get('https://api.tripo3d.ai/v2/openapi/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        res.status(422).json({ code: 4001, message: 'API Key 无效或无权限', errors: ['连通性验证失败'] });
        return;
      }
      const detail = err.message;
      res.status(502).json({ code: 3002, message: 'AI 服务暂时不可用', detail });
      return;
    }
    res.status(502).json({ code: 3002, message: 'AI 服务暂时不可用', detail: String(err) });
    return;
  }

  // 加密并 upsert
  try {
    const encrypted = encrypt(apiKey);
    await query(
      `INSERT INTO system_config (\`key\`, \`value\`) VALUES ('tripo3d_api_key', ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
      [encrypted]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[AdminController] PUT /config error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
});

// ─── GET /api/admin/usage ────────────────────────────────────────────────────

adminRouter.get('/usage', async (_req: Request, res: Response): Promise<void> => {
  try {
    // 总消耗
    const totalRows = await query<Array<{ total: number }>>(
      'SELECT COALESCE(SUM(credits_used), 0) AS total FROM credit_usage'
    );
    const totalCredits = Number(totalRows[0]?.total ?? 0);

    // 按用户排行（Top 20）
    const rankingRows = await query<Array<{ user_id: number; total_credits: number }>>(
      `SELECT user_id, SUM(credits_used) AS total_credits
       FROM credit_usage
       GROUP BY user_id
       ORDER BY total_credits DESC
       LIMIT 20`
    );

    // 按日期趋势（最近 30 天）
    const trendRows = await query<Array<{ date: string; credits: number }>>(
      `SELECT DATE(created_at) AS date, SUM(credits_used) AS credits
       FROM credit_usage
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );

    res.json({
      totalCredits,
      ranking: rankingRows.map((r) => ({
        userId: r.user_id,
        totalCredits: Number(r.total_credits),
      })),
      dailyTrend: trendRows.map((r) => ({
        date: r.date,
        credits: Number(r.credits),
      })),
    });
  } catch (err) {
    console.error('[AdminController] GET /usage error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
});
