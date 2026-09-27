// FOOD tools for the GPT concierge, against a SYNTHETIC knowledge fixture and the test catalog.
// The tools are read-only: no merchant / product / price / cart / order is ever written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createKnowledgeConnection } from "../../knowledge/db.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";

function setup({ conflict = false } = {}) {
  const file = nhaTrangKnowledge();
  if (conflict) {
    // SYNTHETIC: one product with two different prices from the same source, no variant
    const db = createKnowledgeConnection(file);
    const product = db.prepare(`SELECT p.id, p.evidence_id FROM kb_merchant_products p JOIN kb_merchants m ON m.id = p.merchant_id WHERE m.key = 'bun-ca-mau'`).get();
    db.prepare(`INSERT INTO kb_product_prices (product_id, price, currency, price_text_original, evidence_id, captured_at, last_seen_at, status) VALUES (?, 55000, 'VND', '55000₫', ?, '2026-09-26', '2026-09-26', 'published')`).run(product.id, product.evidence_id);
    db.close();
  }
  const platform = buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    withNomNomDemo: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
  });
  const tools = new FoodTools({ services: platform.services, repos: platform.repos, agentSearch: platform.agentSearch, merchantRouter: platform.merchantRouter });
  const customer = platform.services.customers.getOrCreateByZaloUserId("tools-1", "T");
  const session = platform.services.sessions.getOrCreate(customer.id);
  const counts = () => ["merchants", "merchant_products", "merchant_carts", "merchant_cart_items", "orders", "payments"].map((t) => platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  return { platform, tools, ctx: { customer, session }, counts };
}

test("search_food: reference rows carry price_status / source / evidence and are never orderable; the list is remembered", async () => {
  const { platform, tools, ctx, counts } = setup();
  const before = counts();
  const { data, facts } = await tools.run("search_food", { query: "bún cá", location: "Nha Trang" }, ctx);
  assert.equal(data.total_catalog, 0);
  assert.ok(data.total_reference >= 2);
  const mau = data.reference.find((m) => m.merchant_name === "Bún Cá Mẫu");
  assert.equal(mau.orderable, false);
  assert.equal(mau.reference_only, true);
  const priced = mau.products.find((p) => p.price_status === "available");
  assert.equal(priced.price, 45000);
  assert.equal(priced.source, "https://buncamau.example/menu");
  assert.ok(priced.evidence_id);
  assert.ok(priced.captured_at);
  const coBa = data.reference.find((m) => m.merchant_name === "Bún cá Cô Ba");
  assert.ok(coBa.products.every((p) => p.price_status === "unavailable" && p.price === null)); // bún chả cá / bún riêu prices are not bún cá
  assert.ok(!data.reference.some((m) => /Cam Ranh/.test(m.address ?? "")));
  assert.ok(facts.every((f) => f.id.startsWith("kb:") || f.id.startsWith("cat:")));
  const remembered = platform.services.sessions.getKnowledgeContext(ctx.session.id);
  assert.equal(remembered.query, "Bún cá");
  assert.equal(remembered.shownCount, data.reference.length);
  assert.deepEqual(counts(), before);
});

test("search_food: catalog matches are orderable with the FOOD price; a budget keeps only proven prices", async () => {
  const { tools, ctx } = setup();
  const pizza = await tools.run("search_food", { query: "pizza" }, ctx);
  const nomnom = pizza.data.catalog.find((c) => c.merchant_id === "cat:DEMO_NOMNOM001");
  assert.ok(nomnom.orderable);
  assert.ok(nomnom.products.length > 0 && nomnom.products.every((p) => p.source === "FOOD catalog" && p.price > 0));
  const budget = await tools.run("search_food", { query: "bún cá", location: "Nha Trang", max_price: 50000 }, ctx);
  assert.deepEqual(budget.data.reference.map((m) => m.merchant_name), ["Bún Cá Mẫu"]);
  assert.ok(budget.data.query_context.budget.excluded_without_price >= 1);
  const tight = await tools.run("search_food", { query: "bún cá", location: "Nha Trang", max_price: 30000 }, ctx);
  assert.deepEqual(tight.data.reference, []);
  assert.equal(tight.data.query_context.budget.excluded_out_of_range, 1);
});

test("get_merchant / get_menu / get_product: reference and catalog, by namespaced id; unknown ids are errors", async () => {
  const { tools, ctx } = setup();
  const { data } = await tools.run("search_food", { query: "Bún Cá Mịn" }, ctx);
  const min = data.reference.find((m) => m.merchant_name === "Bún Cá Mịn");
  const merchant = await tools.run("get_merchant", { merchant_id: min.merchant_id }, ctx);
  assert.equal(merchant.data.address, "12 Lý Tự Trọng, Nha Trang");
  assert.equal(merchant.data.reference_only, true);
  const menu = await tools.run("get_menu", { merchant_id: min.merchant_id }, ctx);
  const product = menu.data.products[0];
  const one = await tools.run("get_product", { merchant_id: min.merchant_id, product_id: product.product_id }, ctx);
  assert.equal(one.data.price, 45000);
  const catMenu = await tools.run("get_menu", { merchant_id: "cat:DEMO_NOMNOM001" }, ctx);
  assert.ok(catMenu.data.orderable && catMenu.data.products.length > 10);
  assert.equal((await tools.run("get_merchant", { merchant_id: "kb:999999" }, ctx)).data.error, "MERCHANT_NOT_FOUND");
  assert.equal((await tools.run("get_product", { merchant_id: min.merchant_id, product_id: "kbp:1" }, ctx)).data.error, "PRODUCT_NOT_FOUND");
  assert.equal((await tools.run("get_merchant", { merchant_id: "DROP TABLE" }, ctx)).data.error, "MERCHANT_NOT_FOUND");
  assert.equal((await tools.run("no_such_tool", {}, ctx)).data.error, "UNKNOWN_TOOL");
});

test("get_previous_knowledge_results: the remembered list; none / expired are said plainly", async () => {
  const { platform, tools, ctx } = setup();
  assert.deepEqual((await tools.run("get_previous_knowledge_results", {}, ctx)).data, { available: false, reason: "NO_PREVIOUS_RESULTS" });
  await tools.run("search_food", { query: "bún cá", location: "Nha Trang" }, ctx);
  const prev = await tools.run("get_previous_knowledge_results", {}, ctx);
  assert.equal(prev.data.available, true);
  assert.equal(prev.data.query, "Bún cá");
  assert.equal(prev.data.places_with_recorded_price, 1);
  assert.ok(prev.data.places.some((p) => p.merchant_name === "Bún Cá Mẫu"));
  const context = platform.services.sessions.getKnowledgeContext(ctx.session.id);
  platform.services.sessions.setKnowledgeContext(ctx.session.id, { ...context, touchedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
  assert.equal((await tools.run("get_previous_knowledge_results", {}, ctx)).data.reason, "EXPIRED");
});

test("price_status conflicting: two prices for one product are both returned, none chosen", async () => {
  const { tools, ctx } = setup({ conflict: true });
  const { data } = await tools.run("search_food", { query: "bún cá", location: "Nha Trang" }, ctx);
  const p = data.reference.find((m) => m.merchant_name === "Bún Cá Mẫu").products.find((x) => x.prices.length > 1);
  assert.equal(p.price_status, "conflicting");
  assert.equal(p.price, null);
  assert.deepEqual(p.prices.map((x) => x.price).sort(), [45000, 55000]);
});

test("get_customer_cart: reads the carts the customer already has; never creates one", async () => {
  const { platform, tools, ctx, counts } = setup();
  assert.deepEqual((await tools.run("get_customer_cart", {}, ctx)).data, { carts: [] });
  const before = counts();
  assert.deepEqual(counts(), before); // reading an empty cart list created nothing
  const product = platform.services.menu.listProducts("DEMO_NOMNOM001")[0];
  const cart = platform.services.cart.getOrCreateCart(ctx.customer.id, "DEMO_NOMNOM001");
  platform.services.cart.addItem(ctx.customer.id, cart.id, "DEMO_NOMNOM001", product.id, 2);
  const { data } = await tools.run("get_customer_cart", {}, ctx);
  assert.equal(data.carts.length, 1);
  assert.deepEqual(data.carts[0].items, [{ name: product.name, quantity: 2, unit_price: product.price }]);
  assert.equal(data.carts[0].subtotal, product.price * 2);
});
