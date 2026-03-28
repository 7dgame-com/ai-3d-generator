import { Request, Response } from 'express';
import axios from 'axios';
import { query } from '../db/connection';
import { decrypt } from '../services/crypto';
import { addTaskToPoller } from '../services/taskPoller';
import { AuthenticatedRequest } from '../middleware/auth';

const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';

async function getApiKey(): Promise<string> {
  const rows = await query<Array<{ value: string }>>(
    "SELECT `value` FROM system_config WHERE `key` = 'tripo3d_api_key' LIMIT 1"
  );
  if (!rows || rows.length === 0) {
    throw Object.assign(new Error('API Key 未配置'), { code: 3001, status: 503 });
  }
  return decrypt(rows[0].value);
}

export async function createTask(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.userId;
  const { type, prompt, imageBase64, mimeType } = req.body as {
    type?: string; prompt?: string; imageBase64?: string; mimeType?: string;
  };

  if (!type || !['text_to_model', 'image_to_model'].includes(type)) {
    res.status(422).json({ code: 4001, message: '参数错误', errors: ['type 无效'] });
    return;
  }
  if (type === 'text_to_model') {
    if (!prompt || typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 500) {
      res.status(422).json({ code: 4001, message: '参数错误', errors: ['prompt 长度须在 1-500 字符之间'] });
      return;
    }
  }
  if (type === 'image_to_model' && (!imageBase64 || !mimeType)) {
    res.status(422).json({ code: 4001, message: '参数错误', errors: ['imageBase64 和 mimeType 不能为空'] });
    return;
  }

  let apiKey: string;
  try {
    apiKey = await getApiKey();
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    res.status(e.status ?? 503).json({ code: e.code ?? 3001, message: e.message ?? 'API Key 未配置' });
    return;
  }

  let tripoTaskId: string;
  try {
    let requestBody: Record<string, unknown>;
    if (type === 'text_to_model') {
      requestBody = { type: 'text_to_model', model_version: 'v2.0-20240919', prompt };
    } else {
      const uploadResp = await axios.post(
        `${TRIPO_API_BASE}/upload`,
        { file: { type: mimeType, data: imageBase64 } },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
      );
      const imageToken: string = uploadResp.data?.data?.image_token;
      requestBody = { type: 'image_to_model', model_version: 'v2.0-20240919', file: { type: mimeType, file_token: imageToken } };
    }
    const tripoResp = await axios.post(`${TRIPO_API_BASE}/task`, requestBody, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    if (tripoResp.data?.code !== 0) throw new Error(tripoResp.data?.message ?? 'Tripo3D API 返回错误');
    tripoTaskId = tripoResp.data.data.task_id as string;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      res.status(502).json({ code: 3002, message: 'AI 服务暂时不可用', detail: err.message });
    } else {
      res.status(502).json({ code: 3002, message: 'AI 服务暂时不可用', detail: String(err) });
    }
    return;
  }

  try {
    await query(
      "INSERT INTO tasks (task_id, user_id, type, prompt, status, progress) VALUES (?, ?, ?, ?, 'queued', 0)",
      [tripoTaskId, userId, type, prompt ?? null]
    );
  } catch (err) {
    console.error('[TaskController] DB insert error:', err);
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
    return;
  }

  addTaskToPoller(tripoTaskId);
  res.status(201).json({ taskId: tripoTaskId, status: 'queued' });
}

export async function listTasks(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.userId;
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
  const offset = (page - 1) * pageSize;
  try {
    const rows = await query<Array<Record<string, unknown>>>(
      'SELECT task_id, type, prompt, status, progress, credit_cost, output_url, meta_id, error_message, created_at, completed_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [userId, pageSize, offset]
    );
    const countRows = await query<Array<{ total: number }>>('SELECT COUNT(*) AS total FROM tasks WHERE user_id = ?', [userId]);
    res.json({ tasks: rows, total: Number(countRows[0]?.total ?? 0), page, pageSize });
  } catch (err) {
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

export async function getTask(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.userId;
  const { taskId } = req.params;
  try {
    const rows = await query<Array<Record<string, unknown>>>(
      'SELECT task_id, type, prompt, status, progress, credit_cost, output_url, meta_id, error_message, created_at, completed_at FROM tasks WHERE task_id = ? AND user_id = ? LIMIT 1',
      [taskId, userId]
    );
    if (!rows || rows.length === 0) { res.status(404).json({ code: 4004, message: '任务不存在' }); return; }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

export async function getDownloadUrl(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.userId;
  const { taskId } = req.params;
  try {
    const rows = await query<Array<{ output_url: string | null }>>(
      'SELECT output_url FROM tasks WHERE task_id = ? AND user_id = ? LIMIT 1',
      [taskId, userId]
    );
    if (!rows || rows.length === 0) { res.status(404).json({ code: 4004, message: '任务不存在' }); return; }
    const outputUrl = rows[0].output_url;
    if (!outputUrl) { res.status(422).json({ code: 4001, message: '任务尚未完成或无输出文件' }); return; }
    res.json({ url: outputUrl });
  } catch (err) {
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}

export async function updateTaskMeta(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.userId;
  const { taskId } = req.params;
  const { metaId } = req.body as { metaId?: number };
  if (!metaId || typeof metaId !== 'number') {
    res.status(422).json({ code: 4001, message: '参数错误', errors: ['metaId 不能为空'] });
    return;
  }
  try {
    const result = await query<{ affectedRows: number }>(
      'UPDATE tasks SET meta_id = ? WHERE task_id = ? AND user_id = ?',
      [metaId, taskId, userId]
    );
    if (result.affectedRows === 0) { res.status(404).json({ code: 4004, message: '任务不存在' }); return; }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ code: 5001, message: '服务器内部错误' });
  }
}
