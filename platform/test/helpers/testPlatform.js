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

// Reuses A Tiểu's OWN test helper (test/helpers/testApp.js) completely
// unmodified — this is exactly how a real "future merchant" onboarding
// would plug in a second real module: build its own engine, hand it to a
// factory, register it.
import { buildTestContext as buildAtieuTestContext } from "../../../test/helpers/testApp.js";

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
 */
export function buildTestPlatform({
  withAtieu = true,
  withGenericFixture = false,
  genericFixtureMerchants = [],
  dispatchPort,
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
  const services = createPlatformServices(repos, { visionProvider, imageStorage, dispatchPort });
  const ai = new NullProvider();

  const moduleFactories = {};
  let atieuCtx = null;

  if (withAtieu) {
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
    moduleFactories.generic = buildGenericAdapterFactory({ menuService: services.menu, merchantDataService: services.merchantData });
  }

  if (genericFixtureMerchants.length > 0) {
    for (const merchantId of genericFixtureMerchants) {
      registerGenericFixture(repos, merchantId);
    }
    moduleFactories.generic = buildGenericAdapterFactory({ menuService: services.menu, merchantDataService: services.merchantData });
  }

  const registry = new MerchantRegistry({ repos, moduleFactories });
  const merchantRouter = new MerchantRouter(registry, { merchantData: services.merchantData });
  const discovery = new DiscoveryEngine(services.merchantData, registry);
  const agentSearch = new AgentSearchService({ discovery, registry });
  const router = new PlatformRouter({ services, discovery, agentSearch, merchantRouter, ai });
  const app = createPlatformApp({ db, repos, services, discovery, merchantRouter, registry, router });

  return { db, repos, services, ai, visionProvider, imageStorage, registry, merchantRouter, discovery, agentSearch, router, app, atieuCtx };
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
