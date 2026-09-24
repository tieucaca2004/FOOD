import { platformConfig } from "../../config.js";
import { logger } from "../../../src/logger.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The Bot API puts the token in the URL path, so any error text derived from
// the request could carry it; strip it before logging or returning.
function redactToken(value, token) {
  return String(value ?? "").split(token).join("<redacted>");
}

// Tổng Đài's own bot (PLATFORM_TELEGRAM_BOT_TOKEN), never A Tiểu's
// TELEGRAM_BOT_TOKEN. Never throws: callers get { ok, error? }.
// No retries — this runs inside the webhook request Telegram is waiting on.
export async function sendTelegramMessage({ chatId, text }, { fetchImpl = fetchWithTimeout } = {}) {
  const token = platformConfig.telegramBotToken;
  if (!token) {
    logger.warn("TELEGRAM", "PLATFORM_TELEGRAM_BOT_TOKEN not configured, skipping send", { chatId });
    return { ok: false, error: "PLATFORM_TELEGRAM_BOT_TOKEN not configured" };
  }

  try {
    const res = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok === true) return { ok: true };

    const error = redactToken(data.description || `HTTP ${res.status}`, token);
    logger.error("TELEGRAM", "sendMessage rejected", { chatId, status: res.status, error });
    return { ok: false, status: res.status, error };
  } catch (err) {
    const error = err.name === "AbortError" ? "timeout" : redactToken(err.cause?.code || err.message, token);
    logger.error("TELEGRAM", "sendMessage failed", { chatId, error });
    return { ok: false, error };
  }
}
