# Bug Fixes Tasks

## Task 1: 修复 quotaScheduler cycle_started_at 时间错误
- [x] 修改 `backend/src/services/quotaScheduler.ts` `runCycle()` 第 4 步，将 `cycleStartAt` 替换为 `new Date()`
- [x] 更新 `newNextCycleAt` 基于 `now` 计算
- [x] 验证：`quotaScheduler.test.ts` 中相关测试通过

## Task 2: 修复 creditManager.refund 参数设计
- [x] 修改 `backend/src/services/creditManager.ts`，移除 `refund()` 的 `_amount` 参数
- [x] 更新 `backend/src/services/taskPoller.ts` 中两处 `refund()` 调用
- [x] ledger 无记录时改为 `console.warn` 而非静默跳过
- [x] 验证：`creditManager.refundConfirm.test.ts` 测试通过

## Task 3: 修复 creditManager.confirmDeduct 差值未修正
- [x] 修改 `confirmDeduct()`，查询 `pre_deduct` 记录计算预扣总量
- [x] 实际 < 预扣时，差值退还到 Pool/Wallet（同一事务）
- [x] 实际 > 预扣时，追加扣减；余额不足时 warning 不抛错
- [x] 将 `credit_usage` 插入移入 `confirmDeduct()` 事务内（Fix 6 合并）
- [x] 移除 `taskPoller.ts` 中独立的 `credit_usage` 插入
- [x] 验证：`creditManager.refundConfirm.test.ts` 补充 confirmDeduct 差值测试

## Task 4: 修复 task controller 流程顺序
- [x] 修改 `backend/src/controllers/task.ts`，在调用 Tripo3D API 前先做余额预检
- [x] 余额不足时直接返回 `422 INSUFFICIENT_CREDITS`
- [x] 验证：手动测试余额不足场景不会产生孤立 Tripo3D 任务

## Task 5: 修复 auth middleware userId 验证
- [x] 修改 `backend/src/middleware/auth.ts`，提取 `userId` 后验证为正整数
- [x] 验证失败返回 `401`
- [x] 移除打印完整响应体的 `console.log`

## Task 6: 修复 index.ts 启动失败未退出
- [x] 修改 `backend/src/index.ts`，关键服务启动失败时调用 `process.exit(1)`

## Task 7: 修复 recharge ledger wallet_delta 含义
- [x] 修改 `creditManager.recharge()`，`wallet_delta` 改为记录 `wallet_amount`
- [x] `note` 字段补充 `wallet_injection_per_cycle` 信息
- [x] 验证：`creditManager.recharge.test.ts` 相关断言更新

## Task 8: 修复 quotaScheduler 失败后周期中断
- [x] 修改 `runCycle()` catch 块，失败后仍调度下一次周期
- [x] 验证：`quotaScheduler.test.ts` 补充失败重调度测试
