# 实现任务列表：多服务商积分管理（Multi-Provider Credits）

## 任务

- [x] 1 数据库 Schema 改造
  - [x] 1.1 编写数据迁移 SQL 脚本（`backend/src/db/migrate_multi_provider.sql`）：为 `user_accounts`、`credit_ledger`、`quota_jobs`、`tasks` 四张表添加 `provider_id` 字段，将现有行设为 `tripo3d`，重建 `user_accounts` 的唯一键为 `(user_id, provider_id)`
  - [x] 1.2 更新 `backend/src/db/schema.sql`：同步反映改造后的完整表结构，包含 `provider_id` 字段和新索引

- [x] 2 提供商配置与适配器层
  - [x] 2.1 创建 `backend/src/config/providers.ts`：定义 `KNOWN_PROVIDERS` 常量、`parseEnabledProviders()` 启动验证函数（空值或全非法时调用 `process.exit(1)`）
  - [x] 2.2 创建 `backend/src/adapters/IProviderAdapter.ts`：定义 `IProviderAdapter` 接口及相关类型（`CreateTaskInput`、`CreateTaskOutput`、`TaskStatusOutput`、`ProviderBalance`）
  - [x] 2.3 创建 `backend/src/adapters/Tripo3DAdapter.ts`：将 `task.ts` 和 `admin.ts` 中现有的 Tripo3D API 调用逻辑迁移至此适配器，实现 `IProviderAdapter`
  - [x] 2.4 创建 `backend/src/adapters/Hyper3DAdapter.ts`：实现 `IProviderAdapter`，封装 Hyper3D API 调用协议
  - [x] 2.5 创建 `backend/src/adapters/ProviderRegistry.ts`：实现 `ProviderRegistry` 类，提供 `register`、`get`、`getAll`、`getEnabledIds`、`isEnabled` 方法
  - [x] 2.6 在 `backend/src/index.ts` 中调用 `parseEnabledProviders()`，根据结果向 `providerRegistry` 注册对应适配器，在 `startScheduler()` 之前完成

- [x] 3 CreditManager 服务改造
  - [x] 3.1 更新 `CreditManager` 所有方法签名，增加 `providerId: string` 参数：`recharge`、`preDeduct`、`refund`、`confirmDeduct`、`injectWallet`、`settleWallet`
  - [x] 3.2 更新 `getStatus` 方法：增加可选 `providerId?: string` 参数；无参数时返回该用户所有已配置提供商的状态数组；有参数时只返回指定提供商的状态（不存在则返回零余额对象）
  - [x] 3.3 更新所有 SQL 查询：`user_accounts` 的 WHERE 条件改为 `user_id = ? AND provider_id = ?`；`credit_ledger` 的 INSERT 增加 `provider_id` 字段
  - [x] 3.4 更新 `ProviderCreditStatus` 接口：增加 `provider_id` 字段；更新 `CreditStatus` 类型导出

- [x] 4 QuotaScheduler 服务改造
  - [x] 4.1 更新 `startScheduler()`：查询 `user_accounts` 时同时读取 `provider_id`，调度 Map 的 key 改为 `${providerId}:${userId}`
  - [x] 4.2 更新 `scheduleUser` 和 `runCycle` 函数签名：增加 `providerId` 参数
  - [x] 4.3 更新幂等键格式：`cycleKey` 改为 `${providerId}:${userId}:${cycleStartAt.toISOString()}`
  - [x] 4.4 更新 `quota_jobs` 的 INSERT/UPDATE 语句：增加 `provider_id` 字段
  - [x] 4.5 更新对 `creditManager.settleWallet` 和 `creditManager.injectWallet` 的调用：传入 `providerId` 参数

- [x] 5 API 端点改造
  - [x] 5.1 更新 `backend/src/controllers/task.ts` 的 `createTask`：从 `req.body` 读取 `provider_id`（默认 `tripo3d`），验证是否在已启用列表中，通过 `providerRegistry.get(providerId)` 获取适配器，将 `provider_id` 写入 `tasks` 表，所有 `creditManager` 调用传入 `providerId`
  - [x] 5.2 更新 `backend/src/controllers/credits.ts` 的 `getStatusHandler`：从 `req.query` 读取可选 `provider_id`，传入 `creditManager.getStatus(userId, providerId?)`
  - [x] 5.3 更新 `backend/src/controllers/credits.ts` 的 `rechargeHandler`：从 `req.body` 读取必填 `provider_id`，缺失时返回 `MISSING_PROVIDER` 错误，传入 `creditManager.recharge(userId, providerId, params)`
  - [x] 5.4 更新 `backend/src/controllers/admin.ts`：`GET/PUT /config` 和 `GET /balance` 支持 `provider_id` 参数，通过 `providerRegistry.get(providerId)` 路由到对应适配器
  - [x] 5.5 在 `backend/src/routes/admin.ts` 中新增 `GET /api/admin/providers` 路由：返回 `providerRegistry.getEnabledIds()` 列表

- [x] 6 前端改造
  - [x] 6.1 更新 `frontend/src/api/index.ts`：`createTask` 参数增加可选 `provider_id`；新增 `getEnabledProviders()` API 函数；`getAdminConfig`、`saveAdminConfig`、`getAdminBalance` 支持 `provider_id` 参数
  - [x] 6.2 更新 `frontend/src/views/GeneratorView.vue`：`onMounted` 时调用 `getEnabledProviders()` 获取提供商列表；当已启用提供商数量 > 1 时展示提供商选择器（`el-select`）；`createTask` 调用时传入选中的 `provider_id`
  - [x] 6.3 更新 `frontend/src/views/AdminView.vue`：`onMounted` 时调用 `getEnabledProviders()` 获取提供商列表；API Key 配置区域改为按提供商分组展示（`el-tabs` 或循环渲染）；余额展示区域改为按提供商分组；充值表单增加提供商选择下拉框
  - [x] 6.4 更新 i18n 文件（`en-US.ts`、`zh-TW.ts`、`zh-CN.ts`、`ja-JP.ts`、`th-TH.ts`）：新增提供商选择相关文案 key

- [x] 7 docker-compose.yml 更新
  - [x] 7.1 在 `docker-compose.yml` 的 backend 服务 `environment` 中添加 `ENABLED_PROVIDERS` 示例配置（如 `ENABLED_PROVIDERS=tripo3d,hyper3d`）及注释说明
x
- [x] 8 测试
  - [x] 8.1 创建 `backend/src/__tests__/providers.config.test.ts`：测试 `parseEnabledProviders()` 的解析逻辑（空值、全非法值、合法值、大小写混合、空格处理）；包含属性 11 的 fast-check 测试
  - [x] 8.2 创建 `backend/src/__tests__/creditManager.multiProvider.test.ts`：测试账户隔离性（属性 2）、充值日志包含 provider_id（属性 4）、充值参数校验（属性 5）、状态查询完整性（属性 9）、按 provider_id 过滤（属性 10）
  - [x] 8.3 更新 `backend/src/__tests__/creditManager.preDeduct.test.ts`：所有调用增加 `providerId` 参数；新增属性 7（API 失败退款）的 fast-check 测试
  - [x] 8.4 更新 `backend/src/__tests__/creditManager.recharge.test.ts`：所有调用增加 `providerId` 参数
  - [x] 8.5 更新 `backend/src/__tests__/creditManager.getStatus.test.ts`：测试多提供商状态返回和按 provider_id 过滤
  - [x] 8.6 更新 `backend/src/__tests__/quotaScheduler.test.ts`：验证幂等键格式包含 `provider_id`（属性 8）；验证调度隔离性
  - [x] 8.7 创建 `backend/src/__tests__/providerValidation.test.ts`：测试非法 provider_id 被拒绝（属性 1）、`PROVIDER_DISABLED` 错误码、`MISSING_PROVIDER` 错误码
