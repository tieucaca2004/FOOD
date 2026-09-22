import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 3900),
  webhookPath: process.env.WEBHOOK_PATH || "/zalo/webhook",
  zaloAccessToken: process.env.ZALO_OA_ACCESS_TOKEN || "",
  zaloAppSecret: process.env.ZALO_OA_APP_SECRET || "",
  minConfidence: Number(process.env.MIN_CONFIDENCE || 0.6),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  dbPath: process.env.DB_PATH || "./data/support.db",
};
