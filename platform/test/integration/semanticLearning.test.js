// P5: semantic phrases feed the EXISTING merchant-isolated Customer Language
// Learning — never Food Knowledge, never another merchant, never a fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { SemanticLearningService, isOpinion, SEMANTIC_SOURCE } from "../../services/semanticLearningService.js";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";

function setup() {
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true });
  const service = new SemanticLearningService({ productLanguage: platform.services.productLanguage });
  const product = (merchantId, name) => platform.services.menu.listProducts(merchantId).find((p) => p.name === name);
  const customer = (tag) => platform.services.customers.getOrCreateByZaloUserId(`semantic-${tag}`, "Khách").id;
  const aliases = (merchantId) => platform.db.prepare(`SELECT normalized_alias, status, product_id FROM merchant_product_aliases WHERE merchant_id = ?`).all(merchantId);
  return { platform, service, product, aliases, customer };
}

test("P5: a semantic choice becomes an OBSERVED alias of that product, at that merchant only", () => {
  const { platform, service, product, aliases, customer } = setup();
  const crispy = product("ATIEU001", "MÌ XÀO GIÒN HẢI SẢN");
  const r = service.recordChoice({ merchantId: "ATIEU001", customerId: customer("c1"), message: "Cho tôi món giòn giòn", product: crispy });
  assert.deepEqual(r, { recorded: true, phrase: "gion gion", status: "OBSERVED" });
  assert.deepEqual(aliases("ATIEU001").map((a) => [a.normalized_alias, a.status, a.product_id]), [["gion gion", "OBSERVED", crispy.id]]);
  assert.deepEqual(aliases("DEMO_NOMNOM001"), []); // isolation: nothing at another merchant
  const event = platform.db.prepare(`SELECT resolution_source FROM product_alias_events ORDER BY id DESC LIMIT 1`).get();
  assert.equal(event.resolution_source, SEMANTIC_SOURCE);
  // it is only a suggestion there, and only there
  const products = platform.services.menu.listProducts("ATIEU001");
  assert.equal(service.suggestionFor({ merchantId: "ATIEU001", message: "món giòn giòn", products }).level, "OBSERVED");
  assert.equal(service.suggestionFor({ merchantId: "DEMO_NOMNOM001", message: "món giòn giòn", products: platform.services.menu.listProducts("DEMO_NOMNOM001") }), null);
});

test("P5: one customer repeating themselves can never make it trusted (existing rule holds)", () => {
  const { service, product, aliases, customer } = setup();
  const p = product("ATIEU001", "MÌ XÀO GIÒN HẢI SẢN");
  for (let i = 0; i < 10; i++) service.recordChoice({ merchantId: "ATIEU001", customerId: customer("c7"), message: "món giòn giòn", product: p });
  assert.notEqual(aliases("ATIEU001")[0].status, "TRUSTED");
});

test("P5: opinions and canonical names are not learned", () => {
  const { service, product, aliases, customer } = setup();
  const p = product("ATIEU001", "HỦ TIẾU XÀO BÒ");
  for (const text of ["Tôi thấy món này hơi mặn", "ngon quá", "bún cá hơi mặn"]) {
    assert.equal(isOpinion(text), true, text);
    assert.equal(service.recordChoice({ merchantId: "ATIEU001", customerId: customer("c1"), message: text, product: p }).reason, "OPINION_NOT_LEARNED");
  }
  assert.equal(service.recordChoice({ merchantId: "ATIEU001", customerId: customer("c1"), message: "hủ tiếu xào bò", product: p }).reason, "CANONICAL_NAME");
  assert.deepEqual(aliases("ATIEU001"), []);
  assert.equal(isOpinion("cho tôi món giòn giòn"), false);
});

test("P5: customer learning never writes Food Knowledge", () => {
  const { service, product, customer } = setup();
  const kdb = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(kdb);
  const count = () => kdb.prepare(`SELECT (SELECT COUNT(*) FROM kb_claims) + (SELECT COUNT(*) FROM kb_food_names) + (SELECT COUNT(*) FROM kb_food_entities) AS n`).get().n;
  const before = count();
  service.recordChoice({ merchantId: "ATIEU001", customerId: customer("c3"), message: "món giòn giòn", product: product("ATIEU001", "MÌ XÀO GIÒN HẢI SẢN") });
  assert.equal(count(), before);
  assert.ok(!Object.values(service).some((v) => v && typeof v === "object" && "vocabulary" in v), "no knowledge store reachable from the learner");
});
