# 需求文档：多服务商积分管理（Multi-Provider Credits）

## 简介

当前系统仅支持 Tripo3D 作为 3D 生成服务提供商，积分体系与该提供商深度耦合。本功能扩展系统，使其支持多个 3D 生成服务提供商（初期新增 Hyper3D），并为每个提供商维护完全独立的积分账户（Wallet + Pool）、充值记录和消耗核算，互不干扰。用户在生成时可选择使用哪个提供商，系统从对应提供商的积分账户中扣减额度。

---

## 术语表

- **Provider（服务提供商）**：提供 3D 生成能力的外部 AI 服务，当前支持 `tripo3d`（现有）和 `hyper3d`（新增）。
- **Provider_Account（提供商账户）**：某用户在某一特定提供商下的独立积分账户，包含 Wallet 余额、Pool 余额、Pool_Baseline 及周期参数。每个用户对每个提供商各有一个独立账户。
- **Wallet（钱包）**：Provider_Account 内的周期性可用额度区，语义与现有系统一致。
- **Pool（池塘）**：Provider_Account 内的储备额度区，语义与现有系统一致。
- **Pool_Baseline（水平面）**：充值时填入的 pool_amount，作为节流判断基准线，语义与现有系统一致。
- **Credit_Manager（额度管理器）**：负责多提供商额度分配、消耗、节流判断和周期结算的后端服务。
- **Quota_Scheduler（配额调度器）**：负责按周期触发各提供商账户钱包注入和余额结转的定时任务服务。
- **Admin（管理员）**：具有 `admin-config` 权限的系统用户。
- **User（用户）**：已认证的插件使用者。
- **provider_id**：标识服务提供商的字符串标识符，当前内置支持 `tripo3d` 和 `hyper3d`，系统设计上支持通过配置扩展更多提供商。

---

## 需求

### 需求 1：提供商选择

**用户故事：** 作为用户，我希望在发起 3D 生成任务时能够选择使用哪个服务提供商，以便根据需要灵活切换生成服务。

#### 验收标准

1. WHEN 用户发起构建请求，THE System SHALL 接受 `provider_id` 参数，合法值为系统当前已启用的提供商列表。
2. IF 请求中未提供 `provider_id`，THEN THE System SHALL 使用 `tripo3d` 作为默认提供商，保持向后兼容。
3. IF 请求中的 `provider_id` 不在合法值列表中，THEN THE System SHALL 拒绝请求并返回错误码 `INVALID_PROVIDER`。
4. WHEN 用户发起构建请求，THE Credit_Manager SHALL 从与 `provider_id` 对应的 Provider_Account 中扣减额度。
5. THE System SHALL 在任务记录中持久化存储该任务所使用的 `provider_id`，以便后续查询和核算。

---

### 需求 2：独立提供商账户

**用户故事：** 作为用户，我希望每个服务提供商的积分账户完全独立，以便不同提供商的充值和消耗互不影响。

#### 验收标准

1. THE Credit_Manager SHALL 为每个用户的每个提供商维护独立的 Provider_Account，包含独立的 wallet_balance、pool_balance、pool_baseline、wallet_injection_per_cycle、cycles_remaining 及周期时间字段。
2. WHEN 用户在提供商 A 下发生额度消耗，THE Credit_Manager SHALL 不影响该用户在提供商 B 下的任何余额。
3. WHEN 管理员为用户充值，THE Credit_Manager SHALL 仅更新指定 `provider_id` 对应的 Provider_Account，不影响其他提供商账户。
4. THE Credit_Manager SHALL 支持同一用户在不同提供商下拥有不同的周期参数（cycle_duration、total_duration）。
5. WHEN 用户查询额度状态，THE Credit_Manager SHALL 返回该用户所有已配置提供商的 Provider_Account 状态列表，每条记录包含 `provider_id` 字段。

---

### 需求 3：提供商 API 集成

**用户故事：** 作为用户，我希望系统能够调用各服务提供商的 API 完成 3D 生成任务，以便使用不同提供商的生成能力。

#### 验收标准

1. WHEN 用户选择某一提供商并发起构建请求，THE System SHALL 使用系统配置中存储的该提供商 API Key 调用对应服务接口。
2. THE System SHALL 为每个提供商独立存储 API Key，各提供商的 API Key 互相隔离，均经过 AES-256-GCM 加密后存储。
3. THE System SHALL 为每个提供商维护独立的调用适配器，适配器封装该提供商的接口协议，不影响其他提供商的调用逻辑。
4. IF 某提供商的 API Key 未配置，THEN THE System SHALL 拒绝使用该提供商的构建请求，并返回错误码 `PROVIDER_NOT_CONFIGURED`。
5. WHEN 某提供商 API 调用失败，THE System SHALL 退还该请求已预扣的对应 Provider_Account 额度，并返回错误码 `PROVIDER_UNAVAILABLE`。
6. THE System SHALL 支持管理员通过管理界面分别配置各提供商的 API Key。

---

### 需求 4：按提供商充值

**用户故事：** 作为管理员，我希望能够针对特定提供商为用户充值，以便精确控制每个提供商的可用额度。

#### 验收标准

1. WHEN 管理员发起充值操作，THE Admin SHALL 能够指定 `provider_id`（`tripo3d` 或 `hyper3d`）、`userId`、`wallet_amount`、`pool_amount`、`total_duration` 和 `cycle_duration`。
2. IF 充值请求中未提供 `provider_id`，THEN THE Credit_Manager SHALL 拒绝请求并返回错误码 `MISSING_PROVIDER`。
3. WHEN 充值参数验证通过，THE Credit_Manager SHALL 仅更新指定 `provider_id` 对应的 Provider_Account，充值逻辑（wallet_injection_per_cycle 计算、cycles_remaining 初始化、Pool_Baseline 设定）与现有系统一致。
4. WHEN 充值完成，THE Credit_Manager SHALL 在充值日志中记录 `provider_id`，以便按提供商进行审计。
5. IF 充值参数（wallet_amount、pool_amount、total_duration、cycle_duration）不合法，THEN THE Credit_Manager SHALL 拒绝请求并返回具体字段的错误信息，错误码与现有系统一致（`INVALID_AMOUNT`、`INVALID_PARAMS`）。

---

### 需求 5：按提供商额度消耗与节流

**用户故事：** 作为用户，我希望系统在处理不同提供商的请求时，分别从对应提供商的积分账户中扣减额度并执行节流，以便各提供商的用量互不干扰。

#### 验收标准

1. WHEN 用户发起构建请求，THE Credit_Manager SHALL 仅检查并扣减 `provider_id` 对应的 Provider_Account 余额，不读取或修改其他提供商的账户。
2. WHILE 指定提供商的 Pool 余量低于该提供商的 Pool_Baseline，THE Credit_Manager SHALL 在处理该提供商的构建请求前引入额外延迟，延迟算法与现有系统一致。
3. WHEN 指定提供商的 Pool 余量降至 0，THE Credit_Manager SHALL 拒绝该提供商的构建请求并返回错误码 `POOL_EXHAUSTED`，响应体中包含 `provider_id` 字段。
4. IF 指定提供商的 Provider_Account 不存在（用户从未在该提供商下充值），THEN THE Credit_Manager SHALL 拒绝构建请求并返回错误码 `INSUFFICIENT_CREDITS`。
5. THE Credit_Manager SHALL 保证同一提供商账户的并发扣减操作的原子性，不同提供商账户的操作互相独立，不产生跨账户锁竞争。

---

### 需求 6：按提供商周期调度

**用户故事：** 作为系统，我希望每个提供商账户的周期注入和余额结转独立执行，以便各提供商的周期参数互不干扰。

#### 验收标准

1. WHEN 一个 Provider_Account 的 Cycle 开始，THE Quota_Scheduler SHALL 仅向该 Provider_Account 的 Wallet 注入额度，不影响同一用户其他提供商的账户。
2. WHEN 一个 Provider_Account 的 Cycle 结束，THE Quota_Scheduler SHALL 仅对该 Provider_Account 执行 Wallet → Pool 结转，不影响同一用户其他提供商的账户。
3. THE Quota_Scheduler SHALL 使用包含 `provider_id` 的幂等键（格式：`{provider_id}:{user_id}:{cycle_start_at}`）保证同一提供商账户同一周期内的注入和结转操作不重复执行。
4. WHEN 注入或结转事件写入日志，THE Quota_Scheduler SHALL 在日志记录中包含 `provider_id` 字段，以便按提供商审计周期操作。

---

### 需求 7：按提供商额度状态查询

**用户故事：** 作为用户，我希望能够分别查询每个提供商的积分余额和周期状态，以便了解各提供商的可用额度。

#### 验收标准

1. WHEN 用户请求额度状态，THE Credit_Manager SHALL 返回该用户所有已配置提供商的 Provider_Account 状态，每条记录包含 `provider_id`、wallet_balance、pool_balance、pool_baseline、cycles_remaining、cycle_started_at 及 next_cycle_at。
2. WHEN 用户请求指定提供商的额度状态，THE Credit_Manager SHALL 接受 `provider_id` 查询参数，仅返回该提供商的 Provider_Account 状态。
3. IF 用户在指定提供商下无 Provider_Account，THEN THE Credit_Manager SHALL 返回该提供商的零余额状态（所有余额字段为 0，周期时间字段为 null）。
4. THE Credit_Manager SHALL 在 200ms 内返回额度状态响应。
5. THE Credit_Manager SHALL 仅允许已认证用户查询自身的额度状态，不允许查询其他用户的数据。

---

### 需求 8：管理界面多提供商支持

**用户故事：** 作为管理员，我希望在管理界面中能够分别配置各提供商的 API Key 并查看各提供商的账户余额，以便统一管理多个服务提供商。

#### 验收标准

1. WHEN 管理员访问管理界面，THE Admin SHALL 能够动态查看和更新所有已启用提供商的 API Key 配置，各提供商在界面上明确区分。
2. WHEN 管理员查看账户余额，THE Admin SHALL 能够分别查看所有已启用提供商的账户余额，各提供商独立展示。
3. WHEN 管理员发起充值操作，THE Admin SHALL 能够在充值表单中选择目标提供商（从已启用提供商列表中选取），并为指定用户的对应提供商账户充值。
4. THE Admin SHALL 能够在用量统计界面中按提供商筛选查看消耗数据。



---

### 需求 9：通过环境变量控制启用的服务提供商

**用户故事：** 作为部署者，我希望通过 docker-compose 环境变量指定启用哪些服务提供商，以便在不修改代码的情况下灵活控制系统所支持的提供商范围。

#### 验收标准

1. THE System SHALL 读取环境变量 `ENABLED_PROVIDERS`，合法值为任意已知提供商标识符的逗号分隔列表（顺序不限，允许空格）。
2. WHEN 系统启动，THE System SHALL 仅加载 `ENABLED_PROVIDERS` 中列出的提供商的相关配置（包括对应的 API Key 环境变量）。
3. IF `ENABLED_PROVIDERS` 未设置或为空，THEN THE System SHALL 终止启动并输出明确错误信息：`FATAL: ENABLED_PROVIDERS must specify at least one valid provider`。
4. IF `ENABLED_PROVIDERS` 中所有值均不在合法提供商列表中，THEN THE System SHALL 终止启动并输出明确错误信息：`FATAL: No valid providers found in ENABLED_PROVIDERS`。
5. WHEN 用户请求使用未在 `ENABLED_PROVIDERS` 中列出的提供商，THE System SHALL 拒绝请求并返回错误码 `PROVIDER_DISABLED`，响应体中包含 `provider_id` 字段。
6. WHEN 用户请求额度状态，THE Credit_Manager SHALL 仅返回已启用提供商的 Provider_Account 状态，不返回未启用提供商的数据。
7. WHEN 前端界面加载，THE System SHALL 仅向前端暴露已启用提供商的选项列表，前端不展示未启用提供商的余额、选择项或相关配置入口。
8. WHERE 仅启用单一提供商，THE System SHALL 在用户发起构建请求时将该提供商作为唯一可用选项，无需用户显式传入 `provider_id`，行为与需求 1.2 的默认值逻辑一致。
9. THE System SHALL 支持通过新增提供商适配器模块的方式扩展新提供商，无需修改核心积分管理逻辑。
