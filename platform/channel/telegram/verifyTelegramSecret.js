import crypto from "node:crypto";
import { platformConfig } from "../../config.js";
import { logger } from "../../../src/logger.js";

// Verified against a direct scrape of the official Telegram Bot API docs
// (core.telegram.org itself unreachable from this environment — see
// Phase 8.x-T audit): setWebhook's `secret_token` parameter is echoed
// back on every webhook POST in the `X-Telegram-Bot-Api-Secret-Token`
// header; the official docs state the receiving server "must immediately
// reject" a request where the header is missing or the value doesn't
// match, typically with 401.
//
// Unlike Zalo's signature check (Phase 8, disabled by default because the
// scheme itself was genuinely unverifiable), this is fail-closed by
// design: Telegram's mechanism is simple, official, and confirmed — if no
// secret is configured, every request is rejected rather than silently
// accepted unverified. This channel is being built new, so there is no
// "already shipped, can't break it" reason to default it open.
export function verifyTelegramSecret(headers) {
  if (!platformConfig.telegramWebhookSecret) {
    logger.warn("TELEGRAM", "no TELEGRAM_WEBHOOK_SECRET configured — rejecting all webhook requests");
    return false;
  }
  const provided = headers["x-telegram-bot-api-secret-token"];
  if (!provided || typeof provided !== "string") return false;

  const expected = platformConfig.telegramWebhookSecret;
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
