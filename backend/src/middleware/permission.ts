/**
 * 权限中间件
 *
 * 接收 requiredPermission 参数，调用主后端 GET /v1/plugin/check-permission 验证。
 * 验证失败返回 { code: 2003, message: "没有权限执行此操作" }（HTTP 403）。
 *
 * 使用示例：
 *   import { requirePermission } from './middleware/permission';
 *   router.post('/api/tasks', auth, requirePermission('generate-model'), handler);
 */

import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { AuthenticatedRequest } from './auth';

const MAIN_API_URL = process.env.MAIN_API_URL || 'http://localhost:8081';

/**
 * 有效权限列表
 */
export type Permission =
  | 'generate-model'
  | 'download-model'
  | 'upload-to-main'
  | 'view-usage'
  | 'admin-config';

/**
 * 工厂函数：返回验证指定权限的 Express 中间件
 * 假设 auth 中间件已先运行（req.user 已注入）
 */
export function requirePermission(permission: Permission) {
  return async function permissionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      res.status(403).json({ code: 2003, message: '没有权限执行此操作' });
      return;
    }

    const token = header.slice(7);

    try {
      const response = await axios.get(`${MAIN_API_URL}/v1/plugin/check-permission`, {
        params: {
          plugin_name: 'ai-3d-generator',
          action: permission,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 5000,
      });

      // Main backend returns 200 with allowed: true when permission is granted
      const data = response.data;
      const allowed: boolean = data?.data?.allowed ?? data?.allowed ?? false;

      if (allowed) {
        next();
      } else {
        res.status(403).json({ code: 2003, message: '没有权限执行此操作' });
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 403 || status === 401) {
          res.status(403).json({ code: 2003, message: '没有权限执行此操作' });
          return;
        }
        console.error('[PermissionMiddleware] 调用 check-permission 失败:', err.message);
      } else {
        console.error('[PermissionMiddleware] 未知错误:', String(err));
      }
      // Network errors also result in 403 (fail closed)
      res.status(403).json({ code: 2003, message: '没有权限执行此操作' });
    }
  };
}
