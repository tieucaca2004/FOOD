import { logger } from "../../../src/logger.js";
import { MerchantOnboardingError } from "../../services/merchantService.js";

// express.json (body-parser) errors: their messages echo request input
// (body fragments, charset/encoding values), so they get a fixed public code.
const BODY_PARSER_ERROR_TYPES = new Set(["entity.parse.failed", "entity.too.large", "charset.unsupported", "encoding.unsupported"]);

export function platformErrorHandler(err, req, res, _next) {
  if (err instanceof MerchantOnboardingError) {
    return res.status(400).json({ status: "error", code: err.code, error: err.message });
  }
  if (BODY_PARSER_ERROR_TYPES.has(err.type) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ status: "error", error: "invalid_request_body" });
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
