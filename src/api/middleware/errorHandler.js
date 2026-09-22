import { logger } from "../../logger.js";
import { CartError } from "../../services/cartService.js";
import { OrderError } from "../../services/orderService.js";

export function errorHandler(err, req, res, _next) {
  if (err instanceof CartError) {
    return res.status(400).json({ status: "error", code: err.code, error: err.message });
  }
  if (err instanceof OrderError) {
    return res.status(err.status || 400).json({ status: "error", code: err.code, error: err.message });
  }
  if (err.code === "INVALID_TRANSITION") {
    return res.status(409).json({ status: "error", code: err.code, error: err.message });
  }

  logger.error("HTTP", "unhandled error", { requestId: req.requestId, error: err.message, stack: err.stack });
  return res.status(500).json({ status: "error", error: "internal_error" });
}

export function notFound(req, res) {
  res.status(404).json({ status: "error", error: "not_found" });
}
