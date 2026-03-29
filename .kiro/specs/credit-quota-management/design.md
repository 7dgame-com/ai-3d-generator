# 技术设计文档：付费配额管理系统（Credit Quota Management）

## 概述

付费配额管理系统（Credit Quota Management）为 AI 3D 生成插件提供基于周期的额度分配与流控机制。系统围绕两个账户区（Wallet、Pool）运作，通过周期性调度器（QuotaScheduler）驱动额度流转，通过额度管理器（CreditManager）处理消耗与节流逻辑。

### 核心流程

```
充值
  ├─ wallet_amount → 计算 wallet_injection_per_cycle = wallet_amount × cycle_duration / total_duration（持久化存储）
  ├─ cycles_remaining = total_duration / cycle_duration（持久化存储）
  └─ pool_amount → Pool 余额（同时设定 Pool_Baseline）

每周期开始（QuotaScheduler）
  └─ cycles_remaining > 0 → 向 Wallet 注入 wallet_injection_per_cycle，cycles_remaining 递减 1

用户发起构建请求（CreditManager）
  ├─ Pool ≥ Pool_Baseline → 无延迟，正常处理
  ├─ 0 < Pool < Pool_Baseline → 延迟 = max_delay × (Pool_Baseline - pool_current) / Pool_Baseline
  └─ Pool = 0 → 拒绝，返回 POOL_EXHAUSTED
  扣减顺序：先扣 Wallet，不足部分扣 Pool

每周期结束（QuotaScheduler）
  └─ Wallet 余额 → Pool，Wallet 清零
```

### 与现有系统的集成点

- **task 创建流程**：在 `createTask` 控制器调用 Tripo3D API 之前，插入 CreditManager 的预扣（pre-deduct）步骤；任务失败时退还额度。
- **taskPoller**：任务状态变为 `failed` 时，调用 CreditManager 退还预扣额度。
- **auth / requirePermission 中间件**：充值和管理接口复用现有 `admin-config` 权限检查。
- **system_config 表**：存储 `max_delay_ms`、`cycle_duration_minutes` 等全局配置。

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

    subgraph 服务层
        CM[CreditManager]
        QS[QuotaScheduler]
        TP[TaskPoller]
    end

    subgraph 数据层
        DB[(MySQL)]
        SC[system_config]
        UA[user_accounts]
        CL[credit_ledger]
        QJ[quota_jobs]
    end

    FE -->|POST /api/tasks| TR
    FE -->|GET /api/credits/status| CR
    FE -->|POST /api/admin/recharge| AR

    TR -->|pre-deduct| CM
    TR --> TP
    TP -->|refund on failure| CM

    AR -->|recharge| CM
    CR -->|query| CM

    QS -->|inject / settle| CM

    CM --> DB
    CM --> UA
    CM --> CL
    QS --> QJ
    QS --> UA
```

---

## 组件与接口

### CreditManager 服务

负责所有额度的读写操作，是唯一直接操作 `user_accounts` 表的服务。

```typescript
interface CreditManager {
  // 充值：计算并存储 wallet_injection_per_cycle、cycles_remaining，写入 Pool，设定 Pool_Baseline
  recharge(userId: number, params: RechargeParams): Promise<void>;

  // 预扣额度（构建请求发起时）：先扣 Wallet，不足扣 Pool
  preDeduct(userId: number, amount: number, taskId: string): Promise<DeductResult>;

  // 退还预扣额度（任务失败时）
  refund(userId: number, amount: number, taskId: string): Promise<void>;

  // 确认消耗（任务成功，实际 credit_cost 可能与预扣不同）
  confirmDeduct(userId: number, taskId: string, actualAmount: number): Promise<void>;

  // 周期注入：直接向 Wallet 注入 wallet_injection_per_cycle，cycles_remaining 递减
  injectWallet(userId: number, cycleKey: string): Promise<void>;

  // 周期结转：Wallet → Pool，Wallet 清零
  settleWallet(userId: number, cycleKey: string): Promise<void>;

  // 查询用户额度状态
  getStatus(userId: number): Promise<CreditStatus>;

  // 计算节流延迟（毫秒）
  computeThrottleDelay(poolCurrent: number, poolBaseline: number, maxDelayMs: number): number;
}
```

### QuotaScheduler 服务

基于 `setInterval` 实现周期调度，启动时从 `quota_jobs` 表恢复未完成的周期任务。

```typescript
interface QuotaScheduler {
  start(): Promise<void>;
  stop(): void;
}
```

调度逻辑：
1. 启动时读取所有活跃用户的 `next_cycle_at`，计算距下次触发的剩余时间
2. 到期时依次执行：`settleWallet`（结转上周期）→ `injectWallet`（注入新周期）
3. 使用 `quota_jobs` 表的幂等键（`user_id + cycle_start_at`）防止重复执行

### API 路由层

| 路由 | 方法 | 中间件 | 说明 |
|------|------|--------|------|
| `/api/admin/recharge` | POST | auth + requirePermission('admin-config') | 管理员充值 |
| `/api/credits/status` | GET | auth | 查询当前用户额度状态 |
| `/api/admin/credits/:userId` | GET | auth + requirePermission('admin-config') | 管理员查询指定用户额度 |

---

## 数据模型

### 新增表：`user_accounts`

存储每个用户的两账户余额及充值参数。

```sql
CREATE TABLE user_accounts (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          INT UNSIGNED NOT NULL UNIQUE COMMENT '主系统用户 ID',

  -- 两账户余额（单位：credits，精度 2 位小数）
  wallet_balance   DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Wallet 余额',
  pool_balance     DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Pool 余额',

  -- 充值参数（最近一次充值写入）
  pool_baseline             DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '充值时的 pool_amount，节流基准线',
  wallet_injection_per_cycle DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '每周期注入额度 = wallet_amount × cycle_duration / total_duration',
  cycles_remaining          INT UNSIGNED  NOT NULL DEFAULT 0   COMMENT '剩余周期数，每次注入后递减，归零后停止注入',
  cycle_duration            INT UNSIGNED  NOT NULL DEFAULT 1440 COMMENT '周期时长（分钟）',
  total_duration            INT UNSIGNED  NOT NULL DEFAULT 1440 COMMENT '总使用时长（分钟）',

  -- 周期时间
  cycle_started_at DATETIME     COMMENT '当前周期开始时间',
  next_cycle_at    DATETIME     COMMENT '下一个周期开始时间',

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_next_cycle (next_cycle_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 新增表：`credit_ledger`

记录所有额度变动事件，用于审计和对账。

```sql
CREATE TABLE credit_ledger (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  event_type  ENUM(
    'recharge',        -- 充值
    'inject',          -- 周期注入（直接向 Wallet 注入 wallet_injection_per_cycle）
    'settle',          -- 周期结转 Wallet→Pool
    'pre_deduct',      -- 预扣（构建请求）
    'refund',          -- 退还（任务失败）
    'confirm_deduct'   -- 确认消耗（任务成功）
  ) NOT NULL,
  wallet_delta DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pool_delta   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  task_id      VARCHAR(64)   COMMENT '关联任务 ID（pre_deduct/refund/confirm_deduct 时填写）',
  idempotency_key VARCHAR(128) COMMENT '幂等键（inject/settle 时填写）',
  note         VARCHAR(256),
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_user_id (user_id),
  INDEX idx_task_id (task_id),
  INDEX idx_idempotency (idempotency_key),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 新增表：`quota_jobs`

记录周期调度任务，用于幂等性保证和服务重启恢复。

```sql
CREATE TABLE quota_jobs (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED NOT NULL,
  job_type        ENUM('inject', 'settle') NOT NULL,
  cycle_key       VARCHAR(64) NOT NULL COMMENT 'user_id:cycle_start_at，幂等键',
  status          ENUM('pending', 'done', 'failed') NOT NULL DEFAULT 'pending',
  executed_at     DATETIME,
  error_message   VARCHAR(256),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_cycle_key (cycle_key),
  INDEX idx_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 数据类型说明

- 余额使用 `DECIMAL(12,2)` 而非 `FLOAT`，避免浮点精度问题
- 所有余额字段通过数据库约束保证非负（应用层 + 行级锁双重保障）

---

## 节流算法设计

```typescript
/**
 * 计算节流延迟
 * @param poolCurrent   当前 Pool 余量
 * @param poolBaseline  Pool_Baseline（充值时的 pool_amount）
 * @param maxDelayMs    最大延迟毫秒数（从 system_config 读取，默认 30000ms）
 * @returns 延迟毫秒数（0 表示无延迟）
 */
function computeThrottleDelay(
  poolCurrent: number,
  poolBaseline: number,
  maxDelayMs: number
): number {
  if (poolBaseline <= 0) return 0;          // 未设置基准线，不节流
  if (poolCurrent <= 0) return -1;          // -1 表示拒绝（POOL_EXHAUSTED）
  if (poolCurrent >= poolBaseline) return 0; // 正常，无延迟

  const ratio = (poolBaseline - poolCurrent) / poolBaseline;
  return Math.round(maxDelayMs * ratio);
}
```

在 `createTask` 流程中的应用：

```
1. 查询用户 pool_balance、pool_baseline（加行级锁 FOR UPDATE）
2. 调用 computeThrottleDelay
3. 若返回 -1 → 返回 POOL_EXHAUSTED 错误
4. 若返回 > 0 → await sleep(delayMs)
5. 执行 preDeduct（原子扣减 Wallet + Pool）
6. 调用 Tripo3D API 创建任务
```

---

## 并发安全策略

### 行级锁（SELECT ... FOR UPDATE）

所有余额读写操作使用事务 + 行级锁：

```sql
START TRANSACTION;
SELECT wallet_balance, pool_balance, pool_baseline
FROM user_accounts
WHERE user_id = ?
FOR UPDATE;          -- 锁定该行，阻塞其他并发写入

-- 执行余额变更
UPDATE user_accounts SET wallet_balance = wallet_balance - ?, pool_balance = pool_balance - ?
WHERE user_id = ? AND wallet_balance >= ? AND pool_balance >= ?;

-- 写入 credit_ledger
INSERT INTO credit_ledger (...) VALUES (...);

COMMIT;
```

### 余额非负约束

UPDATE 语句的 WHERE 条件包含余额检查（`wallet_balance >= 0`），若并发导致余额不足，`affectedRows = 0`，应用层返回 `CONCURRENT_CONFLICT`。

### 幂等键防重复注入

`quota_jobs.cycle_key` 设有 UNIQUE 约束，重复插入会触发唯一键冲突，从而防止同一周期重复执行注入/结转。

---

## 错误处理

| 错误码 | HTTP 状态 | 触发场景 |
|--------|-----------|----------|
| `INVALID_AMOUNT` | 422 | wallet_amount ≤ 0，或 pool_amount < 0 |
| `POOL_EXHAUSTED` | 429 | Pool 余量为 0 时发起构建请求 |
| `CONCURRENT_CONFLICT` | 409 | 并发扣减导致余额不足 |
| `INSUFFICIENT_CREDITS` | 422 | Wallet + Pool 合计不足以覆盖所需额度 |
| `INVALID_PARAMS` | 422 | cycle_duration 或 total_duration 超出范围 |

`POOL_EXHAUSTED` 响应体：

```json
{
  "code": "POOL_EXHAUSTED",
  "message": "池塘额度已耗尽",
  "data": {
    "poolCurrent": 0,
    "poolBaseline": 500,
    "nextCycleAt": "2024-01-15T08:00:00Z",
    "suggestedWaitSeconds": 3600
  }
}
```

---

