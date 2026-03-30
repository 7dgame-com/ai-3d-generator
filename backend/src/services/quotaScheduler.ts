/**
 * QuotaScheduler — 周期性额度调度器
 *
 * - 启动时查询所有 next_cycle_at 不为 null 的用户，计算剩余时间，使用 setTimeout 精确调度
 * - 到期时依次执行：settleWallet（结转上周期）→ 更新 next_cycle_at → injectWallet（注入新周期）→ 调度下一次触发
 * - 在 quota_jobs 表插入 pending 记录（UNIQUE cycle_key 防重），执行后更新 status 为 done 或 failed
 * - 调度误差不超过 30 秒（需求 2.4）
 */

import { pool } from '../db/connection';
import { creditManager } from './creditManager';

// Map of `${providerId}:${userId}` → setTimeout handle
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 启动调度器：查询所有待调度用户并注册定时器
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 8.2
 */
export async function startScheduler(): Promise<void> {
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT user_id, provider_id, cycle_duration, next_cycle_at FROM user_accounts WHERE next_cycle_at IS NOT NULL'
    );

    if (!rows || rows.length === 0) {
      console.log('[QuotaScheduler] 启动时无待调度用户');
      return;
    }

    console.log(`[QuotaScheduler] 启动时发现 ${rows.length} 个待调度用户`);
    for (const row of rows) {
      const userId: number = row.user_id;
      const providerId: string = row.provider_id;
      const cycleDuration: number = row.cycle_duration;
      const nextCycleAt: Date = new Date(row.next_cycle_at);
      await scheduleUser(userId, providerId, cycleDuration, nextCycleAt);
    }
  } catch (err) {
    console.error('[QuotaScheduler] 启动失败:', (err as Error).message);
  }
}

/**
 * 停止调度器：清除所有定时器
 */
export function stopScheduler(): void {
  for (const timer of scheduledTimers.values()) {
    clearTimeout(timer);
  }
  scheduledTimers.clear();
  console.log('[QuotaScheduler] 已停止，所有定时器已清除');
}

/**
 * 为指定用户注册下一次周期触发的定时器
 */
async function scheduleUser(
  userId: number,
  providerId: string,
  cycleDurationMinutes: number,
  nextCycleAt: Date
): Promise<void> {
  const timerKey = `${providerId}:${userId}`;

  // 清除已有定时器（防止重复调度）
  const existing = scheduledTimers.get(timerKey);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  const now = Date.now();
  const triggerAt = nextCycleAt.getTime();
  const delayMs = Math.max(0, triggerAt - now);

  console.log(
    `[QuotaScheduler] 用户 ${userId} (${providerId}) 下次周期触发时间: ${nextCycleAt.toISOString()}，` +
    `距现在 ${Math.round(delayMs / 1000)} 秒`
  );

  const timer = setTimeout(async () => {
    scheduledTimers.delete(timerKey);
    await runCycle(userId, providerId, cycleDurationMinutes, nextCycleAt);
  }, delayMs);

  scheduledTimers.set(timerKey, timer);
}

/**
 * 执行一次周期：settle → 更新 next_cycle_at → inject → 调度下一次
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 8.2
 */
async function runCycle(
  userId: number,
  providerId: string,
  cycleDurationMinutes: number,
  cycleStartAt: Date
): Promise<void> {
  const cycleKey = `${providerId}:${userId}:${cycleStartAt.toISOString()}`;

  console.log(`[QuotaScheduler] 用户 ${userId} (${providerId}) 开始执行周期，cycle_key: ${cycleKey}`);

  // 1. 插入 quota_jobs pending 记录（UNIQUE cycle_key 防重）
  try {
    await pool.query(
      "INSERT INTO quota_jobs (user_id, provider_id, job_type, cycle_key, status) VALUES (?, ?, 'inject', ?, 'pending')",
      [userId, providerId, cycleKey]
    );
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.warn(`[QuotaScheduler] 用户 ${userId} (${providerId}) 周期 ${cycleKey} 已处理，跳过`);
      return;
    }
    console.error(`[QuotaScheduler] 用户 ${userId} (${providerId}) 插入 quota_jobs 失败:`, err.message);
    throw err;
  }

  try {
    // 2. settleWallet：结转上周期 Wallet → Pool
    console.log(`[QuotaScheduler] 用户 ${userId} (${providerId}) 执行 settleWallet`);
    await creditManager.settleWallet(userId, providerId, `settle:${cycleKey}`);

    // 3. 计算新的 next_cycle_at（基于当前时间，修正 cycle_started_at 时间错误）
    const now = new Date();
    const newNextCycleAt = new Date(now.getTime() + cycleDurationMinutes * 60 * 1000);

    // 4. 更新 user_accounts 中的 cycle_started_at 和 next_cycle_at
    await pool.query(
      'UPDATE user_accounts SET cycle_started_at = ?, next_cycle_at = ? WHERE user_id = ? AND provider_id = ?',
      [now, newNextCycleAt, userId, providerId]
    );

    // 5. injectWallet：注入新周期额度
    console.log(`[QuotaScheduler] 用户 ${userId} (${providerId}) 执行 injectWallet`);
    await creditManager.injectWallet(userId, providerId, `inject:${cycleKey}`);

    // 6. 标记 quota_jobs 为 done
    await pool.query(
      "UPDATE quota_jobs SET status = 'done', executed_at = NOW() WHERE cycle_key = ? AND provider_id = ?",
      [cycleKey, providerId]
    );

    console.log(`[QuotaScheduler] 用户 ${userId} (${providerId}) 周期执行完成，下次触发: ${newNextCycleAt.toISOString()}`);

    // 7. 调度下一次周期
    await scheduleUser(userId, providerId, cycleDurationMinutes, newNextCycleAt);
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(`[QuotaScheduler] 用户 ${userId} (${providerId}) 周期执行失败:`, errMsg);

    // 标记 quota_jobs 为 failed（保留用于审计，不阻止下次调度）
    try {
      await pool.query(
        "UPDATE quota_jobs SET status = 'failed', error_message = ? WHERE cycle_key = ? AND provider_id = ?",
        [errMsg, cycleKey, providerId]
      );
    } catch (updateErr) {
      console.error(`[QuotaScheduler] 用户 ${userId} (${providerId}) 更新 quota_jobs 失败状态失败:`, (updateErr as Error).message);
    }

    // 失败后仍调度下一次，避免周期中断
    const now = new Date();
    const newNextCycleAt = new Date(now.getTime() + cycleDurationMinutes * 60 * 1000);
    await scheduleUser(userId, providerId, cycleDurationMinutes, newNextCycleAt);
  }
}
