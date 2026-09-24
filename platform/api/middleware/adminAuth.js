import { createHash, timingSafeEqual } from "node:crypto";
import { platformConfig } from "../../config.js";
import { logger } from "../../../src/logger.js";

// Shorter values are refused outright: the admin token is the only thing
// between the internet (via the webhook tunnel) and merchant onboarding,
// status changes and merchant API-key issuance.
export const ADMIN_TOKEN_MIN_LENGTH = 32;

const BEARER = /^Bearer ([^\s,]+)$/;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

// The configured admin token, or null when it is missing or too weak to use.
export function configuredAdminToken() {
  const token = platformConfig.adminApiToken;
  if (typeof token !== "string" || token.trim().length < ADMIN_TOKEN_MIN_LENGTH) return null;
  return token;
}

function reject(req, res, status, error, reason) {
  // Never log the Authorization header or any part of the presented token.
  logger.warn("HTTP", "admin request rejected", { requestId: req.requestId, method: req.method, path: req.baseUrl + req.path, reason });
  if (status === 401) res.set("WWW-Authenticate", "Bearer");
  return res.status(status).json({ status: "error", error });
}

// Platform admin boundary. Fails closed: with no usable
// PLATFORM_ADMIN_API_TOKEN configured, every admin request is refused.
// Merchant API keys are a separate credential and never pass this check.
export function adminAuth() {
  return function adminAuthMiddleware(req, res, next) {
    const expected = configuredAdminToken();
    if (!expected) return reject(req, res, 503, "admin_api_disabled", "admin token not configured");

    const match = BEARER.exec(req.headers.authorization || "");
    if (!match) return reject(req, res, 401, "unauthenticated", "missing or malformed credential");

    // Equal-length digests keep the comparison constant-time regardless of
    // the presented token's length.
    if (!timingSafeEqual(digest(match[1]), digest(expected))) {
      return reject(req, res, 401, "unauthenticated", "invalid credential");
    }
    next();
  };
}
