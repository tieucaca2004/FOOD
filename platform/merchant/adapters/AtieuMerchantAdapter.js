import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js"; // generic pure utility — read-only reuse

const hasMarks = (word) => stripAccents(word) !== word;
// words that name nothing: quantity, container, question and polite words (accent-free)
const FILLER = new Set(
  "co khong ko k hong cho toi minh em anh chi tui ban mot hai ba bon nam to phan dia ly suat cai goi dat them lay mua an muon can gia bao nhieu tien voi nhe nha a oi di nua con".split(" ")
);

/**
 * Wraps the existing, unmodified A Tiểu engine (src/services, src/router)
 * behind the platform's MerchantModule contract. Every call here delegates
 * to A Tiểu's real services — nothing about A Tiểu's own code changes.
 *
 * Identity mapping: customers only ever talk to the Tổng Đài OA now, so
 * there is no real "A Tiểu OA zalo_user_id" for them. A Tiểu's schema only
 * needs zalo_user_id to be a stable, unique opaque string per customer —
 * so this adapter synthesizes one as `platform:<platformCustomerId>`. A
 * Tiểu's module has no idea it's being driven by a proxy; its own contract
 * (customers.zalo_user_id unique) is fully satisfied.
 */
export class AtieuMerchantAdapter extends MerchantModule {
  constructor({ merchantId, services, router }) {
    super();
    this._merchantId = merchantId;
    this.services = services; // A Tiểu's src/services/index.js createServices(...) output
    this.router = router; // A Tiểu's src/router/businessRouter.js BusinessRouter instance
  }

  get merchantId() {
    return this._merchantId;
  }

  // Whole words only, accents the customer typed respected ("bơ"/"bố" are not "bò"), and a one-word keyword
  // ("bò") only when the question names nothing else ("bún bò" is another dish, not Hủ Tiếu Xào Bò). A plain
  // substring of the accent-free text used to match "bún bò", "khủng bố bot", "bánh bò" to Hủ Tiếu Xào Bò.
  async searchProducts(queryText) {
    const query = stripAccents(queryText || "");
    const typed = String(queryText || "").normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const keys = typed.map((w) => stripAccents(w));
    const products = this.services.menu.repos.products.list({ includeUnavailable: true });

    return products
      .map((p) => {
        const nameNorm = stripAccents(p.name);
        const nameWords = String(p.name).normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const accented = new Map(nameWords.map((w) => [stripAccents(w), w])); // "bo" -> "bò"
        const keywordNorms = p.keywords.map(stripAccents);
        const at = (words) => {
          for (let i = 0; i + words.length <= keys.length; i++) {
            if (!words.every((w, j) => keys[i + j] === w)) continue;
            // a word typed WITH accents must be the dish's own word ("bơ" is not "bò")
            if (words.every((w, j) => !hasMarks(typed[i + j]) || !accented.has(w) || accented.get(w) === typed[i + j])) return i;
          }
          return -1;
        };
        const keywordHit = keywordNorms.some((k) => {
          const words = k.split(" ").filter(Boolean);
          const i = at(words);
          if (i < 0) return false;
          if (words.length > 1) return true;
          // a one-word keyword: the rest of the question must name nothing (only filler words)
          return keys.every((w, j) => j === i || FILLER.has(w) || /^\d+$/.test(w));
        });
        let matchQuality = null;
        const marksAgree = typed.every((w, j) => !hasMarks(w) || !accented.has(keys[j]) || accented.get(keys[j]) === w);
        if ((nameNorm === query || keywordNorms.includes(query)) && marksAgree) matchQuality = "exact";
        else if (keywordHit) matchQuality = "keyword";
        else if (query.length >= 3 && keys.length && ` ${nameNorm} `.includes(` ${keys.join(" ")} `) && typed.every((w, j) => !hasMarks(w) || accented.get(keys[j]) === w)) matchQuality = "category";
        return matchQuality ? { productId: p.id, name: p.name, price: p.price, available: p.available, matchQuality } : null;
      })
      .filter(Boolean);
  }

  async getMenuSummary() {
    const products = this.services.menu.listMenu();
    const name = this.services.orders.repos.settings.get("store_name") || "Hủ Tiếu Xào A Tiểu";
    const address = this.services.orders.repos.settings.get("store_address") || null;
    return {
      name,
      address,
      items: products.map((p) => ({ name: p.name, price: p.price, available: p.available })),
    };
  }

  async handleMessage(platformCustomerId, text) {
    const zaloUserId = `platform:${platformCustomerId}`;
    const customer = this.services.customers.getOrCreateByZaloUserId(zaloUserId, null);
    const session = this.services.sessions.getOrCreate(customer.id);
    const { replyText, session: updatedSession } = await this.router.handle({ customer, session, text });
    // current_intent is a field A Tiểu's own router already sets on every
    // turn (src/router/businessRouter.js _reply()) — reading it here is
    // observation, not a modification to A Tiểu's code, and lets the
    // platform log funnel analytics (ADD_TO_CART/CHECKOUT_STARTED/...)
    // without A Tiểu needing to know the platform exists.
    return { replyText, merchantIntent: updatedSession.current_intent, orderRef: this._latestOrderCode(customer.id) };
  }

  // Read-only observation of A Tiểu's own checkout progress (its session
  // row) — which checkout question its engine is waiting on, if any. Never
  // writes and never creates a customer/session.
  checkoutState(platformCustomerId) {
    const customer = this._atieuCustomer(platformCustomerId);
    const session = customer ? this.services.sessions.repos.sessions.getActiveByCustomer(customer.id) : null;
    const pendingOrder = session?.pending_order_id ? this.services.orders.repos.orders.getById(session.pending_order_id) : null;
    return {
      field: session?.pending_checkout_field ?? null, // 'fulfillment_type' | 'address' | 'phone' | null
      awaitingConfirmation: Boolean(session?.pending_confirmation),
      pendingOrderTotal: pendingOrder?.total ?? null,
    };
  }

  // Read-only: is an order being built with this module (a checkout question, a confirmation, a pending
  // order, or a cart with items)? The platform keeps the customer in the place while it is.
  hasOrderInProgress(platformCustomerId) {
    const customer = this._atieuCustomer(platformCustomerId);
    if (!customer) return false;
    const state = this.checkoutState(platformCustomerId);
    if (state.field || state.awaitingConfirmation || state.pendingOrderTotal !== null) return true;
    const carts = this.services.cart?.repos?.carts;
    const cart = carts?.getActiveByCustomer(customer.id);
    return Boolean(cart && carts.listItems(cart.id).length);
  }

  // Read-only: how many items are in this customer's active cart with the module (null: no customer yet).
  cartQuantity(platformCustomerId) {
    const customer = this._atieuCustomer(platformCustomerId);
    if (!customer) return 0;
    const carts = this.services.cart?.repos?.carts;
    const cart = carts?.getActiveByCustomer(customer.id);
    return cart ? carts.listItems(cart.id).reduce((n, i) => n + (i.quantity ?? 0), 0) : 0;
  }

  _atieuCustomer(platformCustomerId) {
    return this.services.customers.repos.customers.findByZaloUserId(`platform:${platformCustomerId}`) || null;
  }

  // --- read-only views for customer memory (A Tiểu's orders stay the source of truth) ---

  // One of THIS customer's confirmed A Tiểu orders, or null (someone
  // else's, unconfirmed, cancelled or unknown).
  memoryOrder(platformCustomerId, orderRef) {
    const customer = this._atieuCustomer(platformCustomerId);
    const order = customer ? this.services.orders.repos.orders.getByCode(orderRef) : null;
    if (!order || order.customer_id !== customer.id) return null;
    if (["DRAFT", "PENDING_CONFIRMATION", "CANCELLED"].includes(order.status)) return null;
    return {
      items: this.services.orders.repos.orders.listItems(order.id).map((i) => ({ productId: i.product_id, name: i.product_name, quantity: i.quantity })),
      address: order.fulfillment_type === "delivery" ? order.delivery_address : null,
      fulfillment: order.fulfillment_type === "delivery" ? "delivery" : order.fulfillment_type ? "pickup" : null,
    };
  }

  // The product as it is on A Tiểu's menu NOW (current price/availability).
  memoryProduct(productId) {
    const p = this.services.menu.repos.products.findById(productId);
    return p ? { id: p.id, name: p.name, price: p.price, available: Boolean(p.available) } : null;
  }

  _latestOrderCode(atieuCustomerId) {
    const [latest] = this.services.orders.repos.orders.listByCustomer(atieuCustomerId, 1);
    return latest?.order_code || null;
  }

  isOpenNow() {
    // opening_hours is an unverified placeholder string (see
    // data/seed/NEEDS_OWNER_INPUT.md) — never infer open/closed from it.
    return { known: false };
  }
}
