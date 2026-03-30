/**
 * AdminController
 *
 * GET  /api/admin/config     — 读取 API Key（脱敏返回），支持 provider_id query 参数
 * PUT  /api/admin/config     — 验证格式 + 连通性，加密写入 system_config，支持 provider_id body 参数
 * GET  /api/admin/balance    — 查询提供商余额，支持 provider_id query 参数
 * GET  /api/admin/usage      — 全局 credit 消耗统计
 * GET  /api/admin/providers  — 返回已启用提供商列表
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { encrypt, decrypt } from '../services/crypto';
import { providerRegistry } from '../adapters/ProviderRegistry';

export const adminRouter = Router();

// ─── GET /api/admin/config ───────────────────────────────────────────────────

adminRouter.get('/config', async (req: Request, res: Response): Promise<void> => {
  const providerId = (req.query.provider_id as string | undefined) ?? 'tripo3d';
  const configKey = `${providerId}_api_key`;

  try {
    const rows = await query<Array<{ value: string }>>(
      'SELECT `value` FROM system_config WHERE `key` = ? LIMIT 1',
      [configKey]
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
  const { apiKey, provider_id: rawProviderId } = req.body as { apiKey?: string; provider_id?: string };
  const providerId = rawProviderId ?? 'tripo3d';

  // 格式验证
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(422).json({ code: 4001, message: '参数错误', errors: ['apiKey 不能为空'] });
    return;
  }

  // 获取适配器进行格式和连通性验证
  const adapter = providerRegistry.get(providerId);
  if (!adapter) {
    res.status(422).json({ code: 'INVALID_PROVIDER', message: '无效或未启用的服务提供商' });
    return;
  }

  if (!adapter.validateApiKeyFormat(apiKey)) {
    res.status(422).json({
      code: 4001,
      message: '参数错误',
      errors: ['API Key 格式无效'],
    });
    return;
  }

  // 连通性验证
  try {
    await adapter.verifyApiKey(apiKey);
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string; detail?: string };
    if (e.status === 422) {
      res.status(422).json({ code: e.code ?? 4001, message: e.message ?? 'API Key 无效或无权限', errors: ['连通性验证失败'] });
      return;
    }
    res.status(502).json({ code: e.code ?? 3002, message: e.message ?? 'AI 服务暂时不可用', detail: e.detail });
    return;
  }

  // 加密并 upsert
  try {
    const encrypted = encrypt(apiKey);
    const configKey = `${providerId}_api_key`;
    await query(
      `INSERT INTO system_config (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
      [configKey, encrypted]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[AdminController] PUT /config error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
});

// ─── GET /api/admin/balance ──────────────────────────────────────────────────

adminRouter.get('/balance', async (req: Request, res: Response): Promise<void> => {
  const providerId = (req.query.provider_id as string | undefined) ?? 'tripo3d';
  const configKey = `${providerId}_api_key`;

  const adapter = providerRegistry.get(providerId);
  if (!adapter) {
    res.status(422).json({ code: 'INVALID_PROVIDER', message: '无效或未启用的服务提供商' });
    return;
  }

  try {
    const rows = await query<Array<{ value: string }>>(
      'SELECT `value` FROM system_config WHERE `key` = ? LIMIT 1',
      [configKey]
    );
    if (!rows || rows.length === 0) {
      res.json({ configured: false });
      return;
    }

    let apiKey: string;
    try {
      apiKey = decrypt(rows[0].value);
    } catch {
      res.json({ configured: false });
      return;
    }

    const balance = await adapter.getBalance(apiKey);
    res.json({
      configured: true,
      available: balance.available,
      frozen: balance.frozen,
    });
  } catch (err) {
    const e = err as { status?: number; code?: number; message?: string };
    if (e.status === 422) {
      res.status(422).json({ code: e.code ?? 4001, message: e.message ?? 'API Key 无效' });
      return;
    }
    console.error('[AdminController] GET /balance error:', err);
    res.status(502).json({ code: 3002, message: '查询余额失败' });
  }
});

// ─── GET /api/admin/providers ────────────────────────────────────────────────

adminRouter.get('/providers', (_req: Request, res: Response): void => {
  const providers = providerRegistry.getEnabledIds();
  res.json({ providers });
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
