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
import { startScheduler, stopScheduler } from './services/quotaScheduler';
import { parseEnabledProviders } from './config/providers';
import { providerRegistry } from './adapters/ProviderRegistry';
import { tripo3dAdapter } from './adapters/Tripo3DAdapter';
import { hyper3dAdapter } from './adapters/Hyper3DAdapter';
import adminRoutes from './routes/admin';
import taskRoutes from './routes/task';
import usageRoutes from './routes/usage';
import downloadRoutes from './routes/download';
import creditsRoutes from './routes/credits';

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
app.use('/api', creditsRoutes);

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

    // ========== 注册启用的 Provider 适配器 ==========
    const enabledProviders = parseEnabledProviders();
    const adapterMap: Record<string, typeof tripo3dAdapter | typeof hyper3dAdapter> = {
      tripo3d: tripo3dAdapter,
      hyper3d: hyper3dAdapter,
    };
    for (const providerId of enabledProviders) {
      const adapter = adapterMap[providerId];
      if (adapter) {
        providerRegistry.register(adapter);
        console.log(`[Server] 已注册 Provider 适配器: ${providerId}`);
      }
    }

    await startScheduler();
  } catch (err) {
    console.error('[Server] 关键服务启动失败，退出:', (err as Error).message);
    process.exit(1);
  }
});

// ========== 进程退出时清理 ==========
process.on('SIGTERM', () => {
  console.log('[Server] 收到 SIGTERM，正在关闭...');
  stopScheduler();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] 收到 SIGINT，正在关闭...');
  stopScheduler();
  process.exit(0);
});
