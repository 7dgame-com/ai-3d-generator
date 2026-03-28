# AI 3D 模型生成插件

基于 [Tripo3D](https://www.tripo3d.ai/) AI 服务的 3D 模型生成插件，支持文本描述和参考图片两种方式生成 3D 模型，并可直接上传至主系统资产库。

## 功能

- 文本生成 3D 模型（text-to-3D）
- 图片生成 3D 模型（image-to-3D）
- 实时任务进度轮询
- 下载生成结果（GLB / FBX / OBJ）
- 一键上传至主系统腾讯云 COS 资产库
- Credit 用量统计（用户维度 + 管理员全局视图）
- 多语言支持（简体中文 / English）
- 主题同步（跟随主系统深色/浅色主题）

## 认证方式

插件不提供独立登录，通过主系统的 Plugin Auth API 进行身份验证和权限控制：

- 用户在主系统登录后，主系统通过 postMessage 将 JWT Token 传递给插件
- 插件后端调用主后端 `/v1/plugin/verify-token` 验证用户身份
- 插件后端调用主后端 `/v1/plugin/check-permission` 检查操作权限

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + TypeScript + Element Plus + Vite |
| 后端 | Node.js + Express + TypeScript + MySQL |
| 文件上传 | 腾讯云 COS 直传（cos-js-sdk-v5） |
| AI 服务 | Tripo3D API v2 |

## 端口

| 服务 | 端口 |
|------|------|
| 前端 | http://localhost:3004 |
| 后端 API | http://localhost:8087/api |
| 数据库 | localhost:3307（独立 MySQL） |

## 开发启动

```bash
# 后端
cd backend
npm install
cp .env.example .env   # 填写 DB_* / MAIN_API_URL / CRYPTO_KEY
npm run dev

# 前端
cd frontend
npm install
npm run dev
```

## Docker 启动

```bash
# 确保主系统已运行（提供 Plugin Auth API）
cd driver && docker-compose up -d

# 启动插件（本地开发）
cd plugins/ai-3d-generator
docker-compose up -d
```

## 环境变量

后端 `backend/.env`（参考 `.env.example`）：

| 变量 | 说明 | 示例 |
|------|------|------|
| PORT | 后端监听端口 | 8087 |
| DB_HOST | MySQL 主机 | localhost |
| DB_PORT | MySQL 端口 | 3306 |
| DB_NAME | 数据库名 | ai_3d_generator |
| DB_USER | 数据库用户 | root |
| DB_PASSWORD | 数据库密码 | - |
| MAIN_API_URL | 主后端地址 | http://localhost:8081 |
| CRYPTO_KEY | AES-256-GCM 密钥（64位十六进制） | 生成命令见下 |

生成 CRYPTO_KEY：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 数据库初始化

```bash
# 首次启动后执行
docker exec -i <db-container> mysql -u root -p ai_3d_generator < backend/src/db/schema.sql
```

## API

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | /api/tasks | 创建生成任务 | generate-model |
| GET | /api/tasks | 任务列表 | generate-model |
| GET | /api/tasks/:taskId | 任务状态 | generate-model |
| GET | /api/tasks/:taskId/download-url | 获取下载 URL | download-model |
| PUT | /api/tasks/:taskId/meta | 更新 meta_id | upload-to-main |
| GET | /api/download/:taskId | 代理下载文件 | download-model |
| GET | /api/usage | 当前用户用量统计 | view-usage |
| GET | /api/usage/history | 用量历史列表 | view-usage |
| GET | /api/admin/config | 获取 API Key（脱敏） | admin-config |
| PUT | /api/admin/config | 保存 API Key | admin-config |
| GET | /api/admin/usage | 全局用量统计 | admin-config |
| GET | /api/health | 健康检查 | 无 |

## 权限配置

在主后端管理后台的「插件权限配置」中添加，`plugin_name` 为 `ai-3d-generator`。

| action | 说明 |
|--------|------|
| generate-model | 生成 3D 模型 |
| download-model | 下载生成结果 |
| upload-to-main | 上传至主系统资产库 |
| view-usage | 查看 Credit 用量统计 |
| admin-config | 管理员配置（API Key + 全局用量） |

### 配置示例

```
# 普通用户
plugin_name: ai-3d-generator
action: generate-model,download-model,upload-to-main,view-usage

# 管理员
plugin_name: ai-3d-generator
action: generate-model,download-model,upload-to-main,view-usage,admin-config
```

## 注册到主系统

在 `web/public/config/plugins.json` 中添加：

```json
{
  "id": "ai-3d-generator",
  "url": "http://localhost:3004/",
  "allowedOrigin": "http://localhost:3004",
  "group": "tools",
  "enabled": true,
  "nameI18n": { "zh-CN": "AI 3D 生成", "en-US": "AI 3D Generator" }
}
```
