import { config } from "./config.js";
import { logger } from "./logger.js";
import { createConnection, runMigrations } from "./db/connection.js";
import { runSeed } from "./db/seed.js";
import { createRepositories } from "./repositories/index.js";
import { createServices } from "./services/index.js";
import { createAIProvider } from "./ai/index.js";
import { createApp } from "./api/app.js";

const db = createConnection(config.dbPath);
runMigrations(db);
runSeed(db); // idempotent — safe on every boot, never destructive

const repos = createRepositories(db);
const services = createServices(repos);
const ai = createAIProvider();

const app = createApp({ db, repos, services, ai });

const server = app.listen(config.port, () => {
  logger.info("APP", `A Tiểu ordering engine listening on :${config.port}`, {
    webhookPath: config.webhookPath,
    aiProvider: config.aiProvider,
  });
});

function shutdown(signal) {
  logger.info("APP", `received ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
