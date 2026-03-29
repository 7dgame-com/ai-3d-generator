# 需求文档

## 简介

付费配额管理系统（Credit Quota Management System）为 AI 3D 生成插件提供基于周期的额度分配与流控机制。用户充值时，直接填写分配给**钱包系统（Wallet）**的总额度（wallet_amount）和分配给**池塘（Pool）**的金额（pool_amount）。充值时系统计算每周期注入量（wallet_injection_per_cycle）并持久化存储；每个使用周期开始时，系统直接向钱包注入固定额度，同时递减剩余周期数（cycles_remaining），归零后停止注入。用户在周期内消耗钱包额度，钱包耗尽后从池塘补充；池塘余量低于 Pool_Baseline 时开始节流，余量越低延迟越高；池塘耗尽时构建请求失败。周期结束时，钱包未用完的余额流入池塘，钱包清零。

---

## 术语表

- **Wallet（钱包）**：用户每个周期内的可用额度区。每周期开始时直接注入固定额度（wallet_injection_per_cycle）；周期结束时余额全部流入 Pool，钱包清零。
- **Pool（池塘）**：充值时一次性分配的储备区，之后仅从每周期钱包结余中补充，不会重置或重新注入。
- **Pool_Baseline（水平面）**：充值时填入的 pool_amount（固定值，不随时间变化），作为节流判断的基准线。Pool 余量 ≥ Pool_Baseline 时正常使用；Pool 余量 < Pool_Baseline 时开始增加延迟；Pool 余量 = 0 时构建请求报错失败。
- **wallet_amount**：充值时分配给钱包系统的总额度，用于计算每周期注入量，须大于 0。
- **pool_amount**：充值时分配给池塘的金额，须大于或等于 0。
- **wallet_injection_per_cycle**：每个周期向 Wallet 注入的固定额度，计算公式为 `wallet_amount × cycle_duration / total_duration`，充值时计算并持久化存储。
- **cycles_remaining**：剩余周期数，初始值为 `total_duration / cycle_duration`，每次注入后递减，归零后停止注入。
- **Cycle（使用周期）**：系统自动触发钱包注入和余额结转的固定时间间隔。
- **Credit_Manager（额度管理器）**：负责额度分配、消耗、节流判断和周期结算的后端服务。
- **Quota_Scheduler（配额调度器）**：负责按周期触发钱包注入和余额结转的定时任务服务。
- **Admin（管理员）**：具有 `admin-config` 权限的系统用户。
- **User（用户）**：已认证的插件使用者。

---

## 需求

### 需求 1：充值额度分配

**用户故事：** 作为用户，我希望充值后额度自动分配到钱包系统和池塘，以便系统能按周期平滑管理我的使用配额。

#### 验收标准

1. WHEN 用户完成充值，THE Credit_Manager SHALL 将 pool_amount 写入该用户的 Pool 余额，并将 Pool_Baseline 记录为本次充值时填入的 pool_amount（固定值，后续不随时间变化）。
2. WHEN 用户完成充值，THE Credit_Manager SHALL 根据公式 `wallet_amount × cycle_duration / total_duration` 计算 wallet_injection_per_cycle 并持久化存储。
3. WHEN 用户完成充值，THE Credit_Manager SHALL 将 cycles_remaining 初始化为 `total_duration / cycle_duration`（向下取整）。
4. WHEN 充值额度分配完成，THE Credit_Manager SHALL 记录充值事件日志，包含用户 ID、wallet_amount、pool_amount、wallet_injection_per_cycle、cycles_remaining 及时间戳。
5. IF wallet_amount 小于或等于 0，THEN THE Credit_Manager SHALL 拒绝该充值请求并返回错误码 `INVALID_AMOUNT`。
6. IF pool_amount 小于 0，THEN THE Credit_Manager SHALL 拒绝该充值请求并返回错误码 `INVALID_AMOUNT`。
7. IF wallet_amount 和 pool_amount 同时为 0，THEN THE Credit_Manager SHALL 拒绝该充值请求并返回错误码 `INVALID_AMOUNT`。
8. THE Credit_Manager SHALL 保证充值分配操作的原子性，即 Pool 写入、wallet_injection_per_cycle 和 cycles_remaining 的存储要么全部成功，要么全部回滚。

---

### 需求 2：周期性钱包注入

**用户故事：** 作为用户，我希望每个使用周期开始时钱包自动获得固定额度，以便我在周期内正常使用服务。

#### 验收标准

1. WHEN 一个 Cycle 开始且用户 cycles_remaining 大于 0，THE Quota_Scheduler SHALL 向该用户 Wallet 注入 wallet_injection_per_cycle 额度，并将 cycles_remaining 递减 1。
2. WHEN 一个 Cycle 开始且用户 cycles_remaining 等于 0，THE Quota_Scheduler SHALL 不向该用户 Wallet 注入任何额度。
3. WHEN 钱包注入完成，THE Quota_Scheduler SHALL 记录注入事件日志，包含用户 ID、注入额度、注入后 cycles_remaining 及周期开始时间戳。
4. THE Quota_Scheduler SHALL 按照 cycle_duration 配置的时间间隔周期性执行注入，误差不超过 30 秒。
5. THE Quota_Scheduler SHALL 保证注入操作的原子性，即 Wallet 增加和 cycles_remaining 递减要么全部成功，要么全部回滚。

---

### 需求 3：额度消耗优先级

**用户故事：** 作为用户，我希望系统优先消耗钱包额度，钱包耗尽后自动从池塘补充，以便我无感知地继续使用服务。

#### 验收标准

1. WHEN 用户发起构建请求，THE Credit_Manager SHALL 优先从该用户的 Wallet 余额中扣除所需额度。
2. WHEN 用户发起构建请求且 Wallet 余额不足以覆盖所需额度，THE Credit_Manager SHALL 从 Pool 余额中扣除 Wallet 余额不足的差额部分。
3. WHEN 用户发起构建请求且 Wallet 余额为 0，THE Credit_Manager SHALL 完全从 Pool 余额中扣除所需额度。
4. THE Credit_Manager SHALL 在单次扣除操作中保证 Wallet 和 Pool 的联合扣除具有原子性。

---

### 需求 4：池塘节流机制

**用户故事：** 作为用户，我希望在池塘余量不足时系统通过延迟而非直接拒绝来保护我的剩余额度，以便我仍能完成紧急任务。

#### 验收标准

1. WHILE Pool 余量低于 Pool_Baseline，THE Credit_Manager SHALL 在处理构建请求前引入额外延迟，延迟时长与 `(Pool_Baseline - pool_current) / Pool_Baseline` 的值成正比。
2. WHILE Pool 余量大于或等于 Pool_Baseline，THE Credit_Manager SHALL 不引入额外延迟，正常处理请求。
3. WHEN Pool 余量降至 0（Pool 耗尽），THE Credit_Manager SHALL 拒绝构建请求并返回错误码 `POOL_EXHAUSTED`。
4. THE Credit_Manager SHALL 在拒绝请求时返回响应体，包含当前 Pool 余量、Pool_Baseline、下一个 Cycle 开始时间及建议等待时长。

---

### 需求 5：周期末余额结转

**用户故事：** 作为用户，我希望周期内未用完的钱包余额自动流入池塘，以便积累的额度不会浪费。

#### 验收标准

1. WHEN 一个 Cycle 结束，THE Quota_Scheduler SHALL 将该用户 Wallet 中的剩余余额全部转入 Pool 余额。
2. WHEN 余额结转完成，THE Quota_Scheduler SHALL 将该用户 Wallet 余额重置为 0。
3. WHEN 余额结转完成，THE Quota_Scheduler SHALL 记录结转事件日志，包含用户 ID、结转额度及周期结束时间戳。
4. THE Quota_Scheduler SHALL 保证结转操作的原子性，即 Wallet 清零和 Pool 增加要么全部成功，要么全部回滚。

---

### 需求 6：充值参数配置

**用户故事：** 作为管理员，我希望在充值时能够直接填写钱包总额度、池塘金额及使用时长参数，以便灵活控制额度的分配与消耗节奏。

#### 验收标准

1. WHEN 管理员发起充值操作，THE Admin SHALL 能够设置 wallet_amount（分配给钱包系统的总额度，单位：credits，最小值 1）。
2. WHEN 管理员发起充值操作，THE Admin SHALL 能够设置 pool_amount（分配给池塘的金额，单位：credits，最小值 0）。
3. WHEN 管理员发起充值操作，THE Admin SHALL 能够设置 total_duration（总使用时长，单位：分钟，最小值等于 cycle_duration）。
4. WHEN 管理员发起充值操作，THE Admin SHALL 能够设置 cycle_duration（周期时长，单位：分钟，最小值 60，最大值 43200）。
5. WHEN 管理员提交充值参数，THE Credit_Manager SHALL 验证所有参数均在合法范围内，IF 任意参数不合法，THEN THE Credit_Manager SHALL 拒绝整批提交并返回具体字段的错误信息。
6. WHEN 充值参数验证通过，THE Credit_Manager SHALL 根据公式 `wallet_amount × cycle_duration / total_duration` 计算 wallet_injection_per_cycle 并持久化存储。

---

### 需求 7：用户额度状态查询

**用户故事：** 作为用户，我希望能够查询当前钱包余额、池塘余额、剩余周期数及下一个周期开始时间，以便了解我的可用额度。

#### 验收标准

1. WHEN 用户请求额度状态，THE Credit_Manager SHALL 返回该用户当前 Wallet 余额、Pool 余额、Pool_Baseline、cycles_remaining、当前 Cycle 开始时间及下一个 Cycle 开始时间。
2. WHEN 用户请求额度状态，THE Credit_Manager SHALL 在 200ms 内返回响应。
3. THE Credit_Manager SHALL 仅允许已认证用户查询自身的额度状态，不允许查询其他用户的数据。

---

### 需求 8：额度操作幂等性与并发安全

**用户故事：** 作为系统，我希望额度扣除和注入操作在并发场景下保持数据一致性，以便避免超额消耗或重复注入。

#### 验收标准

1. WHEN 多个构建请求并发到达同一用户，THE Credit_Manager SHALL 通过数据库行级锁或乐观锁保证 Wallet 和 Pool 余额不出现负值。
2. WHEN Quota_Scheduler 触发周期注入，THE Quota_Scheduler SHALL 通过幂等键（idempotency key）保证同一周期内同一用户的注入操作不重复执行。
3. IF 额度扣除操作因并发冲突失败，THEN THE Credit_Manager SHALL 返回错误码 `CONCURRENT_CONFLICT` 并建议客户端重试。
