import { logger } from "../../../src/logger.js";
import { MerchantOnboardingError } from "../../services/merchantService.js";

export function platformErrorHandler(err, req, res, _next) {
  if (err instanceof MerchantOnboardingError) {
    return res.status(400).json({ status: "error", code: err.code, error: err.message });
  }
  if (err.status) {
    return res.status(err.status).json({ status: "error", error: err.message });
  }
  logger.error("HTTP", "platform unhandled error", { requestId: req.requestId, error: err.message, stack: err.stack });
  return res.status(500).json({ status: "error", error: "internal_error" });
}

export function platformNotFound(req, res) {
  res.status(404).json({ status: "error", error: "not_found" });
}
