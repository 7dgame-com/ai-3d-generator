# ============================================================
# AI 3D 模型生成插件 - 后端 Dockerfile (TypeScript 多阶段构建)
# ============================================================
# 构建命令：
#   docker build -t ai-3d-generator-backend .
#
# 运行命令：
#   docker run -p 8087:8087 ai-3d-generator-backend
# ============================================================

# ---- 阶段 1：构建 ----
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./

RUN npm install

COPY src/ ./src/

RUN npm run build

# ---- 阶段 2：生产 ----
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --production

COPY --from=builder /app/dist ./dist

EXPOSE 8087

CMD ["node", "dist/index.js"]
