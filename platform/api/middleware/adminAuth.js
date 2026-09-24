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

// Other credentials the admin token must never equal. The Telegram webhook
// secret in particular travels in every webhook request.
const OTHER_SECRETS = ["telegramWebhookSecret", "telegramBotToken", "zaloAccessToken", "zaloOaSecretKey", "anthropicApiKey"];

// Why the configured admin token cannot be used, or null when it can. The
// reasons name the problem, never the value.
export function adminTokenProblem() {
  const token = platformConfig.adminApiToken;
  if (typeof token !== "string" || token.trim() === "") return "is not set";
  if (token.trim().length < ADMIN_TOKEN_MIN_LENGTH) return `is shorter than ${ADMIN_TOKEN_MIN_LENGTH} characters`;
  if (/[\s,]/.test(token)) return "contains whitespace or commas, which a Bearer header cannot carry";
  if (OTHER_SECRETS.some((field) => platformConfig[field] && platformConfig[field] === token)) return "reuses another configured credential";
  return null;
}

// The configured admin token, or null when it is missing or unusable.
export function configuredAdminToken() {
  return adminTokenProblem() ? null : platformConfig.adminApiToken;
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
