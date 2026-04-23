FROM node:18-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/ ./
# 不写死PORT，让Railway自动设置（Railway会自动设置PORT变量）
EXPOSE 3000
CMD ["node", "server.js"]
