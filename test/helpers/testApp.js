import { createConnection, runMigrations } from "../../src/db/connection.js";
import { runSeed } from "../../src/db/seed.js";
import { createRepositories } from "../../src/repositories/index.js";
import { createServices } from "../../src/services/index.js";
import { NullProvider } from "../../src/ai/NullProvider.js";
import { createApp } from "../../src/api/app.js";
import { BusinessRouter } from "../../src/router/businessRouter.js";

// Fresh, isolated, in-memory DB per call — tests never share state and
// never touch the real data/atieu.db file.
export function buildTestContext({ telegramSend } = {}) {
  const db = createConnection(":memory:");
  runMigrations(db);
  runSeed(db);

  const repos = createRepositories(db);
  const services = createServices(repos, { telegramSend });
  const ai = new NullProvider();
  const app = createApp({ db, repos, services, ai });
  const router = new BusinessRouter(services, ai);

  return { db, repos, services, ai, app, router };
}

export async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

export function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}
