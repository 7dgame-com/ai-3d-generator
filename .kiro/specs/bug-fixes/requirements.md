# Bug Fixes Requirements

## 背景

基于代码审查，发现 credit-quota-management 系统中存在若干逻辑缺陷、API 设计问题和安全隐患，需要逐一修复。

## 需求列表

### 1. quotaScheduler — cycle_started_at 时间错误（高优先级）

**问题**：`runCycle()` 更新 `cycle_started_at` 时写入的是上一个周期的开始时间 `cycleStartAt`，而非当前执行时间，导致时间漂移。

**要求**：
- 1.1 `cycle_started_at` 应更新为当前执行时间（`new Date()`）
- 1.2 `next_cycle_at` 仍基于 `cycleDurationMinutes` 从当前时间计算

---

### 2. creditManager.refund — 参数设计问题（高优先级）

**问题**：`refund(userId, _amount, taskId)` 中 `_amount` 参数完全未使用，调用方传入 `0`，具有误导性；且 ledger 无记录时静默跳过退款，无任何告警。

**要求**：
- 2.1 移除 `_amount` 参数，签名改为 `refund(userId: number, taskId: string)`
- 2.2 更新所有调用方（`taskPoller.ts`）
- 2.3 ledger 无 `pre_deduct` 记录时，打印 warning 日志而非静默跳过

---

### 3. creditManager.confirmDeduct — 差值未修正（高优先级）

**问题**：`confirmDeduct()` 只写 ledger，不处理预扣金额与实际消耗的差值，导致多扣或少扣永远不被修正。

**要求**：
- 3.1 查询该 `taskId` 对应的 `pre_deduct` 记录，计算预扣总量
- 3.2 若 `actualAmount < preDeducted`，将差值退还到 Pool（优先）或 Wallet
- 3.3 若 `actualAmount > preDeducted`，从 Pool（优先）或 Wallet 追加扣减；若余额不足则记录 warning，不抛出错误（避免影响任务完成流程）
- 3.4 所有余额调整和 ledger 写入在同一事务内完成

---

### 4. task controller — 流程顺序错误（高优先级）

**问题**：当前流程是先调用 Tripo3D API 创建任务，再预扣额度。预扣失败时 Tripo3D 任务已创建，产生孤立任务。

**要求**：
- 4.1 调整流程为：先检查并预扣额度，再调用 Tripo3D API
- 4.2 预扣时使用临时占位 `taskId`（如 `temp:${userId}:${Date.now()}`），Tripo3D 返回真实 `task_id` 后更新 ledger 记录
- 4.3 或者：先查询余额是否充足（不预扣），再创建任务，再预扣（保持现有 ledger 结构）
- 4.4 若 Tripo3D 调用失败，不应有任何预扣记录残留

---

### 5. auth middleware — userId 未验证（中优先级）

**问题**：从主后端响应提取 `userId` 后，未验证是否为有效正整数，可能导致后续数据库操作异常。

**要求**：
- 5.1 提取 `userId` 后验证是否为正整数（`Number.isInteger(userId) && userId > 0`）
- 5.2 验证失败时返回 `401 { code: 1001, message: 'Token 无效或已过期' }`
- 5.3 移除生产环境中打印完整响应体的 `console.log`（信息泄露风险），改为只打印 `userId`

---

### 6. taskPoller.handleSuccess — 非事务操作（中优先级）

**问题**：`credit_usage` 插入和 `confirmDeduct` 是两个独立操作，`confirmDeduct` 失败时 `credit_usage` 已写入，数据不一致。

**要求**：
- 6.1 将 `credit_usage` 插入移入 `confirmDeduct()` 内部，与 ledger 写入在同一事务中完成
- 6.2 或者：在 `handleSuccess` 中捕获 `confirmDeduct` 失败时，同时回滚 `credit_usage` 插入

---

### 7. index.ts — 关键服务启动失败未退出（中优先级）

**问题**：`startPoller()` 或 `startScheduler()` 失败时只打日志，进程继续以不完整状态运行。

**要求**：
- 7.1 若 `testConnection()`、`startPoller()` 或 `startScheduler()` 抛出异常，调用 `process.exit(1)` 退出

---

### 8. creditManager.recharge — ledger 记录含义不准确（低优先级）

**问题**：充值时 ledger 的 `wallet_delta` 记录的是 `wallet_injection_per_cycle`（每周期注入量），而非实际充值的 `wallet_amount`，含义不准确。

**要求**：
- 8.1 `wallet_delta` 改为记录 `wallet_amount`（总充值额度）
- 8.2 `note` 字段补充 `wallet_injection_per_cycle` 信息

---

### 9. quotaScheduler — 周期失败后无重试（低优先级）

**问题**：`runCycle()` 失败后 `quota_jobs` 标记为 `failed`，该用户的周期调度中断，不会再次触发。

**要求**：
- 9.1 `runCycle()` 失败后，仍调度下一次周期（基于 `newNextCycleAt`）
- 9.2 `quota_jobs` 保持 `failed` 状态用于审计，但不阻止下次调度
