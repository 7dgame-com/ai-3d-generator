/**
 * DownloadController
 *
 * GET /api/download/:taskId
 *   - 从 tasks 表获取 output_url
 *   - 代理请求 Tripo3D 文件流，以 {task_id}.{format} 命名返回给客户端
 *   - 支持 ?format=glb|fbx|obj 查询参数，默认 glb
 *
 * 需求：6.1、6.2、6.3
 */

import { Response } from 'express';
import axios from 'axios';
import { query } from '../db/connection';
import { AuthenticatedRequest } from '../middleware/auth';

type DownloadFormat = 'glb' | 'fbx' | 'obj';
const ALLOWED_FORMATS: DownloadFormat[] = ['glb', 'fbx', 'obj'];

interface TaskRow {
  task_id: string;
  status: string;
  output_url: string | null;
}

/**
 * GET /api/download/:taskId
 * 代理下载 Tripo3D 输出文件
 */
export async function downloadFile(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { taskId } = req.params;
  const userId = req.user.userId;

  // 解析 format 参数，默认 glb
  const rawFormat = (req.query.format as string) || 'glb';
  const format: DownloadFormat = ALLOWED_FORMATS.includes(rawFormat as DownloadFormat)
    ? (rawFormat as DownloadFormat)
    : 'glb';

  // 查询任务（限定当前用户）
  const rows = await query<TaskRow[]>(
    'SELECT task_id, status, output_url FROM tasks WHERE task_id = ? AND user_id = ?',
    [taskId, userId]
  );

  if (!rows || rows.length === 0) {
    res.status(404).json({ code: 4041, message: '任务不存在' });
    return;
  }

  const task = rows[0];

  if (task.status !== 'success') {
    res.status(400).json({ code: 4001, message: '任务尚未完成' });
    return;
  }

  if (!task.output_url) {
    res.status(404).json({ code: 4042, message: '输出文件不存在' });
    return;
  }

  // 代理文件流
  try {
    const upstream = await axios.get(task.output_url, {
      responseType: 'stream',
      timeout: 30000,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${task.task_id}.${format}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    // 透传 Content-Length（如果上游提供）
    const contentLength = upstream.headers['content-length'];
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    upstream.data.pipe(res);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error('[DownloadController] 代理请求失败:', err.message);
      res.status(502).json({ code: 3002, message: 'AI 服务暂时不可用', detail: err.message });
    } else {
      console.error('[DownloadController] 未知错误:', String(err));
      res.status(500).json({ code: 5001, message: '服务器内部错误' });
    }
  }
}
