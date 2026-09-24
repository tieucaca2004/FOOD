// Genuinely concurrent first messages from a brand-new user, over real HTTP,
// on both webhook channels. They converge on one customer and one session
// because PlatformSessionService.getOrCreate reads and inserts in a single
// synchronous call, which one Node process cannot interleave. The
// check-then-insert shape is only racy across processes sharing the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const CONCURRENT_REQUESTS = 10;

// platform/config.js loads a developer's .env; keep replies off the real Bot API.
platformConfig.telegramBotToken = "";

function sessionsFor(platform, externalId) {
  const customers = platform.db.prepare("SELECT id FROM platform_customers WHERE zalo_user_id = ?").all(externalId);
  const sessions = customers.length
    ? platform.db.prepare("SELECT id FROM platform_sessions WHERE customer_id = ?").all(customers[0].id)
    : [];
  return { customers: customers.length, sessions: sessions.length };
}

test("BUG-005 guard: concurrent first messages on the Zalo webhook create one customer and one session", async () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event_name: "user_send_text", sender: { id: "race-zalo-1" }, message: { text: "Xin chào", msg_id: `rz-${i}` }, timestamp: Date.now() }),
        }).then((r) => r.json())
      )
    );
    assert.deepEqual(sessionsFor(platform, "race-zalo-1"), { customers: 1, sessions: 1 });
  } finally {
    server.close();
  }
});

test("BUG-005 guard: concurrent first messages on the Telegram webhook create one customer and one session", async () => {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = "test-session-race-secret";
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-session-race-secret" },
          body: JSON.stringify({
            update_id: 700000 + i,
            message: { message_id: i + 1, from: { id: 8800001, is_bot: false, first_name: "R" }, chat: { id: 8800001, type: "private" }, date: 1, text: "Xin chào" },
          }),
        }).then((r) => r.json())
      )
    );
    assert.deepEqual(sessionsFor(platform, "telegram:8800001"), { customers: 1, sessions: 1 });
  } finally {
    platformConfig.telegramWebhookSecret = originalSecret;
    server.close();
  }
});
