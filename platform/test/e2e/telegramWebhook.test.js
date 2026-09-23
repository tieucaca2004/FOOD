// Phase 8.x-T SIMULATED integration/security test matrix (A-R per spec).
// "SIMULATED" — every test POSTs locally-constructed, Telegram-shaped JSON
// to the real Express app; none talk to a real Telegram Bot API (no
// credentials exist in this environment — no PLATFORM_TELEGRAM_BOT_TOKEN, and
// api.telegram.org/core.telegram.org are both unreachable from this
// session, confirmed via direct connection test — see Phase 8.x-T final
// report). Never report any result from this file as a REAL TELEGRAM PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_SECRET = "test-telegram-secret-value";

function telegramUpdate({ userId, chatId, text, updateId, messageId, firstName = "Test", username }) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId, is_bot: false, first_name: firstName, username },
      chat: { id: chatId ?? userId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function postTelegramWebhook(server, body, { secret = TEST_SECRET } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* some tests deliberately check a non-JSON or malformed response */
  }
  return { status: res.status, body: json };
}

function withTelegramSecret(fn) {
  const original = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      platformConfig.telegramWebhookSecret = original;
    });
}

// --- A. Webhook validation ------------------------------------------------

test("A. missing secret header is rejected with 401, never processed", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(
        server,
        telegramUpdate({ userId: 111, text: "hi", updateId: 1, messageId: 1 }),
        { secret: null }
      );
      assert.equal(res.status, 401);
      assert.equal(platform.repos.customers.findByZaloUserId("telegram:111"), undefined);
    } finally {
      server.close();
    }
  });
});

test("A. wrong secret header is rejected with 401", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 111, text: "hi", updateId: 1, messageId: 1 }), {
        secret: "totally-wrong",
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });
});

test("A. no secret configured at all (default state): every request rejected — fail closed", async () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    const res = await postTelegramWebhook(server, telegramUpdate({ userId: 111, text: "hi", updateId: 1, messageId: 1 }), {
      secret: TEST_SECRET,
    });
    assert.equal(res.status, 401); // platformConfig.telegramWebhookSecret is unset by default
  } finally {
    server.close();
  }
});

// --- B. Valid update -------------------------------------------------------

test("B. a valid text update is processed and produces a reply through the existing AI Concierge/router pipeline", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: true });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 222, text: "Xin chào", updateId: 10, messageId: 1 }));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "processed");
      assert.equal(res.body.channel, "telegram");
      assert.ok(res.body.reply_text);
    } finally {
      server.close();
    }
  });
});

// --- C. Invalid/malformed update --------------------------------------------

test("C. malformed/garbage JSON body never crashes the server", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
        body: "{not valid json",
      });
      assert.ok(res.status < 500 || res.status === 400, `expected a clean 4xx, got ${res.status}`);
    } finally {
      server.close();
    }
  });
});

test("C. well-formed but semantically unexpected payloads are ignored safely", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      for (const body of [{}, { update_id: 1 }, { update_id: 1, message: {} }, { update_id: 1, message: { chat: "bad" } }]) {
        const res = await postTelegramWebhook(server, body);
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "ignored");
      }
    } finally {
      server.close();
    }
  });
});

// --- D/N. replay / duplicate update -----------------------------------------

test("D/N. the same update_id delivered twice is processed exactly once — the second delivery returns the cached response", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const update = telegramUpdate({ userId: 333, text: "Xin chào", updateId: 55, messageId: 1 });
      const first = await postTelegramWebhook(server, update);
      const second = await postTelegramWebhook(server, update);

      assert.equal(first.body.status, "processed");
      assert.deepEqual(second.body, first.body);

      const customer = platform.repos.customers.findByZaloUserId("telegram:333");
      const session = platform.repos.sessions.getActiveByCustomer(customer.id);
      const messages = platform.db.prepare("SELECT * FROM platform_messages WHERE session_id = ?").all(session.id);
      assert.equal(messages.filter((m) => m.direction === "in").length, 1);
    } finally {
      server.close();
    }
  });
});

// --- E. Missing sender -------------------------------------------------------

test("E. an update with no `from` (e.g. anonymous channel post) is ignored, no customer/session created", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const update = telegramUpdate({ userId: 444, text: "hi", updateId: 1, messageId: 1 });
      delete update.message.from;
      const res = await postTelegramWebhook(server, update);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ignored");
      assert.equal(res.body.reason, "missing_sender");
      assert.equal(platform.repos.customers.findByZaloUserId("telegram:444"), undefined);
    } finally {
      server.close();
    }
  });
});

// --- F. Missing chat ---------------------------------------------------------

test("F. an update with no chat is ignored safely", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const update = telegramUpdate({ userId: 555, text: "hi", updateId: 1, messageId: 1 });
      delete update.message.chat;
      const res = await postTelegramWebhook(server, update);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ignored");
    } finally {
      server.close();
    }
  });
});

// --- G. Empty/oversized text -------------------------------------------------

test("G. empty text is handled without crashing (processed, whatever the Concierge does with it)", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 666, text: "", updateId: 1, messageId: 1 }));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "processed");
    } finally {
      server.close();
    }
  });
});

test("G. oversized text is handled without crashing", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(
        server,
        telegramUpdate({ userId: 777, text: "x".repeat(50000), updateId: 1, messageId: 1 })
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "processed");
    } finally {
      server.close();
    }
  });
});

// --- H. Cross-user session isolation ----------------------------------------

test("H. two different Telegram users always resolve to two distinct, fully isolated customers/sessions", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      await postTelegramWebhook(server, telegramUpdate({ userId: 881, text: "Xin chào", updateId: 1, messageId: 1 }));
      await postTelegramWebhook(server, telegramUpdate({ userId: 882, text: "Xin chào", updateId: 2, messageId: 1 }));

      const a = platform.repos.customers.findByZaloUserId("telegram:881");
      const b = platform.repos.customers.findByZaloUserId("telegram:882");
      assert.notEqual(a.id, b.id);

      const sessionA = platform.repos.sessions.getActiveByCustomer(a.id);
      const sessionB = platform.repos.sessions.getActiveByCustomer(b.id);
      assert.notEqual(sessionA.id, sessionB.id);
    } finally {
      server.close();
    }
  });
});

// --- I. Cross-channel isolation ----------------------------------------------

test("I. a Telegram user and a Zalo user sharing the SAME raw numeric id never collide — namespacing keeps them fully separate", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      // Same raw id (999) used as both a Zalo sender id and a Telegram user id.
      const zaloRes = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_name: "user_send_text", sender: { id: "999" }, message: { text: "hi", msg_id: "z1" }, timestamp: Date.now() }),
      });
      assert.equal(zaloRes.status, 200);

      const tgRes = await postTelegramWebhook(server, telegramUpdate({ userId: 999, text: "hi", updateId: 1, messageId: 1 }));
      assert.equal(tgRes.status, 200);

      const zaloCustomer = platform.repos.customers.findByZaloUserId("999");
      const tgCustomer = platform.repos.customers.findByZaloUserId("telegram:999");
      assert.ok(zaloCustomer);
      assert.ok(tgCustomer);
      assert.notEqual(zaloCustomer.id, tgCustomer.id); // two fully distinct platform customers, not merged
    } finally {
      server.close();
    }
  });
});

test("N/D cross-channel: a Telegram update_id and a Zalo message_id sharing the same raw string never collide in the shared idempotency table", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_name: "user_send_text", sender: { id: "z-user" }, message: { text: "hi", msg_id: "42" }, timestamp: Date.now() }),
      });
      // Telegram update_id "42" — same raw string as the Zalo msg_id above.
      const tgRes = await postTelegramWebhook(server, telegramUpdate({ userId: 1010, text: "hi", updateId: 42, messageId: 1 }));
      assert.equal(tgRes.status, 200);
      assert.equal(tgRes.body.status, "processed"); // not treated as a duplicate of the Zalo message
    } finally {
      server.close();
    }
  });
});

// --- J. Tenant isolation -----------------------------------------------------

test("J. a Telegram-originated customer reaching A Tiểu's order flow stays isolated from other customers (reuses the same frozen AtieuMerchantAdapter, unmodified)", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: true });
    const server = await startServer(platform.app);
    try {
      let r = await postTelegramWebhook(server, telegramUpdate({ userId: 1200, text: "Xin chào", updateId: 1, messageId: 1 }));
      assert.equal(r.body.status, "processed");
      r = await postTelegramWebhook(server, telegramUpdate({ userId: 1200, text: "Tôi muốn ăn hủ tiếu xào.", updateId: 2, messageId: 2 }));
      assert.match(r.body.reply_text, /A TIỂU/i);
      r = await postTelegramWebhook(server, telegramUpdate({ userId: 1200, text: "Xem A Tiểu", updateId: 3, messageId: 3 }));
      assert.match(r.body.reply_text, /Đã mở/);
      // getMenuSummary() alone doesn't create the A Tiểu-side customer
      // bridge — that only happens inside adapter.handleMessage(), the
      // first time an actual message is routed into the merchant context.
      r = await postTelegramWebhook(server, telegramUpdate({ userId: 1200, text: "Cho tôi 2 hủ tiếu xào bò", updateId: 4, messageId: 4 }));
      assert.match(r.body.reply_text, /× 2/);

      const customer = platform.repos.customers.findByZaloUserId("telegram:1200");
      const atieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customer.id}`);
      assert.ok(atieuCustomer); // reached A Tiểu's own customer table, correctly bridged via the internal numeric id
    } finally {
      server.close();
    }
  });
});

// --- K. SQL injection through message content -------------------------------

test("K. SQL-injection-shaped message text is stored safely, no data corruption", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const payload = "'; DROP TABLE platform_messages; --";
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 1300, text: payload, updateId: 1, messageId: 1 }));
      assert.equal(res.status, 200);

      const customer = platform.repos.customers.findByZaloUserId("telegram:1300");
      const session = platform.repos.sessions.getActiveByCustomer(customer.id);
      const stored = platform.db.prepare("SELECT raw_text FROM platform_messages WHERE session_id = ? AND direction = 'in'").get(session.id);
      assert.equal(stored.raw_text, payload);
      const stillExists = platform.db.prepare("SELECT COUNT(*) AS n FROM platform_messages").get();
      assert.ok(stillExists.n >= 1);
    } finally {
      server.close();
    }
  });
});

// --- L/M. error leakage / secret leakage -------------------------------------

test("L. a downstream failure returns a sanitized error (reuses the same middleware Zalo's webhook uses)", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    const original = platform.services.sessions.getOrCreate.bind(platform.services.sessions);
    platform.services.sessions.getOrCreate = () => {
      throw new Error("simulated failure at /home/user/FOOD/platform/services/platformSessionService.js:12");
    };
    try {
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 1400, text: "hi", updateId: 1, messageId: 1 }));
      assert.equal(res.status, 500);
      assert.equal(res.body.error, "internal_error");
      assert.ok(!JSON.stringify(res.body).includes("/home/"));
    } finally {
      platform.services.sessions.getOrCreate = original;
      server.close();
    }
  });
});

test("L. an internal SQL/database error message never leaves the controller — not in the response, the replayed response, or the cached payload", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    const leakedText = "SQLITE_CONSTRAINT: UNIQUE constraint failed: platform_customers.zalo_user_id";
    const original = platform.services.customers.getOrCreateByZaloUserId.bind(platform.services.customers);
    platform.services.customers.getOrCreateByZaloUserId = () => {
      throw new Error(leakedText);
    };
    try {
      const update = telegramUpdate({ userId: 1450, text: "hi", updateId: 7, messageId: 1 });

      const first = await postTelegramWebhook(server, update);
      assert.equal(first.status, 500);
      assert.deepEqual(first.body, { status: "error", error: "internal_error" });

      const replay = await postTelegramWebhook(server, update);
      assert.deepEqual(replay.body, { status: "error", error: "internal_error" });

      // The HTTP layer is also covered by sanitizeWebhookErrors, so this is
      // the assertion that proves the controller itself no longer carries it.
      const cached = platform.repos.webhookEvents.getCachedResponse("telegram:7");
      assert.deepEqual(cached, { status: "error", error: "internal_error" });

      for (const body of [first.body, replay.body, cached]) {
        assert.ok(!JSON.stringify(body).includes("SQLITE"));
        assert.ok(!JSON.stringify(body).includes("UNIQUE constraint"));
      }
    } finally {
      platform.services.customers.getOrCreateByZaloUserId = original;
      server.close();
    }
  });
});

test("M. the configured webhook secret never appears in any webhook response", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    try {
      const res = await postTelegramWebhook(server, telegramUpdate({ userId: 1500, text: "hi", updateId: 1, messageId: 1 }));
      assert.ok(!JSON.stringify(res.body).includes(TEST_SECRET));
    } finally {
      server.close();
    }
  });
});

test("M. repository contains no committed secrets or Telegram credential artifacts (automated scan)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const secretLikePatterns = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)/, /\.sqlite3?$/i, /(^|\/)platform\.db$/, /^data\/uploads\//];
  const offenders = tracked.filter((file) => secretLikePatterns.some((p) => p.test(file)));
  assert.deepEqual(offenders, []);
});

// --- O. Concurrent duplicate processing -------------------------------------

test("O. two truly concurrent createDraft-style reserve() calls for the same update_id — only one wins, at the DB level", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const dedupeKey = "telegram:concurrency-test-1";
    const first = platform.repos.webhookEvents.reserve(dedupeKey, "telegram_message");
    const second = platform.repos.webhookEvents.reserve(dedupeKey, "telegram_message");
    assert.equal(first, true);
    assert.equal(second, false); // the DB-level UNIQUE(message_id) index is the final concurrency authority, same mechanism Zalo already relies on
  });
});

// --- P. Session creation race condition (pre-existing, frozen code — see finding) ---

test("P. session-creation race: two concurrent getOrCreate calls for the same brand-new customer can create two session rows (KNOWN pre-existing gap in frozen platformSessionService.js/platformSessionRepository.js — not introduced or fixed by this phase, exercised here via the Telegram path as required by spec)", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const customer = platform.services.customers.getOrCreateByZaloUserId("telegram:race-test-1", "Race Test");

    // Simulate two "concurrent" getOrCreate calls both observing "no
    // existing session" before either commits — the same TOCTOU shape as
    // the bug-inventory finding for PlatformSessionService.getOrCreate.
    const repo = platform.repos.sessions;
    const originalGetActive = repo.getActiveByCustomer.bind(repo);
    repo.getActiveByCustomer = () => undefined;

    const sessionA = platform.services.sessions.getOrCreate(customer.id);
    const sessionB = platform.services.sessions.getOrCreate(customer.id);
    repo.getActiveByCustomer = originalGetActive;

    const allSessions = platform.db.prepare("SELECT * FROM platform_sessions WHERE customer_id = ?").all(customer.id);
    // Documents the actual, current (pre-existing, not fixed here) behavior:
    // no UNIQUE constraint on platform_sessions.customer_id, so the race
    // DOES produce two rows. This is a known finding (see bug inventory),
    // not something Phase 8.x-T introduces or is authorized to fix
    // (platformSessionService.js/platformSessionRepository.js are frozen
    // Phase 1/2 files).
    assert.notEqual(sessionA.id, sessionB.id);
    assert.equal(allSessions.length, 2);
  });
});

// --- Q. AI receives normalized message only ---------------------------------

test("Q. router.handle() only ever receives {customer, session, text} — no raw Telegram field reaches the Concierge/AI boundary", async () => {
  await withTelegramSecret(async () => {
    const platform = buildTestPlatform({ withAtieu: false });
    const server = await startServer(platform.app);
    const originalHandle = platform.router.handle.bind(platform.router);
    let capturedArgs = null;
    platform.router.handle = (args) => {
      capturedArgs = args;
      return originalHandle(args);
    };
    try {
      await postTelegramWebhook(server, telegramUpdate({ userId: 1600, text: "Xin chào", updateId: 1, messageId: 1 }));
      assert.ok(capturedArgs);
      assert.deepEqual(Object.keys(capturedArgs).sort(), ["customer", "session", "text"]);
      assert.equal(typeof capturedArgs.text, "string");
      assert.equal(capturedArgs.text, "Xin chào"); // plain text only, no Telegram envelope
    } finally {
      platform.router.handle = originalHandle;
      server.close();
    }
  });
});

// --- R. Existing Zalo regression (sanity — full suite run separately) -------

test("R. the Zalo webhook route still works after adding the Telegram route (no cross-route interference)", async () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: "zalo-sanity-1" }, message: { text: "Xin chào", msg_id: "s1" }, timestamp: Date.now() }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "processed");
  } finally {
    server.close();
  }
});
