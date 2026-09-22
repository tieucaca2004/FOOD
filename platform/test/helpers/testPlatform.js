import { createPlatformConnection, runPlatformMigrations } from "../../db/connection.js";
import { createPlatformRepositories } from "../../repositories/index.js";
import { createPlatformServices } from "../../services/index.js";
import { NullProvider } from "../../../src/ai/NullProvider.js";
import { MerchantRegistry, buildAtieuAdapterFactory, buildGenericAdapterFactory } from "../../merchant/MerchantRegistry.js";
import { MerchantRouter } from "../../merchant/MerchantRouter.js";
import { DiscoveryEngine } from "../../discovery/DiscoveryEngine.js";
import { PlatformRouter } from "../../router/PlatformRouter.js";
import { createPlatformApp } from "../../api/app.js";

// Reuses A Tiểu's OWN test helper (test/helpers/testApp.js) completely
// unmodified — this is exactly how a real "future merchant" onboarding
// would plug in a second real module: build its own engine, hand it to a
// factory, register it.
import { buildTestContext as buildAtieuTestContext } from "../../../test/helpers/testApp.js";

const FREE_PLAN = { plan_id: "free", name: "Free", price: 0, trial_days: null };

/**
 * @param {object} opts
 * @param {boolean} opts.withAtieu register the real A Tiểu module (in-memory instance) as ATIEU001
 * @param {boolean} opts.withGenericFixture register a synthetic SECOND merchant
 *   (test-only, never present in production seed — see platform/db/seed.js)
 *   so multi-merchant discovery/ranking can be verified against more than
 *   one merchant.
 */
export function buildTestPlatform({ withAtieu = true, withGenericFixture = false } = {}) {
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
  const services = createPlatformServices(repos);
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
    moduleFactories.generic = buildGenericAdapterFactory({ repos });
  }

  const registry = new MerchantRegistry({ repos, moduleFactories });
  const merchantRouter = new MerchantRouter(registry);
  const discovery = new DiscoveryEngine(repos, registry);
  const router = new PlatformRouter({ services, discovery, merchantRouter, ai });
  const app = createPlatformApp({ db, repos, services, discovery, merchantRouter, registry, router });

  return { db, repos, services, ai, registry, merchantRouter, discovery, router, app, atieuCtx };
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
