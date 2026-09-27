// P6: production-safe, read-only Food Knowledge integration behind
// FOOD_KNOWLEDGE_DISCOVERY_ENABLED (default false). Knowledge rows below are
// SYNTHETIC TEST FIXTURES.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { platformConfig } from "../../config.js";

function knowledgeFixture() {
  const file = path.join(os.tmpdir(), `kb-p6-${crypto.randomUUID()}.db`);
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  const src = ins(`INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://atieu.example/', 'atieu.example', 'merchant_official', '2026-09-25', 'application/json', 'h', 'raw/a')`);
  const ev = () => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, 'q', 'explicit', 'verified')`, src);
  const food = ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES ('hu-tieu', 'Hủ tiếu', 'hu tieu', 'published')`);
  ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, 'Hủ tiếu', 'hu tieu', 'canonical', 'sourced', 'published')`, food);
  const merchant = (key, name) => ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', '2026-09-25', '2026-09-25')`, key, name, key);
  const product = (m, name, norm) => ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'published', '2026-09-25', '2026-09-25')`, m, name, norm, ev());
  const atieu = merchant("a-tieu", "A. Tiểu");
  const other = merchant("quan-khac", "Quán Khác");
  product(atieu, "HỦ TIẾU XÀO BÒ", "hu tieu xao bo");
  product(other, "Hủ tiếu Nam Vang", "hu tieu nam vang");
  ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by) VALUES (?, 'ATIEU001', 'founder')`, atieu);
  db.close();
  return file;
}

const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function platformWith(file) {
  return buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    foodKnowledge: file ? ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) : null,
  });
}

test("FLAG: off by default — the knowledge layer is not used and nothing changes", async () => {
  if (process.env.FOOD_KNOWLEDGE_DISCOVERY_ENABLED === undefined) assert.equal(platformConfig.foodKnowledgeDiscoveryEnabled, false);
  const plain = platformWith(null);
  assert.deepEqual(plain.agentSearch.searchFoodKnowledge("Tìm hủ tiếu"), { enabled: false });
  const withKnowledge = platformWith(knowledgeFixture());
  const ids = async (p) => (await p.agentSearch.searchMerchants("hủ tiếu")).organic.map((c) => c.merchant.merchant_id);
  assert.deepEqual(await ids(withKnowledge), await ids(plain)); // existing discovery untouched
});

test("ENABLED: reference results with sources; orderable decided only by the live platform catalog", () => {
  const file = knowledgeFixture();
  const p = platformWith(file);
  const r = p.agentSearch.searchFoodKnowledge("Tìm hủ tiếu");
  assert.equal(r.enabled, true);
  const byMerchant = Object.fromEntries(r.result.merchants.map((m) => [m.name, m]));
  assert.equal(byMerchant["A. Tiểu"].orderable, true); // bridged by a person + ATIEU001 routable + menu visible
  assert.equal(byMerchant["A. Tiểu"].products[0].orderable, true); // same dish, available on the live menu
  assert.equal(byMerchant["Quán Khác"].orderable, false); // discovery only
  assert.equal(byMerchant["Quán Khác"].products[0].orderable, false);
  assert.match(r.answer, /Thông tin tham khảo — chưa đặt qua FOOD được/);
  assert.match(r.answer, /✅ Quán này đặt được qua FOOD/);

  // the catalog changes -> the answer follows the catalog, not the knowledge data
  const live = p.services.menu.listProducts("ATIEU001").find((x) => x.name === "HỦ TIẾU XÀO BÒ");
  p.services.menu.setProductAvailability("ATIEU001", live.id, false);
  assert.equal(p.agentSearch.searchFoodKnowledge("Tìm hủ tiếu").result.merchants.find((m) => m.name === "A. Tiểu").products[0].orderable, false);
  p.repos.merchants.setStatus("ATIEU001", "SUSPENDED");
  assert.equal(p.agentSearch.searchFoodKnowledge("Tìm hủ tiếu").result.merchants.find((m) => m.name === "A. Tiểu").orderable, false);
});

test("ISOLATION: searching knowledge writes nothing — not the knowledge DB, not merchants, products, carts or orders", () => {
  const file = knowledgeFixture();
  const before = hash(file);
  const p = platformWith(file);
  const counts = () => ["merchants", "merchant_products", "merchant_carts", "orders", "order_items", "merchant_product_aliases"].map((t) => p.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const c0 = counts();
  for (const q of ["Tìm hủ tiếu", "đặt 2 tô hủ tiếu", "quán nhiều món", "Tìm quán hải sản đang mở"]) p.agentSearch.searchFoodKnowledge(q);
  assert.deepEqual(counts(), c0);
  assert.equal(hash(file), before);
});

// Replaces P6's "CHAT UNCHANGED" (chat never used knowledge). Since the founder-approved integration, chat
// uses Food Knowledge ONLY when it is enabled, and only as an appended REFERENCE: the orderable catalog
// section of the reply is byte-for-byte what it was, and flag-off chat is exactly the old reply.
test("CHAT + KNOWLEDGE: flag off -> the old catalog-only reply; flag on -> same catalog section, knowledge appended as reference", async () => {
  const reply = async (p) => {
    const customer = p.services.customers.getOrCreateByZaloUserId("chat-same", "K");
    const session = p.services.sessions.getOrCreate(customer.id);
    return (await p.router.handle({ customer, session, text: "tìm hủ tiếu" })).replyText;
  };
  const without = await reply(platformWith(null));
  assert.doesNotMatch(without, /Tham khảo/);
  const withK = await reply(platformWith(knowledgeFixture()));
  assert.ok(withK.startsWith(without), "the catalog section is unchanged");
  const reference = withK.slice(without.length);
  assert.match(reference, /📚 Tham khảo thêm \(chưa đặt qua FOOD được\)/);
  assert.match(reference, /Quán Khác/);
  assert.doesNotMatch(reference, /A\. Tiểu/); // bridged + orderable: already the catalog result above
});

test("WIRING: server.js loads the adapter only inside the flag, never statically", () => {
  const server = fs.readFileSync(new URL("../../server.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /^import .*knowledge/m);
  assert.doesNotMatch(server, /^import .*foodKnowledgeAdapter/m);
  assert.match(server, /if \(platformConfig\.foodKnowledgeDiscoveryEnabled\) \{[\s\S]*await import\("\.\/services\/foodKnowledgeAdapter\.js"\)/);
});
