import { platformConfig } from "./config.js";
import { logger } from "../src/logger.js";
import { createPlatformConnection, runPlatformMigrations } from "./db/connection.js";
import { runPlatformSeed } from "./db/seed.js";
import { createPlatformRepositories } from "./repositories/index.js";
import { createPlatformServices } from "./services/index.js";
import { createConciergeAIProvider, createGptFoodConcierge, createConversationImageReader } from "./ai/index.js";
import { MerchantRegistry, buildAtieuAdapterFactory, buildGenericAdapterFactory } from "./merchant/MerchantRegistry.js";
import { MerchantRouter } from "./merchant/MerchantRouter.js";
import { DiscoveryEngine } from "./discovery/DiscoveryEngine.js";
import { AgentSearchService } from "./services/agentSearchService.js";
import { PlatformRouter } from "./router/PlatformRouter.js";
import { createPlatformApp } from "./api/app.js";
import { adminTokenProblem } from "./api/middleware/adminAuth.js";

// A Tiểu's own engine, imported UNCHANGED — this is the "Merchant Matrix"
// running in-process, exactly as it does standalone via src/server.js. The
// platform never edits, forks, or re-implements any of this.
import { config as atieuConfig } from "../src/config.js";
import { createConnection as createAtieuConnection, runMigrations as runAtieuMigrations } from "../src/db/connection.js";
import { runSeed as runAtieuSeed } from "../src/db/seed.js";
import { createRepositories as createAtieuRepositories } from "../src/repositories/index.js";
import { createServices as createAtieuServices } from "../src/services/index.js";
import { createAIProvider as createAtieuAIProvider } from "../src/ai/index.js";
import { BusinessRouter as AtieuBusinessRouter } from "../src/router/businessRouter.js";

const platformDb = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(platformDb);
runPlatformSeed(platformDb); // idempotent, registers only the real ATIEU001 merchant

const repos = createPlatformRepositories(platformDb);
const services = createPlatformServices(repos);
const ai = createConciergeAIProvider();
// Learning-event retention: only normalized phrases are stored, and only for a bounded window.
services.productLanguage.pruneEvents();

// Boot A Tiểu's engine against its own DB/config, completely as-is.
const atieuDb = createAtieuConnection(atieuConfig.dbPath);
runAtieuMigrations(atieuDb);
runAtieuSeed(atieuDb);
const atieuRepos = createAtieuRepositories(atieuDb);
const atieuServices = createAtieuServices(atieuRepos);
const atieuAI = createAtieuAIProvider();
const atieuRouter = new AtieuBusinessRouter(atieuServices, atieuAI);

const registry = new MerchantRegistry({
  repos,
  moduleFactories: {
    atieu: buildAtieuAdapterFactory({ services: atieuServices, router: atieuRouter }),
    generic: buildGenericAdapterFactory({
      menuService: services.menu,
      merchantDataService: services.merchantData,
      cartService: services.cart,
      orderService: services.orders,
      conversationStates: repos.conversationStates,
      cartCheckout: repos.cartCheckout,
      productLanguage: services.productLanguage,
      customerMemory: services.customerMemory,
    }),
  },
});

const merchantRouter = new MerchantRouter(registry);
const discovery = new DiscoveryEngine(services.merchantData, registry);
// Food Knowledge discovery: loaded ONLY when explicitly enabled (default off);
// read-only; a missing/broken knowledge.db leaves it disabled, never breaks boot.
let foodKnowledge = null;
if (platformConfig.foodKnowledgeDiscoveryEnabled) {
  try {
    const { createFoodKnowledge } = await import("./services/foodKnowledgeAdapter.js");
    foodKnowledge = createFoodKnowledge({ dbPath: platformConfig.knowledgeDbPath, services, isRoutable: (m) => merchantRouter.isRoutable(m) });
    logger.info("APP", "food knowledge discovery enabled (read-only)", { dbPath: platformConfig.knowledgeDbPath });
  } catch (err) {
    logger.warn("APP", "food knowledge discovery NOT enabled", { error: err.message });
  }
}
const agentSearch = new AgentSearchService({ discovery, registry, foodKnowledge });

// Customer contributions (Multimodal Knowledge Ingestion V1): loaded ONLY when USER_CONTRIBUTIONS_ENABLED=true AND a
// contributor hash key (>= 32 bytes) exists — fail-closed. Writes the WORKING knowledge DB (evidence + unverified
// candidates for review); never the catalog, a price, orderability, a cart or an order.
let contributionService = null;
if (platformConfig.userContributionsEnabled) {
  try {
    const { createContributionIngest, telegramFileFetcher } = await import("./services/knowledgeIngestAdapter.js");
    const { ContributionService } = await import("./services/contributionService.js");
    const { zaloMediaFetcher } = await import("./channel/zalo/zaloMedia.js");
    const { createImageUnderstanding } = await import("./ai/ingest/index.js");
    const { sendTelegramMessage } = await import("./channel/telegram/telegramClient.js");
    const { sendPlatformTextMessage } = await import("./channel/zaloClient.js");
    const reader = await createImageUnderstanding();
    const ingest = createContributionIngest({
      dbPath: platformConfig.knowledgeIngestDbPath,
      rawRoot: platformConfig.knowledgeIngestRawRoot,
      hashKey: platformConfig.contributorHashKey,
      hashKid: platformConfig.contributorHashKid,
      ...reader.asReaders(),
      fetchTelegram: platformConfig.telegramBotToken ? telegramFileFetcher({ botToken: platformConfig.telegramBotToken, fetchImpl: globalThis.fetch }) : null,
      fetchZalo: zaloMediaFetcher({ hosts: platformConfig.zaloMediaHosts, maxBytes: platformConfig.contributionMaxImageBytes }),
      logger,
      pendingTtlMs: platformConfig.contributionPendingTtlMinutes * 60_000,
      maxImageBytes: platformConfig.contributionMaxImageBytes,
    });
    if (!ingest) logger.warn("APP", "customer contributions NOT enabled: KNOWLEDGE_CONTRIBUTOR_HASH_KEY missing or shorter than 32 bytes");
    else {
      const send = (target, text) => (target.channel === "telegram" ? sendTelegramMessage({ chatId: target.chatId, text }) : sendPlatformTextMessage(target.userId, text));
      contributionService = new ContributionService({ ingest, services, repos, foodKnowledge, send, logger, maxImagesPerDay: platformConfig.contributionMaxImagesPerDay, maxImagesPerAlbum: platformConfig.contributionMaxImagesPerAlbum });
      logger.info("APP", "customer contributions enabled (review only)", { reader: reader.name, model: reader.model ?? null, dbPath: platformConfig.knowledgeIngestDbPath });
    }
  } catch (err) {
    logger.warn("APP", "customer contributions NOT enabled", { error: err.message });
  }
}

// GPT FOOD concierge: only when OPENAI_ENABLED=true with a key and a model; otherwise fully deterministic.
const gpt = await createGptFoodConcierge({ services, repos, agentSearch, merchantRouter, logger, contributions: contributionService });
// the model the Agent's provider actually calls (FOOD_AGENT_MODEL > OPENAI_MODEL > default), not OPENAI_MODEL alone
if (gpt) logger.info("APP", "gpt food concierge enabled", { model: gpt.provider?.model ?? platformConfig.foodAgentModel, timeoutMs: platformConfig.openaiTimeoutMs, maxToolTurns: platformConfig.openaiMaxToolTurns });
else if (platformConfig.openaiEnabled) logger.warn("APP", "gpt food concierge NOT enabled: OPENAI_API_KEY or OPENAI_MODEL missing");
// FOOD Agent multimodal conversation (FORM 15): a customer's photo -> the existing media fetchers + image reader ->
// UNVERIFIED evidence for the Agent. Only with the Agent itself (its model, FOOD_AGENT_MODEL); independent of customer
// contributions. Without it, a photo still gets a plain reply (never silence).
let images = null;
if (gpt) {
  try {
    const { customerImageEvidence, telegramFileFetcher } = await import("./services/knowledgeIngestAdapter.js");
    const { zaloMediaFetcher } = await import("./channel/zalo/zaloMedia.js");
    const { createImageConversation } = await import("./services/imageConversation.js");
    const reader = await createConversationImageReader();
    images = createImageConversation({
      fetchTelegram: platformConfig.telegramBotToken ? telegramFileFetcher({ botToken: platformConfig.telegramBotToken, fetchImpl: globalThis.fetch }) : null,
      fetchZalo: zaloMediaFetcher({ hosts: platformConfig.zaloMediaHosts, maxBytes: platformConfig.contributionMaxImageBytes }),
      readEvidence: customerImageEvidence,
      reader,
      maxImageBytes: platformConfig.contributionMaxImageBytes,
      readTimeoutMs: platformConfig.imageUnderstandingTimeoutMs,
      logger,
    });
    logger.info("APP", "food agent image conversation enabled", { model: reader?.model ?? null });
  } catch (err) {
    logger.warn("APP", "food agent image conversation NOT enabled", { error: String(err?.message ?? err).slice(0, 160) });
  }
}
const router = new PlatformRouter({ services, discovery, agentSearch, merchantRouter, ai, gpt, images });

// Knowledge Ingestion: loaded ONLY when enabled AND a Knowledge Group is configured (default off).
let knowledgeIngest = null;
if (platformConfig.knowledgeIngestEnabled && platformConfig.knowledgeGroupChatIds.length) {
  try {
    const { createKnowledgeIngest } = await import("./services/knowledgeIngestAdapter.js");
    knowledgeIngest = createKnowledgeIngest({
      dbPath: platformConfig.knowledgeIngestDbPath,
      rawRoot: platformConfig.knowledgeIngestRawRoot,
      groupChatIds: platformConfig.knowledgeGroupChatIds,
      botToken: platformConfig.telegramBotToken,
      logger,
    });
    logger.info("APP", "knowledge ingestion enabled (review only)", { groups: platformConfig.knowledgeGroupChatIds.length, dbPath: platformConfig.knowledgeIngestDbPath });
  } catch (err) {
    logger.warn("APP", "knowledge ingestion NOT enabled", { error: err.message });
  }
}

// the channels see the router through the contribution wrapper (same interface; text turns pass through unchanged)
const channelRouter = contributionService ? contributionService.wrapRouter(router) : router;
const app = createPlatformApp({ db: platformDb, repos, services, discovery, merchantRouter, registry, router: channelRouter, knowledgeIngest, contributions: Boolean(contributionService) });

const server = app.listen(platformConfig.port, () => {
  logger.info("APP", `Tổng Đài platform listening on :${platformConfig.port}`, {
    webhookPath: platformConfig.webhookPath,
    aiProvider: platformConfig.aiProvider,
  });
  // Names the problem only; the token itself is never logged.
  const adminProblem = adminTokenProblem();
  if (adminProblem) {
    logger.warn("APP", `PLATFORM_ADMIN_API_TOKEN ${adminProblem}: the admin API /api/platform/merchants* refuses every request`);
  }
});

// Merchant order dispatch: re-deliver generic orders whose notification to
// the merchant failed (per-order attempt cap in OrderService; a delivery
// that succeeded is never sent again).
const DISPATCH_RETRY_INTERVAL_MS = 60_000;
const dispatchRetry = setInterval(() => {
  services.orders
    .retryFailedDispatches()
    .then((results) => results.length && logger.info("DISPATCH", "dispatch retry run", { results }))
    .catch((err) => logger.error("DISPATCH", "dispatch retry run failed", { error: err.message }));
}, DISPATCH_RETRY_INTERVAL_MS);
dispatchRetry.unref();

function shutdown(signal) {
  logger.info("APP", `platform received ${signal}, shutting down`);
  clearInterval(dispatchRetry);
  server.close(() => {
    platformDb.close();
    atieuDb.close();
    foodKnowledge?.close();
    contributionService?.ingest.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
