import axios from 'axios'
import type { AxiosError, InternalAxiosRequestConfig } from 'axios'
import {
  getToken,
  setToken,
  removeAllTokens,
  isInIframe,
  requestParentTokenRefresh
} from '../utils/token'

/**
 * 插件业务 API（指向插件后端 /api）
 */
export const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

/**
 * 主后端 API（指向主后端 /v1，用于权限、COS、文件、Meta 等）
 */
export const mainApi = axios.create({
  baseURL: '/v1',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

// --- Token refresh state (shared across both instances) ---
let isRefreshing = false
let failedQueue: Array<{
  resolve: (token: string) => void
  reject: (error: Error) => void
}> = []

function processQueue(error: Error | null, token: string | null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error || !token) {
      reject(error ?? new Error('Token refresh failed'))
    } else {
      resolve(token)
    }
  })
  failedQueue = []
}

/**
 * 为 axios 实例添加请求/响应拦截器
 */
function setupInterceptors(instance: ReturnType<typeof axios.create>) {
  // 请求拦截器：注入 Authorization header
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = getToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })

  // 响应拦截器：处理 401 自动刷新 token 并重试
  instance.interceptors.response.use(
    (res: import('axios').AxiosResponse) => res,
    async (err: AxiosError) => {
      const originalRequest = err.config as InternalAxiosRequestConfig & {
        _retry?: boolean
      }

      if (err.response?.status !== 401 || !originalRequest || originalRequest._retry) {
        return Promise.reject(err)
      }

      if (isRefreshing) {
        // 已有刷新在进行中，排队等待
        return new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then((newToken) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          originalRequest._retry = true
          return instance(originalRequest)
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        let result: { accessToken: string } | null = null

        if (isInIframe()) {
          result = await requestParentTokenRefresh()
        }

        if (!result || !result.accessToken) {
          throw new Error('Token refresh failed')
        }

        setToken(result.accessToken)
        processQueue(null, result.accessToken)

        originalRequest.headers.Authorization = `Bearer ${result.accessToken}`
        return instance(originalRequest)
      } catch (refreshError) {
        removeAllTokens()

        if (isInIframe()) {
          window.parent.postMessage({ type: 'TOKEN_EXPIRED' }, '*')
        }

        processQueue(
          refreshError instanceof Error
            ? refreshError
            : new Error('Token refresh failed'),
          null
        )

        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }
  )
}

setupInterceptors(api)
setupInterceptors(mainApi)

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export type TaskStatus = 'queued' | 'processing' | 'success' | 'failed' | 'timeout'

export interface Task {
  id: number
  taskId: string
  userId: number
  type: 'text_to_model' | 'image_to_model'
  prompt: string | null
  status: TaskStatus
  progress: number
  creditCost: number
  outputUrl: string | null
  metaId: number | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

export interface CreateTextTaskParams {
  type: 'text_to_model'
  prompt: string
  provider_id?: string
}

export interface CreateImageTaskParams {
  type: 'image_to_model'
  imageBase64: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  provider_id?: string
}

export interface TaskListResponse {
  data: Task[]
  total: number
  page: number
  pageSize: number
}

export interface AdminConfig {
  apiKeyMasked: string | null
  configured: boolean
}

export interface AdminUsage {
  totalCredits: number
  userRanking: Array<{ userId: number; username: string; credits: number }>
  dailyTrend: Array<{ date: string; credits: number }>
}

export interface UsageSummary {
  totalCredits: number
  monthCredits: number
  taskCount: number
  dailyTrend: Array<{ date: string; credits: number }>
}

export interface UsageHistoryItem {
  taskId: string
  type: 'text_to_model' | 'image_to_model'
  prompt: string | null
  creditsUsed: number
  createdAt: string
  status: TaskStatus
}

export interface UsageHistoryResponse {
  data: UsageHistoryItem[]
  total: number
}

// ─── 任务 API ────────────────────────────────────────────────────────────────

export const createTask = (params: CreateTextTaskParams | CreateImageTaskParams) =>
  api.post<Task>('/tasks', params)

export const listTasks = (query?: { page?: number; pageSize?: number }) =>
  api.get<TaskListResponse>('/tasks', { params: query })

export const getTask = (taskId: string) =>
  api.get<Task>(`/tasks/${taskId}`)

export const getDownloadUrl = (taskId: string) =>
  api.get<{ url: string }>(`/tasks/${taskId}/download-url`)

export const updateTaskMeta = (taskId: string, metaId: number) =>
  api.put<Task>(`/tasks/${taskId}/meta`, { metaId })

// ─── 管理员 API ──────────────────────────────────────────────────────────────

export const getAdminConfig = (provider_id?: string) =>
  api.get<AdminConfig>('/admin/config', { params: provider_id ? { provider_id } : undefined })

export const getAdminBalance = (provider_id?: string) =>
  api.get<{ configured: boolean; available?: number; frozen?: number }>('/admin/balance', { params: provider_id ? { provider_id } : undefined })

export const saveAdminConfig = (apiKey: string, provider_id?: string) =>
  api.put<{ success: boolean }>('/admin/config', { apiKey, ...(provider_id ? { provider_id } : {}) })

export const getEnabledProviders = () =>
  api.get<{ providers: string[] }>('/admin/providers')

export const getAdminUsage = () =>
  api.get<AdminUsage>('/admin/usage')// ─── 用量 API ────────────────────────────────────────────────────────────────

export const getUsageSummary = () =>
  api.get<UsageSummary>('/usage')

export const verifyToken = () =>
  mainApi.get<{ roles: string[]; username: string; id: number }>('/plugin/verify-token', {
    params: { plugin_name: 'ai-3d-generator' }
  })

export const getUsageHistory = (params?: {
  startDate?: string
  endDate?: string
  type?: 'text_to_model' | 'image_to_model'
  page?: number
  pageSize?: number
}) => api.get<UsageHistoryResponse>('/usage/history', { params })

// ─── 下载 API ────────────────────────────────────────────────────────────────

export const getDownloadProxyUrl = (taskId: string, format: 'glb' | 'fbx' | 'obj' = 'glb') =>
  `/api/download/${taskId}?format=${format}`

export default api
