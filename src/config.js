import "dotenv/config";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export const config = {
  port: Number(process.env.PORT || 3900),
  nodeEnv: process.env.NODE_ENV || "development",

  webhookPath: process.env.WEBHOOK_PATH || "/zalo/webhook",

  // Zalo OA
  zaloAccessToken: process.env.ZALO_OA_ACCESS_TOKEN || "",
  zaloOaSecretKey: process.env.ZALO_OA_SECRET_KEY || "",
  zaloOaId: process.env.ZALO_OA_ID || "",
  zaloSendRetries: Number(process.env.ZALO_SEND_RETRIES || 3),
  zaloSendTimeoutMs: Number(process.env.ZALO_SEND_TIMEOUT_MS || 8000),

  // AI provider (optional — never authoritative for price/state, see src/ai)
  aiProvider: process.env.AI_PROVIDER || "null", // "null" | "anthropic"
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

  // Intent engine
  minConfidence: Number(process.env.MIN_CONFIDENCE || 0.6),

  // Persistence
  dbPath: process.env.SQLITE_PATH || process.env.DB_PATH || "./data/atieu.db",

  // Notifications
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",

  // Business
  orderCodePrefix: process.env.ORDER_CODE_PREFIX || "AT",
  maxItemQuantity: Number(process.env.MAX_ITEM_QUANTITY || 50),

  // Security
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 60),
  enableZaloSignatureCheck: bool(process.env.ENABLE_ZALO_SIGNATURE_CHECK, false),

  logLevel: process.env.LOG_LEVEL || "info",
};
