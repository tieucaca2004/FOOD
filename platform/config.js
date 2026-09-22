import "dotenv/config";

// Platform (Tổng Đài) config — fully separate from the A Tiểu merchant
// module's src/config.js. Different OA, different DB, different port.
export const platformConfig = {
  port: Number(process.env.PLATFORM_PORT || 3901),
  webhookPath: process.env.PLATFORM_WEBHOOK_PATH || "/platform/webhook",

  // Tổng Đài's own Zalo OA — a different OA account than any merchant's.
  zaloAccessToken: process.env.PLATFORM_ZALO_OA_ACCESS_TOKEN || "",
  zaloOaSecretKey: process.env.PLATFORM_ZALO_OA_SECRET_KEY || "",
  zaloSendRetries: Number(process.env.PLATFORM_ZALO_SEND_RETRIES || 3),
  zaloSendTimeoutMs: Number(process.env.PLATFORM_ZALO_SEND_TIMEOUT_MS || 8000),
  enableZaloSignatureCheck: process.env.PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK === "true",

  aiProvider: process.env.PLATFORM_AI_PROVIDER || "null", // "null" | "anthropic"
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

  // Menu Import vision/OCR (Phase 4) — separate toggle from the concierge
  // AI above; tests never depend on either being configured.
  menuVisionProvider: process.env.MENU_VISION_PROVIDER || "null", // "null" | "anthropic"
  menuVisionModel: process.env.MENU_VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  menuImportMaxImageBytes: Number(process.env.MENU_IMPORT_MAX_IMAGE_BYTES || 8 * 1024 * 1024),
  menuImportUploadDir: process.env.MENU_IMPORT_UPLOAD_DIR || "./data/uploads/menu-imports",

  dbPath: process.env.PLATFORM_SQLITE_PATH || "./data/platform.db",

  // Never hard-code trial length — configurable, applied when a plan row
  // doesn't specify its own trial_days.
  defaultTrialDays: Number(process.env.DEFAULT_TRIAL_DAYS || 14),

  rateLimitWindowMs: Number(process.env.PLATFORM_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.PLATFORM_RATE_LIMIT_MAX || 60),

  logLevel: process.env.LOG_LEVEL || "info",
};
