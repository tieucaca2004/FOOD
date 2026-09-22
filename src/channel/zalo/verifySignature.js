import crypto from "node:crypto";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

// BLOCKED / best-effort: Zalo OA's webhook signing scheme for the message
// endpoints is not consistently documented and we have no real OA app to
// verify the exact header name/algorithm against. This implements the
// commonly-referenced scheme (HMAC-SHA256 of the raw body with the OA
// secret key, header `X-ZEvent-Signature`) but MUST be confirmed against
// your OA app's actual webhook delivery before relying on it in production
// — see README "Zalo OA configuration" section.
//
// Disabled by default (ENABLE_ZALO_SIGNATURE_CHECK=false). The webhook
// route's real protection in the meantime is nginx/allowlist + idempotency,
// same posture as the source architecture doc.
export function verifyZaloSignature(rawBody, headers) {
  if (!config.enableZaloSignatureCheck) return true;
  if (!config.zaloOaSecretKey) {
    logger.warn("ZALO", "signature check enabled but ZALO_OA_SECRET_KEY missing — rejecting");
    return false;
  }
  const signature = headers["x-zevent-signature"];
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", config.zaloOaSecretKey).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
