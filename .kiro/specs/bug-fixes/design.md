# Bug Fixes Design

## 修复方案

### Fix 1: quotaScheduler — cycle_started_at 时间修正

**文件**: `backend/src/services/quotaScheduler.ts`

`runCycle()` 中第 4 步，将 `cycleStartAt` 替换为 `new Date()`：

```typescript
const now = new Date();
const newNextCycleAt = new Date(now.getTime() + cycleDurationMinutes * 60 * 1000);

await pool.query(
  'UPDATE user_accounts SET cycle_started_at = ?, next_cycle_at = ? WHERE user_id = ?',
  [now, newNextCycleAt, userId]
);
```

`newNextCycleAt` 传给 `scheduleUser()` 保持不变。

---

### Fix 2: creditManager.refund — 移除无用参数

**文件**: `backend/src/services/creditManager.ts`, `backend/src/services/taskPoller.ts`

1. 修改签名：`async refund(userId: number, taskId: string): Promise<void>`
2. 更新 `taskPoller.ts` 中两处调用：`creditManager.refund(taskRows[0].user_id, taskId)`
3. ledger 无记录时改为：
   ```typescript
   console.warn(`[CreditManager] refund: 未找到 pre_deduct 记录 (userId=${userId}, taskId=${taskId})，跳过退款`);
   await conn.rollback();
   return;
   ```

---

### Fix 3: creditManager.confirmDeduct — 差值修正

**文件**: `backend/src/services/creditManager.ts`

在同一事务内：
1. 查询 `pre_deduct` 记录，计算 `preDeductedWallet + preDeductedPool` 总量
2. 计算 `diff = actualAmount - preDeducted`
3. `diff < 0`（实际 < 预扣）：将 `|diff|` 退还，优先补 Pool，再补 Wallet
4. `diff > 0`（实际 > 预扣）：追加扣减 `diff`，优先扣 Pool，再扣 Wallet；余额不足时记录 warning，不抛错
5. 写入 `confirm_deduct` ledger 记录

---

### Fix 4: task controller — 流程顺序调整

**文件**: `backend/src/controllers/task.ts`

采用方案 4.3（最小改动）：
1. 调用 Tripo3D API 前，先调用 `creditManager.getStatus()` 检查余额是否 >= `ESTIMATED_CREDIT_COST`
2. 余额不足直接返回 `422 INSUFFICIENT_CREDITS`，不调用 Tripo3D
3. 保持现有预扣流程（Tripo3D 成功后再 `preDeduct`）

> 注：完整的"先预扣再创建"需要临时 taskId 机制，改动较大，当前阶段用余额预检代替，降低孤立任务概率。

---

### Fix 5: auth middleware — userId 验证

**文件**: `backend/src/middleware/auth.ts`

```typescript
const rawUserId = data?.data?.user_id ?? data?.data?.id ?? data?.user_id ?? data?.id;
const userId = Number(rawUserId);
if (!Number.isInteger(userId) || userId <= 0) {
  res.status(401).json({ code: 1001, message: 'Token 无效或已过期' });
  return;
}
// 移除打印完整响应体的 console.log，只保留 userId
console.log('[AuthMiddleware] resolved userId:', userId);
```

---

### Fix 6: taskPoller.handleSuccess — 事务一致性

**文件**: `backend/src/services/creditManager.ts`

将 `credit_usage` 插入移入 `confirmDeduct()` 内部，与 ledger 写入在同一事务：

```typescript
async confirmDeduct(userId: number, taskId: string, actualAmount: number): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // ... 差值修正逻辑 ...
    // 写入 credit_usage
    await conn.query(
      'INSERT INTO credit_usage (user_id, task_id, credits_used) VALUES (?, ?, ?)',
      [userId, taskId, actualAmount]
    );
    // 写入 confirm_deduct ledger
    await conn.query(...);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

`taskPoller.ts` 中移除独立的 `credit_usage` 插入语句。

---

### Fix 7: index.ts — 启动失败退出

**文件**: `backend/src/index.ts`

```typescript
try {
  await testConnection();
  await startPoller();
  await startScheduler();
} catch (err) {
  console.error('[Server] 关键服务启动失败，退出:', (err as Error).message);
  process.exit(1);
}
```

---

### Fix 8: recharge ledger — wallet_delta 含义修正

**文件**: `backend/src/services/creditManager.ts`

```typescript
const note = `wallet_amount=${wallet_amount}, wallet_injection_per_cycle=${wallet_injection_per_cycle}, cycles_remaining=${cycles_remaining}`;
await conn.query(
  `INSERT INTO credit_ledger (user_id, event_type, wallet_delta, pool_delta, note)
   VALUES (?, 'recharge', ?, ?, ?)`,
  [userId, wallet_amount, pool_amount, note]
);
```

---

### Fix 9: quotaScheduler — 失败后继续调度

**文件**: `backend/src/services/quotaScheduler.ts`

在 `runCycle()` 的 catch 块中，计算 `newNextCycleAt` 并调用 `scheduleUser()`：

```typescript
} catch (err) {
  const errMsg = (err as Error).message;
  console.error(`[QuotaScheduler] 用户 ${userId} 周期执行失败:`, errMsg);

  try {
    await pool.query(
      "UPDATE quota_jobs SET status = 'failed', error_message = ? WHERE cycle_key = ?",
      [errMsg, cycleKey]
    );
  } catch (updateErr) { /* ... */ }

  // 失败后仍调度下一次，避免周期中断
  const now = new Date();
  const newNextCycleAt = new Date(now.getTime() + cycleDurationMinutes * 60 * 1000);
  await scheduleUser(userId, cycleDurationMinutes, newNextCycleAt);
}
```
