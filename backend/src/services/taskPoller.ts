/**
 * TaskPoller — 后台轮询 Tripo3D 任务状态
 *
 * - 启动时查询所有 status IN ('queued', 'processing') 的任务，加入轮询队列
 * - 每 3 秒调用 Tripo3D GET /task/{task_id} 查询状态
 * - 状态变为 success：更新 tasks 表，写入 credit_usage 表
 * - 状态变为 failed：更新 tasks 表（status、error_message）
 * - 连续 3 次查询失败：标记任务为 failed，error_message 记录"轮询失败"
 * - 轮询超过 10 分钟：标记任务为 timeout
 */

import { query } from '../db/connection';
import { decrypt } from './crypto';

const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 600000; // 10 minutes
const MAX_CONSECUTIVE_FAILURES = 3;

// Track active polling tasks to avoid duplicate polling
const activePollers = new Set<string>();

/**
 * Retrieve the Tripo3D API key from system_config (decrypted).
 */
async function getApiKey(): Promise<string> {
  const rows = await query<Array<{ value: string }>>(
    "SELECT `value` FROM system_config WHERE `key` = 'tripo3d_api_key' LIMIT 1"
  );
  if (!rows || rows.length === 0) {
    throw new Error('Tripo3D API Key 未配置');
  }
  return decrypt(rows[0].value);
}

/**
 * Mark a task as failed in the database.
 */
async function markTaskFailed(taskId: string, errorMessage: string): Promise<void> {
  await query(
    "UPDATE tasks SET status = 'failed', error_message = ?, completed_at = NOW() WHERE task_id = ?",
    [errorMessage, taskId]
  );
}

/**
 * Mark a task as timed out in the database.
 */
async function markTaskTimeout(taskId: string): Promise<void> {
  await query(
    "UPDATE tasks SET status = 'timeout', error_message = '生成超时', completed_at = NOW() WHERE task_id = ?",
    [taskId]
  );
}

/**
 * Handle a successful Tripo3D response: update tasks table and insert credit_usage record.
 */
async function handleSuccess(
  taskId: string,
  outputUrl: string,
  creditCost: number
): Promise<void> {
  // Get user_id for credit_usage insert
  const taskRows = await query<Array<{ user_id: number }>>(
    'SELECT user_id FROM tasks WHERE task_id = ? LIMIT 1',
    [taskId]
  );

  await query(
    `UPDATE tasks
     SET status = 'success', output_url = ?, credit_cost = ?, completed_at = NOW()
     WHERE task_id = ?`,
    [outputUrl, creditCost, taskId]
  );

  if (taskRows && taskRows.length > 0) {
    const userId = taskRows[0].user_id;
    await query(
      'INSERT INTO credit_usage (user_id, task_id, credits_used) VALUES (?, ?, ?)',
      [userId, taskId, creditCost]
    );
  }
}

/**
 * Recursive polling function for a single task.
 *
 * @param taskId       - Tripo3D task ID
 * @param startTime    - timestamp when polling started (for timeout detection)
 * @param failureCount - consecutive API call failures so far
 */
async function pollTask(
  taskId: string,
  startTime: number,
  failureCount: number
): Promise<void> {
  // Timeout check
  if (Date.now() - startTime > TIMEOUT_MS) {
    console.log(`[TaskPoller] 任务 ${taskId} 轮询超时，标记为 timeout`);
    activePollers.delete(taskId);
    await markTaskTimeout(taskId);
    return;
  }

  let apiKey: string;
  try {
    apiKey = await getApiKey();
  } catch (err) {
    console.error(`[TaskPoller] 获取 API Key 失败:`, (err as Error).message);
    // Treat as a failure
    const newFailureCount = failureCount + 1;
    if (newFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      activePollers.delete(taskId);
      await markTaskFailed(taskId, '轮询失败');
      return;
    }
    setTimeout(() => pollTask(taskId, startTime, newFailureCount), POLL_INTERVAL_MS);
    return;
  }

  let responseData: {
    code: number;
    data?: {
      task_id: string;
      status: string;
      progress?: number;
      output?: { model?: string; pbr_model?: string };
      result?: { credit_cost?: number };
    };
  };

  try {
    const response = await fetch(`${TRIPO_API_BASE}/task/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    responseData = (await response.json()) as typeof responseData;
  } catch (err) {
    const newFailureCount = failureCount + 1;
    console.warn(
      `[TaskPoller] 任务 ${taskId} 查询失败 (${newFailureCount}/${MAX_CONSECUTIVE_FAILURES}):`,
      (err as Error).message
    );

    if (newFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`[TaskPoller] 任务 ${taskId} 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，标记为 failed`);
      activePollers.delete(taskId);
      await markTaskFailed(taskId, '轮询失败');
      return;
    }

    setTimeout(() => pollTask(taskId, startTime, newFailureCount), POLL_INTERVAL_MS);
    return;
  }

  const taskData = responseData.data;
  if (!taskData) {
    // Treat unexpected response as a failure
    const newFailureCount = failureCount + 1;
    if (newFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      activePollers.delete(taskId);
      await markTaskFailed(taskId, '轮询失败');
      return;
    }
    setTimeout(() => pollTask(taskId, startTime, newFailureCount), POLL_INTERVAL_MS);
    return;
  }

  const status = taskData.status;

  if (status === 'success') {
    const outputUrl = taskData.output?.model ?? '';
    const creditCost = taskData.result?.credit_cost ?? 30;
    console.log(`[TaskPoller] 任务 ${taskId} 生成成功，output_url: ${outputUrl}, credits: ${creditCost}`);
    activePollers.delete(taskId);
    await handleSuccess(taskId, outputUrl, creditCost);
    return;
  }

  if (status === 'failed') {
    const errorMessage = '任务生成失败';
    console.log(`[TaskPoller] 任务 ${taskId} 生成失败`);
    activePollers.delete(taskId);
    await markTaskFailed(taskId, errorMessage);
    return;
  }

  // status is 'queued' or 'processing' — update progress if available, then schedule next poll
  if (taskData.progress !== undefined) {
    await query('UPDATE tasks SET progress = ? WHERE task_id = ?', [taskData.progress, taskId]);
  }

  if (status === 'processing') {
    await query("UPDATE tasks SET status = 'processing' WHERE task_id = ? AND status = 'queued'", [taskId]);
  }

  // Schedule next poll (reset failure count on success)
  setTimeout(() => pollTask(taskId, startTime, 0), POLL_INTERVAL_MS);
}

/**
 * Add a single task to the polling queue.
 * Safe to call multiple times — duplicate task IDs are ignored.
 */
export function addTaskToPoller(taskId: string): void {
  if (activePollers.has(taskId)) {
    return;
  }
  activePollers.add(taskId);
  console.log(`[TaskPoller] 开始轮询任务: ${taskId}`);
  setTimeout(() => pollTask(taskId, Date.now(), 0), POLL_INTERVAL_MS);
}

/**
 * Start the poller on application startup.
 * Queries all tasks with status IN ('queued', 'processing') and begins polling each.
 */
export async function startPoller(): Promise<void> {
  try {
    const pendingTasks = await query<Array<{ task_id: string }>>(
      "SELECT task_id FROM tasks WHERE status IN ('queued', 'processing')"
    );

    if (!pendingTasks || pendingTasks.length === 0) {
      console.log('[TaskPoller] 启动时无待处理任务');
      return;
    }

    console.log(`[TaskPoller] 启动时发现 ${pendingTasks.length} 个待处理任务，开始轮询`);
    for (const { task_id } of pendingTasks) {
      addTaskToPoller(task_id);
    }
  } catch (err) {
    console.error('[TaskPoller] 启动失败:', (err as Error).message);
  }
}
