import { config } from "../../config.js";
import { logger } from "../../logger.js";

const SEND_MESSAGE_URL = "https://openapi.zalo.me/v3.0/oa/message/cs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Sends a text message to a Zalo user via the OA "customer service" send
// endpoint. Retries transient failures (network error, 5xx, timeout) with
// backoff; never retries a definitive client error (4xx) from Zalo.
export async function sendTextMessage(zaloUserId, text, { fetchImpl = fetchWithTimeout } = {}) {
  if (!config.zaloAccessToken) {
    logger.warn("ZALO", "ZALO_OA_ACCESS_TOKEN not configured, skipping send", { zaloUserId });
    return { ok: false, error: "ZALO_OA_ACCESS_TOKEN not configured" };
  }

  const body = JSON.stringify({ recipient: { user_id: zaloUserId }, message: { text } });
  let lastError;

  for (let attempt = 1; attempt <= config.zaloSendRetries; attempt++) {
    try {
      const res = await fetchImpl(
        SEND_MESSAGE_URL,
        {
          method: "POST",
          headers: { "content-type": "application/json", access_token: config.zaloAccessToken },
          body,
        },
        config.zaloSendTimeoutMs
      );
      const data = await res.json().catch(() => ({}));

      if (res.ok && !data.error) {
        return { ok: true, raw: data };
      }

      if (res.status >= 400 && res.status < 500) {
        logger.error("ZALO", "send failed (client error, not retrying)", {
          zaloUserId,
          status: res.status,
          error: data.message,
        });
        return { ok: false, error: data.message || `HTTP ${res.status}`, raw: data };
      }

      lastError = data.message || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.name === "AbortError" ? "timeout" : err.message;
    }

    logger.warn("ZALO", "send attempt failed, will retry", { zaloUserId, attempt, error: lastError });
    if (attempt < config.zaloSendRetries) await sleep(300 * attempt);
  }

  logger.error("ZALO", "send failed after retries", { zaloUserId, error: lastError });
  return { ok: false, error: lastError };
}
