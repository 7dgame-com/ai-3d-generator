/**
 * 认证中间件
 *
 * 从请求头提取 Bearer token，调用主后端 GET /v1/plugin/verify-token 验证。
 * 验证成功后将用户信息注入到 req.user，供后续路由使用。
 * 验证失败返回 { code: 1001, message: "Token 无效或已过期" }（HTTP 401）。
 *
 * 使用示例：
 *   import { auth } from './middleware/auth';
 *   router.get('/api/tasks', auth, (req, res) => {
 *     const userId = (req as AuthenticatedRequest).user.userId;
 *   });
 */

import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

const MAIN_API_URL = process.env.MAIN_API_URL || 'http://localhost:8081';

/**
 * 注入到 req.user 的用户信息
 */
export interface UserInfo {
  userId: number;
  username?: string;
  [key: string]: unknown;
}

/**
 * 扩展 Express Request，包含 user 属性
 */
export interface AuthenticatedRequest extends Request {
  user: UserInfo;
}

/**
 * Express 中间件：验证 Bearer token
 */
export async function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ code: 1001, message: 'Token 无效或已过期' });
    return;
  }

  const token = header.slice(7); // Remove "Bearer " prefix

  try {
    const response = await axios.get(`${MAIN_API_URL}/v1/plugin/verify-token`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 5000,
    });

    // Main backend returns user info on success
    const data = response.data;
    const rawUserId = data?.data?.user_id ?? data?.data?.id ?? data?.user_id ?? data?.id;
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(401).json({ code: 1001, message: 'Token 无效或已过期' });
      return;
    }
    console.log('[AuthMiddleware] resolved userId:', userId);

    (req as AuthenticatedRequest).user = {
      userId,
      username: data?.data?.username ?? data?.username,
      ...data?.data,
    };

    next();
  } catch (err) {
    // Network errors or 401/403 from main backend
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        res.status(401).json({ code: 1001, message: 'Token 无效或已过期' });
        return;
      }
      // Network error or timeout
      console.error('[AuthMiddleware] 调用 verify-token 失败:', err.message, err.response?.status, JSON.stringify(err.response?.data));
    } else {
      console.error('[AuthMiddleware] 未知错误:', String(err));
    }
    res.status(401).json({ code: 1001, message: 'Token 无效或已过期' });
  }
}
