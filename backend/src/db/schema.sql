-- AI 3D Generator Plugin Database Schema
-- Database: ai_3d_generator

CREATE TABLE tasks (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id       VARCHAR(64) NOT NULL UNIQUE COMMENT 'Tripo3D 任务 ID',
  user_id       INT UNSIGNED NOT NULL COMMENT '主系统用户 ID',
  type          ENUM('text_to_model', 'image_to_model') NOT NULL,
  prompt        TEXT COMMENT '文本提示词（image-to-3D 时为空）',
  status        ENUM('queued', 'processing', 'success', 'failed', 'timeout') NOT NULL DEFAULT 'queued',
  progress      TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '进度 0-100',
  credit_cost   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '实际消耗 credits',
  output_url    VARCHAR(512) COMMENT 'Tripo3D 输出 GLB URL',
  meta_id       INT UNSIGNED COMMENT '主系统 Meta 资产 ID（上传后填写）',
  error_message VARCHAR(512) COMMENT '失败原因',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  DATETIME COMMENT '完成时间',
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE credit_usage (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      INT UNSIGNED NOT NULL,
  task_id      VARCHAR(64) NOT NULL COMMENT 'Tripo3D 任务 ID',
  credits_used INT UNSIGNED NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE system_config (
  `key`       VARCHAR(64) NOT NULL PRIMARY KEY,
  `value`     TEXT NOT NULL COMMENT 'AES-256-GCM 加密存储',
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Credit Quota Management Tables

CREATE TABLE user_accounts (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          INT UNSIGNED NOT NULL UNIQUE COMMENT '主系统用户 ID',

  wallet_balance             DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Wallet 余额',
  pool_balance               DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Pool 余额',

  pool_baseline              DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '充值时的 pool_amount，节流基准线',
  wallet_injection_per_cycle DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '每周期注入额度 = wallet_amount × cycle_duration / total_duration',
  cycles_remaining           INT UNSIGNED  NOT NULL DEFAULT 0   COMMENT '剩余周期数，每次注入后递减，归零后停止注入',
  cycle_duration             INT UNSIGNED  NOT NULL DEFAULT 1440 COMMENT '周期时长（分钟）',
  total_duration             INT UNSIGNED  NOT NULL DEFAULT 1440 COMMENT '总使用时长（分钟）',

  cycle_started_at DATETIME     COMMENT '当前周期开始时间',
  next_cycle_at    DATETIME     COMMENT '下一个周期开始时间',

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_next_cycle (next_cycle_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE credit_ledger (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  event_type  ENUM(
    'recharge',
    'inject',
    'settle',
    'pre_deduct',
    'refund',
    'confirm_deduct'
  ) NOT NULL,
  wallet_delta    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pool_delta      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  task_id         VARCHAR(64)   COMMENT '关联任务 ID（pre_deduct/refund/confirm_deduct 时填写）',
  idempotency_key VARCHAR(128)  COMMENT '幂等键（inject/settle 时填写）',
  note            VARCHAR(256),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_user_id (user_id),
  INDEX idx_task_id (task_id),
  UNIQUE KEY uk_idempotency (idempotency_key),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE quota_jobs (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  job_type      ENUM('inject', 'settle') NOT NULL,
  cycle_key     VARCHAR(64) NOT NULL COMMENT 'user_id:cycle_start_at，幂等键',
  status        ENUM('pending', 'done', 'failed') NOT NULL DEFAULT 'pending',
  executed_at   DATETIME,
  error_message VARCHAR(256),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_cycle_key (cycle_key),
  INDEX idx_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
