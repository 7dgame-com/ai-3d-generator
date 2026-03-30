import axios from 'axios';
import {
  IProviderAdapter,
  CreateTaskInput,
  CreateTaskOutput,
  TaskStatusOutput,
  ProviderBalance,
} from './IProviderAdapter';

const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';

export class Tripo3DAdapter implements IProviderAdapter {
  readonly providerId = 'tripo3d';

  validateApiKeyFormat(apiKey: string): boolean {
    return typeof apiKey === 'string' && apiKey.length > 0;
  }

  async verifyApiKey(apiKey: string): Promise<void> {
    try {
      await axios.get(`${TRIPO_API_BASE}/user/balance`, {
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

    let requestBody: Record<string, unknown>;

    if (type === 'text_to_model') {
      requestBody = { type: 'text_to_model', model_version: 'v2.0-20240919', prompt };
    } else {
      // image_to_model: upload image first to get a file token
      const uploadResp = await axios.post(
        `${TRIPO_API_BASE}/upload`,
        { file: { type: mimeType, data: imageBase64 } },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
      );
      const imageToken: string = uploadResp.data?.data?.image_token;
      requestBody = {
        type: 'image_to_model',
        model_version: 'v2.0-20240919',
        file: { type: mimeType, file_token: imageToken },
      };
    }

    const resp = await axios.post(`${TRIPO_API_BASE}/task`, requestBody, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    if (resp.data?.code !== 0) {
      throw new Error(resp.data?.message ?? 'Tripo3D API 返回错误');
    }

    const taskId: string = resp.data.data.task_id;
    return { taskId, estimatedCost: 30 };
  }

  async getTaskStatus(apiKey: string, taskId: string): Promise<TaskStatusOutput> {
    const response = await fetch(`${TRIPO_API_BASE}/task/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const responseData = (await response.json()) as {
      code: number;
      data?: {
        task_id: string;
        status: string;
        progress?: number;
        output?: { model?: string; pbr_model?: string };
        result?: { credit_cost?: number };
      };
    };

    const taskData = responseData.data;
    if (!taskData) {
      throw new Error('Tripo3D API 返回数据为空');
    }

    const rawStatus = taskData.status;
    let status: TaskStatusOutput['status'];
    if (rawStatus === 'success') {
      status = 'success';
    } else if (rawStatus === 'failed') {
      status = 'failed';
    } else if (rawStatus === 'processing') {
      status = 'processing';
    } else {
      status = 'queued';
    }

    return {
      status,
      progress: taskData.progress ?? 0,
      creditCost: taskData.result?.credit_cost,
      outputUrl: taskData.output?.model,
      errorMessage: status === 'failed' ? '任务生成失败' : undefined,
    };
  }

  async getBalance(apiKey: string): Promise<ProviderBalance> {
    const resp = await axios.get(`${TRIPO_API_BASE}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });

    const data = resp.data?.data ?? resp.data;
    const balance = data?.balance ?? data;
    return {
      available: Number(balance?.available ?? balance?.balance ?? 0),
      frozen: Number(balance?.frozen ?? 0),
    };
  }
}

export const tripo3dAdapter = new Tripo3DAdapter();
