# ============================================================
# AI 3D 模型生成插件 - 前端 Dockerfile
# ============================================================
# 多阶段构建：
#   1. 构建阶段 - 使用 Node.js 编译 Vue 3 + TypeScript 项目
#   2. 服务阶段 - 使用 Nginx 提供静态文件服务
#
# 构建命令：
#   docker build -t ai-3d-generator-frontend .
#
# 运行命令：
#   docker run -p 3004:80 ai-3d-generator-frontend
# ============================================================

# ========== 第一阶段：构建 ==========
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install

COPY . .

RUN npm run build

# ========== 第二阶段：Nginx 服务 ==========
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
