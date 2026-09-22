import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";

export function requestId(req, res, next) {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("x-request-id", req.requestId);
  const start = Date.now();
  res.on("finish", () => {
    logger.info("HTTP", `${req.method} ${req.path} ${res.statusCode}`, {
      requestId: req.requestId,
      durationMs: Date.now() - start,
    });
  });
  next();
}
