import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTelegramSecret } from "../../channel/telegram/verifyTelegramSecret.js";
import { platformConfig } from "../../config.js";

function withSecret(secret, fn) {
  const original = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = secret;
  try {
    return fn();
  } finally {
    platformConfig.telegramWebhookSecret = original;
  }
}

test("A. no secret configured: fail-closed — every request rejected, even a plausible-looking header", () => {
  withSecret("", () => {
    assert.equal(verifyTelegramSecret({ "x-telegram-bot-api-secret-token": "anything" }), false);
    assert.equal(verifyTelegramSecret({}), false);
  });
});

test("A. correct secret token header is accepted", () => {
  withSecret("my-webhook-secret-123", () => {
    assert.equal(verifyTelegramSecret({ "x-telegram-bot-api-secret-token": "my-webhook-secret-123" }), true);
  });
});

test("A/B. missing header is rejected", () => {
  withSecret("my-webhook-secret-123", () => {
    assert.equal(verifyTelegramSecret({}), false);
  });
});

test("A/B. wrong secret token is rejected", () => {
  withSecret("my-webhook-secret-123", () => {
    assert.equal(verifyTelegramSecret({ "x-telegram-bot-api-secret-token": "wrong-value" }), false);
  });
});

test("a header value of a different length than the real secret is rejected without throwing (timingSafeEqual length mismatch)", () => {
  withSecret("short", () => {
    assert.equal(verifyTelegramSecret({ "x-telegram-bot-api-secret-token": "a-much-longer-value-than-the-real-secret" }), false);
  });
});

test("malformed header value types (array, number, object) never throw", () => {
  withSecret("my-webhook-secret-123", () => {
    for (const bad of [["array"], 12345, {}, null]) {
      assert.doesNotThrow(() => verifyTelegramSecret({ "x-telegram-bot-api-secret-token": bad }));
      assert.equal(verifyTelegramSecret({ "x-telegram-bot-api-secret-token": bad }), false);
    }
  });
});
