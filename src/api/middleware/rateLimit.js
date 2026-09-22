import { config } from "../../config.js";

// Minimal in-memory fixed-window rate limiter — no Redis needed for V1
// traffic. Keyed by client IP; good enough to blunt naive abuse/retries.
export function rateLimit({ windowMs = config.rateLimitWindowMs, max = config.rateLimitMax } = {}) {
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { windowStart: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ status: "error", error: "rate_limited" });
    }
    next();
  };
}
