import { verifyPlatformZaloSignature } from "../../channel/verifyZaloSignature.js";
import { logger } from "../../../src/logger.js";

// Applied in front of the platform webhook route (see platform/api/app.js)
// — this is the Part 4 "reject invalid webhook requests" gate. Kept as
// standalone middleware rather than folded into webhookController.js so
// that file (Phase 1/2 era) needs no change at all — this only adds a
// gate in front of it (Phase 8).
export function zaloWebhookSecurity(req, res, next) {
  if (!verifyPlatformZaloSignature(req.rawBody || "", req.headers)) {
    logger.warn("WEBHOOK", "platform signature verification failed", { requestId: req.requestId });
    return res.status(401).json({ status: "error", error: "invalid signature" });
  }
  next();
}
