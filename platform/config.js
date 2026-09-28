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

  // Telegram (Phase 8.x-T) — secondary channel. telegramBotToken is used by
  // platform/channel/telegram/telegramClient.js to send replies back.
  // telegramWebhookSecret is verified against the header
  // X-Telegram-Bot-Api-Secret-Token on every inbound webhook request.
  // PLATFORM_-prefixed because A Tiểu (src/config.js), running in this same
  // process, already owns TELEGRAM_BOT_TOKEN for its order-notification bot.
  telegramBotToken: process.env.PLATFORM_TELEGRAM_BOT_TOKEN || "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  telegramWebhookPath: process.env.TELEGRAM_WEBHOOK_PATH || "/api/platform/webhook/telegram",

  aiProvider: process.env.PLATFORM_AI_PROVIDER || "null", // "null" | "anthropic"
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

  // GPT Food Concierge (OpenAI Responses API + FOOD tool registry + Fact Guard). OFF unless
  // OPENAI_ENABLED=true AND a key is set; the model comes from OPENAI_MODEL. Deterministic
  // handling stays the default and the fallback for every failure.
  openaiEnabled: process.env.OPENAI_ENABLED === "true",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.6-terra", // configurable; business logic never names a model
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000), // whole turn, all model calls together
  openaiMaxToolTurns: Number(process.env.OPENAI_MAX_TOOL_TURNS || 6),
  // FOOD Agent (the GPT concierge as orchestration layer): its model (default: OPENAI_MODEL) and how many earlier
  // turns of the conversation it reads for understanding (facts still come only from tools; 0 = none)
  foodAgentModel: process.env.FOOD_AGENT_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
  foodAgentHistoryTurns: Math.max(0, Number(process.env.FOOD_AGENT_HISTORY_TURNS ?? 6)),
  // controlled learning: the Agent may PROPOSE how a dish is called (DRAFT term relations in the WORKING knowledge DB,
  // for a person to approve); it never publishes. OFF by default; only when the Agent itself runs.
  foodAgentLearningEnabled: process.env.FOOD_AGENT_LEARNING_ENABLED === "true",
  // stateless calls (store=false); reasoning items are echoed back encrypted between tool turns
  openaiIncludeReasoning: process.env.OPENAI_INCLUDE_REASONING !== "false",

  // GPT concierge knowledge layers (independent, OFF by default; only used when the GPT concierge is on):
  // founder guidance (FK-1, APPROVED customer items) and food-name / alias recognition (APPROVED term relations).
  founderKnowledgeEnabled: process.env.FOUNDER_KNOWLEDGE_ENABLED === "true",
  foodAliasKnowledgeEnabled: process.env.FOOD_ALIAS_KNOWLEDGE_ENABLED === "true",
  // structured search intent (dish / place / location / price / follow-up) given to the GPT concierge as context
  searchIntelligenceEnabled: process.env.SEARCH_INTELLIGENCE_ENABLED === "true",

  // Telegram Model Router (FORM 11): /models, /model <id>. FOOD Agent stays the default for everyone; Claude CLI is a
  // TEXT-ONLY backend (every tool disabled) for the Telegram user ids listed here only — OFF unless enabled AND listed.
  claudeCliEnabled: process.env.CLAUDE_CLI_ENABLED === "true",
  claudeCliTelegramUserIds: (process.env.CLAUDE_CLI_TELEGRAM_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  claudeCliPath: process.env.CLAUDE_CLI_PATH || "", // the claude executable (never a .cmd/.ps1 shim); empty = auto-detect
  claudeCliModel: process.env.CLAUDE_CLI_MODEL || "", // empty = the CLI's own default
  claudeCliTimeoutMs: Number(process.env.CLAUDE_CLI_TIMEOUT_MS || 60000),
  claudeCliMaxConcurrent: Number(process.env.CLAUDE_CLI_MAX_CONCURRENT || 2),
  modelSelectionTtlMinutes: Number(process.env.MODEL_SELECTION_TTL_MINUTES || 720), // idle selection -> back to default

  // Knowledge Ingestion (Knowledge Group -> evidence -> review). OFF by default. Writes the WORKING
  // knowledge DB (the collector's), never the runtime snapshot customers read; nothing is published
  // automatically (review only).
  knowledgeIngestEnabled: process.env.KNOWLEDGE_INGEST_ENABLED === "true",
  knowledgeIngestDbPath: process.env.KNOWLEDGE_INGEST_DB_PATH || "./data/normalized/pilot/knowledge.db",
  knowledgeIngestRawRoot: process.env.KNOWLEDGE_INGEST_RAW_ROOT || "./data/raw",
  knowledgeGroupChatIds: (process.env.KNOWLEDGE_GROUP_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),

  // Customer contributions (Multimodal Knowledge Ingestion V1): images / text a CUSTOMER sends in the chat become
  // evidence -> candidates (unverified) in the same WORKING knowledge DB as the Knowledge Group. OFF by default, and
  // fail-closed: without a hash key (>= 32 bytes) nothing is stored. Candidates are never published automatically.
  userContributionsEnabled: process.env.USER_CONTRIBUTIONS_ENABLED === "true",
  contributorHashKey: process.env.KNOWLEDGE_CONTRIBUTOR_HASH_KEY || "",
  contributorHashKid: process.env.KNOWLEDGE_CONTRIBUTOR_HASH_KID || "k1",
  // image reader: "null" (store evidence, read nothing) | "openai"
  imageUnderstandingProvider: process.env.IMAGE_UNDERSTANDING_PROVIDER || "null",
  imageUnderstandingModel: process.env.IMAGE_UNDERSTANDING_MODEL || process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
  imageUnderstandingTimeoutMs: Number(process.env.IMAGE_UNDERSTANDING_TIMEOUT_MS || 45000),
  contributionMaxImageBytes: Number(process.env.CONTRIBUTION_MAX_IMAGE_BYTES || 10 * 1024 * 1024),
  contributionMaxImagesPerDay: Number(process.env.CONTRIBUTION_MAX_IMAGES_PER_DAY || 20),
  contributionMaxImagesPerAlbum: Number(process.env.CONTRIBUTION_MAX_IMAGES_PER_ALBUM || 5),
  contributionPendingTtlMinutes: Number(process.env.CONTRIBUTION_PENDING_TTL_MINUTES || 30),
  // Zalo attachment URLs are fetched only from these host suffixes (https only; SSRF guard)
  zaloMediaHosts: (process.env.ZALO_MEDIA_HOSTS || "zdn.vn,zadn.vn,zalo.me,zaloapp.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Menu Import vision/OCR (Phase 4) — separate toggle from the concierge
  // AI above; tests never depend on either being configured.
  menuVisionProvider: process.env.MENU_VISION_PROVIDER || "null", // "null" | "anthropic" | "openai"
  // MENU_VISION_PROVIDER=openai: the model that reads menu photos (default: OPENAI_MODEL); proposal only, never publishes
  menuVisionOpenAIModel: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-terra",
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

  // Engine serving A Tiểu (ATIEU001) — see platform/db/seed.js. "legacy"
  // (default, src/ module with its own shop notification) | "generic".
  atieuEngine: process.env.PLATFORM_ATIEU_ENGINE === "generic" ? "generic" : "legacy",

  // Food Knowledge discovery (read-only, separate knowledge.db). Off by
  // default: when false the knowledge layer is never even loaded.
  foodKnowledgeDiscoveryEnabled: process.env.FOOD_KNOWLEDGE_DISCOVERY_ENABLED === "true",
  knowledgeDbPath: process.env.KNOWLEDGE_SQLITE_PATH || "./data/knowledge/knowledge.db",

  // Never hard-code trial length — configurable, applied when a plan row
  // doesn't specify its own trial_days.
  defaultTrialDays: Number(process.env.DEFAULT_TRIAL_DAYS || 14),

  rateLimitWindowMs: Number(process.env.PLATFORM_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.PLATFORM_RATE_LIMIT_MAX || 60),

  logLevel: process.env.LOG_LEVEL || "info",
};
