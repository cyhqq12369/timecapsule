FROM node:20-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/ ./
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "server.js"]
