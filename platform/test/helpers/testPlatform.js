import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPlatformConnection, runPlatformMigrations } from "../../db/connection.js";
import { createPlatformRepositories } from "../../repositories/index.js";
import { createPlatformServices } from "../../services/index.js";
import { NullProvider } from "../../../src/ai/NullProvider.js";
import { FakeMenuVisionProvider } from "./fakeMenuVisionProvider.js";
import { MenuImageStorage } from "../../services/menuImageStorage.js";
import { MerchantRegistry, buildAtieuAdapterFactory, buildGenericAdapterFactory } from "../../merchant/MerchantRegistry.js";
import { MerchantRouter } from "../../merchant/MerchantRouter.js";
import { DiscoveryEngine } from "../../discovery/DiscoveryEngine.js";
import { AgentSearchService } from "../../services/agentSearchService.js";
import { PlatformRouter } from "../../router/PlatformRouter.js";
import { createPlatformApp } from "../../api/app.js";
import { runNomNomDemoSeed } from "../../db/demoSeed.js";
import { runPlatformSeed } from "../../db/seed.js";
import { platformConfig } from "../../config.js";

// Reuses A Tiểu's OWN test helper (test/helpers/testApp.js) completely
// unmodified — this is exactly how a real "future merchant" onboarding
// would plug in a second real module: build its own engine, hand it to a
// factory, register it.
import { buildTestContext as buildAtieuTestContext } from "../../../test/helpers/testApp.js";

// A fake admin token, so tests never use a real PLATFORM_ADMIN_API_TOKEN from
// a developer's .env. Tests that drive the admin API send ADMIN_AUTH_HEADER.
export const TEST_ADMIN_TOKEN = "test-only-admin-token-" + "0".repeat(40);
export const ADMIN_AUTH_HEADER = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
platformConfig.adminApiToken = TEST_ADMIN_TOKEN;

// The testApp.js import above already blocks real external APIs; also clear
// the platform's own messaging credentials so no test even attempts a send.
platformConfig.zaloAccessToken = "";
platformConfig.telegramBotToken = "";

// Zalo fixtures in the suites are unsigned; the signature tests turn the
// check back on explicitly.
platformConfig.enableZaloSignatureCheck = false;

const FREE_PLAN = { plan_id: "free", name: "Free", price: 0, trial_days: null };

// TEST-ONLY generic merchant fixtures — never present in production seed
// (platform/db/seed.js only ever registers the real ATIEU001). Named to
// match the spec's own multi-merchant test naming (MERCHANT002/003).
const GENERIC_FIXTURES = {
  MERCHANT002: {
    name: "Merchant 002 (Test Fixture)",
    sku: "FIX2-HAISAN",
    productName: "Hủ Tiếu Xào Hải Sản",
    price: 72000,
    keywords: ["hai san", "hu tieu hai san"],
  },
  MERCHANT003: {
    name: "Merchant 003 (Test Fixture)",
    sku: "FIX3-BO",
    productName: "Hủ Tiếu Xào Bò",
    price: 68000,
    keywords: ["bo", "hu tieu bo"],
  },
};

function registerGenericFixture(repos, merchantId, status = "ACTIVE") {
  const fixture = GENERIC_FIXTURES[merchantId];
  repos.merchants.create({
    merchantId,
    name: fixture.name,
    slug: merchantId.toLowerCase(),
    module: "generic",
    status,
    address: "Nha Trang, Khánh Hòa",
  });
  repos.subscriptions.startTrial(merchantId, "free", new Date().toISOString(), new Date(Date.now() + 365 * 86400000).toISOString());
  const catId = repos.merchantCategories.create(merchantId, "Hủ Tiếu Xào").id;
  repos.merchantProducts.create(merchantId, {
    sku: fixture.sku,
    name: fixture.productName,
    categoryId: catId,
    price: fixture.price,
    available: true,
    keywords: fixture.keywords,
  });
}

/**
 * @param {object} opts
 * @param {boolean} opts.withAtieu register the real A Tiểu module (in-memory instance) as ATIEU001
 * @param {boolean} opts.withGenericFixture register a synthetic SECOND merchant
 *   (test-only, never present in production seed — see platform/db/seed.js)
 *   so multi-merchant discovery/ranking can be verified against more than
 *   one merchant.
 * @param {string[]} opts.genericFixtureMerchants merchant_ids from
 *   GENERIC_FIXTURES (e.g. ["MERCHANT002", "MERCHANT003"]) to additionally
 *   register — each ACTIVE by default; use `repos.merchants.setStatus(...)`
 *   after building to flip one to SUSPENDED/EXPIRED for exclusion tests.
 * @param {"legacy"|"generic"} opts.atieuEngine with withAtieu: "legacy" (default)
 *   drives ATIEU001 through the real src/ module; "generic" runs the real
 *   platform seed with PLATFORM_ATIEU_ENGINE=generic semantics — ATIEU001 on
 *   the generic merchant engine over its imported catalog.
 */
export function buildTestPlatform({
  withAtieu = true,
  atieuEngine = "legacy",
  withGenericFixture = false,
  genericFixtureMerchants = [],
  withNomNomDemo = false,
  dispatchPort,
  dispatchChannels,
  foodKnowledge = null,
  gpt = null,
  knowledgeIngest = null,
  contributions = null,
} = {}) {
  const db = createPlatformConnection(":memory:");
  runPlatformMigrations(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_name ON plans(plan_id)`);
  db.prepare(`INSERT INTO plans (plan_id, name, price, trial_days) VALUES (?, ?, ?, ?)`).run(
    FREE_PLAN.plan_id,
    FREE_PLAN.name,
    FREE_PLAN.price,
    FREE_PLAN.trial_days
  );

  const repos = createPlatformRepositories(db);
  // Deterministic, internet-free vision provider + a per-test-run temp
  // upload dir (never the real data/uploads/menu-imports) — spec §29/§30.
  const visionProvider = new FakeMenuVisionProvider();
  const imageStorage = new MenuImageStorage(path.join(os.tmpdir(), `menu-import-test-${randomUUID()}`));
  // dispatchChannels: fake delivery channels (e.g. { telegram: new TelegramDispatchChannel({ send }) })
  // for the real generic dispatch port — never a real Telegram call in tests.
  const services = createPlatformServices(repos, { visionProvider, imageStorage, dispatchPort, dispatchChannels });
  const ai = new NullProvider();

  const moduleFactories = {};
  let atieuCtx = null;
  const genericFactory = () =>
    buildGenericAdapterFactory({
      menuService: services.menu,
      merchantDataService: services.merchantData,
      cartService: services.cart,
      orderService: services.orders,
      conversationStates: repos.conversationStates,
      cartCheckout: repos.cartCheckout,
      productLanguage: services.productLanguage,
      customerMemory: services.customerMemory,
    });

  if (withNomNomDemo) {
    // Runs the real opt-in demo seed (platform/db/demoSeed.js) against
    // this in-memory DB — the same code `npm run platform:seed:demo` runs.
    runNomNomDemoSeed(db);
    moduleFactories.generic = genericFactory();
  }

  if (withAtieu && atieuEngine === "generic") {
    // The same code server boot runs (platform/db/seed.js) — no test-only catalog.
    runPlatformSeed(db, { atieuEngine: "generic" });
    moduleFactories.generic = genericFactory();
  } else if (withAtieu) {
    atieuCtx = buildAtieuTestContext();
    // Goes through the repository (not raw SQL) so account_status/active
    // (Phase 1's split model) stay in sync automatically — see
    // MerchantRepository.create()/setStatus().
    repos.merchants.create({
      merchantId: "ATIEU001",
      name: "Hủ Tiếu Xào A Tiểu",
      slug: "hu-tieu-xao-a-tieu",
      module: "atieu",
      status: "ACTIVE",
      address: "Nha Trang, Khánh Hòa",
    });
    db.prepare(`INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES ('ATIEU001','free','ACTIVE',datetime('now'))`).run();
    moduleFactories.atieu = buildAtieuAdapterFactory({ services: atieuCtx.services, router: atieuCtx.router });
  }

  if (withGenericFixture) {
    // TEST-ONLY fixture merchant — never seeded into the real platform DB
    // (platform/db/seed.js only ever registers the real A Tiểu merchant).
    repos.merchants.create({
      merchantId: "TESTFIXTURE001",
      name: "Quán Thử Nghiệm B",
      slug: "quan-thu-nghiem-b",
      module: "generic",
      status: "ACTIVE",
      address: "Nha Trang, Khánh Hòa",
    });
    db.prepare(`INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES ('TESTFIXTURE001','free','ACTIVE',datetime('now'))`).run();
    const catId = repos.merchantCategories.create("TESTFIXTURE001", "Hủ Tiếu Xào").id;
    repos.merchantProducts.create("TESTFIXTURE001", {
      sku: "FIX-HAISAN",
      name: "Hủ Tiếu Xào Hải Sản",
      categoryId: catId,
      price: 70000,
      available: true,
      keywords: ["hai san", "hu tieu hai san"],
    });
    moduleFactories.generic = genericFactory();
  }

  if (genericFixtureMerchants.length > 0) {
    for (const merchantId of genericFixtureMerchants) {
      registerGenericFixture(repos, merchantId);
    }
    moduleFactories.generic = genericFactory();
  }

  const registry = new MerchantRegistry({ repos, moduleFactories });
  const merchantRouter = new MerchantRouter(registry);
  const discovery = new DiscoveryEngine(services.merchantData, registry);
  // foodKnowledge: a test-built adapter (services/foodKnowledgeAdapter.js), off unless passed
  const agentSearch = new AgentSearchService({ discovery, registry, foodKnowledge: typeof foodKnowledge === "function" ? foodKnowledge({ services, merchantRouter }) : foodKnowledge });
  // gpt: a test-built GptFoodConcierge (scripted provider — never the real OpenAI API), off unless passed
  const gptConcierge = typeof gpt === "function" ? gpt({ services, repos, agentSearch, merchantRouter }) : gpt;
  const router = new PlatformRouter({ services, discovery, agentSearch, merchantRouter, ai, gpt: gptConcierge });
  // contributions: a test-built ContributionService factory (off unless passed) — the channels then see the wrapped router
  const contributionService = typeof contributions === "function" ? contributions({ services, repos, foodKnowledge: agentSearch.foodKnowledge ?? null }) : null;
  const channelRouter = contributionService ? contributionService.wrapRouter(router) : router;
  const app = createPlatformApp({ db, repos, services, discovery, merchantRouter, registry, router: channelRouter, knowledgeIngest, contributions: Boolean(contributionService) });

  return { db, repos, services, ai, visionProvider, imageStorage, registry, merchantRouter, discovery, agentSearch, router, app, atieuCtx, contributionService };
}

export async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

export function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}
