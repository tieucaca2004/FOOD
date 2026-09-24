// Admin API authorization: every /api/platform/merchants* endpoint (merchant
// listing, detail, onboarding, status changes and API-key issuance) requires
// the platform admin bearer token, and refuses everything when that token is
// not configured. All credentials here are fake, test-only values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const ADMIN_TOKEN = "test-admin-token-" + "a".repeat(48);
const WRONG_TOKEN = "test-admin-token-" + "b".repeat(48);

const UNAUTHENTICATED = { status: "error", error: "unauthenticated" };
const DISABLED = { status: "error", error: "admin_api_disabled" };

async function withServer({ adminToken = ADMIN_TOKEN } = {}, fn) {
  const saved = platformConfig.adminApiToken;
  platformConfig.adminApiToken = adminToken;
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  try {
    return await fn({ platform, url: (p) => `${baseUrl(server)}${p}` });
  } finally {
    server.close();
    platformConfig.adminApiToken = saved;
  }
}

async function call(url, { method = "GET", body, authorization } = {}) {
  const headers = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HEAD and some error paths have no JSON body.
  }
  return { status: res.status, text, body: json, headers: res.headers };
}

const bearer = (token) => `Bearer ${token}`;

// The five admin endpoints, each with a valid request body and the success
// status it returns when authorized.
const ADMIN_ENDPOINTS = [
  { name: "GET /merchants", method: "GET", path: "/api/platform/merchants", ok: 200 },
  { name: "GET /merchants/:id", method: "GET", path: "/api/platform/merchants/MERCHANT002", ok: 200 },
  {
    name: "POST /merchants",
    method: "POST",
    path: "/api/platform/merchants",
    body: { merchantId: "ADMINTEST001", name: "Admin Test", slug: "admin-test", module: "generic" },
    ok: 201,
  },
  { name: "PATCH /merchants/:id/status", method: "PATCH", path: "/api/platform/merchants/MERCHANT002/status", body: { action: "suspend" }, ok: 200 },
  { name: "POST /merchants/:id/api-keys", method: "POST", path: "/api/platform/merchants/MERCHANT002/api-keys", ok: 201 },
];

// State that a successful admin call would change, so a rejected call can be
// shown to have had no effect.
function snapshot(platform) {
  const db = platform.db;
  return {
    merchants: db.prepare("SELECT merchant_id, status FROM merchants ORDER BY merchant_id").all(),
    keys: db.prepare("SELECT id, merchant_id, api_key_hash FROM merchant_users ORDER BY id").all(),
  };
}

// --- Regression: these five requests all succeeded without any credential. ---

test("regression: unauthenticated API-key issuance for a merchant is rejected", async () => {
  await withServer({}, async ({ platform, url }) => {
    const before = snapshot(platform);
    const res = await call(url("/api/platform/merchants/MERCHANT002/api-keys"), { method: "POST" });
    assert.equal(res.status, 401, res.text);
    assert.deepEqual(res.body, UNAUTHENTICATED);
    assert.ok(!res.text.includes("mk_"));
    assert.deepEqual(snapshot(platform), before);
  });
});

test("regression: unauthenticated merchant suspension is rejected and the merchant stays ACTIVE", async () => {
  await withServer({}, async ({ platform, url }) => {
    const res = await call(url("/api/platform/merchants/MERCHANT002/status"), { method: "PATCH", body: { action: "suspend" } });
    assert.equal(res.status, 401, res.text);
    assert.equal(platform.repos.merchants.getById("MERCHANT002").status, "ACTIVE");
  });
});

test("regression: unauthenticated merchant listing is rejected and leaks no merchant data", async () => {
  await withServer({}, async ({ url }) => {
    const res = await call(url("/api/platform/merchants"));
    assert.equal(res.status, 401, res.text);
    assert.deepEqual(res.body, UNAUTHENTICATED);
    assert.ok(!res.text.includes("MERCHANT002"));
    assert.ok(!res.text.includes("Nha Trang"));
  });
});

test("regression: unauthenticated merchant creation is rejected and creates nothing", async () => {
  await withServer({}, async ({ platform, url }) => {
    const res = await call(url("/api/platform/merchants"), {
      method: "POST",
      body: { merchantId: "ATTACKER001", name: "Attacker", slug: "attacker", module: "generic" },
    });
    assert.equal(res.status, 401, res.text);
    assert.ok(!platform.repos.merchants.getById("ATTACKER001"));
  });
});

test("regression: unauthenticated merchant detail lookup is rejected", async () => {
  await withServer({}, async ({ url }) => {
    const res = await call(url("/api/platform/merchants/MERCHANT002"));
    assert.equal(res.status, 401, res.text);
    assert.ok(!res.text.includes("MERCHANT002"));
  });
});

// --- Per-endpoint matrix. ---

for (const ep of ADMIN_ENDPOINTS) {
  test(`${ep.name}: missing, wrong and malformed credentials are all rejected with no side effect`, async () => {
    await withServer({}, async ({ platform, url }) => {
      const before = snapshot(platform);
      const attempts = [
        undefined,
        "",
        "Bearer",
        "Bearer ",
        bearer(""),
        bearer(WRONG_TOKEN),
        bearer(ADMIN_TOKEN.slice(0, -1)),
        bearer(ADMIN_TOKEN + "x"),
        bearer(ADMIN_TOKEN.toUpperCase()),
        `Basic ${Buffer.from(`admin:${ADMIN_TOKEN}`).toString("base64")}`,
        `Token ${ADMIN_TOKEN}`,
        ADMIN_TOKEN,
        `Bearer  ${ADMIN_TOKEN}`,
        `Bearer ${ADMIN_TOKEN} extra`,
        `Bearer ${ADMIN_TOKEN},Bearer ${ADMIN_TOKEN}`,
      ];
      for (const authorization of attempts) {
        const res = await call(url(ep.path), { method: ep.method, body: ep.body, authorization });
        assert.equal(res.status, 401, `${JSON.stringify(authorization)} -> ${res.status} ${res.text}`);
        assert.deepEqual(res.body, UNAUTHENTICATED);
        assert.equal(res.headers.get("www-authenticate"), "Bearer");
        assert.ok(!res.text.includes(ADMIN_TOKEN.slice(17, 40)), "response echoes credential material");
      }
      assert.deepEqual(snapshot(platform), before);
    });
  });

  test(`${ep.name}: a valid merchant API key is not an admin credential`, async () => {
    await withServer({}, async ({ platform, url }) => {
      const { apiKey } = platform.services.merchantAuth.issueApiKey("MERCHANT003");
      const before = snapshot(platform);
      const res = await call(url(ep.path), { method: ep.method, body: ep.body, authorization: bearer(apiKey) });
      assert.equal(res.status, 401, res.text);
      assert.deepEqual(res.body, UNAUTHENTICATED);
      assert.deepEqual(snapshot(platform), before);
    });
  });

  test(`${ep.name}: the configured admin token is accepted`, async () => {
    await withServer({}, async ({ url }) => {
      const res = await call(url(ep.path), { method: ep.method, body: ep.body, authorization: bearer(ADMIN_TOKEN) });
      assert.equal(res.status, ep.ok, res.text);
    });
  });

  test(`${ep.name}: fails closed when no admin token is configured, even for an empty bearer token`, async () => {
    await withServer({ adminToken: "" }, async ({ platform, url }) => {
      const before = snapshot(platform);
      for (const authorization of [undefined, "Bearer ", bearer(""), bearer(ADMIN_TOKEN), bearer("undefined"), bearer("null")]) {
        const res = await call(url(ep.path), { method: ep.method, body: ep.body, authorization });
        assert.equal(res.status, 503, `${JSON.stringify(authorization)} -> ${res.status} ${res.text}`);
        assert.deepEqual(res.body, DISABLED);
      }
      assert.deepEqual(snapshot(platform), before);
    });
  });
}

test("a configured admin token shorter than 32 characters is treated as not configured", async () => {
  const weak = "short-admin-token";
  await withServer({ adminToken: weak }, async ({ url }) => {
    const res = await call(url("/api/platform/merchants"), { authorization: bearer(weak) });
    assert.equal(res.status, 503, res.text);
    assert.deepEqual(res.body, DISABLED);
  });
});

test("a whitespace-only admin token is treated as not configured", async () => {
  const blank = " ".repeat(40);
  await withServer({ adminToken: blank }, async ({ url }) => {
    const res = await call(url("/api/platform/merchants"), { authorization: `Bearer ${blank}` });
    assert.equal(res.status, 503, res.text);
  });
});

test("rejected admin requests never log the presented credential", async () => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => lines.push(args.join(" "));
  await withServer({}, async ({ url }) => {
    console.log = console.warn = console.error = capture;
    try {
      await call(url("/api/platform/merchants"), { authorization: bearer(WRONG_TOKEN) });
      await call(url("/api/platform/merchants"), { authorization: `Basic ${WRONG_TOKEN}` });
      await call(url("/api/platform/merchants"), { authorization: bearer(ADMIN_TOKEN) });
    } finally {
      Object.assign(console, saved);
    }
  });
  const logged = lines.join("\n");
  assert.ok(logged.includes("admin"), "a rejected admin request should be logged");
  assert.ok(!logged.includes(WRONG_TOKEN.slice(17)), "wrong token leaked into logs");
  assert.ok(!logged.includes(ADMIN_TOKEN.slice(17)), "admin token leaked into logs");
});

// --- Path variants: none may reach an admin handler without the token. ---

test("case, trailing-slash and duplicate-slash path variants cannot bypass admin auth", async () => {
  await withServer({}, async ({ platform, url }) => {
    const before = snapshot(platform);
    const variants = [
      ["GET", "/api/platform/MERCHANTS"],
      ["GET", "/API/PLATFORM/merchants"],
      ["GET", "/api/platform/merchants/"],
      ["GET", "/api/platform/Merchants/MERCHANT002"],
      ["GET", "/api/platform//merchants"],
      ["GET", "/api/platform/merchants?x=1"],
      ["GET", "/api/platform/%6Derchants"],
      ["GET", "/api/platform/merchants%2F"],
      ["GET", "/api/platform/./merchants"],
      ["GET", "/api/platform/merchant/../merchants"],
      ["PATCH", "/api/platform/merchants/MERCHANT002/status/"],
      ["PATCH", "/api/platform/MERCHANTS/MERCHANT002/STATUS"],
      ["POST", "/api/platform/merchants/MERCHANT002/api-keys/"],
      ["POST", "/api/platform/Merchants/MERCHANT002/API-KEYS"],
    ];
    for (const [method, path] of variants) {
      const body = method === "PATCH" ? { action: "suspend" } : undefined;
      const res = await call(url(path), { method, body });
      assert.ok(res.status === 401 || res.status === 404, `${method} ${path} -> ${res.status} ${res.text}`);
      assert.ok(!res.text.includes("mk_"), `${method} ${path} issued a key`);
      assert.ok(!res.text.includes("MERCHANT002"), `${method} ${path} leaked merchant data`);
    }
    assert.deepEqual(snapshot(platform), before);
  });
});

test("method override headers and query parameters do not bypass admin auth", async () => {
  await withServer({}, async ({ platform, url }) => {
    const res = await fetch(url("/api/platform/merchants/MERCHANT002/status?_method=GET"), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-http-method-override": "GET" },
      body: JSON.stringify({ action: "suspend" }),
    });
    assert.equal(res.status, 401);
    assert.equal(platform.repos.merchants.getById("MERCHANT002").status, "ACTIVE");
  });
});

test("HEAD and OPTIONS on admin endpoints require the admin token too", async () => {
  await withServer({}, async ({ url }) => {
    const head = await fetch(url("/api/platform/merchants"), { method: "HEAD" });
    assert.equal(head.status, 401);
    const options = await fetch(url("/api/platform/merchants"), { method: "OPTIONS" });
    assert.equal(options.status, 401);
    assert.equal(options.headers.get("allow"), null);
  });
});

test("the admin token does not authenticate merchant-scoped order routes", async () => {
  await withServer({}, async ({ url }) => {
    const res = await call(url("/api/platform/merchant/orders"), { authorization: bearer(ADMIN_TOKEN) });
    assert.equal(res.status, 401);
  });
});

test("public routes stay public when admin auth is configured and when it is not", async () => {
  for (const adminToken of [ADMIN_TOKEN, ""]) {
    await withServer({ adminToken }, async ({ url }) => {
      assert.equal((await call(url("/api/platform/health"))).status, 200);
      assert.equal((await call(url("/api/platform/readiness"))).status, 200);
      assert.equal((await call(url("/api/platform/search?q=hu%20tieu"))).status, 200);
    });
  }
});

test("an admin-issued API key works on the merchant routes and only for that merchant", async () => {
  await withServer({}, async ({ url }) => {
    const issued = await call(url("/api/platform/merchants/MERCHANT002/api-keys"), { method: "POST", authorization: bearer(ADMIN_TOKEN) });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.merchant_id, "MERCHANT002");
    const orders = await call(url("/api/platform/merchant/orders"), { authorization: bearer(issued.body.api_key) });
    assert.equal(orders.status, 200);
  });
});
