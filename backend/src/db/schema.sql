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
