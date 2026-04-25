FROM node:18-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/ ./
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
