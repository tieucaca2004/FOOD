// What the platform app exposes to anyone who can reach its port (in
// production, through the public webhook tunnel): CORS, OPTIONS, public
// error bodies, and routes that must not be mounted here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl, ADMIN_AUTH_HEADER } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

async function withServer(fn) {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    return await fn({ platform, url: (p) => `${baseUrl(server)}${p}` });
  } finally {
    server.close();
  }
}

const ROUTES = [
  ["GET", "/api/platform/health"],
  ["GET", "/api/platform/search?q=hu"],
  ["GET", "/api/platform/merchants"],
  ["POST", "/api/platform/merchants/MERCHANT002/api-keys"],
  ["GET", "/api/platform/merchant/orders"],
];

test("readiness failure does not echo the database error", async () => {
  await withServer(async ({ platform, url }) => {
    platform.db.prepare = () => {
      throw new Error("SQLITE_CANTOPEN: unable to open database file /srv/secret-path/platform.db");
    };
    const res = await fetch(url("/api/platform/readiness"));
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(text), { status: "not_ready" });
    assert.ok(!text.includes("SQLITE"));
    assert.ok(!text.includes("secret-path"));
  });
});

test("no route grants cross-origin access: no Access-Control-Allow-* headers, even for a preflight", async () => {
  await withServer(async ({ url }) => {
    for (const [method, path] of ROUTES) {
      const preflight = await fetch(url(path), {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });
      const actual = await fetch(url(path), { method, headers: { origin: "https://attacker.example", ...ADMIN_AUTH_HEADER } });
      for (const res of [preflight, actual]) {
        for (const [name] of res.headers) {
          assert.ok(!name.startsWith("access-control-allow"), `${method} ${path}: ${name}`);
        }
      }
    }
  });
});

test("OPTIONS on the merchant order routes needs a merchant key, like every other method", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url("/api/platform/merchant/orders"), { method: "OPTIONS" });
    assert.equal(res.status, 401);
  });
});

test("the platform app identifies no framework and answers unknown routes and methods with a plain 404", async () => {
  await withServer(async ({ url }) => {
    const health = await fetch(url("/api/platform/health"));
    assert.equal(health.headers.get("x-powered-by"), null);
    for (const [method, path] of [
      ["GET", "/api/platform/does-not-exist"],
      ["DELETE", "/api/platform/search"],
      ["PUT", "/api/platform/health"],
      ["GET", "/.env"],
      ["GET", "/api/platform/../../.env"],
      ["GET", "/data/platform.db"],
    ]) {
      const res = await fetch(url(path), { method });
      const text = await res.text();
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(JSON.parse(text), { status: "error", error: "not_found" });
    }
  });
});

test("A Tiểu's standalone REST routes are not mounted on the platform app", async () => {
  await withServer(async ({ url }) => {
    for (const [method, path] of [
      ["GET", "/api/customers/1"],
      ["GET", "/api/orders/1"],
      ["PATCH", "/api/orders/1/status"],
      ["POST", "/api/orders"],
      ["GET", "/api/menu"],
      ["POST", "/zalo/webhook"],
    ]) {
      const res = await fetch(url(path), { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

test("the Telegram webhook refuses requests without the secret header", async () => {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = "test-only-webhook-secret-value";
  try {
    await withServer(async ({ url }) => {
      const res = await fetch(url(platformConfig.telegramWebhookPath), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, text: "hi" } }),
      });
      assert.equal(res.status, 401);
    });
  } finally {
    platformConfig.telegramWebhookSecret = saved;
  }
});
