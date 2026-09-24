// F-3: body-parser failures happen in the global express.json middleware,
// before routing and before any webhook security check, and land directly in
// platformErrorHandler. These tests drive the real app over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const SANITIZED = { status: "error", error: "invalid_request_body" };
const PARSER_WORDING = /JSON|position|Unexpected|Expected|entity|too large|charset|encoding/i;

async function withServer(fn) {
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    return await fn({ platform, url: (p) => `${baseUrl(server)}${p}` });
  } finally {
    server.close();
  }
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

function assertSanitized(res, expectedStatus) {
  assert.equal(res.status, expectedStatus, res.text);
  assert.deepEqual(res.body, SANITIZED);
  assert.doesNotMatch(res.text, PARSER_WORDING);
}

test("F-3. malformed JSON on a normal platform route returns 400 invalid_request_body", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url("/api/platform/merchants"), "{not json");
    assertSanitized(res, 400);
  });
});

test("F-3. malformed JSON on the Telegram webhook without a secret gets the sanitized 400, not the parser message or the secret error", async () => {
  const original = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = "test-f3-secret-value";
  try {
    await withServer(async ({ url }) => {
      const res = await post(url(platformConfig.telegramWebhookPath), "{not json");
      assertSanitized(res, 400);
      assert.notEqual(res.status, 401);
      assert.ok(!res.text.includes("invalid secret token"));
    });
  } finally {
    platformConfig.telegramWebhookSecret = original;
  }
});

test("F-3. malformed JSON on the Zalo webhook returns the sanitized 400", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url(platformConfig.webhookPath), "{not valid json!!!");
    assertSanitized(res, 400);
  });
});

test("F-3. no fragment of a malformed body is echoed back", async () => {
  const marker = "QZX-F3-MARKER-7788";
  await withServer(async ({ url }) => {
    for (const body of [`${marker} not json`, `"${marker}"`, `[1,2,3,4,5,6,7,8,9, ${marker}]`]) {
      const res = await post(url("/api/platform/merchants"), body);
      assertSanitized(res, 400);
      assert.ok(!res.text.includes("QZX"), `body fragment echoed for ${JSON.stringify(body)}: ${res.text}`);
    }
  });
});

test("F-3. an oversized body (> 1 MB) returns 413 invalid_request_body", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url("/api/platform/merchants"), JSON.stringify({ padding: "x".repeat(1_100_000) }));
    assertSanitized(res, 413);
  });
});

test("F-3. an unsupported charset returns 415 invalid_request_body without echoing the charset", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url("/api/platform/merchants"), "{}", { "content-type": "application/json; charset=x-f3-charset-marker" });
    assertSanitized(res, 415);
    assert.ok(!res.text.toLowerCase().includes("x-f3-charset-marker"));
  });
});

test("F-3. an unsupported content encoding returns 415 invalid_request_body without echoing the encoding", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url("/api/platform/merchants"), "{}", { "content-encoding": "x-f3-encoding-marker" });
    assertSanitized(res, 415);
    assert.ok(!res.text.toLowerCase().includes("x-f3-encoding-marker"));
  });
});

test("F-3 guard. application-generated 400 errors keep their message", async () => {
  await withServer(async ({ url }) => {
    const res = await post(url("/api/platform/merchants"), "{}");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { status: "error", error: "merchantId is required" });
  });
});

test("F-3 guard. unexpected internal errors still return 500 internal_error", async () => {
  await withServer(async ({ platform, url }) => {
    platform.services.merchants.onboard = () => {
      throw new Error("simulated internal failure at /home/app/platform/services/merchantService.js:42");
    };
    const res = await post(
      url("/api/platform/merchants"),
      JSON.stringify({ merchantId: "F3GUARD001", name: "F3 Guard", slug: "f3-guard", module: "generic" })
    );
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { status: "error", error: "internal_error" });
  });
});

test("F-3b. a request with a malformed body still gets a request id", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url("/api/platform/merchants"), { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    assert.ok(res.headers.get("x-request-id"));
  });
});

test("F-3b. malformed-body requests count against the rate limit", async () => {
  const original = platformConfig.rateLimitMax;
  platformConfig.rateLimitMax = 3;
  try {
    await withServer(async ({ url }) => {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(url("/api/platform/merchants"), { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
        statuses.push(res.status);
      }
      assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
    });
  } finally {
    platformConfig.rateLimitMax = original;
  }
});
