import { verifyTelegramSecret } from "../../channel/telegram/verifyTelegramSecret.js";
import { logger } from "../../../src/logger.js";

export function telegramWebhookSecurity(req, res, next) {
  if (!verifyTelegramSecret(req.headers)) {
    logger.warn("WEBHOOK", "telegram secret token verification failed", { requestId: req.requestId });
    return res.status(401).json({ status: "error", error: "invalid secret token" });
  }
  next();
}
