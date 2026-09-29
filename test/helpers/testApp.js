import { createConnection, runMigrations } from "../../src/db/connection.js";
import { runSeed } from "../../src/db/seed.js";
import { createRepositories } from "../../src/repositories/index.js";
import { createServices } from "../../src/services/index.js";
import { NullProvider } from "../../src/ai/NullProvider.js";
import { createApp } from "../../src/api/app.js";
import { BusinessRouter } from "../../src/router/businessRouter.js";
import { config } from "../../src/config.js";

// Automated tests must never reach a real external API, whatever a
// developer's .env holds (config.js loads it). Messaging APIs are always
// refused at the network layer; AI APIs are refused unless the process is one
// of the live AI tests (platform/test/live/*), which set FOOD_LIVE_AI_TESTS=1.
// The flag is read per request. Tests that exercise sending install their own
// fake fetch on top of this one.
const EXTERNAL_MESSAGING_API = /^https:\/\/(api\.telegram\.org|openapi\.zalo\.me)\//;
const EXTERNAL_AI_API = /^https:\/\/(api\.openai\.com|api\.anthropic\.com)\//;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = String(input?.url ?? input);
  if (EXTERNAL_MESSAGING_API.test(url)) return Promise.reject(new Error("external messaging API is blocked in tests"));
  if (EXTERNAL_AI_API.test(url) && process.env.FOOD_LIVE_AI_TESTS !== "1") {
    return Promise.reject(new Error("external AI API is blocked in tests (only the live AI tests set FOOD_LIVE_AI_TESTS=1)"));
  }
  return realFetch(input, options);
};
config.zaloAccessToken = "";

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
