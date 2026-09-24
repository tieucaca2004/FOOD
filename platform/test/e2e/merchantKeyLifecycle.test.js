// Merchant API keys: issued only through the admin API, returned exactly
// once, stored only as a hash, revoked by re-issuing, and never written to
// logs or echoed in other responses. (Whether suspension or closure should
// revoke a key is an open policy question and is deliberately not pinned
// here.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildTestPlatform, startServer, baseUrl, ADMIN_AUTH_HEADER } from "../helpers/testPlatform.js";

async function withServer(fn) {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  const call = async (path, { method = "GET", headers = {} } = {}) => {
    const res = await fetch(`${baseUrl(server)}${path}`, { method, headers });
    const text = await res.text();
    return { status: res.status, text };
  };
  try {
    return await fn({ platform, call });
  } finally {
    server.close();
  }
}

function captureLogs() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => Object.assign(console, saved) };
}

test("a key is returned once at issuance, stored only as its SHA-256 hash, and never shown again", async () => {
  await withServer(async ({ platform, call }) => {
    const issued = await call("/api/platform/merchants/MERCHANT002/api-keys", { method: "POST", headers: ADMIN_AUTH_HEADER });
    assert.equal(issued.status, 201);
    const key = JSON.parse(issued.text).api_key;
    assert.match(key, /^mk_[0-9a-f]{64}$/);

    const row = platform.db.prepare("SELECT * FROM merchant_users WHERE merchant_id = 'MERCHANT002'").get();
    assert.equal(row.api_key_hash, createHash("sha256").update(key).digest("hex"));
    assert.ok(!JSON.stringify(row).includes(key));

    for (const path of ["/api/platform/merchants", "/api/platform/merchants/MERCHANT002"]) {
      const res = await call(path, { headers: ADMIN_AUTH_HEADER });
      assert.equal(res.status, 200);
      assert.ok(!res.text.includes(key), path);
      assert.ok(!res.text.includes(row.api_key_hash), path);
      assert.ok(!res.text.includes("api_key"), path);
    }
    const orders = await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${key}` } });
    assert.equal(orders.status, 200);
    assert.ok(!orders.text.includes(key));
  });
});

test("a re-issued key revokes the old one on every merchant route; the other merchant is unaffected", async () => {
  await withServer(async ({ platform, call }) => {
    const oldKey = platform.services.merchantAuth.issueApiKey("MERCHANT002").apiKey;
    const otherKey = platform.services.merchantAuth.issueApiKey("MERCHANT003").apiKey;
    const rotated = await call("/api/platform/merchants/MERCHANT002/api-keys", { method: "POST", headers: ADMIN_AUTH_HEADER });
    const newKey = JSON.parse(rotated.text).api_key;
    for (const [method, path] of [["GET", "/api/platform/merchant/orders"], ["GET", "/api/platform/merchant/orders/1"], ["POST", "/api/platform/merchant/orders/1/receive"]]) {
      const res = await call(path, { method, headers: { authorization: `Bearer ${oldKey}` } });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(JSON.parse(res.text), { status: "error", error: "unauthenticated" });
    }
    assert.equal((await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${newKey}` } })).status, 200);
    assert.equal((await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${otherKey}` } })).status, 200);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_users WHERE merchant_id = 'MERCHANT002'").get().n, 1);
  });
});

test("issuing a key for a merchant that does not exist creates nothing", async () => {
  await withServer(async ({ platform, call }) => {
    const before = platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_users").get().n;
    const res = await call("/api/platform/merchants/NOSUCH001/api-keys", { method: "POST", headers: ADMIN_AUTH_HEADER });
    assert.equal(res.status, 404);
    assert.ok(!res.text.includes("mk_"));
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_users").get().n, before);
  });
});

test("no key material reaches the logs: issuance, use, rejection, rotation", async () => {
  await withServer(async ({ platform, call }) => {
    const logs = captureLogs();
    const keys = [];
    try {
      const issued = await call("/api/platform/merchants/MERCHANT002/api-keys", { method: "POST", headers: ADMIN_AUTH_HEADER });
      keys.push(JSON.parse(issued.text).api_key);
      await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${keys[0]}` } });
      await call("/api/platform/merchant/orders/999", { headers: { authorization: `Bearer ${keys[0]}` } });
      await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${keys[0]}x` } });
      const rotated = await call("/api/platform/merchants/MERCHANT002/api-keys", { method: "POST", headers: ADMIN_AUTH_HEADER });
      keys.push(JSON.parse(rotated.text).api_key);
      await call("/api/platform/merchant/orders", { headers: { authorization: `Bearer ${keys[0]}` } });
    } finally {
      logs.restore();
    }
    const hash = platform.db.prepare("SELECT api_key_hash FROM merchant_users WHERE merchant_id = 'MERCHANT002'").get().api_key_hash;
    const logged = logs.lines.join("\n");
    assert.ok(logs.lines.length > 0);
    for (const key of keys) assert.ok(!logged.includes(key.slice(3, 40)), "merchant key in logs");
    assert.ok(!logged.includes(hash.slice(0, 40)), "key hash in logs");
  });
});
