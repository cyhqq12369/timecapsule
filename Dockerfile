FROM node:18-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/ ./
# Railway自动设置PORT环境变量，不要在这里覆盖
EXPOSE 3000
CMD ["node", "server.js"]
