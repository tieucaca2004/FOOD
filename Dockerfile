FROM node:22-slim AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV SQLITE_PATH=/data/atieu.db

VOLUME ["/data"]
EXPOSE 3900

CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed.js && node src/server.js"]
