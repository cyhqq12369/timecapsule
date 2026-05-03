FROM node:20-alpine
WORKDIR /app

# 安装 espeak-ng（中文TTS）和 ffmpeg（WAV转MP3）
RUN apk add --no-cache espeak-ng ffmpeg

COPY backend/package.json ./
RUN npm install --production

COPY backend/ ./
ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV RAILWAY=true
EXPOSE 8080
CMD ["node", "server.js"]
