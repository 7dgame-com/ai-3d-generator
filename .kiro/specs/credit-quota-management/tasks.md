# 实现计划：付费配额管理系统（Credit Quota Management）

## 概述

基于需求文档和设计文档，将系统拆分为以下实现阶段：数据库迁移 → CreditManager 服务 → QuotaScheduler 服务 → API 路由层 → 与现有 task 流程集成。所有代码使用 TypeScript，运行于 Node.js + Express + MySQL（mysql2）环境。

## 任务列表

- [x] 1. 数据库迁移：新增三张表
  - 在 `backend/src/db/schema.sql` 中追加 `user_accounts`、`credit_ledger`、`quota_jobs` 三张表的 DDL
  - `user_accounts`：存储双账户余额及充值参数（wallet_balance、pool_balance、pool_baseline、wallet_injection_per_cycle、cycles_remaining、cycle_duration、total_duration、cycle_started_at、next_cycle_at）
  - `credit_ledger`：记录所有额度变动事件（event_type ENUM、wallet_delta、pool_delta、task_id、idempotency_key）
  - `quota_jobs`：记录周期调度任务，cycle_key 设 UNIQUE 约束保证幂等
  - 所有余额字段使用 `DECIMAL(12,2)`，避免浮点精度问题
  - _需求：1.4、1.8、2.3、2.5、5.3、5.4、8.2_

- [x] 2. 实现 CreditManager 服务核心类型与工具函数
  - 新建 `backend/src/services/creditManager.ts`
  - 定义 `RechargeParams`、`DeductResult`、`CreditStatus` 等 TypeScript 接口
  - 实现 `computeThrottleDelay(poolCurrent, poolBaseline, maxDelayMs): number`：Pool ≥ Baseline 返回 0，Pool = 0 返回 -1，否则按比例计算延迟
  - 实现 `sleep(ms): Promise<void>` 工具函数
  - _需求：4.1、4.2、4.3_

- [x] 3. 实现 CreditManager.recharge（充值分配）
  - 在 `creditManager.ts` 中实现 `recharge(userId, params)` 方法
  - 参数校验：wallet_amount > 0，pool_amount ≥ 0，cycle_duration 在 [60, 43200]，total_duration ≥ cycle_duration
  - 计算 `wallet_injection_per_cycle = wallet_amount × cycle_duration / total_duration`
  - 计算 `cycles_remaining = Math.floor(total_duration / cycle_duration)`
  - 使用事务 + `FOR UPDATE` 行级锁执行 UPSERT `user_accounts`，同时写入 `credit_ledger`（event_type='recharge'）
  - 操作原子性：Pool 写入、wallet_injection_per_cycle、cycles_remaining 存储要么全部成功，要么全部回滚
  - _需求：1.1、1.2、1.3、1.4、1.5、1.6、1.7、1.8、6.1、6.2、6.3、6.4、6.5、6.6_

  - [ ]* 3.1 为 recharge 编写单元测试
    - 测试正常充值参数写入正确字段
    - 测试 wallet_amount ≤ 0 返回 INVALID_AMOUNT
    - 测试 pool_amount < 0 返回 INVALID_AMOUNT
    - 测试 cycle_duration 超出范围返回 INVALID_PARAMS
    - _需求：1.5、1.6、1.7、6.5_

- [x] 4. 实现 CreditManager.preDeduct（预扣额度）
  - 在 `creditManager.ts` 中实现 `preDeduct(userId, amount, taskId)` 方法
  - 使用事务 + `SELECT ... FOR UPDATE` 锁定 `user_accounts` 行
  - 扣减顺序：先扣 Wallet，不足部分扣 Pool；若 Wallet + Pool 合计不足返回 `INSUFFICIENT_CREDITS`
  - UPDATE 语句 WHERE 条件包含余额非负检查，`affectedRows = 0` 时返回 `CONCURRENT_CONFLICT`
  - 写入 `credit_ledger`（event_type='pre_deduct'，task_id 关联）
  - _需求：3.1、3.2、3.3、3.4、8.1、8.3_

  - [ ]* 4.1 为 preDeduct 编写单元测试
    - 测试 Wallet 充足时仅扣 Wallet
    - 测试 Wallet 不足时联合扣 Pool
    - 测试 Wallet + Pool 均不足返回 INSUFFICIENT_CREDITS
    - _需求：3.1、3.2、3.3_

- [x] 5. 实现 CreditManager.refund 与 confirmDeduct
  - 在 `creditManager.ts` 中实现 `refund(userId, amount, taskId)` 方法：退还预扣额度，优先补回 Pool，再补 Wallet（与扣减顺序对称），写入 credit_ledger（event_type='refund'）
  - 实现 `confirmDeduct(userId, taskId, actualAmount)` 方法：任务成功时以实际消耗量确认，写入 credit_ledger（event_type='confirm_deduct'）
  - _需求：3.4、8.1_

- [x] 6. 实现 CreditManager.injectWallet 与 settleWallet（周期操作）
  - 在 `creditManager.ts` 中实现 `injectWallet(userId, cycleKey)` 方法
    - 检查 cycles_remaining > 0，否则跳过
    - 使用事务 + `FOR UPDATE` 向 Wallet 注入 wallet_injection_per_cycle，cycles_remaining 递减 1
    - 写入 credit_ledger（event_type='inject'，idempotency_key=cycleKey）
    - 通过 idempotency_key UNIQUE 约束防止重复注入
  - 实现 `settleWallet(userId, cycleKey)` 方法
    - 使用事务 + `FOR UPDATE` 将 wallet_balance 全部加入 pool_balance，wallet_balance 清零
    - 写入 credit_ledger（event_type='settle'，idempotency_key=cycleKey）
  - _需求：2.1、2.2、2.3、2.5、5.1、5.2、5.3、5.4、8.2_

  - [ ]* 6.1 为 injectWallet 编写单元测试
    - 测试 cycles_remaining > 0 时正确注入并递减
    - 测试 cycles_remaining = 0 时不注入
    - 测试幂等键重复时不重复执行
    - _需求：2.1、2.2、8.2_

- [x] 7. 实现 CreditManager.getStatus（额度状态查询）
  - 在 `creditManager.ts` 中实现 `getStatus(userId)` 方法
  - 返回：wallet_balance、pool_balance、pool_baseline、cycles_remaining、cycle_started_at、next_cycle_at
  - 查询不使用行级锁（只读），保证 200ms 内响应
  - _需求：7.1、7.2_

- [x] 8. 检查点 — 确保 CreditManager 所有测试通过
  - 确保所有测试通过，如有问题请向用户反馈。

- [x] 9. 实现 QuotaScheduler 服务
  - 新建 `backend/src/services/quotaScheduler.ts`，导出 `startScheduler()` 和 `stopScheduler()` 函数
  - 启动时查询所有 `user_accounts` 中 `next_cycle_at` 不为 null 的用户，计算距下次触发的剩余时间，使用 `setTimeout` 精确调度
  - 到期时依次执行：`settleWallet`（结转上周期）→ 更新 `next_cycle_at` → `injectWallet`（注入新周期）→ 调度下一次触发
  - 在 `quota_jobs` 表插入 pending 记录（利用 UNIQUE cycle_key 防重），执行后更新 status 为 done 或 failed
  - 调度误差不超过 30 秒（需求 2.4）
  - _需求：2.1、2.2、2.3、2.4、2.5、5.1、5.2、5.3、5.4、8.2_

  - [ ]* 9.1 为 QuotaScheduler 编写单元测试
    - 测试启动时正确恢复待处理周期任务
    - 测试 settleWallet → injectWallet 执行顺序
    - 测试 cycle_key 重复时不重复执行
    - _需求：2.4、8.2_

- [x] 10. 实现 credits 路由与控制器
  - 新建 `backend/src/controllers/credits.ts`
    - `GET /api/credits/status`：调用 `creditManager.getStatus(userId)`，仅返回当前认证用户自身数据（需求 7.3）
    - `GET /api/admin/credits/:userId`：管理员查询指定用户额度状态
  - 新建 `backend/src/routes/credits.ts`，注册路由：
    - `GET /api/credits/status`：`auth` 中间件
    - `GET /api/admin/credits/:userId`：`auth` + `requirePermission('admin-config')` 中间件
  - 在 `backend/src/index.ts` 中注册 credits 路由
  - _需求：7.1、7.2、7.3_

- [x] 11. 实现充值 API（admin recharge）
  - 在 `backend/src/controllers/credits.ts` 中新增 `rechargeHandler`
    - 接收 `{ userId, wallet_amount, pool_amount, total_duration, cycle_duration }` 请求体
    - 调用 `creditManager.recharge()`，将错误码映射为对应 HTTP 状态（INVALID_AMOUNT → 422，INVALID_PARAMS → 422）
  - 在 `backend/src/routes/credits.ts` 中注册 `POST /api/admin/recharge`：`auth` + `requirePermission('admin-config')`
  - _需求：1.1、1.2、1.3、1.4、1.5、1.6、1.7、1.8、6.1、6.2、6.3、6.4、6.5_

- [x] 12. 将 CreditManager 集成到 createTask 流程
  - 修改 `backend/src/controllers/task.ts` 中的 `createTask` 函数
  - 在调用 Tripo3D API 之前插入以下步骤：
    1. 查询用户 pool_balance、pool_baseline（加 `FOR UPDATE` 行级锁）
    2. 调用 `computeThrottleDelay`：返回 -1 → 响应 429 + POOL_EXHAUSTED 错误体（含 poolCurrent、poolBaseline、nextCycleAt、suggestedWaitSeconds）；返回 > 0 → `await sleep(delayMs)`
    3. 调用 `creditManager.preDeduct(userId, estimatedCost, taskId)`
  - 任务创建成功后继续原有流程（写 tasks 表、addTaskToPoller）
  - _需求：3.1、3.2、3.3、3.4、4.1、4.2、4.3、4.4_

- [x] 13. 将 CreditManager 集成到 taskPoller（失败退款）
  - 修改 `backend/src/services/taskPoller.ts` 中的 `markTaskFailed` 函数
  - 任务状态变为 `failed` 或 `timeout` 时，查询该任务的预扣记录，调用 `creditManager.refund(userId, preDeductedAmount, taskId)`
  - 任务状态变为 `success` 时，调用 `creditManager.confirmDeduct(userId, taskId, actualCreditCost)` 替代原有 `credit_usage` 直接写入
  - _需求：3.4_

- [x] 14. 在应用启动时注册 QuotaScheduler
  - 修改 `backend/src/index.ts`，在 `startPoller()` 之后调用 `startScheduler()`
  - 确保 `stopScheduler()` 在进程退出时被调用（监听 SIGTERM/SIGINT）
  - _需求：2.4_

- [x] 15. 检查点 — 确保所有测试通过，集成验证
  - 确保所有测试通过，如有问题请向用户反馈。

## 备注

- 标有 `*` 的子任务为可选测试任务，可在 MVP 阶段跳过
- 每个任务均引用具体需求条款，保证可追溯性
- 所有余额操作必须在数据库事务内执行，使用 `pool.getConnection()` 获取连接后手动管理事务
- `query()` 函数不支持事务，事务操作需直接使用 `pool.getConnection()` + `conn.beginTransaction()`
