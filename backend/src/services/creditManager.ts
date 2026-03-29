import { pool } from '../db/connection';

// ─── TypeScript 接口定义 ───────────────────────────────────────────────────────

export interface RechargeParams {
  wallet_amount: number;
  pool_amount: number;
  total_duration: number;  // minutes
  cycle_duration: number;  // minutes
}

export interface DeductResult {
  success: boolean;
  errorCode?: 'INSUFFICIENT_CREDITS' | 'CONCURRENT_CONFLICT';
  walletDeducted?: number;
  poolDeducted?: number;
}

export interface CreditStatus {
  wallet_balance: number;
  pool_balance: number;
  pool_baseline: number;
  cycles_remaining: number;
  cycle_started_at: Date | null;
  next_cycle_at: Date | null;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 计算节流延迟（毫秒）
 * - Pool >= Baseline：返回 0（无延迟）
 * - Pool = 0：返回 -1（拒绝，POOL_EXHAUSTED）
 * - 0 < Pool < Baseline：按比例计算延迟
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */
export function computeThrottleDelay(
  poolCurrent: number,
  poolBaseline: number,
  maxDelayMs: number
): number {
  if (poolBaseline <= 0) return 0;           // 未设置基准线，不节流
  if (poolCurrent <= 0) return -1;           // -1 表示拒绝（POOL_EXHAUSTED）
  if (poolCurrent >= poolBaseline) return 0; // 正常，无延迟

  const ratio = (poolBaseline - poolCurrent) / poolBaseline;
  return Math.round(maxDelayMs * ratio);
}

/**
 * 异步等待指定毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CreditManager 类（方法将在后续任务中实现）────────────────────────────────

export class CreditManager {
  /**
   * 充值：计算并存储 wallet_injection_per_cycle、cycles_remaining，写入 Pool，设定 Pool_Baseline
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
   */
  async recharge(userId: number, params: RechargeParams): Promise<void> {
    const { wallet_amount, pool_amount, total_duration, cycle_duration } = params;

    // 参数校验
    if (wallet_amount <= 0 || pool_amount < 0) {
      throw { code: 'INVALID_AMOUNT', message: 'wallet_amount 必须大于 0，pool_amount 必须大于或等于 0' };
    }
    if (cycle_duration < 60 || cycle_duration > 43200) {
      throw { code: 'INVALID_PARAMS', message: 'cycle_duration 必须在 [60, 43200] 范围内' };
    }
    if (total_duration < cycle_duration) {
      throw { code: 'INVALID_PARAMS', message: 'total_duration 必须大于或等于 cycle_duration' };
    }

    // 计算充值参数
    const wallet_injection_per_cycle = wallet_amount * cycle_duration / total_duration;
    const cycles_remaining = Math.floor(total_duration / cycle_duration);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 锁定行（如存在）
      await conn.query(
        'SELECT id FROM user_accounts WHERE user_id = ? FOR UPDATE',
        [userId]
      );

      // UPSERT user_accounts
      await conn.query(
        `INSERT INTO user_accounts
          (user_id, wallet_balance, pool_balance, pool_baseline,
           wallet_injection_per_cycle, cycles_remaining,
           cycle_duration, total_duration,
           cycle_started_at, next_cycle_at)
         VALUES (?, 0.00, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? MINUTE))
         ON DUPLICATE KEY UPDATE
           pool_balance               = VALUES(pool_balance),
           pool_baseline              = VALUES(pool_baseline),
           wallet_injection_per_cycle = VALUES(wallet_injection_per_cycle),
           cycles_remaining           = VALUES(cycles_remaining),
           cycle_duration             = VALUES(cycle_duration),
           total_duration             = VALUES(total_duration),
           cycle_started_at           = NOW(),
           next_cycle_at              = DATE_ADD(NOW(), INTERVAL ? MINUTE)`,
        [
          userId,
          pool_amount, pool_amount,
          wallet_injection_per_cycle,
          cycles_remaining,
          cycle_duration, total_duration,
          cycle_duration,
          cycle_duration,
        ]
      );

      // 写入 credit_ledger
      const note = `wallet_amount=${wallet_amount}, wallet_injection_per_cycle=${wallet_injection_per_cycle}, cycles_remaining=${cycles_remaining}`;
      await conn.query(
        `INSERT INTO credit_ledger
          (user_id, event_type, wallet_delta, pool_delta, note)
         VALUES (?, 'recharge', ?, ?, ?)`,
        [userId, wallet_amount, pool_amount, note]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 预扣额度（构建请求发起时）：先扣 Wallet，不足扣 Pool
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 8.1, 8.3
   */
  async preDeduct(userId: number, amount: number, taskId: string): Promise<DeductResult> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 锁定行，读取余额
      const [rows] = await conn.query<any[]>(
        'SELECT wallet_balance, pool_balance FROM user_accounts WHERE user_id = ? FOR UPDATE',
        [userId]
      );

      if (!rows || rows.length === 0) {
        await conn.rollback();
        return { success: false, errorCode: 'INSUFFICIENT_CREDITS' };
      }

      const { wallet_balance, pool_balance } = rows[0];
      const walletBal = Number(wallet_balance);
      const poolBal = Number(pool_balance);

      // 2. 计算扣减分配
      const walletDeducted = Math.min(walletBal, amount);
      const poolDeducted = amount - walletDeducted;

      // 3. 余额不足
      if (poolDeducted > poolBal) {
        await conn.rollback();
        return { success: false, errorCode: 'INSUFFICIENT_CREDITS' };
      }

      // 4. 执行扣减（WHERE 条件包含余额非负检查）
      const [updateResult] = await conn.query<any>(
        `UPDATE user_accounts
         SET wallet_balance = wallet_balance - ?,
             pool_balance   = pool_balance   - ?
         WHERE user_id = ?
           AND wallet_balance >= ?
           AND pool_balance   >= ?`,
        [walletDeducted, poolDeducted, userId, walletDeducted, poolDeducted]
      );

      if (updateResult.affectedRows === 0) {
        await conn.rollback();
        return { success: false, errorCode: 'CONCURRENT_CONFLICT' };
      }

      // 5. 写入 credit_ledger（delta 为负值）
      await conn.query(
        `INSERT INTO credit_ledger
          (user_id, event_type, wallet_delta, pool_delta, task_id)
         VALUES (?, 'pre_deduct', ?, ?, ?)`,
        [userId, -walletDeducted, -poolDeducted, taskId]
      );

      await conn.commit();
      return { success: true, walletDeducted, poolDeducted };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 退还预扣额度（任务失败时）：优先补回 Pool，再补 Wallet（与扣减顺序对称）
   * Validates: Requirements 3.4, 8.1
   */
  async refund(userId: number, taskId: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 查询该 taskId 的 pre_deduct 记录，获取 wallet_delta 和 pool_delta（负值）
      const [ledgerRows] = await conn.query<any[]>(
        `SELECT wallet_delta, pool_delta FROM credit_ledger
         WHERE user_id = ? AND task_id = ? AND event_type = 'pre_deduct'
         LIMIT 1`,
        [userId, taskId]
      );

      if (!ledgerRows || ledgerRows.length === 0) {
        console.warn(`[CreditManager] refund: 未找到 pre_deduct 记录 (userId=${userId}, taskId=${taskId})，跳过退款`);
        await conn.rollback();
        return;
      }

      const { wallet_delta, pool_delta } = ledgerRows[0];
      // delta 为负值，取绝对值得到退还量
      const walletRefund = Math.abs(Number(wallet_delta));
      const poolRefund = Math.abs(Number(pool_delta));

      // 2. 退还余额（优先补回 Pool，再补 Wallet）
      await conn.query(
        `UPDATE user_accounts
         SET wallet_balance = wallet_balance + ?,
             pool_balance   = pool_balance   + ?
         WHERE user_id = ?`,
        [walletRefund, poolRefund, userId]
      );

      // 3. 写入 credit_ledger（event_type='refund'，delta 为正值）
      await conn.query(
        `INSERT INTO credit_ledger
          (user_id, event_type, wallet_delta, pool_delta, task_id)
         VALUES (?, 'refund', ?, ?, ?)`,
        [userId, walletRefund, poolRefund, taskId]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 确认消耗（任务成功，实际 credit_cost 可能与预扣不同）
   * 查询 pre_deduct 记录计算预扣总量，修正差值，并将 credit_usage 插入同一事务
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 6.1
   */
  async confirmDeduct(userId: number, taskId: string, actualAmount: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 查询 pre_deduct 记录，计算预扣总量
      const [preRows] = await conn.query<any[]>(
        `SELECT wallet_delta, pool_delta FROM credit_ledger
         WHERE user_id = ? AND task_id = ? AND event_type = 'pre_deduct'`,
        [userId, taskId]
      );

      // wallet_delta and pool_delta are stored as negative numbers for pre_deduct
      const preDeductedWallet = (preRows as any[]).reduce(
        (sum: number, r: any) => sum + Math.abs(Number(r.wallet_delta || 0)), 0
      );
      const preDeductedPool = (preRows as any[]).reduce(
        (sum: number, r: any) => sum + Math.abs(Number(r.pool_delta || 0)), 0
      );
      const preDeducted = preDeductedWallet + preDeductedPool;

      // 2. 计算差值
      const diff = actualAmount - preDeducted;

      if (diff < 0) {
        // 实际 < 预扣，退还差值，优先补 Pool，再补 Wallet
        const refundAmount = Math.abs(diff);

        // 读取当前余额以决定退还分配（锁定行）
        await conn.query(
          'SELECT id FROM user_accounts WHERE user_id = ? FOR UPDATE',
          [userId]
        );

        // 优先退还到 Pool（最多退还 preDeductedPool），剩余退还到 Wallet
        const poolRefund = Math.min(refundAmount, preDeductedPool);
        const walletRefund = refundAmount - poolRefund;

        await conn.query(
          `UPDATE user_accounts
           SET pool_balance   = pool_balance   + ?,
               wallet_balance = wallet_balance + ?
           WHERE user_id = ?`,
          [poolRefund, walletRefund, userId]
        );

        await conn.query(
          `INSERT INTO credit_ledger
            (user_id, event_type, wallet_delta, pool_delta, task_id, note)
           VALUES (?, 'confirm_deduct', ?, ?, ?, ?)`,
          [userId, walletRefund, poolRefund, taskId, `actual=${actualAmount},pre=${preDeducted},refund=${refundAmount}`]
        );
      } else if (diff > 0) {
        // 实际 > 预扣，追加扣减，优先扣 Pool，再扣 Wallet；余额不足时记录 warning，不抛错
        const [balRows] = await conn.query<any[]>(
          'SELECT wallet_balance, pool_balance FROM user_accounts WHERE user_id = ? FOR UPDATE',
          [userId]
        );

        if (balRows && balRows.length > 0) {
          const walletBal = Number(balRows[0].wallet_balance);
          const poolBal = Number(balRows[0].pool_balance);

          const poolExtra = Math.min(diff, poolBal);
          const walletExtra = Math.min(diff - poolExtra, walletBal);
          const totalExtra = poolExtra + walletExtra;

          if (totalExtra < diff) {
            console.warn(
              `[CreditManager] confirmDeduct: 余额不足以追加扣减 (userId=${userId}, taskId=${taskId}, diff=${diff}, available=${totalExtra})`
            );
          }

          if (totalExtra > 0) {
            await conn.query(
              `UPDATE user_accounts
               SET pool_balance   = pool_balance   - ?,
                   wallet_balance = wallet_balance - ?
               WHERE user_id = ?`,
              [poolExtra, walletExtra, userId]
            );
          }

          await conn.query(
            `INSERT INTO credit_ledger
              (user_id, event_type, wallet_delta, pool_delta, task_id, note)
             VALUES (?, 'confirm_deduct', ?, ?, ?, ?)`,
            [userId, -walletExtra, -poolExtra, taskId,
             `actual=${actualAmount},pre=${preDeducted},extra=${diff}`]
          );
        } else {
          // No account row — just log warning
          console.warn(
            `[CreditManager] confirmDeduct: 未找到用户账户 (userId=${userId}, taskId=${taskId})`
          );
          await conn.query(
            `INSERT INTO credit_ledger
              (user_id, event_type, wallet_delta, pool_delta, task_id, note)
             VALUES (?, 'confirm_deduct', ?, 0, ?, ?)`,
            [userId, -actualAmount, taskId, `actual=${actualAmount},pre=${preDeducted}`]
          );
        }
      } else {
        // diff === 0，无需调整余额，按预扣比例记录 ledger
        await conn.query(
          `INSERT INTO credit_ledger
            (user_id, event_type, wallet_delta, pool_delta, task_id, note)
           VALUES (?, 'confirm_deduct', ?, ?, ?, ?)`,
          [userId, -preDeductedWallet, -preDeductedPool, taskId, `actual=${actualAmount}`]
        );
      }

      // 3. 写入 credit_usage（Fix 6 合并：与 ledger 在同一事务）
      await conn.query(
        'INSERT INTO credit_usage (user_id, task_id, credits_used) VALUES (?, ?, ?)',
        [userId, taskId, actualAmount]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 周期注入：直接向 Wallet 注入 wallet_injection_per_cycle，cycles_remaining 递减
   * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.2
   */
  async injectWallet(userId: number, cycleKey: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 先检查幂等键是否已存在，防止重复注入
      const [existingRows] = await conn.query<any[]>(
        "SELECT id FROM credit_ledger WHERE idempotency_key = ? AND event_type = 'inject' LIMIT 1",
        [cycleKey]
      );
      if (existingRows && existingRows.length > 0) {
        // 已注入过，幂等跳过
        await conn.commit();
        return;
      }

      // 2. 锁定行，读取注入参数
      const [rows] = await conn.query<any[]>(
        'SELECT wallet_injection_per_cycle, cycles_remaining FROM user_accounts WHERE user_id = ? FOR UPDATE',
        [userId]
      );

      // 3. 无记录或 cycles_remaining = 0，跳过
      if (!rows || rows.length === 0 || Number(rows[0].cycles_remaining) === 0) {
        await conn.rollback();
        return;
      }

      const injectionAmount = Number(rows[0].wallet_injection_per_cycle);

      // 4. 更新余额和剩余周期数
      await conn.query(
        `UPDATE user_accounts
         SET wallet_balance = wallet_balance + ?,
             cycles_remaining = cycles_remaining - 1
         WHERE user_id = ?`,
        [injectionAmount, userId]
      );

      // 5. 写入 credit_ledger（幂等键防重复，此时不会再有 ER_DUP_ENTRY）
      await conn.query(
        `INSERT INTO credit_ledger
          (user_id, event_type, wallet_delta, pool_delta, idempotency_key)
         VALUES (?, 'inject', ?, 0, ?)`,
        [userId, injectionAmount, cycleKey]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 周期结转：Wallet → Pool，Wallet 清零
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 8.2
   */
  async settleWallet(userId: number, cycleKey: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 先检查幂等键是否已存在，防止重复结转
      const [existingRows] = await conn.query<any[]>(
        "SELECT id FROM credit_ledger WHERE idempotency_key = ? AND event_type = 'settle' LIMIT 1",
        [cycleKey]
      );
      if (existingRows && existingRows.length > 0) {
        // 已结转过，幂等跳过
        await conn.commit();
        return;
      }

      // 2. 锁定行，读取 wallet_balance
      const [rows] = await conn.query<any[]>(
        'SELECT wallet_balance FROM user_accounts WHERE user_id = ? FOR UPDATE',
        [userId]
      );

      if (!rows || rows.length === 0) {
        await conn.rollback();
        return;
      }

      const walletBalance = Number(rows[0].wallet_balance);

      // 3. 将 wallet_balance 全部转入 pool_balance，wallet 清零
      await conn.query(
        `UPDATE user_accounts
         SET pool_balance = pool_balance + wallet_balance,
             wallet_balance = 0
         WHERE user_id = ?`,
        [userId]
      );

      // 4. 写入 credit_ledger
      await conn.query(
        `INSERT INTO credit_ledger
          (user_id, event_type, wallet_delta, pool_delta, idempotency_key)
         VALUES (?, 'settle', ?, ?, ?)`,
        [userId, -walletBalance, walletBalance, cycleKey]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 查询用户额度状态（只读，不使用行级锁）
   * Validates: Requirements 7.1, 7.2
   */
  async getStatus(userId: number): Promise<CreditStatus> {
    const [rows] = await pool.query<any[]>(
      `SELECT wallet_balance, pool_balance, pool_baseline,
              cycles_remaining, cycle_started_at, next_cycle_at
       FROM user_accounts
       WHERE user_id = ?`,
      [userId]
    );

    if (!rows || rows.length === 0) {
      return {
        wallet_balance: 0,
        pool_balance: 0,
        pool_baseline: 0,
        cycles_remaining: 0,
        cycle_started_at: null,
        next_cycle_at: null,
      };
    }

    const row = rows[0];
    return {
      wallet_balance: Number(row.wallet_balance),
      pool_balance: Number(row.pool_balance),
      pool_baseline: Number(row.pool_baseline),
      cycles_remaining: Number(row.cycles_remaining),
      cycle_started_at: row.cycle_started_at ?? null,
      next_cycle_at: row.next_cycle_at ?? null,
    };
  }

  /**
   * 计算节流延迟（毫秒）
   * Validates: Requirements 4.1, 4.2, 4.3
   */
  computeThrottleDelay(poolCurrent: number, poolBaseline: number, maxDelayMs: number): number {
    return computeThrottleDelay(poolCurrent, poolBaseline, maxDelayMs);
  }
}

export const creditManager = new CreditManager();
