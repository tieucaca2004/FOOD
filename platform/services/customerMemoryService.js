import { stripAccents } from "../../src/nlp/normalize.js";

// Customer Memory — Layers 2 (intelligence) and 3 (learning) on top of the
// structured storage in CustomerMemoryRepository (Layer 1). Deterministic,
// evidence-based, no model calls. Memory never acts on its own: it only
// PROPOSES (instructions, an address, a reorder candidate); carts and
// orders are still created by CartService / OrderService after the
// customer confirms. Everything is scoped by customer_id; merchant-scoped
// memory never crosses to another merchant; global scope only when the
// customer said so.

// Evidence scoring (V1).
const CONFIDENCE = {
  strong: 0.98, // "lần nào cũng không hành"
  persistent: 0.95, // "em không ăn hành"
  correction: 0.9, // "Không, em muốn ít tiêu"
  orderFirst: 0.4, // first confirmed order with "không hành" — CANDIDATE only
  orderStep: 0.2, // each further confirmed order (3 orders -> 0.8 = applied)
  orderMax: 0.85,
};
const ORDER_EVIDENCE_TO_ACTIVE = 3; // repeated behavior becomes an applied preference
const APPLY_MIN_CONFIDENCE = 0.8;
const HISTORY_LIMIT = 10;

function normalizeAddress(address) {
  return stripAccents(address || "")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

export function instructionKey(i) {
  return i.attribute;
}

export class CustomerMemoryService {
  constructor(repos) {
    this.repos = repos;
  }

  get store() {
    return this.repos.customerMemory;
  }

  // ======================================================================
  // LAYER 3 — learning
  // ======================================================================

  /**
   * An explicit statement. "Hôm nay …" (current_only) and plain order
   * instructions are NOT persisted here: the first only ever applies to the
   * current order, the second becomes evidence when an order is confirmed.
   * @returns {Array} the preferences stored
   */
  rememberStatement({ customerId, merchantId, productId = null, instructions, temporality, scope, correction = false }) {
    const persistent = temporality === "persistent" || temporality === "strong" || correction;
    if (!persistent || temporality === "current_only") return [];
    const confidence = temporality === "strong" ? CONFIDENCE.strong : correction && temporality === "order" ? CONFIDENCE.correction : CONFIDENCE.persistent;
    const source = correction ? "customer_correction" : "explicit_customer_statement";
    const effectiveScope = scope === "product" && !productId ? "merchant" : scope;
    return instructions.map((i) =>
      this._upsertExplicit({ customerId, merchantId, productId, scope: effectiveScope, instruction: i, confidence, source })
    );
  }

  _target({ customerId, merchantId, productId, scope }) {
    return {
      customer_id: customerId,
      scope,
      merchant_id: scope === "global" ? null : merchantId,
      product_id: scope === "product" ? productId : null,
    };
  }

  _upsertExplicit({ customerId, merchantId, productId, scope, instruction, confidence, source }) {
    const target = this._target({ customerId, merchantId, productId, scope });
    const key = { scope, merchantId: target.merchant_id, productId: target.product_id, attribute: instruction.attribute };
    const existing = this.store.getPreference(customerId, key);
    if (!existing) {
      const row = { ...target, attribute: instruction.attribute, value: instruction.value, label: instruction.label, confidence, evidence_count: 1, contradiction_count: 0, source, status: "ACTIVE" };
      this.store.insertPreference(row);
      return row;
    }
    // A new explicit statement replaces an old value ("thật ra em ăn hành
    // bình thường"), and the contradiction is recorded.
    const contradicts = existing.value !== instruction.value;
    const updated = {
      value: instruction.value,
      label: instruction.label,
      confidence: contradicts ? confidence : Math.max(existing.confidence, confidence),
      evidence_count: contradicts ? 1 : existing.evidence_count + 1,
      contradiction_count: existing.contradiction_count + (contradicts ? 1 : 0),
      source,
      status: "ACTIVE",
    };
    this.store.updatePreference(existing.id, updated);
    return { ...existing, ...updated };
  }

  // Evidence from a confirmed order: never permanent on its own.
  _orderEvidence({ customerId, merchantId, instruction }) {
    const key = { scope: "merchant", merchantId, productId: null, attribute: instruction.attribute };
    const existing = this.store.getPreference(customerId, key);
    if (!existing) {
      this.store.insertPreference({
        ...this._target({ customerId, merchantId, scope: "merchant" }),
        attribute: instruction.attribute,
        value: instruction.value,
        label: instruction.label,
        confidence: CONFIDENCE.orderFirst,
        evidence_count: 1,
        contradiction_count: 0,
        source: "confirmed_order",
        status: "CANDIDATE",
      });
      return;
    }
    const explicit = existing.source !== "confirmed_order";
    if (existing.value !== instruction.value) {
      // An order never overrides what the customer explicitly said; it
      // only counts as a contradiction. Order evidence vs order evidence:
      // the newer behavior restarts as a candidate.
      if (explicit) {
        this.store.updatePreference(existing.id, { ...existing, contradiction_count: existing.contradiction_count + 1 });
      } else {
        this.store.updatePreference(existing.id, {
          value: instruction.value,
          label: instruction.label,
          confidence: CONFIDENCE.orderFirst,
          evidence_count: 1,
          contradiction_count: existing.contradiction_count + 1,
          source: "confirmed_order",
          status: "CANDIDATE",
        });
      }
      return;
    }
    const evidence = existing.evidence_count + 1;
    this.store.updatePreference(existing.id, {
      ...existing,
      evidence_count: evidence,
      confidence: explicit ? existing.confidence : Math.min(CONFIDENCE.orderMax, CONFIDENCE.orderFirst + CONFIDENCE.orderStep * (evidence - 1)),
      status: explicit || evidence >= ORDER_EVIDENCE_TO_ACTIVE ? "ACTIVE" : "CANDIDATE",
    });
  }

  rememberAddress({ customerId, address, label = null, used = false }) {
    if (!address) return null;
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    const existing = this.store.getAddress(customerId, normalized);
    if (existing) {
      this.store.touchAddress(existing.id, { label, used });
      return existing;
    }
    const isFirst = this.store.listAddresses(customerId).length === 0;
    this.store.insertAddress({ customerId, label, address, normalizedAddress: normalized, isDefault: isFirst, usageCount: used ? 1 : 0 });
    return this.store.getAddress(customerId, normalized);
  }

  /**
   * After an order is CONFIRMED (never before). Idempotent per order.
   * @param instructions [{attribute, value, label, temporality}] used for that order
   */
  learnFromConfirmedOrder({ customerId, merchantId, orderRef, instructions = [], address = null }) {
    const inserted = this.store.insertOrderRef({ customerId, merchantId, orderRef, instructions });
    if (!inserted) return false; // already learned from this order
    for (const i of instructions) {
      // "hôm nay …" instructions are not habits; memory-proposed ones were
      // re-confirmed by the customer, so they count like any other.
      if (i.temporality !== "current_only") this._orderEvidence({ customerId, merchantId, instruction: i });
    }
    if (address) this.rememberAddress({ customerId, address, used: true });
    return true;
  }

  // ======================================================================
  // LAYER 2 — intelligence
  // ======================================================================

  /** Applied preferences only: ACTIVE and confident enough. */
  activePreferences(customerId, merchantId, productIds = []) {
    const rank = { product: 3, merchant: 2, global: 1 };
    const byAttr = new Map();
    for (const p of this.store.listApplicable(customerId, merchantId)) {
      if (p.status !== "ACTIVE" || p.confidence < APPLY_MIN_CONFIDENCE) continue;
      if (p.scope === "product" && !productIds.includes(p.product_id)) continue;
      const current = byAttr.get(p.attribute);
      if (!current || rank[p.scope] > rank[current.scope]) byAttr.set(p.attribute, p);
    }
    return [...byAttr.values()];
  }

  /**
   * Merges instructions by the memory priority rules — for each attribute
   * the highest-priority source wins:
   *   1 current message  2 current conversation  3 explicit persistent
   *   preference  6 recent order  (confidence-gated, evidence-based)
   * "normal" values are kept only when they override something.
   */
  resolveInstructions({ customerId, merchantId, productIds = [], current = [], conversation = [], historical = [] }) {
    const layers = [
      ...historical.map((i) => ({ ...i, source: "recent_order" })),
      ...this.activePreferences(customerId, merchantId, productIds).map((p) => ({
        attribute: p.attribute,
        value: p.value,
        label: p.label,
        source: "preference",
        confidence: p.confidence,
      })),
      ...conversation.map((i) => ({ ...i, source: "conversation" })),
      ...current.map((i) => ({ ...i, source: "current" })),
    ];
    const byAttr = new Map();
    for (const i of layers) {
      const previous = byAttr.get(i.attribute);
      byAttr.set(i.attribute, { ...i, overrides: previous ?? null });
    }
    return [...byAttr.values()].filter((i) => i.value !== "normal" || i.overrides);
  }

  /**
   * "giao chỗ cũ" / "giao về nhà": one clear address, a choice, or nothing.
   * Never guessed: several unlabeled addresses -> the customer chooses.
   */
  resolveAddress({ customerId, label = null }) {
    const all = this.store.listAddresses(customerId);
    if (all.length === 0) return { none: true };
    if (label) {
      const labeled = all.filter((a) => a.label === label);
      if (labeled.length === 1) return { address: labeled[0].address };
      return labeled.length > 1 ? { choices: labeled } : { none: true, label };
    }
    if (all.length === 1) return { address: all[0].address };
    return { choices: all };
  }

  /**
   * "như cũ" / "như mọi lần": a reorder CANDIDATE built from the customer's
   * confirmed orders at THIS merchant, re-read from the real orders and
   * mapped onto the CURRENT menu. Nothing is created here.
   *
   * @param orderReader {
   *   readOrder(orderRef) -> {items:[{productId, name, quantity}], address, fulfillment} | null,
   *   currentProduct(productId) -> {id, name, price, available} | null }
   * @returns null (no history) | {
   *   source, orderRef, items:[{productId, name, quantity, price}],
   *   unavailable:[{name, quantity}], instructions, address, fulfillment, total }
   */
  buildReorderCandidate({ customerId, merchantId, orderReader, preferRecurring = false, current = [], productIdsHint = [] }) {
    const refs = this.store.listOrderRefs(customerId, merchantId, HISTORY_LIMIT);
    const orders = refs.map((ref) => ({ ref, order: orderReader.readOrder(ref.order_ref) })).filter((o) => o.order && o.order.items.length > 0);
    if (orders.length === 0) return null;

    const signature = (o) =>
      o.order.items
        .map((i) => `${i.productId}:${i.quantity}`)
        .sort()
        .join(",");
    const counts = new Map();
    for (const o of orders) counts.set(signature(o), (counts.get(signature(o)) || 0) + 1);
    const recurring = orders.find((o) => counts.get(signature(o)) >= 2) || null;
    const chosen = preferRecurring && recurring ? recurring : orders[0];

    const items = [];
    const unavailable = [];
    for (const item of chosen.order.items) {
      const product = orderReader.currentProduct(item.productId);
      // the current menu always wins: gone/unavailable is reported, never substituted
      if (!product || !product.available) unavailable.push({ name: item.name, quantity: item.quantity });
      else items.push({ productId: product.id, name: product.name, quantity: item.quantity, price: product.price });
    }
    const historical = (chosen.ref.instructions || []).filter((i) => i.temporality !== "current_only");
    const instructions = this.resolveInstructions({
      customerId,
      merchantId,
      productIds: [...items.map((i) => i.productId), ...productIdsHint],
      historical,
      current,
    });
    const address = chosen.order.address || null;
    return {
      source: chosen === recurring && preferRecurring ? "recurring_order" : "recent_order",
      recurring: Boolean(recurring),
      orderRef: chosen.ref.order_ref,
      items,
      unavailable,
      instructions,
      address,
      fulfillment: chosen.order.fulfillment || (address ? "delivery" : null),
      total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    };
  }
}
