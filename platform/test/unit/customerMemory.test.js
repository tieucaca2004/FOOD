// Customer Memory — Layer 2/3 rules on a real (in-memory) platform DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const M1 = "DEMO_NOMNOM001";
const M2 = "ATIEU001";
const onion = { attribute: "onion", value: "avoid", label: "không hành" };
const pepperLow = { attribute: "pepper", value: "low", label: "ít tiêu" };

function setup() {
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const a = platform.services.customers.getOrCreateByZaloUserId("mem:a", "A").id;
  const b = platform.services.customers.getOrCreateByZaloUserId("mem:b", "B").id;
  return { platform, memory: platform.services.customerMemory, a, b };
}

const pref = (platform, customerId, attribute) =>
  platform.db.prepare(`SELECT * FROM customer_preferences WHERE customer_id = ? AND attribute = ?`).all(customerId, attribute);

test("explicit statements are persistent and strong; 'hôm nay …' and plain order instructions are not", () => {
  const { platform, memory, a } = setup();
  assert.equal(memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "current_only", scope: "merchant" }).length, 0);
  assert.equal(memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "order", scope: "merchant" }).length, 0);
  assert.equal(pref(platform, a, "onion").length, 0);

  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "persistent", scope: "merchant" });
  const [p] = pref(platform, a, "onion");
  assert.deepEqual([p.scope, p.merchant_id, p.value, p.status, p.confidence, p.source], ["merchant", M1, "avoid", "ACTIVE", 0.95, "explicit_customer_statement"]);

  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [pepperLow], temporality: "strong", scope: "merchant" });
  assert.equal(pref(platform, a, "pepper")[0].confidence, 0.98);
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [{ attribute: "sauce", value: "low", label: "ít sốt" }], temporality: "order", scope: "merchant", correction: true });
  const [sauce] = pref(platform, a, "sauce");
  assert.deepEqual([sauce.source, sauce.confidence], ["customer_correction", 0.9]);
});

test("one confirmed order is only a CANDIDATE; repeated confirmed orders make it applied", () => {
  const { platform, memory, a } = setup();
  const learn = (n) =>
    memory.learnFromConfirmedOrder({ customerId: a, merchantId: M1, orderRef: `TD-X-${n}`, instructions: [{ ...onion, temporality: "order" }] });
  learn(1);
  let [p] = pref(platform, a, "onion");
  assert.deepEqual([p.status, p.confidence, p.source], ["CANDIDATE", 0.4, "confirmed_order"]);
  assert.equal(memory.activePreferences(a, M1).length, 0); // never applied from a single order
  learn(2);
  learn(3);
  [p] = pref(platform, a, "onion");
  assert.equal(p.status, "ACTIVE");
  assert.ok(Math.abs(p.confidence - 0.8) < 1e-9);
  assert.equal(memory.activePreferences(a, M1).length, 1);
  // learning is idempotent per order
  assert.equal(learn(3), false);
  assert.equal(pref(platform, a, "onion")[0].evidence_count, 3);
});

test("'hôm nay …' instructions of an order are never evidence for a habit", () => {
  const { platform, memory, a } = setup();
  memory.learnFromConfirmedOrder({ customerId: a, merchantId: M1, orderRef: "TD-T-1", instructions: [{ ...onion, temporality: "current_only" }] });
  assert.equal(pref(platform, a, "onion").length, 0);
});

test("contradiction: an order never overrides an explicit preference; a new explicit statement does", () => {
  const { platform, memory, a } = setup();
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "persistent", scope: "merchant" });
  memory.learnFromConfirmedOrder({ customerId: a, merchantId: M1, orderRef: "TD-C-1", instructions: [{ attribute: "onion", value: "normal", label: "hành bình thường", temporality: "order" }] });
  let [p] = pref(platform, a, "onion");
  assert.deepEqual([p.value, p.contradiction_count], ["avoid", 1]);
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [{ attribute: "onion", value: "normal", label: "hành bình thường" }], temporality: "persistent", scope: "merchant" });
  [p] = pref(platform, a, "onion");
  assert.deepEqual([p.value, p.contradiction_count, p.status], ["normal", 2, "ACTIVE"]);
});

test("priority: current message > conversation > saved preference > recent order", () => {
  const { memory, a } = setup();
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion, pepperLow], temporality: "persistent", scope: "merchant" });
  const resolved = memory.resolveInstructions({
    customerId: a,
    merchantId: M1,
    historical: [{ attribute: "sauce", value: "low", label: "ít sốt" }, { attribute: "pepper", value: "avoid", label: "không tiêu" }],
    conversation: [{ attribute: "onion", value: "normal", label: "hành bình thường" }],
    current: [{ attribute: "pepper", value: "extra", label: "nhiều tiêu" }],
  });
  const byAttr = Object.fromEntries(resolved.map((i) => [i.attribute, [i.value, i.source]]));
  assert.deepEqual(byAttr, { sauce: ["low", "recent_order"], pepper: ["extra", "current"], onion: ["normal", "conversation"] });
});

test("merchant isolation; global only when said globally; product scope only for that product", () => {
  const { memory, a } = setup();
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "persistent", scope: "merchant" });
  assert.equal(memory.activePreferences(a, M1).length, 1);
  assert.equal(memory.activePreferences(a, M2).length, 0);
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [{ attribute: "peanut", value: "avoid", label: "không đậu phộng" }], temporality: "persistent", scope: "global" });
  assert.deepEqual(memory.activePreferences(a, M2).map((p) => p.attribute), ["peanut"]);
  memory.rememberStatement({ customerId: a, merchantId: M1, productId: 8, instructions: [pepperLow], temporality: "persistent", scope: "product" });
  assert.ok(!memory.activePreferences(a, M1, [1]).some((p) => p.attribute === "pepper"));
  assert.ok(memory.activePreferences(a, M1, [8]).some((p) => p.attribute === "pepper"));
});

test("customer isolation: nothing of A is ever visible for B", () => {
  const { memory, a, b } = setup();
  memory.rememberStatement({ customerId: a, merchantId: M1, instructions: [onion], temporality: "persistent", scope: "global" });
  memory.rememberAddress({ customerId: a, address: "76 Nguyễn Thị Minh Khai", used: true });
  memory.learnFromConfirmedOrder({ customerId: a, merchantId: M1, orderRef: "TD-A-1", instructions: [] });
  assert.equal(memory.activePreferences(b, M1).length, 0);
  assert.deepEqual(memory.resolveAddress({ customerId: b }), { none: true });
  assert.equal(memory.store.listOrderRefs(b, M1).length, 0);
});

test("addresses: no duplicates, usage counted, one clear -> used, several -> ask, labels", () => {
  const { memory, a } = setup();
  memory.rememberAddress({ customerId: a, address: "76 Nguyễn Thị Minh Khai", used: true });
  memory.rememberAddress({ customerId: a, address: "76 nguyen thi minh khai", used: true });
  const list = memory.store.listAddresses(a);
  assert.equal(list.length, 1);
  assert.equal(list[0].usage_count, 2);
  assert.equal(list[0].is_default, 1);
  assert.deepEqual(memory.resolveAddress({ customerId: a }), { address: "76 Nguyễn Thị Minh Khai" });
  memory.rememberAddress({ customerId: a, address: "123 Trần Phú", label: "công ty" });
  assert.equal(memory.resolveAddress({ customerId: a }).choices.length, 2); // never guessed
  assert.deepEqual(memory.resolveAddress({ customerId: a, label: "công ty" }), { address: "123 Trần Phú" });
  assert.equal(memory.resolveAddress({ customerId: a, label: "nhà" }).none, true);
});

test("reorder candidate: current menu wins, gone items are reported not substituted, recurring vs recent", () => {
  const { memory, a } = setup();
  const orders = {
    "O-1": { items: [{ productId: 1, name: "Old A", quantity: 2 }], address: "76 X" },
    "O-2": { items: [{ productId: 1, name: "Old A", quantity: 2 }], address: "76 X" },
    "O-3": { items: [{ productId: 2, name: "Old B", quantity: 1 }, { productId: 9, name: "Gone C", quantity: 1 }], address: "9 Y" },
  };
  for (const ref of ["O-1", "O-2", "O-3"]) memory.learnFromConfirmedOrder({ customerId: a, merchantId: M1, orderRef: ref, instructions: [] });
  const reader = {
    readOrder: (ref) => orders[ref] ?? null,
    currentProduct: (id) => ({ 1: { id: 1, name: "A now", price: 111, available: true }, 2: { id: 2, name: "B now", price: 222, available: true } })[id] ?? null,
  };
  const recent = memory.buildReorderCandidate({ customerId: a, merchantId: M1, orderReader: reader });
  assert.equal(recent.orderRef, "O-3");
  assert.deepEqual(recent.items, [{ productId: 2, name: "B now", quantity: 1, price: 222 }]); // current name/price
  assert.deepEqual(recent.unavailable, [{ name: "Gone C", quantity: 1 }]);
  const usual = memory.buildReorderCandidate({ customerId: a, merchantId: M1, orderReader: reader, preferRecurring: true });
  assert.equal(usual.source, "recurring_order");
  assert.deepEqual(usual.items, [{ productId: 1, name: "A now", quantity: 2, price: 111 }]);
  assert.equal(memory.buildReorderCandidate({ customerId: a, merchantId: M2, orderReader: reader }), null); // other merchant: no history
});
