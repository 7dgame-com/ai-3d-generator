/**
 * AI 3D 模型生成插件 - 后端入口文件
 *
 * 配置 Express 应用，注册中间件和路由，启动 HTTP 服务器。
 */

import 'dotenv/config';

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { testConnection } from './db/connection';
import { startPoller } from './services/taskPoller';
import adminRoutes from './routes/admin';
import taskRoutes from './routes/task';
import usageRoutes from './routes/usage';
import downloadRoutes from './routes/download';

const app = express();
const PORT: string | number = process.env.PORT || 8087;

// ========== CORS 配置 ==========
app.use(
  cors({
    origin: [
      'http://localhost:3004', // 插件前端开发服务器
      'http://localhost:3001', // 主前端开发服务器
    ],
    credentials: true,
  })
);

// ========== 请求体解析 ==========
app.use(express.json({ limit: '50mb' }));

// ========== 健康检查 ==========
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ========== 路由注册 ==========
app.use('/api', adminRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/download', downloadRoutes);

// ========== 全局错误处理 ==========
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] 未处理的错误:', err.message);
  res.status(err.status || 500).json({
    code: 5001,
    message: err.message || '服务器内部错误',
  });
});

// ========== 启动服务器 ==========
app.listen(PORT, async () => {
  console.log(`[AI 3D Generator] API 服务已启动，端口: ${PORT}`);
  try {
    await testConnection();
    await startPoller();
  } catch (err) {
    console.error('[Server] 数据库连接失败:', (err as Error).message);
  }
});
