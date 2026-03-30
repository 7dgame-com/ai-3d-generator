import axios from 'axios';
import FormData from 'form-data';
import {
  IProviderAdapter,
  CreateTaskInput,
  CreateTaskOutput,
  TaskStatusOutput,
  ProviderBalance,
} from './IProviderAdapter';

const HYPER3D_API_BASE = 'https://hyper3d.ai/api/v0';

export class Hyper3DAdapter implements IProviderAdapter {
  readonly providerId = 'hyper3d';

  validateApiKeyFormat(apiKey: string): boolean {
    return typeof apiKey === 'string' && apiKey.length > 0;
  }

  async verifyApiKey(apiKey: string): Promise<void> {
    try {
      await axios.get(`${HYPER3D_API_BASE}/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      });
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          throw Object.assign(new Error('API Key 无效或无权限'), { code: 4001, status: 422 });
        }
        throw Object.assign(new Error('AI 服务暂时不可用'), { code: 3002, status: 502, detail: err.message });
      }
      throw Object.assign(new Error('AI 服务暂时不可用'), { code: 3002, status: 502, detail: String(err) });
    }
  }

  async createTask(apiKey: string, input: CreateTaskInput): Promise<CreateTaskOutput> {
    const { type, prompt, imageBase64, mimeType } = input;

    let resp: { data: { uuid?: string; task_uuid?: string } };

    if (type === 'text_to_model') {
      resp = await axios.post(
        `${HYPER3D_API_BASE}/rodin`,
        { prompt },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
    } else {
      // image_to_model: use multipart/form-data
      const form = new FormData();
      if (imageBase64) {
        const buffer = Buffer.from(imageBase64, 'base64');
        form.append('images', buffer, {
          filename: 'image',
          contentType: mimeType ?? 'image/png',
        });
      }
      if (prompt) {
        form.append('prompt', prompt);
      }

      resp = await axios.post(`${HYPER3D_API_BASE}/rodin`, form, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...form.getHeaders(),
        },
        timeout: 30000,
      });
    }

    const taskId: string = resp.data?.uuid ?? resp.data?.task_uuid ?? '';
    if (!taskId) {
      throw new Error('Hyper3D API 未返回任务 ID');
    }

    return { taskId, estimatedCost: 30 };
  }

  async getTaskStatus(apiKey: string, taskId: string): Promise<TaskStatusOutput> {
    const resp = await axios.post(
      `${HYPER3D_API_BASE}/rodin/status`,
      { task_uuids: [taskId] },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    // Response is an array or object keyed by taskId
    const list: Array<{ task_uuid: string; status: string; progress?: number; output_url?: string }> =
      Array.isArray(resp.data) ? resp.data : resp.data?.list ?? resp.data?.jobs ?? [];

    const taskData = list.find((t) => t.task_uuid === taskId) ?? list[0];

    if (!taskData) {
      throw new Error('Hyper3D API 返回数据为空');
    }

    const rawStatus = taskData.status?.toLowerCase();
    let status: TaskStatusOutput['status'];
    if (rawStatus === 'done' || rawStatus === 'success' || rawStatus === 'succeeded') {
      status = 'success';
    } else if (rawStatus === 'failed' || rawStatus === 'error') {
      status = 'failed';
    } else if (rawStatus === 'processing' || rawStatus === 'running' || rawStatus === 'generating') {
      status = 'processing';
    } else {
      status = 'queued';
    }

    return {
      status,
      progress: taskData.progress ?? 0,
      outputUrl: taskData.output_url,
      errorMessage: status === 'failed' ? '任务生成失败' : undefined,
    };
  }

  async getBalance(apiKey: string): Promise<ProviderBalance> {
    const resp = await axios.get(`${HYPER3D_API_BASE}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });

    const data = resp.data?.data ?? resp.data;
    return {
      available: Number(data?.balance ?? data?.available ?? 0),
      frozen: Number(data?.frozen ?? 0),
    };
  }
}

export const hyper3dAdapter = new Hyper3DAdapter();
