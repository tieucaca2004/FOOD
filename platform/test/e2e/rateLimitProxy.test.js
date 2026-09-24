// Client IP detection for the platform rate limiter. By default no proxy is
// trusted, so X-Forwarded-For is ignored and cannot be used to dodge the
// limit. PLATFORM_TRUST_PROXY opts in to trusting specific proxy addresses
// (e.g. "loopback" for a local cloudflared); values that would trust
// arbitrary clients are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const CONFIG_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config.js")).href;

// platform/config.js in a fresh process, with no .env, and the variable set
// to `value` (undefined = unset).
function trustProxyFor(value) {
  const env = { ...process.env };
  delete env.PLATFORM_TRUST_PROXY;
  if (value !== undefined) env.PLATFORM_TRUST_PROXY = value;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trust-proxy-"));
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const { platformConfig } = await import(${JSON.stringify(CONFIG_URL)}); process.stdout.write(JSON.stringify(platformConfig.trustProxy));`],
      { cwd, env, encoding: "utf8" }
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function withServer({ trustProxy, max = 3 }, fn) {
  const saved = { trustProxy: platformConfig.trustProxy, max: platformConfig.rateLimitMax, secret: platformConfig.telegramWebhookSecret };
  platformConfig.trustProxy = trustProxy;
  platformConfig.rateLimitMax = max;
  platformConfig.telegramWebhookSecret = "test-only-webhook-secret-value";
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    const get = (headers = {}) => fetch(`${baseUrl(server)}/api/platform/health`, { headers }).then((r) => r.status);
    return await fn({ server, get });
  } finally {
    server.close();
    Object.assign(platformConfig, { trustProxy: saved.trustProxy, rateLimitMax: saved.max, telegramWebhookSecret: saved.secret });
  }
}

test("PLATFORM_TRUST_PROXY: unset, empty or false trusts no proxy", () => {
  assert.equal(trustProxyFor(undefined), false);
  assert.equal(trustProxyFor(""), false);
  assert.equal(trustProxyFor("false"), false);
});

test("PLATFORM_TRUST_PROXY: loopback and explicit addresses or subnets are accepted", () => {
  assert.equal(trustProxyFor("loopback"), "loopback");
  assert.equal(trustProxyFor(" Loopback "), "loopback");
  assert.equal(trustProxyFor("loopback, 10.0.0.5"), "loopback,10.0.0.5");
  assert.equal(trustProxyFor("172.16.0.0/12"), "172.16.0.0/12");
  assert.equal(trustProxyFor("::1"), "::1");
});

test("PLATFORM_TRUST_PROXY: values that would trust any client are refused, not partly applied", () => {
  for (const value of ["true", "TRUE", "1", "2", "*", "all", "0.0.0.0/0", "::/0", "loopback, 0.0.0.0/0", "loopback,true", "10.0.0.0/33", "not-an-ip", "loopback,,"]) {
    assert.equal(trustProxyFor(value), false, value);
  }
});

test("default: spoofed X-Forwarded-For values all share the connection's bucket", async () => {
  await withServer({ trustProxy: false }, async ({ get }) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await get({ "x-forwarded-for": `203.0.113.${i}` }));
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
});

test("trusting loopback: clients forwarded by a local proxy get separate buckets", async () => {
  await withServer({ trustProxy: "loopback" }, async ({ get }) => {
    const a = [];
    for (let i = 0; i < 4; i++) a.push(await get({ "x-forwarded-for": "198.51.100.7" }));
    assert.deepEqual(a, [200, 200, 200, 429]);
    assert.equal(await get({ "x-forwarded-for": "198.51.100.8" }), 200);
  });
});

test("trusting loopback: rotating the client-supplied left part of X-Forwarded-For does not bypass the limit", async () => {
  // A proxy that appends the peer address produces "<client-supplied>, <real client>".
  await withServer({ trustProxy: "loopback" }, async ({ get }) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await get({ "x-forwarded-for": `203.0.113.${i}, 198.51.100.9` }));
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
});

test("trusting loopback: a forwarded loopback address cannot claim a fresh bucket", async () => {
  await withServer({ trustProxy: "loopback" }, async ({ get }) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await get({ "x-forwarded-for": "198.51.100.10, 127.0.0.1" }));
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });
});

test("trusting only a different proxy address: X-Forwarded-For from this peer is ignored", async () => {
  await withServer({ trustProxy: "10.9.9.9" }, async ({ get }) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await get({ "x-forwarded-for": `203.0.113.${i}` }));
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });
});

test("trusting loopback: one client exhausting its budget does not block Telegram webhook deliveries from another address", async () => {
  await withServer({ trustProxy: "loopback" }, async ({ server, get }) => {
    for (let i = 0; i < 5; i++) await get({ "x-forwarded-for": "198.51.100.66" });
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "149.154.167.220", "x-telegram-bot-api-secret-token": "test-only-webhook-secret-value" },
      body: JSON.stringify({ update_id: 1, edited_message: {} }),
    });
    assert.notEqual(res.status, 429);
    assert.ok(res.status < 500, String(res.status));
  });
});

test("without a trusted proxy, the same abuse does block the webhook (the shared-bucket risk this setting addresses)", async () => {
  await withServer({ trustProxy: false }, async ({ server, get }) => {
    for (let i = 0; i < 5; i++) await get({ "x-forwarded-for": "198.51.100.66" });
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "149.154.167.220", "x-telegram-bot-api-secret-token": "test-only-webhook-secret-value" },
      body: JSON.stringify({ update_id: 2, edited_message: {} }),
    });
    assert.equal(res.status, 429);
  });
});
