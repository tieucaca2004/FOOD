import { config } from "../config.js";

const ZALO_SEND_MESSAGE_URL = "https://openapi.zalo.me/v3.0/oa/message/cs";

// Sends a text message to a Zalo user via the OA "customer service" send
// endpoint (consumes reply quota — only valid within the window after the
// user's own message, same constraint as the doc's §4.3).
export async function sendTextMessage(zaloUserId, text) {
  if (!config.zaloAccessToken) {
    return { ok: false, error: "ZALO_OA_ACCESS_TOKEN not configured" };
  }

  const body = {
    recipient: { user_id: zaloUserId },
    message: { text },
  };

  const res = await fetch(ZALO_SEND_MESSAGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      access_token: config.zaloAccessToken,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    return { ok: false, error: data.message || `HTTP ${res.status}`, raw: data };
  }
  return { ok: true, raw: data };
}
