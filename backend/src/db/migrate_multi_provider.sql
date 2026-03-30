-- =============================================================================
-- 数据迁移脚本：多服务商积分管理（Multi-Provider Credits）
-- 目标：为 user_accounts、credit_ledger、quota_jobs、tasks 四张表添加 provider_id 字段
-- 迁移策略：幂等操作，可重复执行（通过 IF NOT EXISTS / IF EXISTS 判断）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. user_accounts 表
--    - 添加 provider_id 字段（默认 'tripo3d'）
--    - 将现有行设为 'tripo3d'
--    - 删除原 UNIQUE KEY (user_id)，重建为复合唯一键 (user_id, provider_id)
-- -----------------------------------------------------------------------------

-- 1.1 添加 provider_id 列（幂等：若列已存在则跳过）
ALTER TABLE user_accounts
  ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符，如 tripo3d、hyper3d'
    AFTER user_id;

-- 1.2 将现有行的 provider_id 设为 'tripo3d'
UPDATE user_accounts SET provider_id = 'tripo3d' WHERE provider_id = '';

-- 1.3 删除原 user_id 单列唯一键（幂等：若索引不存在则忽略错误）
ALTER TABLE user_accounts
  DROP INDEX IF EXISTS user_id;

-- 1.4 添加复合唯一键 (user_id, provider_id)（幂等：若已存在则跳过）
ALTER TABLE user_accounts
  ADD UNIQUE KEY IF NOT EXISTS uk_user_provider (user_id, provider_id);

-- 1.5 添加 provider_id 单列索引（供按提供商查询使用）
ALTER TABLE user_accounts
  ADD INDEX IF NOT EXISTS idx_provider (provider_id);

-- -----------------------------------------------------------------------------
-- 2. credit_ledger 表
--    - 添加 provider_id 字段（默认 'tripo3d'）
--    - 添加复合索引 (provider_id, user_id)
-- -----------------------------------------------------------------------------

-- 2.1 添加 provider_id 列（幂等：若列已存在则跳过）
ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符'
    AFTER user_id;

-- 2.2 添加复合索引（幂等：若已存在则跳过）
ALTER TABLE credit_ledger
  ADD INDEX IF NOT EXISTS idx_provider_user (provider_id, user_id);

-- -----------------------------------------------------------------------------
-- 3. quota_jobs 表
--    - 添加 provider_id 字段（默认 'tripo3d'）
--    - 添加复合索引 (provider_id, user_id, status)
-- -----------------------------------------------------------------------------

-- 3.1 添加 provider_id 列（幂等：若列已存在则跳过）
ALTER TABLE quota_jobs
  ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符'
    AFTER user_id;

-- 3.2 添加复合索引（幂等：若已存在则跳过）
ALTER TABLE quota_jobs
  ADD INDEX IF NOT EXISTS idx_provider_user_status (provider_id, user_id, status);

-- -----------------------------------------------------------------------------
-- 4. tasks 表
--    - 添加 provider_id 字段（默认 'tripo3d'）
--    - 添加 provider_id 索引
-- -----------------------------------------------------------------------------

-- 4.1 添加 provider_id 列（幂等：若列已存在则跳过）
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NOT NULL DEFAULT 'tripo3d'
    COMMENT '服务提供商标识符'
    AFTER user_id;

-- 4.2 添加索引（幂等：若已存在则跳过）
ALTER TABLE tasks
  ADD INDEX IF NOT EXISTS idx_provider_id (provider_id);

-- =============================================================================
-- 迁移完成
-- 验证查询（可选，用于确认迁移结果）：
--   SHOW COLUMNS FROM user_accounts LIKE 'provider_id';
--   SHOW INDEX FROM user_accounts WHERE Key_name = 'uk_user_provider';
--   SHOW COLUMNS FROM credit_ledger LIKE 'provider_id';
--   SHOW COLUMNS FROM quota_jobs LIKE 'provider_id';
--   SHOW COLUMNS FROM tasks LIKE 'provider_id';
-- =============================================================================
