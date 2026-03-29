import { ref, readonly } from 'vue'
import axios, { AxiosInstance } from 'axios'
import { getToken } from '../utils/token'

/**
 * 权限检查组合式函数
 * Permissions Check Composable
 *
 * 功能特性 / Features:
 * - 调用主后端 Plugin Auth API 检查权限 / Call main backend Plugin Auth API to check permissions
 * - 支持单个权限检查 / Support single permission check
 * - 支持批量获取允许的操作 / Support batch fetching of allowed actions
 * - 权限结果缓存 / Cache permission results
 * - 自动处理认证错误 / Auto-handle authentication errors
 *
 * API 参考 / API Reference:
 * - GET /v1/plugin/check-permission - 检查单个权限 / Check single permission
 * - GET /v1/plugin/allowed-actions - 批量获取允许的操作 / Batch get allowed actions
 *
 * 详见 / See: web/docs/plugin-auth-api-reference.md
 *
 * 插件权限列表 / Plugin permissions:
 * - generate-model: 生成 3D 模型
 * - download-model: 下载 3D 模型
 * - upload-to-main: 上传到主系统
 * - view-usage: 查看用量统计
 * - admin-config: 管理员配置
 */

// 插件标识 - 需要与主系统中注册的插件名称一致
// Plugin identifier - must match the plugin name registered in the main system
const PLUGIN_NAME = 'ai-3d-generator'

// 主后端 API 通过 nginx 反向代理访问，使用相对路径
// Main backend API is accessed via nginx reverse proxy, use relative path
const mainApi: AxiosInstance = axios.create({
  baseURL: '/v1/plugin',
  timeout: 5000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 请求拦截器：添加 JWT Token
// Request interceptor: Add JWT token
mainApi.interceptors.request.use(
  (config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

/**
 * 权限缓存
 * Permission cache
 */
const permissionCache = ref<Record<string, boolean>>({})

/**
 * 允许的操作列表缓存
 * Allowed actions list cache
 */
const allowedActions = ref<string[]>([])

/**
 * 是否已加载权限
 * Whether permissions have been loaded
 */
const loaded = ref(false)

/**
 * 是否正在加载权限
 * Whether permissions are being loaded
 */
const loading = ref(false)

/**
 * 权限检查组合式函数
 * Permissions check composable function
 */
export function usePermissions() {
  /**
   * 检查单个权限
   * Check single permission
   *
   * @param action 操作标识 / Action identifier
   *   e.g., 'generate-model', 'download-model', 'upload-to-main', 'view-usage', 'admin-config'
   * @returns Promise<boolean> 是否有权限 / Whether has permission
   */
  async function checkPermission(action: string): Promise<boolean> {
    // 如果缓存中已有结果，直接返回
    // If result exists in cache, return directly
    if (action in permissionCache.value) {
      return permissionCache.value[action]
    }

    try {
      const response = await mainApi.get('/check-permission', {
        params: {
          plugin_name: PLUGIN_NAME,
          action: action
        }
      })

      if (response.data.code === 0 && response.data.data) {
        const allowed = response.data.data.allowed === true
        permissionCache.value[action] = allowed
        return allowed
      }

      permissionCache.value[action] = false
      return false
    } catch (error) {
      console.error(`[usePermissions] Failed to check permission for action: ${action}`, error)
      permissionCache.value[action] = false
      return false
    }
  }

  /**
   * 批量获取允许的操作列表
   * Batch fetch allowed actions list
   *
   * 调用主后端的 /v1/plugin/allowed-actions?plugin_name=ai-3d-generator
   * Call main backend's /v1/plugin/allowed-actions API
   *
   * @returns Promise<string[]> 允许的操作列表 / List of allowed actions
   */
  async function fetchAllowedActions(): Promise<string[]> {
    if (loaded.value || loading.value) {
      return allowedActions.value
    }

    loading.value = true

    try {
      const response = await mainApi.get('/allowed-actions', {
        params: {
          plugin_name: PLUGIN_NAME
        }
      })

      if (response.data.code === 0 && response.data.data && Array.isArray(response.data.data.actions)) {
        const actions = response.data.data.actions
        allowedActions.value = actions

        permissionCache.value = {}
        actions.forEach((action: string) => {
          permissionCache.value[action] = true
        })

        loaded.value = true
        return actions
      }

      console.error('[usePermissions] Invalid response format from allowed-actions API')
      allowedActions.value = []
      loaded.value = true
      return []
    } catch (error) {
      console.error('[usePermissions] Failed to fetch allowed actions', error)
      allowedActions.value = []
      loaded.value = true
      return []
    } finally {
      loading.value = false
    }
  }

  /**
   * 检查是否有指定权限（基于缓存）
   * Check if has specified permission (based on cache)
   *
   * 注意：使用此方法前需要先调用 fetchAllowedActions()
   *
   * @param action 操作标识 / Action identifier
   * @returns boolean 是否有权限 / Whether has permission
   */
  function can(action: string): boolean {
    return permissionCache.value[action] === true
  }

  /**
   * 检查是否有任意权限
   * Check if has any permission
   *
   * @returns boolean 是否有任意权限 / Whether has any permission
   */
  function hasAny(): boolean {
    return allowedActions.value.length > 0
  }

  /**
   * 清除权限缓存
   * Clear permission cache
   */
  function clearCache(): void {
    permissionCache.value = {}
    allowedActions.value = []
    loaded.value = false
    loading.value = false
  }

  /**
   * 重新加载权限
   * Reload permissions
   */
  async function reloadPermissions(): Promise<string[]> {
    clearCache()
    return await fetchAllowedActions()
  }

  return {
    // 状态 / State
    permissions: readonly(permissionCache),
    allowedActions: readonly(allowedActions),
    loaded: readonly(loaded),
    loading: readonly(loading),

    // 方法 / Methods
    checkPermission,
    fetchAllowedActions,
    can,
    hasAny,
    clearCache,
    reloadPermissions
  }
}
