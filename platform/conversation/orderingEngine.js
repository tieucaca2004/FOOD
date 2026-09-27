import { understandMessage, yesNoAnswer } from "./understand.js";
import { looksLikeAddress } from "./checkoutDetails.js";
import { formatReorderCandidate } from "./reorderText.js";
import { resolveItemRequest, parseItemRequest, matchByName, matchCategories } from "../nlp/genericOrderText.js";
import { normalizeForMatch } from "../nlp/searchQuery.js";
import { typoCandidates, sharedWords } from "../nlp/fuzzyMatch.js";
import { normalizePhrase, displayPhrase } from "../services/productLanguageService.js";

// Conversational Ordering Engine (V1) for data-driven merchants.
//
//   MESSAGE ──understand()──► intent + entities
//   + STATE (conversation memory: focus products, last cart lines, pending
//     clarification / confirmation)            ──► resolve context
//   + MENU (MenuService)                       ──► resolve entities
//   ambiguous? ──► ask, remember what was asked (never guess)
//   else      ──► execute through CartService / OrderService (sources of truth)
//   ──► remember the new state
//
// Merchant-agnostic: every merchant is data. The engine never trusts a price,
// total or merchant id from text; CartService/OrderService recompute them.

const MAX_CHOICES = 10;
// A menu this large that has categories is shown as its categories first.
export const MENU_FLAT_LIMIT = 20;

export function vnd(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}

const ERROR_REPLIES = {
  PRODUCT_UNAVAILABLE: "Dạ món này hiện tạm hết, anh/chị chọn món khác giúp em nha.",
  PRODUCT_NOT_FOUND: "Dạ em không tìm thấy món này trong menu quán.",
  INVALID_QUANTITY: "Dạ số lượng chưa hợp lệ, anh/chị nhập số lượng từ 1 đến 50 giúp em nha.",
  CART_ITEM_LIMIT_EXCEEDED: "Dạ giỏ hàng đã đạt số món tối đa.",
  PRICE_CHANGED: 'Dạ giá một số món vừa thay đổi, anh/chị xem lại giỏ (gõ "xem giỏ") rồi đặt lại giúp em nha.',
  MERCHANT_NOT_ACTIVE: "Dạ quán này hiện không nhận đơn.",
  CART_EMPTY: "Dạ giỏ hàng đang trống.",
  ORDER_ALREADY_EXISTS_FOR_CART: "Dạ giỏ này đã được đặt thành đơn rồi ạ.",
};

// A delivery address must at least carry a house/alley number and a street
// word. Nothing is ever completed or invented (ward, city, recipient…).
function isUsableAddress(address) {
  return /\d/.test(address) && /[\p{L}]{2,}/u.test(address.replace(/\d+/g, ""));
}

// lastResolutions: phrase -> product decisions made in the previous turn,
//   judged by what the customer says next (learning signal).
// lastAdded: cart additions of the previous turn (undone by "Không, …").
// cartPhrases: phrases behind the current cart lines, confirmed when the
//   order is placed.
// instructions: food instructions for the CURRENT order ([{attribute,
//   value, label, temporality}]); freeNote: other free-text note (e.g. a time).
function freshState(merchantId) {
  return {
    merchantId,
    focus: [],
    lastLines: [],
    pending: null,
    lastResolutions: [],
    lastAdded: [],
    cartPhrases: [],
    focusPhrase: null,
    instructions: [],
    freeNote: null,
  };
}

function cartItemsSignature(cart) {
  return cart.items.map((i) => `${i.product_id}:${i.quantity}:${i.unit_price}`).join(",");
}

// Messages after which the previous resolution is neither right nor wrong.
const NEUTRAL_FOLLOW_UPS = new Set(["negation", "cancel_pending", "remove_from_cart", "cancel_order", "clear_cart", "unknown"]);

function isExactName(phrase, product) {
  const wanted = normalizeForMatch(phrase);
  return [product.name, ...product.name.split(" - ")].some((part) => normalizeForMatch(part) === wanted);
}

export class ConversationalOrderingEngine {
  constructor({
    merchantId,
    menuService,
    merchantDataService,
    cartService,
    orderService,
    conversationStates,
    cartCheckout,
    productLanguage = null,
    customerMemory = null,
  }) {
    this.merchantId = merchantId;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
    this.cartService = cartService;
    this.orderService = orderService;
    this.conversationStates = conversationStates;
    this.cartCheckout = cartCheckout;
    this.productLanguage = productLanguage; // optional: without it the engine simply doesn't learn
    this.customerMemory = customerMemory; // optional: without it the engine has no memory across orders
  }

  async handle(customerId, text) {
    const msg = understandMessage(text);
    const saved = this.conversationStates.getByCustomer(customerId);
    const state = saved?.merchantId === this.merchantId ? { ...freshState(this.merchantId), ...saved } : freshState(this.merchantId);
    const turn = { customerId, msg, state, previous: state.lastResolutions || [], previousAdded: state.lastAdded || [] };
    state.lastResolutions = [];
    state.lastAdded = [];
    this._settlePreviousTurn(turn);
    try {
      return await this._route(turn);
    } catch (err) {
      const known = ERROR_REPLIES[err.code];
      if (!known) throw err;
      return this._reply(known);
    } finally {
      this.conversationStates.saveForCustomer(customerId, turn.state);
    }
  }

  // ---------------------------------------------------------------- routing

  async _route(turn) {
    const { msg, state } = turn;

    // 1. A pending question gets first claim on the answer.
    if (state.pending?.type === "confirm_address") {
      const answer = yesNoAnswer(msg.raw);
      const { address, fromReview } = state.pending;
      if (answer === true) {
        // offered from the summary: re-show it with the address, ready to confirm
        state.pending = fromReview ? { type: "need_fulfillment" } : null;
        return this._setCheckout(turn, { fulfillment_type: "delivery", delivery_address: address });
      }
      if (answer === false) {
        state.pending = fromReview ? { type: "need_fulfillment" } : null;
        return this._reply(fromReview ? 'Dạ vâng, anh/chị cho em xin địa chỉ giao hàng khác hoặc gõ "lấy tại quán" ạ.' : "Dạ vâng ạ. Anh/chị cần gì thêm cứ nhắn em nha.");
      }
    }
    // A bare "76 Nguyễn Thị Minh Khai" is the address when checkout is
    // waiting for one — never searched in the menu. Outside checkout it is
    // asked about instead of being treated as food.
    const bareAddress = this._bareAddress(turn);
    if (bareAddress) {
      if (["need_fulfillment", "confirm", "confirm_address"].includes(state.pending?.type)) {
        return this._setCheckout(turn, { fulfillment_type: "delivery", delivery_address: bareAddress });
      }
      state.pending = { type: "confirm_address", address: bareAddress };
      return this._reply(`Dạ "${bareAddress}" là địa chỉ giao hàng phải không ạ? (gõ "đúng" để em lưu địa chỉ này)`);
    }
    // an unanswered address offer does not linger into later messages
    if (state.pending?.type === "confirm_address") state.pending = state.pending.fromReview ? { type: "need_fulfillment" } : null;
    if (state.pending?.type === "confirm_product") {
      const answer = yesNoAnswer(msg.raw);
      if (answer !== null) return this._answerSuggestion(turn, answer);
      state.pending = null; // something else entirely: a new request
    }
    if (state.pending?.type === "choose_product") {
      const answered = await this._answerChoice(turn);
      if (answered) return answered;
      if (msg.intent !== "cancel_pending") state.pending = null; // a new request replaces the unanswered question
    }
    if (state.pending?.type === "confirm_reorder") {
      const answer = msg.intent === "confirm_order" ? true : yesNoAnswer(msg.raw);
      const pending = state.pending;
      state.pending = null;
      if (answer === true) return this._executeReorder(turn, pending);
      if (answer === false) return this._reply("Dạ vâng ạ. Anh/chị muốn gọi món gì ạ?");
    }
    if (state.pending?.type === "choose_address") {
      const choices = state.pending.choices;
      const n = msg.intent === "choose_option" ? msg.ordinal : msg.intent === "quantity_only" ? msg.quantity : null;
      state.pending = null;
      if (n !== null && choices[n - 1]) return this._setCheckout(turn, { fulfillment_type: "delivery", delivery_address: choices[n - 1] });
    }

    // Food instructions carried by any message ("cho 2 thập cẩm, không hành")
    const instructionAck = msg.instructions && !["food_instruction", "reorder"].includes(msg.intent) ? this._applyInstructions(turn) : null;
    const result = await this._dispatch(turn);
    return instructionAck ? this._reply(`${result.replyText}\n\n${instructionAck}`, result.merchantIntent, result.orderRef) : result;
  }

  async _dispatch(turn) {
    const { msg, state } = turn;
    switch (msg.intent) {
      case "food_instruction":
        return this._reply(this._applyInstructions(turn));
      case "reorder":
        return this._reorder(turn);
      case "greeting":
      case "general_help":
      case "unknown":
        return this._reply(this._helpText());
      case "cancel_pending":
        return this._cancelPending(state);
      case "show_menu":
        return this._reply(await this._menuText());
      case "browse_category":
        return this._browse(turn);
      case "store_location":
        return this._locationReply();
      case "delivery_question":
        return this._reply(
          'Dạ Tổng Đài chuyển đơn tới quán, việc giao hàng do quán sắp xếp ạ. Anh/chị cho em địa chỉ (VD: "giao tới 7 Nguyễn Thiện Thuật") hoặc gõ "lấy tại quán" nha.'
        );
      case "ask_product_availability":
        return this._askAboutProduct(turn, "availability");
      case "ask_product_price":
        return this._askAboutProduct(turn, "price");
      case "mention":
        return this._askAboutProduct(turn, "mention");
      case "add_to_cart": {
        // An order that also carries checkout details ("… gửi về 76 …"):
        // both parts are kept.
        const added = await this._addSegments(turn, msg.items);
        if (msg.note) this._addFreeNote(turn, msg.note);
        const patch = this._checkoutPatch(msg);
        if (!patch && !msg.invalidPhone && !msg.note) return added;
        const noted = this._storeCheckout(turn, patch, msg.invalidPhone);
        return this._reply(`${added.replyText}\n\n${noted}`, added.merchantIntent, added.orderRef);
      }
      case "quantity_only":
        return this._quantityOnly(turn);
      case "choose_option":
        return this._reply("Dạ hiện em không có danh sách nào đang chờ anh/chị chọn ạ.");
      case "adjust_quantity":
        return this._adjustQuantity(turn);
      case "correction":
        return this._correction(turn);
      case "change_quantity":
        return this._changeQuantity(turn);
      case "remove_from_cart":
        return this._remove(turn);
      case "clear_cart": {
        const cart = this._cart(turn.customerId);
        this.cartService.clearCart(turn.customerId, cart.id);
        state.lastLines = [];
        state.cartPhrases = [];
        return this._reply("Dạ em đã xóa hết giỏ hàng.");
      }
      case "show_cart":
        return this._reply(this._cartText(this._cart(turn.customerId), { withCheckout: true }));
      case "ask_total":
        return this._total(turn);
      case "review_order":
      case "checkout":
        return this._review(turn);
      case "provide_delivery_address":
        return this._provideAddress(turn);
      case "provide_fulfillment":
        return this._setCheckout(turn, { fulfillment_type: "pickup", delivery_address: null });
      case "provide_phone":
        return this._setCheckout(turn, { customer_phone: msg.phone });
      case "provide_note": {
        this._addFreeNote(turn, msg.note);
        return this._reply(`Dạ em đã ghi chú: ${msg.note}`);
      }
      case "confirm_order":
        return this._confirm(turn);
      case "cancel_order":
        state.pending = null;
        return this._reply("Dạ em đã hủy bước chốt đơn, giỏ hàng vẫn được giữ nguyên ạ.");
      case "negation":
        return this._negation(turn);
      default:
        return this._reply(this._helpText());
    }
  }

  // ------------------------------------------------------ clarification

  _askToChoose(state, candidates, { action, quantity = null, delta = null, queue = [], intro, phrase = null }) {
    const shown = candidates.slice(0, MAX_CHOICES);
    state.pending = { type: "choose_product", action, quantity, delta, queue, phrase, candidates: shown.map((c) => c.id) };
    const lines = shown.map((c, i) => `${i + 1}. ${c.name}${c.price !== undefined ? `: ${vnd(c.price)}` : ""}`);
    const more = candidates.length > MAX_CHOICES ? `\n… và ${candidates.length - MAX_CHOICES} món khác (gõ rõ tên hơn)` : "";
    return `${intro ?? `Dạ có ${candidates.length} món phù hợp:`}\n${lines.join("\n")}${more}\n\nAnh/chị chọn món nào ạ? (gõ số thứ tự hoặc tên món)`;
  }

  // Resolves the answer to "which one?" — by number, or by a name that
  // matches exactly one of the offered candidates. Returns null when the
  // message isn't an answer, so it is handled as a new request.
  async _answerChoice(turn) {
    const { msg, state } = turn;
    const pending = state.pending;
    const pool = pending.candidates.map((id) => this._productById(id) || this._cartLineAsProduct(turn, id)).filter(Boolean);

    let chosen = null;
    const ordinal = msg.intent === "choose_option" ? msg.ordinal : msg.intent === "quantity_only" && /^\d+$/.test(msg.norm) ? msg.quantity : null;
    if (ordinal !== null) {
      chosen = pool[ordinal - 1] ?? null;
      if (!chosen) return this._reply(`Dạ danh sách chỉ có ${pool.length} lựa chọn, anh/chị chọn lại giúp em nha.`);
    } else if (msg.intent === "mention" || (msg.intent === "add_to_cart" && msg.items.length === 1)) {
      const query = msg.intent === "mention" ? msg.query : msg.items[0];
      const { match } = matchByName(query, pool);
      chosen = match;
    }
    if (!chosen) return null;

    state.pending = null;
    // An ambiguous phrase ("pizza") never becomes an alias from a choice.
    // The choice only strengthens evidence that already existed for it and
    // weakens evidence pointing at the products NOT chosen.
    const phrase = normalizePhrase(pending.phrase);
    if (this.productLanguage && phrase) {
      const ctx = { merchantId: this.merchantId, customerId: turn.customerId, phrase, productId: chosen.id, source: "clarification" };
      this.productLanguage.confirm(ctx, { createIfMissing: false });
      this.productLanguage.rejectOthers(ctx);
    }
    const reply = await this._executeChosen(turn, pending, chosen);
    if (pending.queue?.length) {
      const rest = await this._addSegments(turn, pending.queue);
      return this._reply(`${reply.replyText}\n\n${rest.replyText}`, rest.merchantIntent ?? reply.merchantIntent);
    }
    return reply;
  }

  async _executeChosen(turn, pending, product) {
    switch (pending.action) {
      case "add":
        return this._addProducts(turn, [{ product, quantity: pending.quantity ?? 1 }], []);
      case "remove":
        return this._removeLine(turn, product.id);
      case "change":
        return this._setLineQuantity(turn, product.id, pending.quantity);
      case "adjust":
        return this._adjustLine(turn, product.id, pending.delta);
      case "price":
      case "availability":
      case "focus":
      default:
        turn.state.focus = [product.id];
        return this._reply(this._productInfo(product));
    }
  }

  // ------------------------------------------------------ learning

  // The customer's reply to the previous turn is the outcome of its
  // resolutions: carrying on confirms them, "Không, …" rejects them (in
  // _negation), and a few replies say nothing either way.
  _settlePreviousTurn(turn) {
    if (!this.productLanguage || turn.previous.length === 0) return;
    if (NEUTRAL_FOLLOW_UPS.has(turn.msg.intent)) return;
    for (const r of turn.previous) {
      this.productLanguage.confirm(
        { merchantId: this.merchantId, customerId: turn.customerId, phrase: r.phrase, productId: r.productId, source: "accepted" },
        { createIfMissing: false }
      );
    }
  }

  // Records "the customer said <phrase> and meant <product>" as OBSERVED
  // evidence. Canonical names teach nothing and are skipped.
  _learnResolution(turn, { phrase, original, product, source, forCart = false }) {
    if (!this.productLanguage || source === "canonical_name") return;
    const norm = normalizePhrase(phrase);
    if (!norm || !this.productLanguage.isLearnable(norm, product)) return;
    const display = displayPhrase(original ?? phrase, norm);
    this.productLanguage.observe({ merchantId: this.merchantId, customerId: turn.customerId, phrase: norm, display, product, source });
    const record = { phrase: norm, productId: product.id, source };
    turn.state.lastResolutions.push(record);
    if (forCart) turn.state.cartPhrases.push(record);
    else turn.state.focusPhrase = record;
  }

  /**
   * Product resolution, in priority order (spec):
   *   1 exact canonical name   2 conversation context (the list just shown)
   *   3 TRUSTED alias          4 CONFIRMED alias
   *   5 unique name match      6 ambiguous -> clarification
   * Weaker evidence is only ever SUGGESTED ("ý anh/chị là …?"), never acted on:
   *   OBSERVED alias, typo match, partial overlap with the product in focus.
   * Aliases are looked up among currently orderable products only, so an
   * alias of an inactive product is ignored rather than re-pointed.
   * @returns {{product, source}|{candidates}|{suggestion, source}|{}}
   */
  _resolvePhrase(turn, phrase, pool, nameResult = null) {
    if (!phrase) return {};
    const r = nameResult ?? matchByName(phrase, pool);
    const exact = pool.filter((p) => isExactName(phrase, p));
    if (exact.length === 1) return { product: exact[0], source: "canonical_name" };

    // context settles only what the name alone leaves open
    const fromContext = r.match ? null : this._narrowByFocus(turn.state, r.candidates, phrase);
    if (fromContext) return { product: fromContext, source: "context" };

    const learnPhrase = normalizePhrase(phrase);
    const orderable = this._orderable();
    const learned = this.productLanguage && learnPhrase ? this.productLanguage.resolveLearned(this.merchantId, learnPhrase, orderable) : null;
    const learnedProduct = learned && pool.some((p) => p.id === learned.product.id) ? learned.product : null;
    const nameAmbiguous = r.candidates.length > 1;
    // A learned alias acts directly only where the menu itself is not
    // ambiguous. For a phrase naming several dishes ("hải sản") it is
    // offered as the likely answer, never applied silently. Where the name
    // was only settled by preferring the plain dish over its variants, the
    // customers' own established language for one of those dishes comes first.
    const learnedAmongVariants = learnedProduct && r.match && r.candidates.some((c) => c.id === learnedProduct.id);
    if (learnedProduct && (!nameAmbiguous || learnedAmongVariants)) return { product: learnedProduct, source: "learned_alias" };
    if (r.match) return { product: r.match, source: "name_match" };
    if (learnedProduct) return { suggestion: learnedProduct, source: "learned_alias" };
    if (nameAmbiguous) return { candidates: r.candidates };

    if (this.productLanguage && learnPhrase) {
      const observed = this.productLanguage.suggestObserved(this.merchantId, learnPhrase, orderable);
      if (observed) return { suggestion: observed, source: "learned_alias" };
    }
    const typo = typoCandidates(phrase, orderable);
    if (typo.length === 1) return { suggestion: typo[0], source: "fuzzy_match" };
    if (typo.length > 1) return { candidates: typo };

    const focus = turn.state.focus.map((id) => orderable.find((p) => p.id === id)).filter(Boolean);
    if (focus.length === 1 && sharedWords(phrase, focus[0].name).length > 0) return { suggestion: focus[0], source: "context" };
    return {};
  }

  _suggest(turn, product, { action, quantity = null, phrase, original, source, queue = [] }) {
    turn.state.pending = { type: "confirm_product", action, quantity, productId: product.id, phrase, original, source, queue };
    return `Dạ ý anh/chị là "${product.name}" (${vnd(product.price)}) phải không ạ? (gõ "đúng", hoặc gõ tên món khác)`;
  }

  // "đúng" / "không" to "ý anh/chị là X?". An explicit yes is the strongest
  // evidence there is; an explicit no is remembered so X isn't offered for
  // that phrase again.
  async _answerSuggestion(turn, yes) {
    const pending = turn.state.pending;
    turn.state.pending = null;
    const product = this._productById(pending.productId);
    const phrase = normalizePhrase(pending.phrase);
    if (this.productLanguage && phrase && product) {
      const ctx = {
        merchantId: this.merchantId,
        customerId: turn.customerId,
        phrase,
        display: displayPhrase(pending.original ?? pending.phrase, phrase),
        product,
        source: pending.source === "fuzzy_match" ? "fuzzy_match" : "clarification",
      };
      if (yes) {
        this.productLanguage.observe(ctx);
        this.productLanguage.confirm(ctx);
      } else {
        this.productLanguage.reject(ctx);
      }
    }
    if (!yes || !product || !product.available) {
      return this._reply('Dạ vậy anh/chị muốn món nào ạ? Gõ "menu" để xem thực đơn nha.');
    }
    const record = { phrase, productId: product.id, source: "clarification" };
    if (pending.action === "add") {
      if (phrase) turn.state.cartPhrases.push(record);
      const added = this._addProducts(turn, [{ product, quantity: pending.quantity ?? 1 }], []);
      if (pending.queue?.length) {
        const rest = await this._addSegments(turn, pending.queue);
        return this._reply(`${added.replyText}\n\n${rest.replyText}`, "add_to_cart");
      }
      return added;
    }
    turn.state.focus = [product.id];
    if (phrase) turn.state.focusPhrase = record;
    return this._reply(this._productInfo(product));
  }

  // "Không, pizza bò" / "không phải món đó": the previous resolution was
  // wrong. Its evidence is rejected, what it added is taken back out, and
  // the replacement (if any) is ordered in the same quantity.
  async _negation(turn) {
    const { msg, state } = turn;
    const replacement = msg.replacement ? understandMessage(msg.replacement) : null;
    // "Không, 3" is a quantity fix, not a wrong product.
    if (replacement?.intent === "quantity_only") {
      return this._correction({ ...turn, msg: { ...msg, intent: "correction", quantity: replacement.quantity } });
    }
    if (this.productLanguage) {
      for (const r of turn.previous) {
        this.productLanguage.reject(
          { merchantId: this.merchantId, customerId: turn.customerId, phrase: r.phrase, productId: r.productId, source: "correction" },
          { createIfMissing: false }
        );
      }
    }
    const undone = [];
    const cart = this._cart(turn.customerId);
    for (const added of turn.previousAdded) {
      const item = cart.items.find((i) => i.product_id === added.productId);
      if (!item) continue;
      const remaining = item.quantity - added.quantity;
      if (remaining > 0) this.cartService.updateItemQuantity(turn.customerId, cart.id, item.id, remaining);
      else this.cartService.removeItem(turn.customerId, cart.id, item.id);
      undone.push({ name: item.product_name, quantity: added.quantity });
      state.cartPhrases = state.cartPhrases.filter((p) => p.productId !== added.productId);
    }
    state.lastLines = [];
    state.focus = [];
    const undoneText = undone.length ? `Dạ em đã bỏ ${undone.map((u) => `${u.quantity} × ${u.name}`).join(", ")}.` : "Dạ vâng ạ.";
    if (!replacement || replacement.intent === "unknown") {
      return this._reply(`${undoneText} Anh/chị muốn món nào ạ?`);
    }
    // Same quantity as what was taken back, unless the replacement says one.
    const carried = undone.length === 1 ? undone[0].quantity : 1;
    const segments = (replacement.intent === "add_to_cart" ? replacement.items : [msg.replacement]).map((seg) =>
      parseItemRequest(seg).quantity === null ? `${carried} ${seg}` : seg
    );
    const result = await this._addSegments(turn, segments);
    return this._reply(`${undoneText}\n\n${result.replyText}`, result.merchantIntent);
  }

  _cancelPending(state) {
    const had = state.pending;
    state.pending = null;
    return this._reply(had ? "Dạ vâng, em bỏ qua bước đó ạ. Anh/chị cần gì thêm cứ nhắn em nha." : "Dạ vâng ạ.");
  }

  // ------------------------------------------------------ products

  _orderable() {
    return this._withCategory(this.menuService.listProducts(this.merchantId, { includeUnavailable: false }));
  }

  _allProducts() {
    return this._withCategory(this.menuService.listProducts(this.merchantId, { includeUnavailable: true }));
  }

  // Products carry their category's name, so words the customer takes from
  // it ("mì mềm bò", "thêm trứng") can find them.
  _withCategory(products) {
    const names = new Map(this.menuService.listCategories(this.merchantId).map((c) => [c.id, c.name]));
    return products.map((p) => (names.has(p.category_id) ? { ...p, category: names.get(p.category_id) } : p));
  }

  _productById(id) {
    return this._allProducts().find((p) => p.id === id) || null;
  }

  _cartLineAsProduct(turn, id) {
    const line = this._cart(turn.customerId).items.find((i) => i.product_id === id);
    return line ? { id: line.product_id, name: line.product_name, price: line.unit_price } : null;
  }

  // Context resolution: "2 tôm" is ambiguous on the whole menu, but right
  // after "Có sủi cảo không?" listed the sủi cảo options it means the ONE of
  // those with "tôm". Only a unique match inside the focus counts (the
  // plain dish over its variants, as on the whole menu).
  _narrowByFocus(state, candidates, phrase = null) {
    if (candidates.length < 2 || state.focus.length === 0) return null;
    const inFocus = candidates.filter((c) => state.focus.includes(c.id));
    if (inFocus.length === 1) return inFocus[0];
    return inFocus.length > 1 && phrase ? matchByName(phrase, inFocus).match : null;
  }

  _productInfo(product) {
    if (!product.available) return `Dạ ${product.name} hiện tạm hết ạ.`;
    return `Dạ có ạ: ${product.name} — ${vnd(product.price)}\nGõ số lượng (VD: "2 phần") hoặc "thêm 1 ${product.name}" để thêm vào giỏ.`;
  }

  // "Có sủi cảo không?", "giá?", "tôm" — answered from THIS merchant's menu only.
  _askAboutProduct(turn, kind) {
    const { msg, state } = turn;
    if (msg.ref === "last" || !msg.query) {
      const focus = state.focus.map((id) => this._productById(id)).filter(Boolean);
      if (focus.length === 1) return this._reply(kind === "price" ? `${focus[0].name}: ${vnd(focus[0].price)}` : this._productInfo(focus[0]));
      if (focus.length > 1) return this._reply(this._askToChoose(state, focus, { action: kind === "price" ? "price" : "focus" }));
      return this._reply(`Dạ anh/chị hỏi món nào ạ? (VD: "${this._exampleDish()} giá bao nhiêu")`);
    }

    const resolved = this._resolvePhrase(turn, msg.query, this._allProducts());
    if (resolved.product) {
      const match = resolved.product;
      state.focus = [match.id];
      this._learnResolution(turn, { phrase: msg.query, original: msg.raw, product: match, source: resolved.source });
      return this._reply(kind === "price" ? `${match.name}: ${vnd(match.price)}` : this._productInfo(match));
    }
    if (resolved.suggestion) {
      return this._reply(this._suggest(turn, resolved.suggestion, { action: "focus", phrase: msg.query, original: msg.raw, source: resolved.source }));
    }
    if (resolved.candidates) {
      const { candidates } = resolved;
      state.focus = candidates.map((c) => c.id);
      return this._reply(
        this._askToChoose(state, candidates, {
          action: "focus",
          phrase: msg.query,
          intro: `Dạ quán có ${candidates.length} món phù hợp với "${msg.query}":`,
        })
      );
    }
    if (kind === "mention") return this._reply(`Dạ em chưa hiểu ý anh/chị, hoặc quán chưa có món "${msg.query}".\n\n${this._helpText()}`);
    return this._reply(`Dạ quán chưa có món "${msg.query}" ạ. Gõ "menu" để xem thực đơn.`);
  }

  // ------------------------------------------------------ cart: add

  // Resolves each item segment against the menu, adds every unambiguous
  // one, and asks about the first ambiguous one (the rest wait in a queue).
  async _addSegments(turn, segments) {
    const products = this._orderable();
    const resolved = [];
    const notFound = [];
    for (let i = 0; i < segments.length; i++) {
      const request = resolveItemRequest(segments[i], products);
      const { quantity, query } = request;
      const res = this._resolvePhrase(turn, query, products, request);
      if (res.product) {
        resolved.push({ product: res.product, quantity: quantity ?? 1 });
        this._learnResolution(turn, { phrase: query, original: segments[i], product: res.product, source: res.source, forCart: true });
      } else if (res.candidates || res.suggestion) {
        const added = resolved.length ? this._addProducts(turn, resolved, notFound).replyText + "\n\n" : "";
        const options = { action: "add", quantity: quantity ?? 1, queue: segments.slice(i + 1), phrase: query, original: segments[i] };
        const ask = res.suggestion
          ? this._suggest(turn, res.suggestion, { ...options, source: res.source })
          : this._askToChoose(turn.state, res.candidates, { ...options, intro: `Dạ quán có ${res.candidates.length} món phù hợp với "${query}":` });
        return this._reply(added + ask, resolved.length ? "add_to_cart" : null);
      } else if (query) {
        notFound.push(query);
      }
    }
    if (resolved.length === 0) {
      if (notFound.length) return this._reply(`Dạ em không tìm thấy món "${notFound.join('", "')}" trong menu quán. Gõ "menu" để xem thực đơn nha.`);
      return this._reply(`Anh/chị muốn thêm món nào ạ? (VD: "cho 2 ${this._exampleDish()}")`);
    }
    return this._addProducts(turn, resolved, notFound);
  }

  _addProducts(turn, entries, notFound) {
    const cart = this._cart(turn.customerId);
    let updated = cart;
    for (const { product, quantity } of entries) {
      updated = this.cartService.addItem(turn.customerId, cart.id, this.merchantId, product.id, quantity);
    }
    turn.state.lastLines = entries.map((e) => e.product.id);
    turn.state.focus = entries.map((e) => e.product.id);
    turn.state.lastAdded.push(...entries.map((e) => ({ productId: e.product.id, quantity: e.quantity })));
    const lines = entries.map((e) => `✅ Đã thêm ${e.quantity} × ${e.product.name} (${vnd(e.product.price)})`);
    if (entries.length === 1) {
      const line = updated.items.find((i) => i.product_id === entries[0].product.id);
      lines.push(`Trong giỏ: ${line.quantity} × ${entries[0].product.name}`);
    }
    if (notFound.length) lines.push(`⚠️ Quán chưa có món: ${notFound.join(", ")}`);
    return this._reply(`${lines.join("\n")}\n\n${this._cartText(updated)}`, "add_to_cart");
  }

  // "2 cái" — how many of the product being discussed.
  _quantityOnly(turn) {
    const { msg, state } = turn;
    const cart = this._cart(turn.customerId);
    const focus = state.focus.map((id) => this._productById(id)).filter(Boolean);
    const justAdded = focus.length === 1 && state.lastLines.includes(focus[0].id) && cart.items.some((i) => i.product_id === focus[0].id);
    if (focus.length === 1 && !justAdded) {
      // the phrase that found this product now also stands behind a cart line
      if (state.focusPhrase?.productId === focus[0].id) state.cartPhrases.push(state.focusPhrase);
      return this._addProducts(turn, [{ product: focus[0], quantity: msg.quantity }], []);
    }
    if (justAdded) {
      return this._reply(
        `Dạ anh/chị muốn đổi ${focus[0].name} thành ${msg.quantity} (gõ "đổi thành ${msg.quantity}") hay thêm ${msg.quantity} phần nữa (gõ "thêm ${msg.quantity}") ạ?`
      );
    }
    if (focus.length > 1) return this._reply(this._askToChoose(state, focus, { action: "add", quantity: msg.quantity }));
    return this._reply(`Dạ ${msg.quantity} phần món nào ạ?`);
  }

  // ------------------------------------------------------ cart: modify

  // Resolves which cart line a modification refers to: an explicit name,
  // or "cái đó"/nothing = the line(s) just touched. Returns
  // { line } | { ask } | { none }.
  _resolveLine(turn, query, ref, action, extra = {}) {
    const cart = this._cart(turn.customerId);
    if (cart.isEmpty) return { none: "Dạ giỏ hàng đang trống ạ." };
    const lines = cart.items.map((i) => ({ id: i.product_id, name: i.product_name, price: i.unit_price, quantity: i.quantity }));

    if (!query || ref === "last") {
      // "cái đó" = the line just touched; with a single-line cart it can only mean that line.
      const recent = lines.filter((l) => turn.state.lastLines.includes(l.id));
      if (recent.length === 1) return { line: recent[0] };
      const pool = recent.length > 1 ? recent : lines;
      if (pool.length === 1) return { line: pool[0] };
      return { ask: this._askToChoose(turn.state, pool, { action, ...extra, intro: "Dạ anh/chị muốn sửa món nào trong giỏ:" }) };
    }
    const { match, candidates } = matchByName(query, lines);
    if (match) return { line: match };
    if (candidates.length > 1) return { ask: this._askToChoose(turn.state, candidates, { action, ...extra }) };
    return { none: `Dạ trong giỏ chưa có món "${query}".\n\n${this._cartText(cart)}` };
  }

  _changeQuantity(turn) {
    const { msg } = turn;
    if (msg.quantity === null) return this._reply('Dạ anh/chị muốn đổi món nào thành bao nhiêu ạ? (VD: "đổi tôm thành 3")');
    const r = this._resolveLine(turn, msg.query, msg.ref, "change", { quantity: msg.quantity });
    if (!r.line) return this._reply(r.ask ?? r.none);
    return this._setLineQuantity(turn, r.line.id, msg.quantity);
  }

  _correction(turn) {
    if (turn.state.lastLines.length === 0) {
      return this._reply(`Dạ anh/chị muốn sửa món nào thành ${turn.msg.quantity} ạ?`);
    }
    const r = this._resolveLine(turn, null, "last", "change", { quantity: turn.msg.quantity });
    if (!r.line) return this._reply(r.ask ?? r.none);
    return this._setLineQuantity(turn, r.line.id, turn.msg.quantity);
  }

  _adjustQuantity(turn) {
    const { msg } = turn;
    const r = this._resolveLine(turn, msg.query, msg.ref, "adjust", { delta: msg.delta });
    if (!r.line) return this._reply(r.ask ?? r.none);
    return this._adjustLine(turn, r.line.id, msg.delta);
  }

  _remove(turn) {
    const { msg } = turn;
    // Unaccented "bo vien": the dish "bò viên" when the menu has it.
    if (msg.alternativeMention && matchByName(msg.alternativeMention, this._allProducts()).candidates.length > 0) {
      return this._askAboutProduct({ ...turn, msg: { ...msg, intent: "mention", query: msg.alternativeMention, ref: null } }, "mention");
    }
    const r = this._resolveLine(turn, msg.query, msg.ref, "remove");
    if (!r.line) return this._reply(r.ask ?? r.none);
    return this._removeLine(turn, r.line.id);
  }

  _lineItem(turn, productId) {
    const cart = this._cart(turn.customerId);
    return { cart, item: cart.items.find((i) => i.product_id === productId) };
  }

  _setLineQuantity(turn, productId, quantity) {
    const { cart, item } = this._lineItem(turn, productId);
    if (!item) return this._reply("Dạ món này không còn trong giỏ ạ.");
    const updated = this.cartService.updateItemQuantity(turn.customerId, cart.id, item.id, quantity);
    turn.state.lastLines = quantity === 0 ? [] : [productId];
    const done = quantity === 0 ? `🗑 Đã bỏ ${item.product_name}` : `✏️ Đã đổi ${item.product_name} thành ${quantity}`;
    return this._reply(`${done}\n\n${this._cartText(updated)}`);
  }

  _adjustLine(turn, productId, delta) {
    const { item } = this._lineItem(turn, productId);
    if (!item) return this._reply("Dạ món này không còn trong giỏ ạ.");
    return this._setLineQuantity(turn, productId, Math.max(0, item.quantity + delta));
  }

  _removeLine(turn, productId) {
    const { cart, item } = this._lineItem(turn, productId);
    if (!item) return this._reply("Dạ món này không còn trong giỏ ạ.");
    const updated = this.cartService.removeItem(turn.customerId, cart.id, item.id);
    turn.state.lastLines = [];
    turn.state.focus = [];
    turn.state.cartPhrases = turn.state.cartPhrases.filter((p) => p.productId !== productId);
    return this._reply(`🗑 Đã bỏ ${item.product_name}\n\n${this._cartText(updated)}`);
  }

  // ------------------------------------------------------ checkout

  _cart(customerId) {
    return this.cartService.getOrCreateCart(customerId, this.merchantId);
  }

  _checkout(cart) {
    return this.cartCheckout.getByCart(cart.id);
  }

  _hasFulfillment(checkout) {
    return checkout?.fulfillment_type === "pickup" || (checkout?.fulfillment_type === "delivery" && Boolean(checkout.delivery_address));
  }

  // Exactly what the customer is confirming: cart lines + checkout details.
  _signature(cart, checkout) {
    const items = cart.items.map((i) => `${i.product_id}:${i.quantity}:${i.unit_price}`).join(",");
    const c = checkout || {};
    return JSON.stringify([cart.id, items, c.fulfillment_type, c.delivery_address, c.customer_phone, c.note]);
  }

  _checkoutLines(checkout) {
    if (!checkout) return [];
    const lines = [];
    if (checkout.fulfillment_type === "pickup") lines.push("🏪 Nhận tại quán");
    else if (checkout.delivery_address) lines.push(`📍 Giao tới: ${checkout.delivery_address}`);
    if (checkout.customer_phone) lines.push(`☎️ SĐT: ${checkout.customer_phone}`);
    if (checkout.note) lines.push(`📝 Ghi chú: ${checkout.note}`);
    return lines;
  }

  _summary(cart, checkout) {
    const merchant = this.merchantDataService.getById(this.merchantId);
    const items = cart.items.map((i) => `• ${i.quantity} × ${i.product_name} — ${vnd(i.unit_price)} = ${vnd(i.subtotal)}`);
    return [merchant.name, "", ...items, `Tạm tính: ${vnd(cart.total)}`, ...(this._checkoutLines(checkout).length ? ["", ...this._checkoutLines(checkout)] : [])].join("\n");
  }

  _review(turn) {
    const cart = this._cart(turn.customerId);
    if (cart.isEmpty) return this._reply(`Dạ giỏ hàng đang trống, anh/chị chọn món trước nha (VD: "cho 2 ${this._exampleDish()}").`);
    const applied = this._syncNote(turn);
    const checkout = this._checkout(cart);
    // saved preferences shown as such: memory is never applied silently
    const fromMemory = applied.filter((i) => i.source === "preference").map((i) => i.label);
    const memoryLine = fromMemory.length ? `\n🧠 Theo sở thích anh/chị đã dặn: ${fromMemory.join(", ")}` : "";
    const summary = `Anh/chị kiểm tra lại đơn giúp em:\n\n${this._summary(cart, checkout)}${memoryLine}`;
    if (!this._hasFulfillment(checkout)) {
      // one saved address: offered, not assumed
      const saved = this.customerMemory ? this.customerMemory.resolveAddress({ customerId: turn.customerId }) : {};
      if (saved.address) {
        turn.state.pending = { type: "confirm_address", address: saved.address, fromReview: true };
        return this._reply(
          `${summary}\n\nAnh/chị giao tới ${saved.address} như lần trước không ạ? (gõ "đúng", hoặc cho em địa chỉ khác / "lấy tại quán")`,
          "checkout"
        );
      }
      turn.state.pending = { type: "need_fulfillment" };
      return this._reply(
        `${summary}\n\nĐể chốt đơn, anh/chị cho em xin địa chỉ giao hàng (VD: "giao tới 7 Nguyễn Thiện Thuật") hoặc gõ "lấy tại quán" ạ.`,
        "checkout"
      );
    }
    turn.state.pending = { type: "confirm", signature: this._signature(cart, checkout) };
    return this._reply(`${summary}\n\nAnh/chị xác nhận đặt đơn này không? (gõ "xác nhận")`, "checkout");
  }

  // Checkout details carried by a message (address / phone), as a
  // cart_checkout patch; null when none. The note is composed separately
  // (instructions + free note, see _syncNote).
  _checkoutPatch(msg) {
    const patch = {};
    if (msg.address) Object.assign(patch, { fulfillment_type: "delivery", delivery_address: msg.address });
    if (msg.phone) patch.customer_phone = msg.phone;
    return Object.keys(patch).length ? patch : null;
  }

  // ------------------------------------------------------ customer memory

  _addFreeNote(turn, note) {
    turn.state.freeNote = [turn.state.freeNote, note].filter(Boolean).join(", ");
    this._syncNote(turn);
  }

  // The order note = the instructions that apply (current order first, then
  // the customer's saved preferences) + the free note, written to the one
  // checkout store so the summary, the confirmation check and the order
  // all see the same thing. Returns the applied instructions.
  _syncNote(turn) {
    const cart = this._cart(turn.customerId);
    const applied = this.customerMemory
      ? this.customerMemory.resolveInstructions({
          customerId: turn.customerId,
          merchantId: this.merchantId,
          productIds: cart.items.map((i) => i.product_id),
          conversation: turn.state.instructions,
        })
      : turn.state.instructions;
    const note = [applied.map((i) => i.label).join(", "), turn.state.freeNote].filter(Boolean).join(", ") || null;
    const existing = this.cartCheckout.getByCart(cart.id);
    if ((existing?.note ?? null) !== note) this.cartCheckout.upsert(cart.id, { note });
    return applied;
  }

  // "Không hành, ít tiêu" / "em không ăn hành" / "hôm nay cho hành":
  // always applies to the current order; persisted only when the customer
  // said it as a lasting preference (never for "hôm nay …").
  _applyInstructions(turn) {
    const { msg, state } = turn;
    for (const i of msg.instructions) {
      state.instructions = [...state.instructions.filter((x) => x.attribute !== i.attribute), { ...i, temporality: msg.temporality }];
    }
    const stored = this.customerMemory
      ? this.customerMemory.rememberStatement({
          customerId: turn.customerId,
          merchantId: this.merchantId,
          productId: state.focus.length === 1 ? state.focus[0] : null,
          instructions: msg.instructions,
          temporality: msg.temporality,
          scope: msg.scope,
          correction: msg.correction,
        })
      : [];
    this._syncNote(turn);
    const labels = msg.instructions.map((i) => i.label).join(", ");
    let text = `Dạ em ghi chú cho đơn này: ${labels}.`;
    if (stored.length) {
      text += msg.scope === "global" ? " Em cũng nhớ điều này cho những lần sau, ở mọi quán ạ." : " Em cũng nhớ cho những lần sau ở quán này ạ.";
    } else if (msg.temporality === "current_only" && this.customerMemory) {
      const saved = this.customerMemory
        .activePreferences(turn.customerId, this.merchantId)
        .filter((p) => msg.instructions.some((i) => i.attribute === p.attribute && i.value !== p.value));
      text += saved.length
        ? ` (Chỉ đơn này thôi ạ — lần sau em vẫn nhớ: ${saved.map((p) => p.label).join(", ")}.)`
        : " (Chỉ áp dụng cho đơn này ạ.)";
    }
    return text;
  }

  async _provideAddress(turn) {
    const { msg, state } = turn;
    // "giao 2 pizza hải sản" has an address's shape — but names a dish
    if (msg.addressUncertain && msg.address) {
      const request = resolveItemRequest(msg.address, this._orderable());
      const resolved = this._resolvePhrase(turn, request.query, this._orderable(), request);
      if (resolved.product || resolved.candidates || resolved.suggestion) return this._addSegments(turn, [msg.address]);
    }
    if (msg.addressRef) {
      if (!this.customerMemory) return this._setCheckout(turn, null);
      const found = this.customerMemory.resolveAddress({ customerId: turn.customerId, label: msg.addressRef.label });
      if (found.address) return this._setCheckout(turn, { fulfillment_type: "delivery", delivery_address: found.address });
      if (found.choices) {
        state.pending = { type: "choose_address", choices: found.choices.map((a) => a.address) };
        const list = found.choices.map((a, i) => `${i + 1}. ${a.label ? `(${a.label}) ` : ""}${a.address}`).join("\n");
        return this._reply(`Dạ anh/chị có ${found.choices.length} địa chỉ đã dùng:\n${list}\n\nAnh/chị muốn giao tới địa chỉ nào ạ? (gõ số thứ tự)`);
      }
      const which = msg.addressRef.label ? ` "${msg.addressRef.label}"` : " cũ";
      return this._reply(`Dạ em chưa lưu địa chỉ${which} nào của anh/chị. Anh/chị cho em xin địa chỉ giao hàng nha.`);
    }
    if (msg.addressLabel && msg.address && this.customerMemory) {
      this.customerMemory.rememberAddress({ customerId: turn.customerId, address: msg.address, label: msg.addressLabel });
    }
    if (msg.note) this._addFreeNote(turn, msg.note);
    return this._setCheckout(turn, msg.address ? this._checkoutPatch(msg) : null, msg.invalidPhone);
  }

  // Reads the customer's past generic orders at this merchant (the order
  // records are the source of truth) and the current menu.
  _orderReader(turn) {
    return {
      readOrder: (orderRef) => {
        const summary = this.orderService.listOrders(turn.customerId).find((o) => o.order_code === orderRef && o.merchant_id === this.merchantId);
        if (!summary || summary.status === "CANCELLED") return null;
        const order = this.orderService.getOrder(turn.customerId, summary.id);
        const checkout = this.cartCheckout.getByCart(order.cart_id);
        return {
          items: order.items.map((i) => ({ productId: i.product_id, name: i.product_name, quantity: i.quantity })),
          address: checkout?.fulfillment_type === "delivery" ? checkout.delivery_address : null,
          fulfillment: checkout?.fulfillment_type ?? null,
        };
      },
      currentProduct: (id) => {
        const p = this._productById(id);
        return p ? { id: p.id, name: p.name, price: p.price, available: p.available && this.menuService.isMenuVisible(this.merchantId) } : null;
      },
    };
  }

  // "như cũ": a CANDIDATE from memory, shown with current menu prices —
  // nothing is added or ordered until the customer confirms it.
  _reorder(turn) {
    const { msg, state } = turn;
    if (!this.customerMemory) return this._reply(this._helpText());
    const current = (msg.instructions || []).map((i) => ({ ...i, temporality: msg.temporality }));
    const candidate = this.customerMemory.buildReorderCandidate({
      customerId: turn.customerId,
      merchantId: this.merchantId,
      orderReader: this._orderReader(turn),
      preferRecurring: msg.preferRecurring,
      current,
    });
    if (!candidate) {
      return this._reply("Dạ em chưa thấy đơn nào trước đây của anh/chị ở quán này, nên em chưa biết \"như cũ\" là món gì ạ. Anh/chị muốn gọi món gì ạ?");
    }
    const merchant = this.merchantDataService.getById(this.merchantId);
    if (candidate.items.length === 0) return this._reply(formatReorderCandidate(candidate, { merchantName: merchant.name }));
    let address = candidate.address;
    let fulfillment = candidate.fulfillment;
    if (!address && fulfillment !== "pickup") {
      const saved = this.customerMemory.resolveAddress({ customerId: turn.customerId });
      if (saved.address) {
        address = saved.address;
        fulfillment = "delivery";
      }
    }
    const cart = this._cart(turn.customerId);
    state.pending = {
      type: "confirm_reorder",
      cartSignature: cartItemsSignature(cart),
      items: candidate.items.map((i) => ({ productId: i.productId, quantity: i.quantity, price: i.price })),
      instructions: candidate.instructions.map((i) => ({ attribute: i.attribute, value: i.value, label: i.label, temporality: i.temporality ?? (i.source === "current" ? msg.temporality : "order") })),
      address: fulfillment === "pickup" ? null : address,
      fulfillment,
    };
    return this._reply(
      formatReorderCandidate(candidate, {
        merchantName: merchant.name,
        address: fulfillment === "pickup" ? null : address,
        fulfillment,
        extraCartItems: cart.isEmpty ? 0 : cart.items.length,
        extraCartTotal: cart.isEmpty ? 0 : cart.total,
      })
    );
  }

  // The customer confirmed the candidate: build the cart through
  // CartService (current prices re-checked), set the checkout, and — when
  // everything shown is still exactly true — place the order.
  async _executeReorder(turn, pending) {
    const { state } = turn;
    const cart = this._cart(turn.customerId);
    const orderable = this._orderable();
    const drifted = cartItemsSignature(cart) !== pending.cartSignature || pending.items.some((i) => orderable.find((p) => p.id === i.productId)?.price !== i.price);
    if (drifted) {
      // something changed since it was shown: show it again, never order on stale info
      return this._reorder({ ...turn, msg: { ...turn.msg, intent: "reorder", instructions: null } });
    }
    for (const item of pending.items) this.cartService.addItem(turn.customerId, cart.id, this.merchantId, item.productId, item.quantity);
    for (const i of pending.instructions) {
      state.instructions = [...state.instructions.filter((x) => x.attribute !== i.attribute), i];
    }
    if (pending.fulfillment === "pickup") this.cartCheckout.upsert(cart.id, { fulfillment_type: "pickup", delivery_address: null });
    else if (pending.address) this.cartCheckout.upsert(cart.id, { fulfillment_type: "delivery", delivery_address: pending.address });
    this._syncNote(turn);
    const updated = this._cart(turn.customerId);
    const checkout = this._checkout(updated);
    if (!this._hasFulfillment(checkout)) return this._review(turn); // asks for the address
    state.pending = { type: "confirm", signature: this._signature(updated, checkout) };
    return this._confirm(turn);
  }

  // Stores details on the customer's current cart (cart_checkout — the one
  // checkout store) and returns the acknowledgement text.
  _storeCheckout(turn, patch, invalidPhone = null) {
    const warnings = invalidPhone ? [`⚠️ Số điện thoại "${invalidPhone}" chưa đúng (cần 10 số), anh/chị kiểm tra lại giúp em nha.`] : [];
    if (!patch) return warnings.join("\n");
    if (patch.delivery_address && !isUsableAddress(patch.delivery_address)) {
      return [`Dạ địa chỉ "${patch.delivery_address}" chưa có số nhà/tên đường, anh/chị ghi rõ giúp em nha.`, ...warnings].join("\n");
    }
    const cart = this._cart(turn.customerId);
    const checkout = this.cartCheckout.upsert(cart.id, patch);
    const heading = patch.delivery_address ? "Dạ em đã ghi nhận địa chỉ giao hàng:" : "Dạ em đã ghi nhận:";
    return [heading, ...this._checkoutLines(checkout), ...warnings].join("\n");
  }

  _setCheckout(turn, patch, invalidPhone = null) {
    if (!patch) {
      return this._reply('Dạ anh/chị cho em xin địa chỉ cụ thể (số nhà, tên đường) ạ. VD: "giao tới 7 Nguyễn Thiện Thuật".');
    }
    if (patch.delivery_address && !isUsableAddress(patch.delivery_address)) {
      return this._reply(`Dạ địa chỉ "${patch.delivery_address}" chưa có số nhà/tên đường, anh/chị ghi rõ giúp em nha.`);
    }
    const noted = this._storeCheckout(turn, patch, invalidPhone);
    const cart = this._cart(turn.customerId);
    // Mid-checkout (address was asked for, or a summary was shown): show the
    // updated summary so the customer confirms what is really there.
    if (!cart.isEmpty && (turn.state.pending?.type === "need_fulfillment" || turn.state.pending?.type === "confirm")) {
      return this._review(turn);
    }
    const next = cart.isEmpty ? "Anh/chị chọn món nha." : 'Gõ "đặt món" để xem lại và chốt đơn ạ.';
    return this._reply(`${noted}\n\n${next}`);
  }

  // The message is only "76 Nguyễn Thị Minh Khai"-shaped text that does not
  // name anything on this menu -> the address text, else null.
  _bareAddress(turn) {
    const { msg } = turn;
    if (!["add_to_cart", "mention", "quantity_only", "unknown"].includes(msg.intent)) return null;
    if (msg.intent === "add_to_cart" && msg.items.length !== 1) return null;
    if (!looksLikeAddress(msg.raw)) return null;
    // It is only an address if NOTHING on this menu fits — by name, learned
    // language, typo tolerance or context ("2 pizza tôm" is an order).
    const orderable = this._orderable();
    const request = resolveItemRequest(msg.raw, orderable);
    const resolved = this._resolvePhrase(turn, request.query, orderable, request);
    if (resolved.product || resolved.candidates || resolved.suggestion) return null;
    return msg.raw.trim().replace(/[\s.!?]+$/, "");
  }

  _total(turn) {
    const cart = this._cart(turn.customerId);
    if (cart.isEmpty) return this._reply("Dạ giỏ hàng đang trống ạ.");
    const count = cart.items.reduce((n, i) => n + i.quantity, 0);
    const extra = this._checkoutLines(this._checkout(cart));
    return this._reply(`${this._cartText(cart)}\n\nTổng tạm tính: ${vnd(cart.total)} (${count} phần)${extra.length ? `\n${extra.join("\n")}` : ""}`);
  }

  async _confirm(turn) {
    const { state } = turn;
    const cart = this._cart(turn.customerId);
    if (cart.isEmpty) return this._reply("Dạ giỏ hàng đang trống, chưa có gì để chốt ạ.");
    this._syncNote(turn); // a preference changed since the summary -> signature differs -> review again
    const checkout = this._checkout(cart);
    // Never order on a bare "ok": only when the customer was shown a summary
    // of exactly this cart + delivery details. Anything changed -> review again.
    if (state.pending?.type !== "confirm" || state.pending.signature !== this._signature(cart, checkout)) {
      return this._review(turn);
    }

    const order = await this.orderService.confirmOrder(turn.customerId, cart.id);
    state.pending = null;
    state.lastLines = [];
    state.focus = [];
    // An order placed with these phrases is the strongest positive outcome.
    if (this.productLanguage) {
      const ordered = new Set(order.items.map((i) => i.product_id));
      for (const p of state.cartPhrases.filter((c) => ordered.has(c.productId))) {
        this.productLanguage.confirm(
          { merchantId: this.merchantId, customerId: turn.customerId, phrase: p.phrase, productId: p.productId, source: "order_confirmed" },
          { createIfMissing: false }
        );
      }
    }
    state.cartPhrases = [];
    // Customer memory learns only from a CONFIRMED order: the instructions it
    // was placed with (evidence, not yet preferences) and the address used.
    if (this.customerMemory) {
      this.customerMemory.learnFromConfirmedOrder({
        customerId: turn.customerId,
        merchantId: this.merchantId,
        orderRef: order.order_code,
        instructions: state.instructions,
        address: checkout?.fulfillment_type === "delivery" ? checkout.delivery_address : null,
      });
    }
    state.instructions = [];
    state.freeNote = null;
    const lines = order.items.map((i) => `• ${i.quantity} × ${i.product_name} = ${vnd(i.line_total)}`);
    // Only what really happened: sent, no channel for this merchant, or a
    // delivery that failed (the order itself is kept either way).
    const noChannel = !order.dispatch || order.dispatch.reason === "NO_DISPATCH_CHANNEL";
    const delivery =
      order.status === "SENT_TO_MERCHANT"
        ? "Đơn đã được gửi tới quán."
        : noChannel
        ? "Lưu ý: đơn đã được ghi nhận nhưng CHƯA được gửi tới quán — Tổng Đài chưa có kênh gửi đơn tự động cho quán này."
        : "Lưu ý: đơn đã được ghi nhận nhưng CHƯA được gửi tới quán (gửi thông báo cho quán bị lỗi) — Tổng Đài sẽ thử gửi lại; nếu cần gấp anh/chị gọi trực tiếp cho quán giúp em.";
    const details = this._checkoutLines(checkout);
    return this._reply(
      `✅ Đã tạo đơn ${order.order_code}\n${lines.join("\n")}\nTổng: ${vnd(order.total)}${details.length ? `\n${details.join("\n")}` : ""}\n\n${delivery}`,
      "confirm_order",
      order.order_code
    );
  }

  // ------------------------------------------------------ texts

  _reply(replyText, merchantIntent = null, orderRef = null) {
    return { replyText, merchantIntent, orderRef };
  }

  _cartText(cart, { withCheckout = false } = {}) {
    if (cart.isEmpty) return "🛒 Giỏ hàng đang trống.";
    const lines = cart.items.map((i) => `• ${i.quantity} × ${i.product_name} = ${vnd(i.subtotal)}`);
    const extra = withCheckout ? this._checkoutLines(this._checkout(cart)) : [];
    return `🛒 Giỏ hàng:\n${lines.join("\n")}\nTạm tính: ${vnd(cart.total)}${extra.length ? `\n${extra.join("\n")}` : ""}`;
  }

  async _menuText() {
    const merchant = this.merchantDataService.getById(this.merchantId);
    const items = this.menuService.listProducts(this.merchantId, { includeUnavailable: false });
    const groups = this._menuGroups();
    // a large menu with categories: the categories first, then drill down
    if (groups.length > 1 && items.length > MENU_FLAT_LIMIT) {
      const lines = groups.map((g) => `• ${g.name} (${g.products.length} món)`);
      return [
        `${merchant.name} — thực đơn ${items.length} món, ${groups.length} nhóm:`,
        "",
        ...lines,
        "",
        `Anh/chị muốn xem nhóm nào ạ? (VD: "cho xem ${groups[0].name.toLowerCase()}")`,
        `Hoặc gọi món luôn (VD: "cho 2 ${this._exampleDish()}").`,
      ].join("\n");
    }
    return `${merchant.name}\n\n${items.map((i) => `🍽 ${i.name}: ${vnd(i.price)}`).join("\n")}`;
  }

  // This merchant's categories that have orderable products, in menu order.
  _menuGroups() {
    const products = this._orderable();
    return this.menuService
      .listCategories(this.merchantId)
      .map((c) => ({ name: c.name, products: products.filter((p) => p.category_id === c.id) }))
      .filter((g) => g.products.length > 0);
  }

  // "cho xem hủ tiếu" / "cho xem cơm" / "cho xem món nước": the dishes of
  // the categories named; when no category fits, the dishes that do.
  _browse(turn) {
    const { msg, state } = turn;
    const groups = this._menuGroups();
    const found = matchCategories(msg.query, groups);
    if (found.length === 0) {
      const query = parseItemRequest(msg.query).query || msg.query;
      return this._askAboutProduct({ ...turn, msg: { ...msg, intent: "ask_product_availability", query, ref: null } }, "availability");
    }
    const products = found.flatMap((g) => g.products);
    state.focus = products.map((p) => p.id);
    const blocks = found.map((g) => [`${g.name}:`, ...g.products.map((p) => `🍽 ${p.name}: ${vnd(p.price)}`)].join("\n"));
    return this._reply(`${blocks.join("\n\n")}\n\nAnh/chị muốn gọi món nào ạ? (VD: "cho 2 ${products[0].name}")`);
  }

  _locationReply() {
    const merchant = this.merchantDataService.getById(this.merchantId);
    return this._reply(merchant.address ? `📍 ${merchant.name}: ${merchant.address}` : "Dạ quán chưa cập nhật địa chỉ.");
  }

  // Examples in replies use THIS merchant's own first dish, never a fixed name.
  _exampleDish() {
    return this._orderable()[0]?.name ?? "tên món";
  }

  _helpText() {
    return [
      "Dạ anh/chị cứ nhắn tự nhiên, ví dụ:",
      '• "menu" — xem thực đơn',
      `• "có ${this._exampleDish()} không?" / "giá bao nhiêu?"`,
      `• "cho 2 ${this._exampleDish()}" — thêm món (nhiều món: "cho 2 A, 1 B")`,
      '• "đổi … thành 3" / "bỏ …" / "thêm một phần nữa"',
      '• "giao tới 7 Nguyễn Thiện Thuật" hoặc "lấy tại quán"',
      '• "tổng bao nhiêu?" / "đặt món" rồi "xác nhận"',
      '• "quay lại tổng đài" — tìm quán khác',
    ].join("\n");
  }
}
