import crypto from "node:crypto";
import { platformConfig } from "../config.js";
import { logger } from "../../src/logger.js";

// Same shape as src/channel/zalo/verifySignature.js (A Tiểu's own,
// frozen) — not imported directly since that file reads A Tiểu's own
// src/config.js, not platformConfig, and src/ is frozen. This is a
// small, independent copy carrying the SAME honest caveat:
//
// BLOCKED / best-effort — Zalo OA's webhook signing scheme for the
// message endpoints could not be independently verified in this session
// (no outbound network access to developers.zalo.me or any other
// documentation source, no real OA app to confirm the header name/
// algorithm against — see Phase 8 audit). This implements the same
// commonly-referenced scheme A Tiểu's own code already encodes
// (HMAC-SHA256 of the raw body with the OA secret key, header
// `X-ZEvent-Signature`), reused rather than reinvented, but MUST be
// confirmed against real OA webhook delivery before being relied on in
// production.
//
// Disabled by default (PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK=false). Real
// protection in the meantime is network-level allowlisting plus the
// existing platform_webhook_events UNIQUE(message_id) idempotency guard
// (prevents reprocessing, not signature forgery).
export function verifyPlatformZaloSignature(rawBody, headers) {
  if (!platformConfig.enableZaloSignatureCheck) return true;
  if (!platformConfig.zaloOaSecretKey) {
    logger.warn("ZALO", "platform signature check enabled but PLATFORM_ZALO_OA_SECRET_KEY missing — rejecting");
    return false;
  }
  const signature = headers["x-zevent-signature"];
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", platformConfig.zaloOaSecretKey).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
