FROM node:20-alpine
WORKDIR /app

# Python3 + pip + ffmpeg（gTTS 免费无需API Key）
RUN apk add --no-cache python3 ffmpeg py3-pip && \
    python3 -m pip install --break-system-packages gtts

COPY backend/package.json ./
RUN npm install --production

COPY backend/ ./
ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV RAILWAY=true
EXPOSE 8080
CMD ["node", "server.js"]
