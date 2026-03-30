# 技术设计文档：多服务商积分管理（Multi-Provider Credits）

## 概述

本功能在现有单提供商（Tripo3D）积分体系基础上，扩展为支持多个 3D 生成服务提供商（初期新增 Hyper3D）。核心改造思路是：

1. **数据层**：`user_accounts`、`credit_ledger`、`quota_jobs` 三张表均增加 `provider_id` 字段，将原来的单用户账户拆分为 `(user_id, provider_id)` 复合主键的独立账户。
2. **服务层**：`CreditManager` 所有方法增加 `provider_id` 参数；`QuotaScheduler` 幂等键格式改为 `{provider_id}:{user_id}:{cycle_start_at}`。
3. **适配器层**：新增 `IProviderAdapter` 接口，`Tripo3DAdapter` 和 `Hyper3DAdapter` 各自实现，通过 `ProviderRegistry` 统一管理。
4. **启动验证**：解析 `ENABLED_PROVIDERS` 环境变量，启动时验证合法性，失败则终止进程。
5. **API 层**：`/api/tasks` 增加 `provider_id` 参数；`/api/credits/status` 支持按 `provider_id` 过滤。
6. **前端层**：`GeneratorView` 增加提供商选择器；`AdminView` 动态展示各提供商配置和余额。

### 核心流程（多提供商版）

```
充值（指定 provider_id）
  ├─ 仅更新 (user_id, provider_id) 对应的 Provider_Account
  └─ credit_ledger 记录包含 provider_id

用户发起构建请求（指定 provider_id）
  ├─ 验证 provider_id 在 ENABLED_PROVIDERS 中
  ├─ 检查对应 Provider_Account 的 Pool 节流状态
  ├─ 从对应 Provider_Account 预扣额度
  └─ 调用对应提供商的 IProviderAdapter 创建任务

每周期（QuotaScheduler，按 provider_id 独立调度）
  ├─ 幂等键：{provider_id}:{user_id}:{cycle_start_at}
  ├─ settleWallet(userId, providerId, cycleKey)
  └─ injectWallet(userId, providerId, cycleKey)
```

---

## 架构

```mermaid
graph TD
    subgraph 客户端
        FE[前端插件]
    end

    subgraph Express 路由层
        TR[/api/tasks]
        CR[/api/credits]
        AR[/api/admin]
    end

    subgraph 提供商注册表
        PR[ProviderRegistry]
        T3[Tripo3DAdapter]
        H3[Hyper3DAdapter]
    end

    subgraph 服务层
        CM[CreditManager]
        QS[QuotaScheduler]
        TP[TaskPoller]
        EV[EnvValidator]
    end

    subgraph 数据层
        DB[(MySQL)]
        UA[user_accounts\n(user_id, provider_id)]
        CL[credit_ledger\n+provider_id]
        QJ[quota_jobs\n+provider_id]
    end

    FE -->|POST /api/tasks {provider_id}| TR
    FE -->|GET /api/credits/status?provider_id=| CR
    FE -->|POST /api/admin/recharge {provider_id}| AR

    TR -->|pre-deduct(userId, providerId)| CM
    TR -->|getAdapter(providerId)| PR
    PR --> T3
    PR --> H3

    TP -->|refund(userId, providerId, taskId)| CM

    AR -->|recharge(userId, providerId, ...)| CM
    CR -->|getStatus(userId, providerId?)| CM

    QS -->|inject/settle(userId, providerId, cycleKey)| CM

    EV -->|启动时验证| PR

    CM --> UA
    CM --> CL
    QS --> QJ
    QS --> UA
```

---

## 组件与接口

### IProviderAdapter 接口

统一封装各提供商的 API 调用协议，核心积分逻辑不感知具体提供商实现。

```typescript
export interface CreateTaskInput {
  type: 'text_to_model' | 'image_to_model';
  prompt?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface CreateTaskOutput {
  taskId: string;       // 提供商返回的任务 ID
  estimatedCost: number; // 预估消耗 credits
}

export interface TaskStatusOutput {
  status: 'queued' | 'processing' | 'success' | 'failed';
  progress: number;
  creditCost?: number;
  outputUrl?: string;
  errorMessage?: string;
}

export interface ProviderBalance {
  available: number;
  frozen: number;
}

export interface IProviderAdapter {
  readonly providerId: string;

  /** 验证 API Key 格式（本地，不发网络请求） */
  validateApiKeyFormat(apiKey: string): boolean;

  /** 验证 API Key 连通性（发网络请求） */
  verifyApiKey(apiKey: string): Promise<void>;

  /** 创建生成任务 */
  createTask(apiKey: string, input: CreateTaskInput): Promise<CreateTaskOutput>;

  /** 查询任务状态 */
  getTaskStatus(apiKey: string, taskId: string): Promise<TaskStatusOutput>;

  /** 查询提供商账户余额 */
  getBalance(apiKey: string): Promise<ProviderBalance>;
}
```

### ProviderRegistry

启动时根据 `ENABLED_PROVIDERS` 注册适配器，运行时提供查找能力。

```typescript
export class ProviderRegistry {
  private adapters = new Map<string, IProviderAdapter>();

  register(adapter: IProviderAdapter): void;
  get(providerId: string): IProviderAdapter | undefined;
  getAll(): IProviderAdapter[];
  getEnabledIds(): string[];
  isEnabled(providerId: string): boolean;
}

export const providerRegistry = new ProviderRegistry();
```

### EnvValidator（启动时验证）

```typescript
// backend/src/config/providers.ts
export const KNOWN_PROVIDERS = ['tripo3d', 'hyper3d'] as const;
export type KnownProvider = typeof KNOWN_PROVIDERS[number];

export function parseEnabledProviders(): string[] {
  const raw = process.env.ENABLED_PROVIDERS ?? '';
  if (!raw.trim()) {
    console.error('FATAL: ENABLED_PROVIDERS must specify at least one valid provider');
    process.exit(1);
  }
  const parsed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = parsed.filter(p => KNOWN_PROVIDERS.includes(p as KnownProvider));
  if (valid.length === 0) {
    console.error('FATAL: No valid providers found in ENABLED_PROVIDERS');
    process.exit(1);
  }
  return valid;
}
```

### CreditManager 服务（改造后）

所有方法增加 `providerId` 参数，操作范围限定在 `(userId, providerId)` 对应的 Provider_Account。

```typescript
export interface RechargeParams {
  wallet_amount: number;
  pool_amount: number;
  total_duration: number;
  cycle_duration: number;
}

export interface ProviderCreditStatus {
  provider_id: string;
  wallet_balance: number;
  pool_balance: number;
  pool_baseline: number;
  cycles_remaining: number;
  cycle_started_at: Date | null;
  next_cycle_at: Date | null;
}

export class CreditManager {
  recharge(userId: number, providerId: string, params: RechargeParams): Promise<void>;
  preDeduct(userId: number, providerId: string, amount: number, taskId: string): Promise<DeductResult>;
  refund(userId: number, providerId: string, taskId: string): Promise<void>;
  confirmDeduct(userId: number, providerId: string, taskId: string, actualAmount: number): Promise<void>;
  injectWallet(userId: number, providerId: string, cycleKey: string): Promise<void>;
  settleWallet(userId: number, providerId: string, cycleKey: string): Promise<void>;
  getStatus(userId: number, providerId?: string): Promise<ProviderCreditStatus[]>;
}
```

### QuotaScheduler 服务（改造后）

调度粒度从 `userId` 变为 `(userId, providerId)` 对，幂等键格式改为 `{providerId}:{userId}:{cycleStartAt}`。

```typescript
// 调度 Map 的 key 改为 `${providerId}:${userId}`
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>();

// runCycle 签名改为：
async function runCycle(
  userId: number,
  providerId: string,
  cycleDurationMinutes: number,
  cycleStartAt: Date
): Promise<void>
```

### API 路由层变更

| 路由 | 方法 | 变更说明 |
|------|------|----------|
| `/api/tasks` | POST | body 增加可选 `provider_id`，默认 `tripo3d` |
| `/api/credits/status` | GET | 增加可选 query param `provider_id` |
| `/api/admin/recharge` | POST | body 增加必填 `provider_id` |
| `/api/admin/config` | GET/PUT | 支持 `provider_id` 参数，分别管理各提供商 API Key |
| `/api/admin/balance` | GET | 支持 `provider_id` 参数，查询指定提供商余额 |
| `/api/admin/providers` | GET | 新增：返回已启用提供商列表（供前端使用） |

---

## 数据模型

### `user_accounts` 表改造

原 `user_id UNIQUE` 改为 `(user_id, provider_id)` 复合主键，删除原 `id` 自增主键（或保留为内部 ID）。

```sql
CREATE TABLE user_accounts (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          INT UNSIGNED NOT NULL COMMENT '主系统用户 ID',
  provider_id      VARCHAR(32)  NOT NULL COMMENT '服务提供商标识符，如 tripo3d、hyper3d',

  wallet_balance             DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pool_balance               DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pool_baseline              DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  wallet_injection_per_cycle DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  cycles_remaining           INT UNSIGNED  NOT NULL DEFAULT 0,
  cycle_duration             INT UNSIGNED  NOT NULL DEFAULT 1440,
  total_duration             INT UNSIGNED  NOT NULL DEFAULT 1440,

  cycle_started_at DATETIME,
  next_cycle_at    DATETIME,

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_user_provider (user_id, provider_id),
  INDEX idx_next_cycle (next_cycle_at),
  INDEX idx_provider (provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**迁移策略**：现有数据通过 `ALTER TABLE` 添加 `provider_id` 列，并将现有行的 `provider_id` 设为 `'tripo3d'`，然后删除原 `UNIQUE KEY (user_id)` 并添加复合唯一键。

### `credit_ledger` 表改造

增加 `provider_id` 字段，幂等键格式同步更新。

```sql
ALTER TABLE credit_ledger
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符' AFTER user_id,
  ADD INDEX idx_provider_user (provider_id, user_id);
```

### `quota_jobs` 表改造

增加 `provider_id` 字段，`cycle_key` 格式改为 `{provider_id}:{user_id}:{cycle_start_at}`。

```sql
ALTER TABLE quota_jobs
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符' AFTER user_id,
  ADD INDEX idx_provider_user_status (provider_id, user_id, status);
```

### `tasks` 表改造

增加 `provider_id` 字段，记录任务使用的提供商。

```sql
ALTER TABLE tasks
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符' AFTER user_id,
  ADD INDEX idx_provider_id (provider_id);
```

### `system_config` 表（无结构变更）

API Key 存储键名规则改为 `{provider_id}_api_key`，例如：
- `tripo3d_api_key`（现有，保持不变）
- `hyper3d_api_key`（新增）

### 数据迁移脚本

```sql
-- 1. user_accounts：添加 provider_id，设置现有行为 tripo3d，重建唯一键
ALTER TABLE user_accounts
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d' AFTER user_id;

UPDATE user_accounts SET provider_id = 'tripo3d';

ALTER TABLE user_accounts
  DROP INDEX user_id,
  ADD UNIQUE KEY uk_user_provider (user_id, provider_id);

-- 2. credit_ledger：添加 provider_id
ALTER TABLE credit_ledger
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d' AFTER user_id;

-- 3. quota_jobs：添加 provider_id
ALTER TABLE quota_jobs
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d' AFTER user_id;

-- 4. tasks：添加 provider_id
ALTER TABLE tasks
  ADD COLUMN provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d' AFTER user_id;
```

---

## 正确性属性

*属性（Property）是在系统所有合法执行中都应成立的特征或行为——本质上是对系统应做什么的形式化陈述。属性是人类可读规范与机器可验证正确性保证之间的桥梁。*

### 属性 1：非法 provider_id 被拒绝

*对于任意* 不在已启用提供商列表中的字符串作为 `provider_id`，构建请求应被拒绝并返回 `INVALID_PROVIDER` 或 `PROVIDER_DISABLED` 错误码。

**验证需求：1.3、9.5**

### 属性 2：provider_id 账户隔离性

*对于任意* 用户和两个不同的提供商 A、B，在提供商 A 的账户上执行任何写操作（充值、扣减、注入、结转），提供商 B 的账户余额和周期参数应保持不变。

**验证需求：1.4、2.2、2.3、4.3、5.1、6.1、6.2**

### 属性 3：任务 provider_id 持久化轮回

*对于任意* 合法的 `provider_id` 和构建请求，创建任务后查询该任务，返回的 `provider_id` 应与创建时传入的值完全一致。

**验证需求：1.5**

### 属性 4：充值日志包含 provider_id

*对于任意* 充值操作，完成后查询 `credit_ledger` 中对应的 `recharge` 记录，应包含与充值请求一致的 `provider_id` 字段。

**验证需求：4.4、6.4**

### 属性 5：充值参数校验拒绝非法输入

*对于任意* 不合法的充值参数组合（`wallet_amount ≤ 0`、`pool_amount < 0`、`cycle_duration` 超出范围、`total_duration < cycle_duration`），充值请求应被拒绝并返回对应错误码。

**验证需求：4.5**

### 属性 6：API Key 加密存储轮回

*对于任意* 合法的 API Key 字符串，加密后存入 `system_config`，再读取并解密，应得到与原始值完全相同的字符串。

**验证需求：3.2**

### 属性 7：提供商 API 失败时预扣额度被退还

*对于任意* 用户和提供商，当提供商 API 调用失败时，该请求已预扣的 Provider_Account 余额应被完整退还，账户余额恢复到预扣前的状态。

**验证需求：3.5**

### 属性 8：调度器幂等键包含 provider_id

*对于任意* `(provider_id, user_id, cycle_start_at)` 三元组，使用相同三元组触发两次注入或结转操作，第二次应被幂等跳过，账户余额只变化一次。

**验证需求：6.3**

### 属性 9：额度状态查询返回所有已启用提供商

*对于任意* 已为多个提供商充值的用户，不带 `provider_id` 参数的额度状态查询应返回所有已启用提供商的 Provider_Account 状态，且每条记录包含 `provider_id` 字段。

**验证需求：2.5、7.1、9.6**

### 属性 10：按 provider_id 过滤额度状态

*对于任意* 用户和已启用的 `provider_id`，带 `provider_id` 参数的额度状态查询应只返回该提供商的 Provider_Account 状态，不包含其他提供商的数据。

**验证需求：7.2、9.6**

### 属性 11：ENABLED_PROVIDERS 解析正确性

*对于任意* 包含至少一个合法提供商标识符的逗号分隔字符串（允许空格、大小写混合），`parseEnabledProviders()` 应返回去重、小写、仅包含合法标识符的数组。

**验证需求：9.1**

---

## 错误处理

| 错误码 | HTTP 状态 | 触发场景 |
|--------|-----------|----------|
| `INVALID_PROVIDER` | 422 | `provider_id` 不在合法提供商列表中 |
| `PROVIDER_DISABLED` | 422 | `provider_id` 合法但未在 `ENABLED_PROVIDERS` 中启用 |
| `PROVIDER_NOT_CONFIGURED` | 503 | 指定提供商的 API Key 未配置 |
| `PROVIDER_UNAVAILABLE` | 502 | 提供商 API 调用失败 |
| `MISSING_PROVIDER` | 422 | 充值请求未提供 `provider_id` |
| `POOL_EXHAUSTED` | 429 | 指定提供商的 Pool 余量为 0（响应体包含 `provider_id`） |
| `INSUFFICIENT_CREDITS` | 422 | 指定提供商的 Provider_Account 不存在或余额不足 |
| `CONCURRENT_CONFLICT` | 409 | 并发扣减导致余额不足 |
| `INVALID_AMOUNT` | 422 | `wallet_amount ≤ 0` 或 `pool_amount < 0` |
| `INVALID_PARAMS` | 422 | `cycle_duration` 或 `total_duration` 超出范围 |

`POOL_EXHAUSTED` 响应体（新增 `provider_id` 字段）：

```json
{
  "code": "POOL_EXHAUSTED",
  "message": "池塘额度已耗尽",
  "data": {
    "provider_id": "hyper3d",
    "poolCurrent": 0,
    "poolBaseline": 500,
    "nextCycleAt": "2024-01-15T08:00:00Z",
    "suggestedWaitSeconds": 3600
  }
}
```

启动时致命错误（直接 `process.exit(1)`）：
- `FATAL: ENABLED_PROVIDERS must specify at least one valid provider`
- `FATAL: No valid providers found in ENABLED_PROVIDERS`

---

## 测试策略

### 双轨测试方法

- **单元测试**：验证具体示例、边界条件和错误场景
- **属性测试**：验证跨所有输入的通用属性

两者互补，共同提供全面覆盖。

### 属性测试配置

使用 `fast-check` 库（TypeScript 生态主流 PBT 库）。每个属性测试最少运行 **100 次迭代**。

每个属性测试必须包含注释标签：
```
// Feature: multi-provider-credits, Property {N}: {property_text}
```

**属性测试列表**（每个属性对应一个 `fc.assert` 调用）：

| 属性 | 测试文件 | 生成器策略 |
|------|----------|-----------|
| 属性 1：非法 provider_id 被拒绝 | `creditManager.providerValidation.test.ts` | `fc.string()` 过滤掉合法值 |
| 属性 2：账户隔离性 | `creditManager.isolation.test.ts` | `fc.tuple(fc.integer(), fc.constantFrom(...providers))` |
| 属性 3：任务 provider_id 轮回 | `task.providerPersistence.test.ts` | `fc.constantFrom(...enabledProviders)` |
| 属性 4：充值日志包含 provider_id | `creditManager.recharge.test.ts` | `fc.constantFrom(...providers)` |
| 属性 5：充值参数校验 | `creditManager.recharge.test.ts` | `fc.record({wallet_amount: fc.float({max: 0}), ...})` |
| 属性 6：API Key 加密轮回 | `crypto.roundtrip.test.ts` | `fc.string()` |
| 属性 7：API 失败退款 | `creditManager.refund.test.ts` | `fc.tuple(fc.integer(), fc.constantFrom(...providers))` |
| 属性 8：调度器幂等键 | `quotaScheduler.idempotency.test.ts` | `fc.tuple(fc.constantFrom(...providers), fc.integer(), fc.date())` |
| 属性 9：状态查询完整性 | `creditManager.getStatus.test.ts` | `fc.array(fc.constantFrom(...providers), {minLength: 2})` |
| 属性 10：按 provider_id 过滤 | `creditManager.getStatus.test.ts` | `fc.constantFrom(...providers)` |
| 属性 11：ENABLED_PROVIDERS 解析 | `providers.config.test.ts` | `fc.array(fc.constantFrom(...knownProviders))` |

### 单元测试重点

- `provider_id` 默认值为 `tripo3d`（需求 1.2）
- `ENABLED_PROVIDERS` 为空时启动失败（需求 9.3）
- `ENABLED_PROVIDERS` 全部非法时启动失败（需求 9.4）
- 未配置 API Key 时返回 `PROVIDER_NOT_CONFIGURED`（需求 3.4）
- `POOL_EXHAUSTED` 响应体包含 `provider_id`（需求 5.3）
- 未认证用户无法查询额度状态（需求 7.5）
- 零余额状态返回（需求 7.3）

### 集成测试

- 端到端流程：选择提供商 → 预扣 → 调用适配器 → 确认消耗
- 数据迁移验证：现有 `tripo3d` 数据迁移后功能不变
