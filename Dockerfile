FROM node:18-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install
COPY backend/ ./
ENV PORT=3000
ENV VOICES_DIR=/app/voices
EXPOSE 3000
CMD ["node", "server.js"]
