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

  // Telegram (Phase 8.x-T) — secondary INBOUND-only channel. telegramBotToken
  // is not read anywhere in this phase (no outbound send exists yet) —
  // reserved for a future outbound phase, per the security requirement to
  // establish the safe config pattern before the capability is built.
  // telegramWebhookSecret is used now: verified against the header
  // X-Telegram-Bot-Api-Secret-Token on every inbound webhook request.
  // PLATFORM_-prefixed because A Tiểu (src/config.js), running in this same
  // process, already owns TELEGRAM_BOT_TOKEN for its order-notification bot.
  telegramBotToken: process.env.PLATFORM_TELEGRAM_BOT_TOKEN || "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  telegramWebhookPath: process.env.TELEGRAM_WEBHOOK_PATH || "/api/platform/webhook/telegram",

  aiProvider: process.env.PLATFORM_AI_PROVIDER || "null", // "null" | "anthropic"
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

  // Menu Import vision/OCR (Phase 4) — separate toggle from the concierge
  // AI above; tests never depend on either being configured.
  menuVisionProvider: process.env.MENU_VISION_PROVIDER || "null", // "null" | "anthropic"
  menuVisionModel: process.env.MENU_VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  menuImportMaxImageBytes: Number(process.env.MENU_IMPORT_MAX_IMAGE_BYTES || 8 * 1024 * 1024),
  menuImportUploadDir: process.env.MENU_IMPORT_UPLOAD_DIR || "./data/uploads/menu-imports",

  // Generic Cart Engine (Phase 5).
  cartMaxItemQuantity: Number(process.env.CART_MAX_ITEM_QUANTITY || 50), // per line item
  cartMaxItems: Number(process.env.CART_MAX_ITEMS || 200), // distinct products per cart — resource abuse guard (security gate §50)

  // Generic Order + Dispatch Engine (Phase 6). Separate from A Tiểu's own
  // src/config.js orderCodePrefix ("AT") — platform order codes must not
  // be tagged with A Tiểu's prefix for merchants that aren't A Tiểu.
  orderCodePrefix: process.env.PLATFORM_ORDER_CODE_PREFIX || "TD",

  dbPath: process.env.PLATFORM_SQLITE_PATH || "./data/platform.db",

  // Never hard-code trial length — configurable, applied when a plan row
  // doesn't specify its own trial_days.
  defaultTrialDays: Number(process.env.DEFAULT_TRIAL_DAYS || 14),

  rateLimitWindowMs: Number(process.env.PLATFORM_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.PLATFORM_RATE_LIMIT_MAX || 60),

  logLevel: process.env.LOG_LEVEL || "info",
};
