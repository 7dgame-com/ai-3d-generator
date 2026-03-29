/**
 * UsageController
 *
 * GET /api/usage         — 当前用户用量统计（总消耗、本月消耗、任务数、按日期趋势）
 * GET /api/usage/history — 用量历史列表，支持 startDate、endDate、type 筛选
 */

import { Response } from 'express';
import { query } from '../db/connection';
import { AuthenticatedRequest } from '../middleware/auth';

// ─── GET /api/usage ──────────────────────────────────────────────────────────

export async function getUsageSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user.userId;

  try {
    // 总消耗 credits
    const totalRows = await query<Array<{ total: number }>>(
      'SELECT COALESCE(SUM(credits_used), 0) AS total FROM credit_usage WHERE user_id = ?',
      [userId]
    );
    const totalCredits = Number(totalRows[0]?.total ?? 0);

    // 本月消耗 credits
    const monthRows = await query<Array<{ month_total: number }>>(
      `SELECT COALESCE(SUM(credits_used), 0) AS month_total
       FROM credit_usage
       WHERE user_id = ?
         AND MONTH(created_at) = MONTH(CURDATE())
         AND YEAR(created_at) = YEAR(CURDATE())`,
      [userId]
    );
    const monthCredits = Number(monthRows[0]?.month_total ?? 0);

    // 任务总数
    const taskCountRows = await query<Array<{ task_count: number }>>(
      'SELECT COUNT(*) AS task_count FROM tasks WHERE user_id = ?',
      [userId]
    );
    const taskCount = Number(taskCountRows[0]?.task_count ?? 0);

    // 最近 30 天按日期趋势
    const trendRows = await query<Array<{ date: string; credits: number }>>(
      `SELECT DATE(created_at) AS date, SUM(credits_used) AS credits
       FROM credit_usage
       WHERE user_id = ?
         AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [userId]
    );

    res.json({
      totalCredits,
      monthCredits,
      taskCount,
      dailyTrend: trendRows.map((r) => ({
        date: r.date,
        credits: Number(r.credits),
      })),
    });
  } catch (err) {
    console.error('[UsageController] GET /usage error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

// ─── GET /api/usage/history ──────────────────────────────────────────────────

export async function getUsageHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user.userId;
  const { startDate, endDate, type } = req.query as {
    startDate?: string;
    endDate?: string;
    type?: string;
  };

  try {
    const conditions: string[] = ['cu.user_id = ?'];
    const params: unknown[] = [userId];

    if (startDate) {
      conditions.push('DATE(cu.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      conditions.push('DATE(cu.created_at) <= ?');
      params.push(endDate);
    }

    if (type && (type === 'text_to_model' || type === 'image_to_model')) {
      conditions.push('t.type = ?');
      params.push(type);
    }

    const whereClause = conditions.join(' AND ');

    const rows = await query<
      Array<{
        task_id: string;
        type: string;
        prompt: string | null;
        credits_used: number;
        created_at: string;
        status: string;
      }>
    >(
      `SELECT
         cu.task_id,
         t.type,
         t.prompt,
         cu.credits_used,
         cu.created_at,
         t.status
       FROM credit_usage cu
       LEFT JOIN tasks t ON cu.task_id = t.task_id
       WHERE ${whereClause}
       ORDER BY cu.created_at DESC`,
      params
    );

    res.json({
      data: rows.map((r) => ({
        taskId: r.task_id,
        type: r.type,
        prompt: r.prompt ? r.prompt.slice(0, 50) : null,
        creditsUsed: Number(r.credits_used),
        createdAt: r.created_at,
        status: r.status,
      })),
    });
  } catch (err) {
    console.error('[UsageController] GET /usage/history error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}
