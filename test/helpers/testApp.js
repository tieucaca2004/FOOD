import { createConnection, runMigrations } from "../../src/db/connection.js";
import { runSeed } from "../../src/db/seed.js";
import { createRepositories } from "../../src/repositories/index.js";
import { createServices } from "../../src/services/index.js";
import { NullProvider } from "../../src/ai/NullProvider.js";
import { createApp } from "../../src/api/app.js";
import { BusinessRouter } from "../../src/router/businessRouter.js";
import { config } from "../../src/config.js";

// Automated tests must never reach a real messaging API, whatever a
// developer's .env holds (config.js loads it). Any such request is refused
// at the network layer; tests that exercise sending install their own fake.
const EXTERNAL_MESSAGING_API = /^https:\/\/(api\.telegram\.org|openapi\.zalo\.me)\//;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  EXTERNAL_MESSAGING_API.test(String(url))
    ? Promise.reject(new Error("external messaging API is blocked in tests"))
    : realFetch(url, options);
config.zaloAccessToken = "";

// Fresh, isolated, in-memory DB per call — tests never share state and
// never touch the real data/atieu.db file.
//
// The order notifier defaults to a recording fake: config.js loads a
// developer's .env, and with TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set the real
// sender would message the real chat on every confirmed test order.
export function buildTestContext({ telegramSend } = {}) {
  const db = createConnection(":memory:");
  runMigrations(db);
  runSeed(db);

  const sentNotifications = [];
  const repos = createRepositories(db);
  const services = createServices(repos, {
    telegramSend: telegramSend || (async (message) => void sentNotifications.push(message)),
  });
  const ai = new NullProvider();
  const app = createApp({ db, repos, services, ai });
  const router = new BusinessRouter(services, ai);

  return { db, repos, services, ai, app, router, sentNotifications };
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
