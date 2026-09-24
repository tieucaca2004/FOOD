FROM node:22-slim AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV SQLITE_PATH=/data/atieu.db

VOLUME ["/data"]
# The REST API on this port has no authentication. Publish it on loopback
# only (docker run -p 127.0.0.1:3900:3900 ...) and expose nothing but
# /zalo/webhook through a reverse proxy; see README sections 7 and 12.
EXPOSE 3900

CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed.js && node src/server.js"]
