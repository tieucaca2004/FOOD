import { platformConfig } from "../config.js";
import { logger } from "../../src/logger.js";

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

// Same retry/timeout/error-handling shape as src/channel/zalo/client.js,
// but bound to the Tổng Đài OA's own credential (platformConfig), which is
// a different Zalo OA account than any merchant's — hence a separate
// client rather than reusing A Tiểu's (which is wired to A Tiểu's token).
// `fetchImpl` is injectable (same pattern A Tiểu's own sendTextMessage
// already uses) so tests can exercise retry/timeout/error handling
// deterministically, without a real network call.
export async function sendPlatformTextMessage(zaloUserId, text, { fetchImpl = fetchWithTimeout } = {}) {
  if (!platformConfig.zaloAccessToken) {
    logger.warn("ZALO", "PLATFORM_ZALO_OA_ACCESS_TOKEN not configured, skipping send", { zaloUserId });
    return { ok: false, error: "PLATFORM_ZALO_OA_ACCESS_TOKEN not configured" };
  }

  const body = JSON.stringify({ recipient: { user_id: zaloUserId }, message: { text } });
  let lastError;

  for (let attempt = 1; attempt <= platformConfig.zaloSendRetries; attempt++) {
    try {
      const res = await fetchImpl(
        SEND_MESSAGE_URL,
        { method: "POST", headers: { "content-type": "application/json", access_token: platformConfig.zaloAccessToken }, body },
        platformConfig.zaloSendTimeoutMs
      );
      const data = await res.json().catch(() => ({}));

      if (res.ok && !data.error) return { ok: true, raw: data };
      if (res.status >= 400 && res.status < 500) {
        logger.error("ZALO", "platform send failed (client error, not retrying)", { zaloUserId, status: res.status });
        return { ok: false, error: data.message || `HTTP ${res.status}`, raw: data };
      }
      lastError = data.message || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.name === "AbortError" ? "timeout" : err.message;
    }
    logger.warn("ZALO", "platform send attempt failed, will retry", { zaloUserId, attempt, error: lastError });
    if (attempt < platformConfig.zaloSendRetries) await sleep(300 * attempt);
  }

  logger.error("ZALO", "platform send failed after retries", { zaloUserId, error: lastError });
  return { ok: false, error: lastError };
}
