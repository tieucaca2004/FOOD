import { classifyConciergeIntent } from "../nlp/concierge.js";
import { classifyMerchantFollowUp, parseProductQuestion } from "../nlp/merchantFollowUp.js";
import { classifyKnowledgeFollowUp } from "../nlp/knowledgeFollowUp.js";
import { buildKnowledgeContext, isFresh } from "../conversation/knowledgeContext.js";
import { normalizeSearchQuery, normalizeForMatch, matchesMerchantName } from "../nlp/searchQuery.js";
import { understandMessage, fold, yesNoAnswer } from "../conversation/understand.js";
import { formatReorderCandidate } from "../conversation/reorderText.js";
import { MENU_FLAT_LIMIT } from "../conversation/orderingEngine.js";
import { classifyIntent } from "../../src/nlp/intentEngine.js"; // pure, read-only reuse
import { classifyScope, hasFoodSignal, SCOPE_REPLY } from "../nlp/scopeGuard.js";
import { composer, withSearchState, withPending, detectIntent, normalizeInput } from "../search/v2/index.js";

// whole-word / accent-aware matches of the catalog adapters (a raw substring match is not among them)
const GLOBAL_PLANS = new Set(["FOOD_DISCOVERY", "AREA_DISCOVERY", "CONTEXT_DISCOVERY"]);
const TRUSTED_CATALOG_MATCH = new Set(["exact", "keyword", "category", "merchant_name"]);
const OTHER_PLACES_ASK = "Anh/chị muốn tìm món gì để em tìm quán khác giúp ạ?";

const ADD_VERB_START = /^(?:(?:toi|minh|em)\s+)?(?:cho|them|lay|order|mua|dat|goi|an)\b/;

// "3 bò viên" -> "Thêm 3 bò viên" so a module's own parser sees an add.
function withAddVerb(segment) {
  return ADD_VERB_START.test(fold(segment).folded) ? segment : `Thêm ${segment}`;
}

// Checkout details in a message sent to a legacy module, or null.
function legacyCheckoutDetails(msg) {
  const details = {};
  if (msg.intent === "provide_fulfillment" && msg.fulfillment === "pickup") details.fulfillment = "pickup";
  if (msg.address) details.address = msg.address;
  if (msg.phone) details.phone = msg.phone;
  if (msg.note) details.note = msg.note;
  if (msg.instructions?.length) details.instructions = msg.instructions.map((i) => ({ ...i, temporality: msg.temporality }));
  const isDetailsMessage = ["provide_delivery_address", "provide_fulfillment", "provide_phone", "provide_note", "food_instruction"].includes(msg.intent);
  if (msg.intent === "provide_delivery_address" && !msg.address) return null; // "giao đây": let the module ask
  return Object.keys(details).length && (isDetailsMessage || msg.intent === "add_to_cart") ? details : null;
}

function mergeInstructions(existing = [], incoming = []) {
  const byAttr = new Map(existing.map((i) => [i.attribute, i]));
  for (const i of incoming) byAttr.set(i.attribute, i);
  return [...byAttr.values()];
}

function legacyDetailLines(details) {
  const lines = [];
  if (details.fulfillment === "pickup") lines.push("🏪 Nhận tại quán");
  else if (details.address) lines.push(`📍 Giao tới: ${details.address}`);
  if (details.phone) lines.push(`☎️ SĐT: ${details.phone}`);
  const note = [(details.instructions || []).map((i) => i.label).join(", "), details.note].filter(Boolean).join(", ");
  if (note) lines.push(`📝 Ghi chú: ${note}`);
  return lines;
}

function formatProductAnswer(matches, query) {
  if (matches.length === 0) return `Dạ quán chưa có món "${query}" ạ. Gõ "menu" để xem thực đơn.`;
  const price = (p) => `${Number(p).toLocaleString("vi-VN")}đ`;
  if (matches.length === 1) {
    const m = matches[0];
    return m.available ? `Dạ có ạ: ${m.name} — ${price(m.price)}` : `Dạ ${m.name} hiện tạm hết ạ.`;
  }
  const lines = matches.map((m) => `• ${m.name}: ${price(m.price)}${m.available ? "" : " (tạm hết)"}`);
  return `Dạ quán có ${matches.length} món phù hợp:\n${lines.join("\n")}`;
}

function formatMerchantCard({ merchant, matches }) {
  const itemLines = matches
    .slice(0, 5)
    .map((m) => `🍜 ${m.name}${m.available ? "" : " (tạm hết)"}`);
  const location = merchant.address ? `📍 ${merchant.address}` : "📍 (chưa có địa chỉ)";
  return [merchant.name.toUpperCase(), ...itemLines, location, `[ XEM ${merchant.name.toUpperCase()} ]`].join("\n");
}

// Food Knowledge places shown in one chat reply (the rest is counted, never dumped)
const KNOWLEDGE_RESULT_LIMIT = 5;

function formatSearchResults({ organic, sponsored }) {
  if (organic.length === 0 && sponsored.length === 0) {
    return "Dạ em chưa tìm thấy quán nào phù hợp, anh/chị thử mô tả món khác giúp em nha.";
  }
  const blocks = [...organic, ...sponsored.map((s) => ({ ...s, isSponsored: true }))].map((c) =>
    c.isSponsored ? `[Được quảng bá]\n${formatMerchantCard(c)}` : formatMerchantCard(c)
  );
  return `Em tìm thấy một số quán phù hợp:\n\n${blocks.join("\n\n---\n\n")}\n\nAnh/chị muốn xem quán nào ạ?`;
}

function formatMenuSummary(menu) {
  // A large menu that comes with categories opens on its categories.
  if (menu.categories?.length > 1 && menu.items.length > MENU_FLAT_LIMIT) {
    const groups = menu.categories.map((c) => `• ${c.name} (${c.count} món)`);
    return `Đã mở ${menu.name}${menu.address ? ` — 📍 ${menu.address}` : ""}\n\nThực đơn ${menu.items.length} món, ${menu.categories.length} nhóm:\n${groups.join(
      "\n"
    )}\n\nAnh/chị muốn xem nhóm nào hoặc đặt món gì ạ? (VD: "cho xem ${menu.categories[0].name.toLowerCase()}". Gõ "quay lại tổng đài" để tìm quán khác)`;
  }
  const lines = menu.items.map((i) => `🍜 ${i.name}: ${Number(i.price).toLocaleString("vi-VN")}đ${i.available ? "" : " (tạm hết)"}`);
  return `Đã mở ${menu.name}${menu.address ? ` — 📍 ${menu.address}` : ""}\n\n${lines.join(
    "\n"
  )}\n\nAnh/chị muốn đặt món gì ạ? (Gõ "quay lại tổng đài" để tìm quán khác)`;
}

// merchant context lifecycle: back to the Core after this much silence (unless an order is in progress there)
const MERCHANT_IDLE_MS = 60 * 60 * 1000;
// the legacy module's product-question intents (its own labels, src/router/businessRouter.js _reply())
const LEGACY_PRODUCT_INTENTS = new Set(["product_question", "product_price", "product_availability"]);
// the platform's own ordering reading (conversation/understand.js) of turns that continue an order without naming a dish
// FORM 10 — the structured reference of a conversation (knowledge_context_json): what FOOD SHOWED, by id.
// shownIds: the places as displayed (the Agent's items, when it rendered the answer) — else the first shownCount ids.
const shownPlaces = (ctx) => (Array.isArray(ctx?.shownIds) && ctx.shownIds.length ? ctx.shownIds : (ctx?.matchedIds ?? []).slice(0, ctx?.shownCount ?? 0));
// a list the customer can count in ("quán thứ 2"): two places or more shown
const enumerated = (ctx) => shownPlaces(ctx).length >= 2;
// a list kept as it was shown (no nested list / menu / dish focus of its own)
const asList = (ctx) => {
  if (!ctx) return null;
  const { list, menu, productFocus, ...rest } = ctx;
  return rest;
};
// the dishes a merchant answer SHOWED, in order (the same rules as search/v2/composer.js composeMerchantOperation)
const priceOfDish = (p) => p.prices?.find((x) => x.price !== null) ?? null;
function displayedDishes(operation, group) {
  if (operation === "place") {
    const main = [...group].sort((a, b) => (b.products?.length ?? 0) - (a.products?.length ?? 0))[0];
    return (main?.products ?? []).slice(0, 5).map((p) => ({ merchantId: main.id, productId: p.id }));
  }
  if (operation !== "menu" && operation !== "price") return [];
  const seen = new Map();
  for (const m of group) for (const p of m.products ?? []) if (!seen.has(p.name.toLowerCase()) || (!priceOfDish(seen.get(p.name.toLowerCase()).p) && priceOfDish(p))) seen.set(p.name.toLowerCase(), { p, merchantId: m.id });
  const dishes = [...seen.values()].filter((x) => operation === "menu" || priceOfDish(x.p));
  return dishes.slice(0, 10).map((x) => ({ merchantId: x.merchantId, productId: x.p.id }));
}

// FORM 13 — a reference-only place is never ordered: said plainly, deterministically
// FORM 15 — a photo when the FOOD Agent cannot answer (off / failed): said plainly, never silence, never a fact
const IMAGE_NOT_READ = "Dạ em đã nhận được ảnh của anh/chị, nhưng hiện em chưa trả lời được về ảnh này. Anh/chị nhắn giúp em tên món hoặc quán cần tìm nhé.";
const REFERENCE_ONLY_ORDER = "Dạ quán này hiện chỉ có thông tin tham khảo, chưa hỗ trợ đặt món qua FOOD.";
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The catalog dishes a merchant reply SHOWED as menu lines ("🍜 Name: …", "- Name: …"), in the order shown. */
function menuShownIn(replyText, items) {
  const text = String(replyText ?? "");
  return items
    .map((i) => ({ name: i.name, at: text.search(new RegExp(`(?:^|\\n)\\s*(?:🍜|🍽|-|•)\\s*${escapeRe(i.name)}:\\s`, "u")) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.name);
}
const vndText = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;

// "menu quán thứ 2", "quán này có món gì": the place's MENU, not its list card
const MENU_QUESTION = /\b(?:menu|thuc don|mon gi|co gi|ban gi|nhung mon nao|mon nao)\b/;

const ORDER_CONTINUATION = new Set(["quantity_only", "adjust_quantity", "change_quantity", "choose_option", "confirm_order", "cancel_order", "provide_delivery_address", "ask_total", "review_order", "show_cart", "reorder"]);

export class PlatformRouter {
  constructor({ services, discovery, agentSearch, merchantRouter, ai, gpt = null, images = null, now = () => new Date(), merchantIdleMs = MERCHANT_IDLE_MS }) {
    // FORM 15 — services/imageConversation.js: a customer's photo -> UNVERIFIED evidence for the FOOD Agent (never a reply)
    this.images = images;
    this.services = services;
    this.discovery = discovery;
    // Phase 2: global keyword search now goes through AgentSearchService
    // (Customer -> AI Concierge -> AgentSearchService -> DiscoveryEngine).
    // `discovery` is still used directly for name-based lookups, which
    // aren't part of AgentSearchService's minimal tool-call surface.
    this.agentSearch = agentSearch;
    this.merchantRouter = merchantRouter;
    this.ai = ai;
    // Optional GPT FOOD concierge (platform/ai/foodConcierge, OPENAI_ENABLED). Only an interface here:
    // respond() returns a guarded answer or null — null always means "keep the deterministic reply".
    this.gpt = gpt;
    this.now = now;
    this.merchantIdleMs = merchantIdleMs;
  }

  // Deterministic search first (cheap, and the only path that lists ORDERABLE catalog places and sets
  // the pick list). Only when it found no orderable place does the GPT concierge answer — natural
  // language, constraints, reference data — and only if its answer passes the Fact Guard.
  // discovery: the concierge's flag — the customer ASKED FOR something new ("tìm …"). That request replaces
  // the previous list (GPT-2.1): it is not restored, and the model is told it is a new request.
  // searchResult: Search Intelligence V2's reading of this turn, taken before any search changed the session — the
  // concierge is given that one reading (it never reads the message a second time)
  async _discover(customer, session, keywords, text, { discovery = false, searchResult = null } = {}) {
    const gptOn = Boolean(this.gpt?.enabled());
    const previous = gptOn && !discovery ? this.services.sessions.getKnowledgeContext(session.id) : null;
    const deterministic = await this._runSearch(customer, session, keywords, { rawText: text, newRequest: discovery });
    // a catalog hit answers directly only when the match itself is trustworthy (exact / keyword / the place's own
    // name); a loose "category" match is not a final answer when the concierge can look at it with FOOD's reading
    const trusted = deterministic.searchResultCount > 0 && TRUSTED_CATALOG_MATCH.has(deterministic.catalogQuality);
    if (!gptOn || trusted) return deterministic;
    // a message that is not a new request and found no new list must not erase the list the conversation is
    // about (GPT follow-ups read it)
    if (!deterministic.knowledgeResultCount && previous) this.services.sessions.setKnowledgeContext(session.id, previous);
    // the model only answers FOOD questions: nothing found and nothing food-like in the words -> scope reply
    if (!deterministic.knowledgeResultCount && !this._foodScope(deterministic.session, text)) return { ...deterministic, replyText: SCOPE_REPLY, scope: { scope: "NO_FOOD_SIGNAL" } };
    const answer = await this.gpt.respond({ customer, session: deterministic.session, text, reason: "discovery", newRequest: discovery, searchResult, results: deterministic.results, deterministicReply: deterministic.replyText });
    if (answer) this._recordShown(deterministic.session, answer.meta, { replacesDisplay: true });
    return answer ? { ...deterministic, replyText: answer.text, concierge: answer.meta } : deterministic;
  }

  // Is this a FOOD conversation turn the model may answer? Food words in the message, a dish / place / region
  // Food Knowledge knows, the customer being inside a place, or a fresh list to follow up on. Never length.
  _foodScope(session, text) {
    if (hasFoodSignal(text)) return true;
    if (session?.context === "merchant" && session.active_merchant_id) return true;
    if (session && isFresh(this.services.sessions.getKnowledgeContext(session.id))) return true;
    try {
      return Boolean(this.agentSearch.foodKnowledgeNamesSomething?.(text));
    } catch {
      return false;
    }
  }

  async handle({ customer, session, text, inbound = null }) {
    // a photo (with or without a caption) is a conversational message: the FOOD Agent answers it (FORM 15)
    if (inbound?.attachments?.some((a) => a.type === "image")) return this._imageTurn(customer, session, text, inbound);
    // FOOD-only scope guard, before anything else (0 GPT call, 0 search): image / video generation, secrets /
    // instruction overrides / shell-like input, and clearly non-food topics get the short scope reply
    const scope = classifyScope(text);
    if (scope.scope === "OUT_OF_SCOPE") return { replyText: SCOPE_REPLY, session, scope };

    const concierge = classifyConciergeIntent(text);

    // Merchant context lifecycle: a customer who comes back after a long pause is back at the Core — unless an
    // order is being built there (cart, checkout question, confirmation), which keeps the place.
    if (session.context === "merchant" && session.active_merchant_id && this._merchantContextIdle(customer, session)) {
      session = this.services.sessions.returnToPlatform(session.id);
    }

    if (session.context === "merchant" && session.active_merchant_id) {
      return this._handleWithinMerchant(customer, session, text, concierge);
    }
    return this._handleAtPlatform(customer, session, text, concierge);
  }

  /**
   * A customer's photo: the image service prepares the evidence, the FOOD Agent answers (tools + Fact Guard as for any
   * turn). With the Agent off or failing, a plain reply — never silence, never a fact read from the photo.
   */
  async _imageTurn(customer, session, text, inbound) {
    const caption = String(text ?? "").trim();
    if (caption) {
      const scope = classifyScope(caption);
      if (scope.scope === "OUT_OF_SCOPE") return { replyText: SCOPE_REPLY, session, scope, imageTurn: "scope" };
    }
    if (!this.gpt?.enabled()) return { replyText: IMAGE_NOT_READ, session, imageTurn: "agent_unavailable" };
    let evidence;
    try {
      evidence = (await this.images?.read(inbound)) ?? { source: "customer_image", trust: "UNVERIFIED", status: "unavailable", reason: "no_image_service" };
    } catch {
      evidence = { source: "customer_image", trust: "UNVERIFIED", status: "unavailable", reason: "image_service_failed" };
    }
    this._rememberImage(customer.id, evidence);
    let answer = null;
    try {
      answer = await this.gpt.respond({ customer, session, text: caption, reason: "image", imageEvidence: evidence });
    } catch {
      answer = null;
    }
    if (answer) return { replyText: answer.text, session, concierge: answer.meta, imageTurn: "agent" };
    return { replyText: IMAGE_NOT_READ, session, imageTurn: "agent_failed", imageStatus: evidence.status };
  }

  /** The customer's latest photo evidence (for follow-ups on it), next to the conversation's working memory. */
  _rememberImage(customerId, evidence) {
    try {
      const store = this._conversationStates();
      const state = store.getByCustomer(customerId) ?? {};
      store.saveForCustomer(customerId, { ...state, lastImage: { evidence, touchedAt: new Date().toISOString() } });
    } catch {
      // memory is a convenience: never fails a turn
    }
  }

  async _handleWithinMerchant(customer, session, text, concierge) {
    if (concierge.intent === "return_to_platform") {
      const updated = this.services.sessions.returnToPlatform(session.id);
      return { replyText: "Đã quay lại Tổng Đài, anh/chị muốn tìm quán hoặc món gì ạ?", session: updated };
    }

    if (concierge.intent === "global_search") {
      const updated = this.services.sessions.returnToPlatform(session.id);
      const query = session.last_search_query;
      if (!query) {
        return { replyText: "Anh/chị muốn tìm món gì để em tìm quán khác giúp ạ?", session: updated };
      }
      return this._runSearch(customer, updated, query);
    }

    // Routing contract (founder decision 2026-09-26, live Telegram #277/#279): a message the concierge
    // marks as DISCOVERY ("tìm Bún Cá Mịn", "tìm quán bún cá ở Nha Trang", "muốn ăn … ở …") is a global
    // search — leave the merchant exactly as "quay lại tổng đài" does (its cart stays) and handle it at the
    // platform. Everything else stays with the merchant.
    // A question about OTHER places or the AREA ("có quán nào bán bún cá", "còn quán nào khác", "xung quanh đây
    // có món gì", "ngoài quán này ra …") is global too: the place the customer is in never answers it.
    // Search Intelligence V2 also reads an exclusion of this place without "ra" ("ngoài quán này còn bún cá nào?"):
    // when it plans a global search for it, that is a global request too (its intent layer is pure and cheap)
    const leavesHere = !concierge.discovery && !concierge.global && detectIntent(normalizeInput(text)).exclusion.current && GLOBAL_PLANS.has(this._searchPlan(session, text, { currentMerchantId: session.active_merchant_id })?.plan.type);
    if (concierge.discovery || concierge.global || leavesHere) {
      const updated = this.services.sessions.returnToPlatform(session.id);
      // "còn quán nào khác?" from inside a place names nothing to search: ask what to find elsewhere — but
      // "ngoài quán này ra còn quán nào bán BÚN CÁ?" names the dish: search it, without the place just left
      const asksOnlyForMore = !concierge.discovery && classifyKnowledgeFollowUp(text)?.kind === "more";
      const names = asksOnlyForMore && this._searchPlan(updated, text, { currentMerchantId: session.active_merchant_id })?.plan.type;
      if (asksOnlyForMore && !["FOOD_DISCOVERY", "AREA_DISCOVERY", "MERCHANT_OPERATION", "UNKNOWN_PLACE", "CONTEXT_DISCOVERY"].includes(names)) return { replyText: OTHER_PLACES_ASK, session: updated };
      return this._handleAtPlatform(customer, updated, text, concierge, { excludeMerchantId: session.active_merchant_id });
    }

    // Everything else while inside a merchant context is scoped to that
    // merchant — never re-run a platform-wide search behind the customer's
    // back (spec §10).
    // FORM 13 — the menu the customer was SHOWN here: "món thứ 2" / "món đó" / "giá món đó" answered from the catalog,
    // "cho tôi 2 phần" handed to the merchant's own engine as "2 <exact dish name>" (the engine still does the ordering)
    const bridged = await this._menuBridge(customer, session, text);
    if (bridged?.replyText) return bridged;
    const engineText = bridged?.engineText ?? text;
    const result = await this._routeToMerchant(session.active_merchant_id, customer.id, engineText);
    if (result.ok && !result.handBack) await this._recordMerchantMenu(customer.id, session.active_merchant_id, result.replyText);
    if (!result.ok) {
      const updated = this.services.sessions.returnToPlatform(session.id);
      return { replyText: "Quán này hiện không khả dụng, anh/chị tìm quán khác giúp em nha.", session: updated };
    }
    // Conversation ownership: the merchant's engine could not handle this turn (its own verdict — see
    // _routeToLegacy), so it is not an ordering turn: the Core answers it (search / GPT with tools), and the
    // customer stays in the place (GPT sees current_merchant_id). The engine's fallback text is never sent.
    if (result.handBack) return this._handleAtPlatform(customer, session, text, concierge);
    // the place does not have that dish: it answers (merchant-local), and FOOD says — without leaving the place —
    // that other places have it on record; the dish becomes the conversation's dish ("quán nào khác?" then finds it)
    const elsewhere = result.missingProduct ? this._offerElsewhere(session, text) : null;
    return {
      replyText: elsewhere ? `${result.replyText}

${elsewhere}` : result.replyText,
      session,
      merchantIntent: result.merchantIntent,
      orderRef: result.orderRef,
      activeMerchantId: session.active_merchant_id,
    };
  }

  async _handleAtPlatform(customer, session, text, concierge, { excludeMerchantId = null } = {}) {
    if (concierge.intent === "greeting") {
      return { replyText: this._greetingText(), session };
    }

    if (concierge.intent === "open_merchant_by_name") {
      // Look up by name across ALL statuses first, so an existing-but-
      // unavailable merchant gets an honest "not available" reply instead
      // of silently falling through to a generic keyword search.
      const anyStatusMatches = this.discovery.searchByMerchantNameAnyStatus(concierge.merchantNameHint);
      const discoverableMatches = anyStatusMatches.filter((m) => this.merchantRouter.isRoutable(m));

      if (discoverableMatches.length === 1) {
        return this._openMerchant(customer, session, discoverableMatches[0], { entrySource: "name_lookup" });
      }
      if (discoverableMatches.length > 1) {
        const cards = discoverableMatches.map((m) => `- ${m.name}`).join("\n");
        return { replyText: `Có ${discoverableMatches.length} quán tên gần giống, anh/chị chọn giúp em:\n${cards}`, session };
      }
      if (anyStatusMatches.length > 0) {
        return { replyText: `Dạ ${anyStatusMatches[0].name} hiện không khả dụng, anh/chị tìm quán khác giúp em nha.`, session };
      }
      // No merchant by that name ("xem thực đơn") — maybe a follow-up below.
    }

    // "chọn 2" / "2" right after a result list.
    const pickedByNumber = this._pickFromLastResults(session, text);
    if (pickedByNumber?.ambiguous) return { replyText: pickedByNumber.ambiguous, session, knowledgeFollowUp: "clarify" };
    if (pickedByNumber) return this._openMerchant(customer, session, pickedByNumber, { entrySource: "search_pick" });

    // A question about OTHER places or the AREA is never about the merchant just found (it would reopen it)
    const aboutOthers = concierge.global && !concierge.discovery;

    // "A Tiểu" right after a result list naming it.
    const pickedByName = aboutOthers ? null : await this._pickByNameFromLastResults(session, text);
    if (pickedByName) return this._openMerchant(customer, session, pickedByName, { entrySource: "search_pick" });

    // Follow-up about the merchant the customer just found ("có menu quán
    // ko", "quán ở đâu", "cho tôi 2 …") — answered with that merchant, never
    // by re-running a marketplace-wide search.
    const followUp = aboutOthers ? null : classifyMerchantFollowUp(text);
    if (followUp) {
      const handled = await this._handleFollowUp(customer, session, text, followUp);
      if (handled) return handled;
    }

    // Search Intelligence V2 (deterministic path, Food Knowledge on): a named place + operation, a dish with
    // filters, a shortened / mistyped dish, an area question, the dish of the conversation — planned first;
    // anything it does not own (orders, catalog places, list follow-ups) continues below unchanged.
    // ONE reading of the message per turn: the plan below and every concierge call of this turn use it
    // A pure reference ("quán thứ 2", "quán đó", "món thứ 2", "giá món đó", "còn không?") is resolved against the stored
    // context — or asked back — before any plan or model call: the model never decides what a reference means (FORM 10)
    if (!aboutOthers && this._referenceOnlyOrder(session, text)) return { replyText: REFERENCE_ONLY_ORDER, session, knowledgeFollowUp: "reference_only" };
    if (!aboutOthers && this._isPureReference(text, concierge)) {
      const resolved = this._knowledgeFollowUp(session, text, concierge);
      if (resolved) return resolved;
    }

    const reading = this._searchPlan(session, text, { currentMerchantId: excludeMerchantId });
    const planned = await this._executeSearchPlan(customer, session, text, { excludeMerchantId, newRequest: Boolean(concierge.discovery), reading });
    if (planned) return planned;

    // A question about the Food Knowledge reference list just shown ("sao ko có giá?") — answered about
    // that list, never by searching the question's own words (live Telegram #283/#284).
    const knowledgeFollowUp = this._knowledgeFollowUp(session, text, concierge);
    if (knowledgeFollowUp) return knowledgeFollowUp;

    if (concierge.intent === "open_merchant_by_name") {
      // No merchant by that name at all — fall back to treating it as a product/category search.
      return this._discover(customer, session, concierge.merchantNameHint, text, { discovery: concierge.discovery, searchResult: reading });
    }

    if (concierge.intent === "search_food") {
      // "<a catalog place> có <món> không": a question to THAT place — open it and ask it (never the default place)
      const asked = await this._questionToNamedMerchant(customer, session, text);
      if (asked) return asked;
      // "<a reference place> có món gì": that place by its name, not the dish words inside its name
      const place = this._namedReferencePlace(text);
      if (place) return this._discover(customer, session, place, place, { discovery: concierge.discovery, searchResult: reading });
      // "có Seafood Pizza không" with no merchant context: search the dish itself.
      return this._discover(customer, session, parseProductQuestion(text) ?? concierge.searchKeywords, text, { discovery: concierge.discovery, searchResult: reading });
    }

    if (concierge.intent === "global_search") {
      return { replyText: "Anh/chị muốn tìm món gì ạ?", session };
    }

    // Unknown: the GPT concierge (tools + Fact Guard) when enabled — for FOOD questions only ...
    if (this.gpt?.enabled()) {
      if (!this._foodScope(session, text)) return { replyText: SCOPE_REPLY, session, scope: { scope: "NO_FOOD_SIGNAL" } };
      const before = JSON.stringify(this.services.sessions.getKnowledgeContext(session.id));
      const answer = await this.gpt.respond({ customer, session, text, reason: "unknown", searchResult: reading });
      // this turn showed no list of its own — unless the Agent's search tool stored a new one during the turn
      if (answer) this._recordShown(session, answer.meta, { replacesDisplay: JSON.stringify(this.services.sessions.getKnowledgeContext(session.id)) !== before });
      if (answer) return { replyText: answer.text, session, concierge: answer.meta };
    }

    // ... else the optional AI fallback (never authoritative — its
    // suggestion still goes through the same DB search/resolve below).
    const aiHint = await this.ai.classify(text);
    if (aiHint?.intent === "open_merchant_by_name" && aiHint.merchantNameHint) {
      const matches = this.discovery.searchByMerchantName(aiHint.merchantNameHint);
      if (matches.length === 1) return this._openMerchant(customer, session, matches[0], { entrySource: "ai_hint" });
    }
    if (aiHint?.intent === "search_food" && aiHint.searchKeywords) {
      return this._runSearch(customer, session, aiHint.searchKeywords, { rawText: text });
    }

    return { replyText: "Dạ em chưa rõ ý anh/chị, anh/chị muốn ăn gì hoặc tìm quán nào ạ?", session };
  }

  async _runSearch(customer, session, keywords, { rawText = null, plan = null, excludeMerchantId = null, newRequest = false } = {}) {
    let { organic, sponsored } = await this.agentSearch.searchMerchants(keywords);
    // "ngoài quán này ra …": the place the customer just left is not an answer
    const excluded = new Set([excludeMerchantId, ...(plan?.exclude ?? []).filter((e) => e.type === "merchant").map((e) => String(e.id).replace(/^cat:/, ""))].filter(Boolean));
    if (excluded.size) {
      organic = organic.filter((c) => !excluded.has(c.merchant.merchant_id));
      sponsored = sponsored.filter((c) => !excluded.has(c.merchant.merchant_id));
    }
    const found = [...organic, ...sponsored];
    // Food Knowledge (only when FOOD_KNOWLEDGE_DISCOVERY_ENABLED): REFERENCE places / dishes / recorded prices
    // with their sources. It never decides what can be ordered — the catalog results above stay the only
    // pickable, orderable list; knowledge places are shown as "tham khảo".
    // A Search Intelligence plan searches its STRUCTURED query (resolved dishes, price filter, region).
    const fk = this.agentSearch.foodKnowledge;
    const knowledgeQuery = plan && fk?.foodQuery ? fk.foodQuery(plan, plan.attributeText ?? "", rawText) : rawText ?? keywords;
    const knowledge = this.agentSearch.searchFoodKnowledge(knowledgeQuery, { limit: KNOWLEDGE_RESULT_LIMIT, exclude: this._shownInCatalog(found), remember: true });
    // a planned search always answers from its result — even an empty one ("no place in that price range" is an
    // answer, never silently the unfiltered list)
    const knowledgeText = knowledge.enabled && (knowledge.result.merchants.length > 0 || (plan && found.length === 0)) ? knowledge.answer : null;
    // The query is always recorded (search analytics read it), but an empty
    // result keeps the previous results as the conversation context: a
    // misunderstood follow-up must not erase the merchant just found —
    // unless a reference list is now on screen ("1" must not open an older result).
    const updated = this.services.sessions.update(session.id, {
      lastSearchQuery: keywords,
      ...(found.length > 0 && {
        lastSearchResults: found.map((c) => ({
          merchant_id: c.merchant.merchant_id,
          name: c.merchant.name,
          name_match: Boolean(c.merchantNameMatch),
        })),
      }),
      ...(found.length === 0 && knowledgeText && { lastSearchResults: [] }),
    });
    // the reference list becomes the subject of follow-ups; any other search result replaces it — except that
    // words naming nothing ("quán nào bán?" misread, "haha") never erase a list the conversation is about
    if (knowledge.enabled) {
      const previous = this.services.sessions.getKnowledgeContext(updated.id);
      const namesNothing = !plan && !newRequest && !this.gpt?.enabled() && !knowledgeText && isFresh(previous) && !this.agentSearch.foodKnowledgeNamesSomething(rawText ?? keywords);
      if (!namesNothing) {
        const base = knowledgeText ? { ...buildKnowledgeContext(knowledge, { rawQuery: rawText ?? keywords, keywords }), ...(plan ? { searchQuery: knowledge.result.query } : {}) } : null;
        this.services.sessions.setKnowledgeContext(updated.id, plan ? withSearchState(base, this._planState(plan, rawText ?? keywords)) : base);
      }
    }
    let replyText = formatSearchResults({ organic, sponsored });
    if (knowledgeText && found.length > 0) replyText = `${replyText}\n\n———\n📚 Tham khảo thêm (chưa đặt qua FOOD được):\n\n${knowledgeText}`;
    else if (knowledgeText) replyText = `${knowledge.result.merchants.length ? "Dạ hiện chưa có quán nào đặt được qua FOOD cho yêu cầu này. Em có thông tin tham khảo:" : "Dạ hiện chưa có quán nào đặt được qua FOOD cho yêu cầu này."}\n\n${knowledgeText}`;
    if (plan?.price) replyText = `${composer.priceHeader(plan.price)}\n\n${replyText}`;
    return {
      replyText,
      session: updated,
      searchResultCount: found.length,
      knowledgeResultCount: knowledgeText ? knowledge.result.totalMerchants : 0,
      catalogQuality: found[0]?.matchQuality ?? null,
      // ids / counts only — what the GPT concierge is told this plan found (never prices or text)
      results: { catalog: found.map((c) => `cat:${c.merchant.merchant_id}`), reference_total: knowledge.enabled ? knowledge.result.totalMerchants : 0, reference_shown: knowledge.enabled ? knowledge.result.merchants.map((m) => `kb:${m.id}`) : [] },
    };
  }

  // ---------------------------------------------------------------- Search Intelligence V2
  // The planner (platform/search/v2) over Food Knowledge — the ONE reading of a message, deterministic path and
  // GPT concierge alike; null when Food Knowledge is off.
  _searchPlan(session, text, { currentMerchantId = null } = {}) {
    const fk = this.agentSearch.foodKnowledge;
    if (!fk?.searchIntelligence) return null;
    try {
      return fk.searchIntelligence().understand(text, { context: this.services.sessions.getKnowledgeContext(session.id), currentMerchantId: currentMerchantId ? `cat:${currentMerchantId}` : null });
    } catch {
      return null; // a planner failure never breaks the conversation: the existing path answers
    }
  }

  _offerElsewhere(session, text) {
    const si = this._searchPlan(session, text, { currentMerchantId: session.active_merchant_id });
    const fk = this.agentSearch.foodKnowledge;
    if (!si || si.plan.type !== "FOOD_DISCOVERY" || !fk?.foodQuery) return null;
    const found = this.agentSearch.searchFoodKnowledge(fk.foodQuery(si.plan, "", text), { limit: 1 });
    const total = found.enabled ? found.result.totalMerchants : 0;
    if (!total) return null;
    this.services.sessions.setKnowledgeContext(session.id, withSearchState(null, this._planState(si.plan, text)));
    const dish = si.plan.foods.map((f) => f.name).join(", ");
    return `FOOD có dữ liệu tham khảo về “${dish}” ở ${total} quán khác — anh/chị nhắn “quán nào bán?” để em gửi danh sách ạ.`;
  }

  _planState(plan, text) {
    const food = plan.foods?.[0] ?? null;
    return {
      currentIntent: plan.type,
      currentFoodEntity: food ? { id: food.id, key: food.key, name: food.name } : null,
      currentFilters: { price: plan.price ?? null, regionId: plan.regionId ?? null },
      lastSearchPlan: { type: plan.type, foods: (plan.foods ?? []).map((f) => f.key), price: plan.price ?? null, regionId: plan.regionId ?? null },
      lastUserQuery: text,
    };
  }

  async _executeSearchPlan(customer, session, text, { excludeMerchantId = null, newRequest = false, reading = undefined } = {}) {
    const si = reading !== undefined ? reading : this._searchPlan(session, text, { currentMerchantId: excludeMerchantId });
    if (!si) return null;
    const p = si.plan;
    const fk = this.agentSearch.foodKnowledge;
    const trace = { plan: p.type, reason: p.reason ?? null, confidence: si.confidence, gptCalled: false };
    const reply = (replyText, extra = {}) => ({ replyText, session, searchIntelligence: trace, ...extra });
    // the GPT concierge (when on) phrases the answer from FOOD's reading + the tools; its answer passes the Fact
    // Guard or the deterministic reply stands. It is never used to repair a wrong match: those never get here.
    const viaGpt = async (fallback, reason, results = null, sess = session) => {
      if (!this.gpt?.enabled()) return fallback;
      trace.gptCalled = true;
      const answer = await this.gpt.respond({ customer, session: sess, text, reason, newRequest, searchResult: si, results, deterministicReply: fallback.replyText });
      if (answer) this._recordShown(sess, answer.meta, { replacesDisplay: true });
      return answer ? { ...fallback, replyText: answer.text, concierge: answer.meta } : fallback;
    };
    if (p.type === "DEFER") return null;
    if (p.type === "CLARIFY") {
      let text2 = null;
      if (p.reason === "AMBIGUOUS_FOOD") text2 = composer.composeFoodChoice(p);
      else if (p.reason === "AMBIGUOUS_PLACE") text2 = composer.composeAmbiguousPlace(p);
      else if (p.reason === "ASK_DISH") text2 = composer.composeAskDish(p.price);
      else if (p.reason === "NO_CONTEXT") text2 = composer.composeNoContext(p.operation);
      else if (p.reason === "DID_YOU_MEAN") {
        this.services.sessions.setKnowledgeContext(session.id, withPending(this.services.sessions.getKnowledgeContext(session.id), p.pending));
        text2 = composer.composeDidYouMean(p);
      } else if (p.reason === "SUGGESTION_REJECTED") {
        this.services.sessions.setKnowledgeContext(session.id, withPending(this.services.sessions.getKnowledgeContext(session.id), null));
        return reply("Dạ vâng, anh/chị muốn tìm món gì ạ?");
      }
      return text2 ? viaGpt(reply(text2), "clarify") : null;
    }
    if (p.type === "MERCHANT_OPERATION") {
      const groups = p.groups.map((g) => g.map((c) => fk.merchant(Number(String(c.id).replace(/^kb:/, "")))).filter(Boolean)).filter((g) => g.length);
      if (!groups.length) return null;
      const ids = groups.flat().map((m) => m.id);
      // the list the customer was shown before stays the list ("quán thứ 2" after "quán X có menu gì?"): kept under it
      const prior = this.services.sessions.getKnowledgeContext(session.id);
      const kept = isFresh(prior) && enumerated(prior) ? asList(prior) : prior?.list && isFresh(prior.list) ? prior.list : null;
      const updated = this.services.sessions.update(session.id, { lastSearchQuery: p.said, lastSearchResults: [] });
      const shownIds = groups.map((g) => ([...g].sort((a, b) => (b.products?.length ?? 0) - (a.products?.length ?? 0))[0] ?? g[0]).id);
      const dishes = groups.length === 1 ? displayedDishes(p.operation, groups[0]) : [];
      const base = { type: "food_knowledge_results", rawQuery: text, query: p.said, named: true, foodKeys: [], regionId: null, matchedIds: ids, searchIds: ids, shownIds, shownCount: shownIds.length, total: ids.length, focusId: groups.length === 1 ? shownIds[0] : null, list: kept, menu: dishes.length ? { items: dishes, touchedAt: new Date().toISOString() } : null };
      this.services.sessions.setKnowledgeContext(updated.id, withSearchState(base, { currentIntent: `MERCHANT_${p.operation.toUpperCase()}`, currentMerchant: { ids, name: p.said }, lastSearchPlan: { type: p.type, operation: p.operation }, lastUserQuery: text }));
      const answer = { ...reply(composer.composeMerchantOperation({ operation: p.operation, groups, confidence: si.confidence, said: p.said, renderPlace: (m) => fk.renderMerchant(m) })), session: updated, knowledgeResultCount: groups.length };
      // the place is resolved: its records answer (deterministic), or the concierge phrases them from the same
      // resolved place (its tools return exactly that place); a MEDIUM name is said to be a near-miss either way
      return viaGpt(answer, "merchant_detail", { reference_shown: ids.map((id) => `kb:${id}`) }, updated);
    }
    if (p.type === "AREA_DISCOVERY") {
      const foods = fk.areaSummary({ regionId: p.regionId, excludeKeys: p.exclude.filter((e) => e.type === "food").map((e) => e.key) });
      const excludedNames = p.exclude.filter((e) => e.type === "food").map((e) => e.name);
      this.services.sessions.setKnowledgeContext(session.id, null); // a new (area) request replaces the list
      const area = reply(composer.composeArea({ regionName: fk.regionName(p.regionId), foods, nearMe: p.nearMe, unsupportedArea: p.unsupportedArea, excluded: excludedNames }));
      // the dish summary is FOOD's own data (no tool gives it): deterministic; a location FOOD cannot use: the
      // concierge explains it (the deterministic text stays the fallback)
      return p.areaAsk ? area : viaGpt(area, "discovery");
    }
    if (p.type === "UNKNOWN_PLACE") {
      const unknown = composer.composeUnknownPlace(p);
      if (!p.foods.length) return reply(unknown);
      const listed = await this._runSearch(customer, session, p.foods.map((f) => f.said ?? f.name).join(" "), { rawText: text, plan: { ...p, type: "FOOD_DISCOVERY" }, excludeMerchantId });
      return { ...listed, replyText: `${unknown} Các quán ${p.foods.map((f) => f.name).join(", ")} khác có dữ liệu:\n\n${listed.replyText}` };
    }
    // FOOD_DISCOVERY / CONTEXT_DISCOVERY / PRICE_REFINE: the catalog by the resolved dish name, Food Knowledge by the plan
    // the catalog is searched with the customer's own words for the dish (as before), the reference data by the plan
    const gptOn = Boolean(this.gpt?.enabled());
    const previous = gptOn && !newRequest ? this.services.sessions.getKnowledgeContext(session.id) : null;
    const found = await this._runSearch(customer, session, p.foods.map((f) => f.said ?? f.name).join(" "), { rawText: text, plan: { attributeText: "", ...p }, excludeMerchantId, newRequest });
    found.searchIntelligence = trace;
    // (GPT-2.1) a turn that is not a new request and found no new list keeps the list the conversation is about
    if (gptOn && !found.knowledgeResultCount && previous) this.services.sessions.setKnowledgeContext(session.id, previous);
    // orderable catalog places for a dish FOOD read with HIGH confidence: the deterministic list is the answer;
    // reference-only (or nothing) goes to the concierge with FOOD's reading and what was found
    // the same gate as _discover: a loose (category) catalog match is never a final answer on its own
    if (found.searchResultCount > 0 && TRUSTED_CATALOG_MATCH.has(found.catalogQuality) && si.confidence === "HIGH_CONFIDENCE") return found;
    return viaGpt(found, p.type === "FOOD_DISCOVERY" ? "discovery" : "follow_up", found.results, found.session);
  }

  // Follow-up on the remembered reference list (migration 013). Only when: the message is not a new
  // request ("tìm …"), it is a question about a list, it names no dish / place / region of its own, and
  // the list is recent. A question with no list to refer to is asked back — never guessed, never searched.
  _knowledgeFollowUp(session, text, concierge) {
    if (concierge.discovery) return null;
    const question = classifyKnowledgeFollowUp(text);
    if (!question || !this.agentSearch.foodKnowledgeEnabled()) return null;
    // only the words that are not the question itself can name something new ("giá BÚN BÒ bao nhiêu")
    if (question.residue && this.agentSearch.foodKnowledgeNamesSomething(question.residue)) return null;
    const context = this.services.sessions.getKnowledgeContext(session.id);
    const fresh = isFresh(context);
    if (!fresh) {
      const about = { price: "giá", address: "địa chỉ", hours: "giờ mở cửa" }[question.kind] ?? "thông tin";
      return { replyText: `Dạ anh/chị muốn hỏi ${about} của món hoặc quán nào ạ? (VD: "tìm <tên món>")`, session, knowledgeFollowUp: "clarify" };
    }
    // a DISH of the menu shown ("món thứ 2", "món đó", "giá món đó") / "còn không?"
    if (question.kind === "product" || question.productOrdinal != null || question.productRef) return this._dishFollowUp(session, context, question);
    if (question.kind === "availability") return this._availabilityFollowUp(session, context, question);
    // a POSITION ("quán thứ 2") counts in the list the customer was SHOWN: this context's own list, or — when this
    // context is one place answered by name — the list kept under it; never a place that was not shown
    if (question.ordinal !== null && question.kind !== "more") {
      const list = enumerated(context) ? context : context.list && isFresh(context.list) ? context.list : context;
      const shown = shownPlaces(list);
      const index = question.ordinal < 0 ? shown.length + question.ordinal : question.ordinal;
      if (!shown.length || index < 0 || index >= shown.length) return { replyText: `Dạ danh sách vừa rồi có ${shown.length} quán thôi ạ.`, session, knowledgeFollowUp: "clarify" };
      // the Agent rendered the list (its own order): those places, by id
      if (MENU_QUESTION.test(normalizeForMatch(text))) return this._menuOf(session, list === context ? context : asList(list), shown[index]);
      const byDisplay = Array.isArray(list.shownIds) && list.shownIds.length;
      const view = byDisplay ? { ...list, matchedIds: shown, searchIds: shown, shownCount: shown.length } : list;
      const answer = this.agentSearch.foodKnowledgeFollowUp(question.kind, { context: view, ordinal: index, targetId: null });
      // that list is the subject again; the place answered about is its focus
      this.services.sessions.setKnowledgeContext(session.id, { ...(list === context ? context : asList(list)), focusId: answer.focusId ?? null, touchedAt: new Date().toISOString() });
      return { replyText: answer.text, session, knowledgeFollowUp: question.kind };
    }
    // a list that is one place asked for by name: "còn quán nào khác / nữa" asks for OTHER places (global)
    if (question.kind === "more" && context.named) {
      this.services.sessions.setKnowledgeContext(session.id, null);
      return { replyText: OTHER_PLACES_ASK, session };
    }
    // "quán đó / quán này": the place last answered about in THIS list (focusId, same stored context);
    // a one-place list is unambiguous; otherwise ask — never guess, never search "quán đó"
    let targetId = null;
    if (question.ref === "focus") {
      const ids = [...new Set([...(context.matchedIds ?? []), ...shownPlaces(context)])];
      if (context.focusId != null && ids.includes(context.focusId)) targetId = context.focusId;
      else if (shownPlaces(context).length === 1) targetId = shownPlaces(context)[0];
      else return { replyText: "Dạ anh/chị hỏi quán nào trong danh sách ạ? (VD: “quán đầu tiên”, “quán thứ 2”)", session, knowledgeFollowUp: "clarify" };
    }
    if (targetId !== null && question.kind === "place" && MENU_QUESTION.test(normalizeForMatch(text))) return this._menuOf(session, context, targetId);
    const answer = this.agentSearch.foodKnowledgeFollowUp(question.kind, { context, ordinal: question.ordinal, targetId });
    // the list stays the subject of the conversation; the original query is never overwritten
    this.services.sessions.setKnowledgeContext(session.id, { ...context, shownCount: answer.shownCount, focusId: answer.focusId ?? null, touchedAt: new Date().toISOString() });
    return { replyText: answer.text, session, knowledgeFollowUp: question.kind };
  }

  /**
   * "cho tôi 2 phần" / "đặt" about the Food Knowledge place being talked about (no catalog list on screen, nothing
   * named): a reference place is not orderable on FOOD — FOOD says so, without a model call and without ordering.
   */
  _referenceOnlyOrder(session, text) {
    const intent = understandMessage(text).intent;
    if (!["quantity_only", "checkout", "confirm_order"].includes(intent)) return false;
    if ((session.lastSearchResults ?? []).length) return false;
    const ctx = this.services.sessions.getKnowledgeContext(session.id);
    return isFresh(ctx) && shownPlaces(ctx).length > 0;
  }

  // --- FORM 13: the menu a merchant showed, per customer + merchant (conversation_state_json, next to the engine's
  // own working memory, kept only for the SAME merchant) — menu = exact catalog names in the order shown; dish = the one
  // picked from it. Fresh for KNOWLEDGE_CONTEXT_TTL_MS (the same 30 minutes as a reference list).
  _merchantMemory(customerId, merchantId) {
    const state = this._conversationStates().getByCustomer(customerId);
    return state?.merchantId === merchantId ? state.menuBridge ?? null : null;
  }

  _setMerchantMemory(customerId, merchantId, patch) {
    const store = this._conversationStates();
    const state = store.getByCustomer(customerId);
    const base = state?.merchantId === merchantId ? state : { merchantId };
    store.saveForCustomer(customerId, { ...base, menuBridge: { ...(base.menuBridge ?? {}), ...patch } });
  }

  /** After a merchant reply: if it SHOWED menu lines, that is the menu "món thứ N" counts in (a new menu drops the dish). */
  async _recordMerchantMenu(customerId, merchantId, replyText, menu = null) {
    try {
      const summary = menu ?? (await this.merchantRouter.registry.getAdapter(merchantId)?.getMenuSummary?.());
      const names = menuShownIn(replyText, summary?.items ?? []);
      if (names.length) this._setMerchantMemory(customerId, merchantId, { menu: { items: names, touchedAt: new Date().toISOString() }, dish: null });
    } catch {
      // a menu that cannot be read is simply not a reference
    }
  }

  /**
   * Inside a merchant: a dish reference against the menu shown, or a quantity for the dish picked. Returns a reply
   * ({replyText}), the text to hand the merchant's engine ({engineText}), or null (the engine gets the message as is).
   */
  async _menuBridge(customer, session, text) {
    const merchantId = session.active_merchant_id;
    const adapter = this.merchantRouter.registry.getAdapter(merchantId);
    if (!adapter?.getMenuSummary) return null;
    const memory = this._merchantMemory(customer.id, merchantId);
    const menu = memory?.menu && isFresh(memory.menu) ? memory.menu.items : null;
    const dish = memory?.dish && isFresh(memory.dish) ? memory.dish.name : null;
    const catalogItem = async (name) => (await adapter.getMenuSummary()).items.find((i) => i.name === name) ?? null;
    const reply = (replyText) => ({ replyText, session, activeMerchantId: merchantId, menuBridge: true });
    const q = classifyKnowledgeFollowUp(text);
    if (q && !q.residue && (q.kind === "product" || q.productOrdinal != null || q.productRef)) {
      let name;
      if (q.productOrdinal != null) {
        if (!menu) return reply("Dạ anh/chị xem menu trước giúp em nha (gõ “menu”), rồi chọn “món thứ …” ạ.");
        const index = q.productOrdinal < 0 ? menu.length + q.productOrdinal : q.productOrdinal;
        if (index < 0 || index >= menu.length) return reply(`Dạ menu vừa rồi có ${menu.length} món thôi ạ.`);
        name = menu[index];
      } else if (dish) name = dish;
      else return null; // no dish picked here: "giá món này?" stays the merchant engine's own question (unchanged)
      const item = await catalogItem(name);
      if (!item) return reply("Dạ món đó hiện không còn trong thực đơn của quán ạ.");
      this._setMerchantMemory(customer.id, merchantId, { dish: { name: item.name, touchedAt: new Date().toISOString() } });
      return reply(`Dạ ${item.name}: ${vndText(item.price)}${item.available === false ? " (tạm hết)" : ""}.\nAnh/chị muốn đặt mấy phần ạ? (VD: “cho tôi 2 phần”)`);
    }
    // "cho tôi 2 phần": the dish picked from the menu, by its exact catalog name (never a guess from "2 phần")
    const msg = understandMessage(text);
    if (msg.intent === "quantity_only" && msg.quantity > 0 && dish) {
      const item = await catalogItem(dish);
      if (item) return { engineText: `${msg.quantity} ${item.name}` };
    }
    return null;
  }

  /** A message that is ONLY a reference to something shown (no dish / place / region of its own). */
  _isPureReference(text, concierge) {
    if (concierge.discovery || !this.agentSearch.foodKnowledgeEnabled()) return false;
    const q = classifyKnowledgeFollowUp(text);
    if (!q || q.residue) return false;
    return q.ordinal !== null || q.ref !== null || q.productOrdinal != null || Boolean(q.productRef) || q.kind === "availability";
  }

  /**
   * Record what the Agent SHOWED (FORM 10): the reference for the next "quán thứ 2" / "món thứ 2" is that, by id.
   * replacesDisplay: the Agent's answer replaced this turn's deterministic reply (the customer saw only the Agent's
   * items, never the list the router stored this turn); otherwise it answered about something shown earlier.
   */
  _recordShown(session, meta, { replacesDisplay = false } = {}) {
    const shown = Array.isArray(meta?.shown) ? meta.shown.filter((x) => /^kb:\d+$/.test(String(x.merchant_id))) : [];
    if (!session || !shown.length) return;
    const ctx = this.services.sessions.getKnowledgeContext(session.id);
    if (!isFresh(ctx)) return;
    const ids = shown.map((x) => Number(String(x.merchant_id).slice(3)));
    const dishes = ids.length === 1 ? shown[0].product_ids.filter((p) => /^kbp:\d+$/.test(p)).map((p) => ({ merchantId: ids[0], productId: Number(p.slice(4)) })) : [];
    const menu = dishes.length ? { items: dishes, touchedAt: new Date().toISOString() } : ids.length === 1 && ctx.named ? ctx.menu ?? null : null;
    const inList = ids.every((id) => (ctx.matchedIds ?? []).includes(id));
    let next;
    if (!replacesDisplay && inList && ids.length === 1 && enumerated(ctx)) next = { ...ctx, focusId: ids[0], menu }; // one place OF a list shown before: the focus
    else if (inList) next = { ...ctx, shownIds: ids, shownCount: ids.length, focusId: ids.length === 1 ? ids[0] : null, menu };
    else {
      // places outside the stored list (the Agent's own tool call): a new subject; the list the customer SAW before is
      // kept under it (this turn's stored list was never seen when the Agent replaced the display)
      const kept = !replacesDisplay && enumerated(ctx) ? asList(ctx) : ctx.list && isFresh(ctx.list) ? ctx.list : null;
      next = { ...asList(ctx), named: true, matchedIds: ids, searchIds: ids, shownIds: ids, shownCount: ids.length, total: ids.length, focusId: ids.length === 1 ? ids[0] : null, list: kept, menu, touchedAt: new Date().toISOString() };
    }
    this.services.sessions.setKnowledgeContext(session.id, next);
  }

  // "món thứ 2" / "món đầu tiên" / "món đó" / "giá món đó": one dish of the menu FOOD showed (by id), rendered from the
  // data (price with its source and date) — never from HISTORY; nothing is added to a cart
  _dishFollowUp(session, context, question) {
    const fk = this.agentSearch.foodKnowledge;
    const menu = context.menu?.items?.length && isFresh(context.menu) ? context.menu.items : null;
    let pick = null;
    if (question.productOrdinal != null) {
      if (!menu) return { replyText: "Dạ anh/chị hỏi món của quán nào ạ? (VD: “menu quán …”)", session, knowledgeFollowUp: "clarify" };
      const index = question.productOrdinal < 0 ? menu.length + question.productOrdinal : question.productOrdinal;
      if (index < 0 || index >= menu.length) return { replyText: `Dạ thực đơn vừa rồi có ${menu.length} món thôi ạ.`, session, knowledgeFollowUp: "clarify" };
      pick = menu[index];
    } else if (context.productFocus) pick = context.productFocus;
    else if (menu?.length === 1) pick = menu[0];
    else return { replyText: "Dạ anh/chị hỏi món nào ạ? (VD: “món thứ 2”)", session, knowledgeFollowUp: "clarify" };
    const m = fk.merchant(pick.merchantId);
    const dish = m?.products.find((p) => p.id === pick.productId) ?? null;
    if (!dish) return { replyText: "Dạ món đó không còn trong dữ liệu hiện có, anh/chị xem lại thực đơn giúp em nha.", session, knowledgeFollowUp: "clarify" };
    this.services.sessions.setKnowledgeContext(session.id, { ...context, focusId: m.id, productFocus: { merchantId: m.id, productId: dish.id }, touchedAt: new Date().toISOString() });
    return { replyText: fk.renderMerchant({ ...m, products: [dish] }), session, knowledgeFollowUp: question.kind === "price" ? "price" : "product" };
  }

  /** One place's menu from the data (the same card as a merchant detail); the dishes SHOWN become the menu context. */
  _menuOf(session, context, merchantId) {
    const fk = this.agentSearch.foodKnowledge;
    const m = fk.merchant(merchantId);
    if (!m) return { replyText: "Dạ quán đó không còn trong dữ liệu hiện có, anh/chị tìm lại giúp em nha.", session, knowledgeFollowUp: "clarify" };
    const dishes = displayedDishes("place", [m]);
    this.services.sessions.setKnowledgeContext(session.id, { ...context, focusId: m.id, productFocus: null, menu: dishes.length ? { items: dishes, touchedAt: new Date().toISOString() } : null, touchedAt: new Date().toISOString() });
    return { replyText: fk.renderMerchant(m), session, knowledgeFollowUp: "menu" };
  }

  // "còn không?": about the dish or the place just answered about — FOOD has no stock / open-now data for a reference
  // place, and says so; with no clear referent it asks
  _availabilityFollowUp(session, context, question) {
    const fk = this.agentSearch.foodKnowledge;
    if (context.productFocus && (question.productRef || !question.ref)) {
      const m = fk.merchant(context.productFocus.merchantId);
      const dish = m?.products.find((p) => p.id === context.productFocus.productId);
      if (dish) return { replyText: `Dạ em chưa có thông tin món “${dish.name}” ở ${m.name} hiện còn phục vụ hay không — các nguồn chỉ ghi món này (thông tin tham khảo, chưa đặt qua FOOD được). Anh/chị liên hệ quán để chắc chắn giúp em nha.`, session, knowledgeFollowUp: "availability" };
    }
    const shown = shownPlaces(context);
    const target = context.focusId != null ? context.focusId : shown.length === 1 ? shown[0] : null;
    const m = target != null ? fk.merchant(target) : null;
    if (!m) return { replyText: "Dạ anh/chị hỏi món nào hoặc quán nào ạ? (VD: “quán thứ 2 còn mở không”)", session, knowledgeFollowUp: "clarify" };
    return { replyText: `Dạ em chưa có thông tin ${m.name} hiện còn mở hay còn món không — dữ liệu của quán là thông tin tham khảo, chưa đặt qua FOOD được. Anh/chị liên hệ quán để chắc chắn giúp em nha.`, session, knowledgeFollowUp: "availability" };
  }

  // A knowledge place the catalog results already show must not reappear below them as "chưa đặt qua FOOD":
  // it is orderable (a person bridged it), or its listed dishes are the catalog merchant's own menu names
  // (>= 3 and >= 80% of them, exact names). Only ever HIDES a reference entry; never adds a claim.
  _shownInCatalog(found) {
    if (found.length === 0) return null;
    const menus = found.map((c) => new Set(this.services.menu.listProducts(c.merchant.merchant_id).map((p) => normalizeForMatch(p.name))));
    return (m) => {
      if (m.orderable) return true;
      const names = [...new Set(m.products.map((p) => normalizeForMatch(p.name)))];
      return menus.some((menu) => {
        const same = names.filter((n) => menu.has(n)).length;
        return same >= 3 && same >= 0.8 * names.length;
      });
    };
  }

  // The merchant a follow-up refers to, from the last search:
  // - exactly one result -> that merchant;
  // - several, but exactly one matched by its own name ("Tìm hủ tiếu xào"
  //   names "Hủ Tiếu Xào A Tiểu") -> that one;
  // - otherwise ambiguous -> the customer must choose. Never guessed.
  _recentMerchant(session) {
    const results = session.lastSearchResults || [];
    if (results.length === 0) return { merchantId: null, candidates: [] };
    if (results.length === 1) return { merchantId: results[0].merchant_id, candidates: results };
    const named = results.filter((r) => r.name_match);
    return { merchantId: named.length === 1 ? named[0].merchant_id : null, candidates: results };
  }

  _pickFromLastResults(session, text) {
    const m = String(text || "").trim().toLowerCase().match(/^(?:(?:chọn|chon|xem|mở|mo|quán|quan|số|so)\s+)*(\d{1,2})$/);
    const results = session.lastSearchResults || [];
    if (results.length < 2) return null;
    if (m) {
      const picked = results[Number(m[1]) - 1];
      return picked ? this.services.merchantData.getById(picked.merchant_id) : null;
    }
    // "cho tôi quán thứ 2 đi": a position in the catalog list — unless the reference list shown with it has that
    // position too (two lists on screen): then ask which one, never guess (FORM 10)
    const q = classifyKnowledgeFollowUp(text);
    if (!q || q.kind !== "place" || q.ordinal === null || q.ordinal < 0 || q.residue) return null;
    const picked = results[q.ordinal];
    if (!picked) return null;
    const kb = this.services.sessions.getKnowledgeContext(session.id);
    const other = isFresh(kb) && !kb.named ? shownPlaces(kb)[q.ordinal] : null;
    if (other != null) {
      const ref = this.agentSearch.foodKnowledge?.merchant?.(other);
      return { ambiguous: `Dạ anh/chị muốn xem quán thứ ${q.ordinal + 1} trong danh sách đặt được qua FOOD (${picked.name}) hay trong danh sách tham khảo${ref ? ` (${ref.name})` : ""} ạ?` };
    }
    return this.services.merchantData.getById(picked.merchant_id);
  }

  // A bare merchant name answering a result list ("A Tiểu"). Only when the
  // text names exactly one listed merchant AND is not also a dish at another
  // listed merchant ("hủ tiếu" names A Tiểu but is a dish at others too).
  async _pickByNameFromLastResults(session, text) {
    const results = session.lastSearchResults || [];
    if (results.length === 0) return null;
    if (/^(tim|kiem|toi muon|minh muon|muon an|cho toi tim|cho minh tim)\b/.test(normalizeForMatch(text))) return null;
    const query = normalizeSearchQuery(text);
    if (!query.normalized) return null;

    const listed = results.map((r) => this.services.merchantData.getById(r.merchant_id)).filter(Boolean);
    const named = listed.filter((m) => matchesMerchantName(m, query.normalized));
    if (named.length !== 1) return null;
    for (const other of listed) {
      if (other.merchant_id === named[0].merchant_id) continue;
      const adapter = this.merchantRouter.registry.getAdapter(other.merchant_id);
      if (adapter && (await adapter.searchProducts(query.text)).length > 0) return null;
    }
    return named[0];
  }

  // Sends a message into a merchant's own conversation. Modules with a
  // legacy engine of their own (supportsConversationalOrdering falsy) get
  // two generic helpers on top, through the MerchantModule contract only:
  // product questions are answered from searchProducts(), and a
  // multi-item message is handed over one item at a time.
  async _routeToMerchant(merchantId, customerId, text) {
    const adapter = this.merchantRouter.registry.getAdapter(merchantId);
    if (adapter && !adapter.supportsConversationalOrdering) {
      const before = adapter.checkoutState?.(customerId) ?? null;
      const result = await this._routeToLegacy(adapter, merchantId, customerId, text, before);
      // the module confirmed an order that was awaiting confirmation -> memory learns
      if (before?.awaitingConfirmation && result?.merchantIntent === "confirm_order" && result.orderRef) {
        this._learnFromLegacyOrder(adapter, merchantId, customerId, result.orderRef);
      }
      return result;
    }
    return this.merchantRouter.routeMessage(merchantId, customerId, text);
  }

  async _moduleCannotHandle(adapter, intent, text, { addedNothing = false } = {}) {
    if (intent === "unknown") return true;
    if (!LEGACY_PRODUCT_INTENTS.has(intent) && !(intent === "add_to_cart" && addedNothing)) return false;
    const found = await adapter.searchProducts(text);
    return !found.length;
  }

  /** True when the customer has been silent in a merchant context for longer than the idle TTL and no order is in progress. */
  _merchantContextIdle(customer, session) {
    const last = this.services.sessions.lastReplyAt?.(session.id);
    if (!last) return false;
    const idleMs = this.now().getTime() - Date.parse(`${String(last).replace(" ", "T")}Z`);
    if (!(idleMs > this.merchantIdleMs)) return false;
    const adapter = this.merchantRouter.registry.getAdapter(session.active_merchant_id);
    return !adapter?.hasOrderInProgress?.(customer.id);
  }

  async _routeToLegacy(adapter, merchantId, customerId, text, atieuState) {
    let msg = understandMessage(text);
    const memory = this.services.customerMemory;

    // --- pending questions the platform asked on the module's behalf ---
    const pending = this._legacyPending(merchantId, customerId);
    if (pending?.type === "confirm_reorder") {
      this._setLegacyPending(merchantId, customerId, null);
      const answer = msg.intent === "confirm_order" ? true : yesNoAnswer(text);
      if (answer === true) return this._executeLegacyReorder(adapter, merchantId, customerId, pending);
      if (answer === false) return { ok: true, replyText: "Dạ vâng ạ. Anh/chị muốn gọi món gì ạ?", merchantIntent: null, orderRef: null };
    }
    if (pending?.type === "choose_address") {
      this._setLegacyPending(merchantId, customerId, null);
      const n = msg.intent === "choose_option" ? msg.ordinal : msg.intent === "quantity_only" ? msg.quantity : null;
      if (n !== null && pending.choices[n - 1]) msg = { intent: "provide_delivery_address", address: pending.choices[n - 1], raw: text };
    }

    // --- customer memory: "như cũ", "chỗ cũ", labeled addresses ---
    if (msg.intent === "reorder" && memory) return this._legacyReorder(adapter, merchantId, customerId, msg);
    if (msg.addressRef && memory) {
      const found = memory.resolveAddress({ customerId, label: msg.addressRef.label });
      if (found.choices) {
        this._setLegacyPending(merchantId, customerId, { type: "choose_address", choices: found.choices.map((a) => a.address) });
        const list = found.choices.map((a, i) => `${i + 1}. ${a.label ? `(${a.label}) ` : ""}${a.address}`).join("\n");
        return { ok: true, replyText: `Dạ anh/chị có ${found.choices.length} địa chỉ đã dùng:\n${list}\n\nAnh/chị muốn giao tới địa chỉ nào ạ? (gõ số thứ tự)`, merchantIntent: null, orderRef: null };
      }
      if (!found.address) {
        const which = msg.addressRef.label ? ` "${msg.addressRef.label}"` : " cũ";
        return { ok: true, replyText: `Dạ em chưa lưu địa chỉ${which} nào của anh/chị. Anh/chị cho em xin địa chỉ giao hàng nha.`, merchantIntent: null, orderRef: null };
      }
      msg = { ...msg, address: found.address };
    }
    // "giao 2 hủ tiếu" has an address's shape but names dishes: it is an order
    if (msg.addressUncertain && msg.address && (await adapter.searchProducts(msg.address)).length > 0) {
      return this.merchantRouter.routeMessage(merchantId, customerId, withAddVerb(msg.address));
    }
    if (msg.addressLabel && msg.address && memory) memory.rememberAddress({ customerId, address: msg.address, label: msg.addressLabel });
    // a lasting preference ("em không ăn hành") is remembered for this merchant
    let remembered = [];
    if (msg.instructions && memory) {
      remembered = memory.rememberStatement({ customerId, merchantId, instructions: msg.instructions, temporality: msg.temporality, scope: msg.scope, correction: msg.correction });
    }

    const details = legacyCheckoutDetails(msg);
    if (details && !atieuState?.awaitingConfirmation) {
      const answeringItsQuestion = Boolean(atieuState?.field);
      return this._legacyCheckoutDetails(adapter, merchantId, customerId, msg, details, { answeringItsQuestion, remembered });
    }
    // "tổng bao nhiêu" / "xem lại": the module's own cart view, plus the
    // delivery details the platform holds for it (only outside its own checkout).
    if (["ask_total", "review_order", "show_cart"].includes(msg.intent) && atieuState && !atieuState.field && !atieuState.awaitingConfirmation) {
      const result = await this.merchantRouter.routeMessage(merchantId, customerId, "xem giỏ");
      const lines = legacyDetailLines(this._legacyDetails(merchantId, customerId));
      return lines.length ? { ...result, replyText: `${result.replyText}\n\n${lines.join("\n")}` } : result;
    }
    // Only questions the module's own engine does not understand at all
    // ("có sủi cảo không?") are answered here; anything it recognizes
    // keeps going to it untouched.
    const moduleUnderstands = classifyIntent(text).intent !== "unknown";
    if (!moduleUnderstands && (msg.intent === "ask_product_availability" || msg.intent === "ask_product_price") && msg.query) {
      const matches = await adapter.searchProducts(msg.query);
      return { ok: true, replyText: formatProductAnswer(matches, msg.query), merchantIntent: null, orderRef: null, missingProduct: matches.length === 0 ? msg.query : null };
    }
    if (msg.intent === "add_to_cart" && msg.items.length > 1) {
      const replies = [];
      let last = null;
      for (const segment of msg.items) {
        last = await this.merchantRouter.routeMessage(merchantId, customerId, withAddVerb(segment));
        if (!last.ok) return last;
        replies.push(last.replyText);
      }
      return { ...last, replyText: replies.join("\n\n") };
    }
    // Any other turn (e.g. "đặt") may have started the module's own
    // checkout: answer its questions from details the customer already gave.
    // A one-item order the platform understood but the module cannot read without a verb ("2 hủ tiếu xào bò")
    // goes to it as an order, exactly like the multi-item case above.
    const single = !moduleUnderstands && msg.intent === "add_to_cart" && msg.items.length === 1 ? withAddVerb(text) : text;
    const cartBefore = adapter.cartQuantity?.(customerId) ?? null;
    const result = await this.merchantRouter.routeMessage(merchantId, customerId, single);
    if (!result.ok) return result;
    // The module's own verdict decides ownership: it did not understand the message ("unknown"), it read a
    // product question, or an order that added nothing, naming nothing on its menu — not an ordering turn, so the
    // Core takes it back. Never while the module waits for an ordering answer (checkout detail / confirmation).
    const addedNothing = result.merchantIntent === "add_to_cart" && cartBefore !== null && (adapter.cartQuantity?.(customerId) ?? null) === cartBefore;
    // an order continuation the platform itself reads ("cho 2 tô", "xác nhận", an address…) always stays here
    if (!atieuState?.field && !atieuState?.awaitingConfirmation && !ORDER_CONTINUATION.has(msg.intent) && (await this._moduleCannotHandle(adapter, result.merchantIntent, text, { addedNothing }))) return { ...result, handBack: true };
    const filled = await this._autofillLegacyCheckout(adapter, merchantId, customerId);
    return filled ? { ...filled.result, replyText: `${filled.note}\n\n${filled.result.replyText}` } : result;
  }

  // --- customer memory for modules with their own engine ---------------------------

  _legacyPending(merchantId, customerId) {
    const state = this._conversationStates().getByCustomer(customerId);
    return state?.merchantId === merchantId ? state.legacyPending ?? null : null;
  }

  _setLegacyPending(merchantId, customerId, pending) {
    const store = this._conversationStates();
    const state = store.getByCustomer(customerId);
    const base = state?.merchantId === merchantId ? state : { merchantId };
    store.saveForCustomer(customerId, { ...base, legacyPending: pending });
  }

  _legacyOrderReader(adapter, customerId) {
    return {
      readOrder: (orderRef) => adapter.memoryOrder?.(customerId, orderRef) ?? null,
      currentProduct: (productId) => adapter.memoryProduct?.(productId) ?? null,
    };
  }

  // "như cũ" for a module with its own engine: the same candidate as the
  // generic engine builds, read from the module's own orders + current menu.
  async _legacyReorder(adapter, merchantId, customerId, msg) {
    const memory = this.services.customerMemory;
    const current = (msg.instructions || []).map((i) => ({ ...i, temporality: msg.temporality }));
    const candidate = memory.buildReorderCandidate({
      customerId,
      merchantId,
      orderReader: this._legacyOrderReader(adapter, customerId),
      preferRecurring: msg.preferRecurring,
      current,
    });
    const reply = (replyText) => ({ ok: true, replyText, merchantIntent: null, orderRef: null });
    if (!candidate) return reply('Dạ em chưa thấy đơn nào trước đây của anh/chị ở quán này, nên em chưa biết "như cũ" là món gì ạ. Anh/chị muốn gọi món gì ạ?');
    const { name } = await adapter.getMenuSummary();
    if (candidate.items.length === 0) return reply(formatReorderCandidate(candidate, { merchantName: name }));
    let { address, fulfillment } = candidate;
    if (!address && fulfillment !== "pickup") {
      const saved = memory.resolveAddress({ customerId });
      if (saved.address) {
        address = saved.address;
        fulfillment = "delivery";
      }
    }
    this._setLegacyPending(merchantId, customerId, {
      type: "confirm_reorder",
      items: candidate.items,
      instructions: candidate.instructions.map((i) => ({ attribute: i.attribute, value: i.value, label: i.label, temporality: i.temporality ?? (i.source === "current" ? msg.temporality : "order") })),
      address: fulfillment === "pickup" ? null : address,
      fulfillment,
      total: candidate.total,
    });
    return reply(formatReorderCandidate(candidate, { merchantName: name, address: fulfillment === "pickup" ? null : address, fulfillment }));
  }

  // The customer confirmed the candidate: hand the items and details to the
  // module's own engine (unchanged), and place the order only when the
  // module's pending order is exactly what the customer confirmed; otherwise
  // the module's own summary (e.g. with a delivery fee) is shown for confirmation.
  async _executeLegacyReorder(adapter, merchantId, customerId, pending) {
    for (const item of pending.items) {
      const now = adapter.memoryProduct?.(item.productId);
      if (!now || !now.available || now.price !== item.price) {
        // menu changed since the candidate was shown: show it again, never order on stale info
        return this._legacyReorder(adapter, merchantId, customerId, { intent: "reorder", preferRecurring: false });
      }
    }
    const details = { ...this._legacyDetails(merchantId, customerId), instructions: pending.instructions };
    if (pending.fulfillment === "pickup") details.fulfillment = "pickup";
    else if (pending.address) details.address = pending.address;
    this._saveLegacyDetails(merchantId, customerId, details);

    const replies = [];
    for (const item of pending.items) {
      const added = await this.merchantRouter.routeMessage(merchantId, customerId, `Thêm ${item.quantity} ${item.name}`);
      if (!added.ok) return added;
    }
    let last = await this.merchantRouter.routeMessage(merchantId, customerId, "Đặt");
    if (!last.ok) return last;
    const filled = await this._autofillLegacyCheckout(adapter, merchantId, customerId);
    if (filled) last = filled.result;
    const state = adapter.checkoutState?.(customerId);
    if (state?.awaitingConfirmation && state.pendingOrderTotal === pending.total) {
      const confirmed = await this.merchantRouter.routeMessage(merchantId, customerId, "Xác nhận");
      if (confirmed.ok && confirmed.merchantIntent === "confirm_order" && confirmed.orderRef) {
        this._learnFromLegacyOrder(adapter, merchantId, customerId, confirmed.orderRef);
      }
      return confirmed;
    }
    replies.push(last.replyText);
    return { ...last, replyText: replies.join("\n\n") };
  }

  // After the module confirmed an order: reference it in customer memory
  // with the instructions it was placed with, then forget those instructions.
  _learnFromLegacyOrder(adapter, merchantId, customerId, orderRef) {
    const memory = this.services.customerMemory;
    const order = adapter.memoryOrder?.(customerId, orderRef);
    if (!memory || !order) return;
    const details = this._legacyDetails(merchantId, customerId);
    memory.learnFromConfirmedOrder({ customerId, merchantId, orderRef, instructions: details.instructions || [], address: order.address });
    const { instructions, note, ...rest } = details;
    this._saveLegacyDetails(merchantId, customerId, rest);
  }

  // --- checkout details for modules with their own checkout (A Tiểu) -------------
  // Such a module only accepts an address when ITS checkout asks for it. The
  // platform keeps what the customer said early (in the session's existing
  // conversation state — no new store) and answers the module's questions
  // with it when they come, reading the module's checkout state through
  // its adapter, never by parsing reply text.

  _conversationStates() {
    return this.merchantRouter.registry.repos.conversationStates;
  }

  _legacyDetails(merchantId, customerId) {
    const state = this._conversationStates().getByCustomer(customerId);
    return state?.merchantId === merchantId ? state.legacyCheckout ?? {} : {};
  }

  _saveLegacyDetails(merchantId, customerId, details) {
    const store = this._conversationStates();
    const state = store.getByCustomer(customerId);
    const base = state?.merchantId === merchantId ? state : { merchantId };
    store.saveForCustomer(customerId, { ...base, legacyCheckout: details });
  }

  async _legacyCheckoutDetails(adapter, merchantId, customerId, msg, details, { answeringItsQuestion = false, remembered = [] } = {}) {
    const previous = this._legacyDetails(merchantId, customerId);
    const merged = { ...previous, ...details, instructions: mergeInstructions(previous.instructions, details.instructions) };
    if (!merged.instructions.length) delete merged.instructions;
    this._saveLegacyDetails(merchantId, customerId, merged);

    const replies = [];
    let last = null;
    if (msg.intent === "add_to_cart") {
      for (const segment of msg.items) {
        last = await this.merchantRouter.routeMessage(merchantId, customerId, withAddVerb(segment));
        if (!last.ok) return last;
        replies.push(last.replyText);
      }
    }
    const filled = await this._autofillLegacyCheckout(adapter, merchantId, customerId);
    if (filled) {
      if (!answeringItsQuestion) replies.push(filled.note);
      replies.push(filled.result.replyText);
      last = filled.result;
    } else {
      const heading = details.address ? "Dạ em đã ghi nhận địa chỉ giao hàng:" : "Dạ em đã ghi nhận:";
      const memoryNote = remembered.length
        ? [msg.scope === "global" ? "Em cũng nhớ điều này cho những lần sau, ở mọi quán ạ." : "Em cũng nhớ cho những lần sau ở quán này ạ."]
        : msg.temporality === "current_only" && details.instructions
        ? ["(Chỉ áp dụng cho đơn này ạ.)"]
        : [];
      replies.push([heading, ...legacyDetailLines(merged), ...memoryNote, "", 'Khi anh/chị gõ "đặt", em sẽ gửi quán thông tin này.'].join("\n"));
    }
    if (msg.invalidPhone) replies.push(`⚠️ Số điện thoại "${msg.invalidPhone}" chưa đúng (cần 10 số), anh/chị kiểm tra lại giúp em nha.`);
    return { ok: true, replyText: replies.join("\n\n"), merchantIntent: last?.merchantIntent ?? null, orderRef: last?.orderRef ?? null };
  }

  // Answers the module's pending checkout questions (fulfillment -> address
  // -> phone) with details already given; stops at the first it can't answer.
  async _autofillLegacyCheckout(adapter, merchantId, customerId) {
    if (!adapter.checkoutState) return null;
    const details = this._legacyDetails(merchantId, customerId);
    if (!details.address && !details.fulfillment && !details.phone) return null;
    let result = null;
    const used = [];
    for (let step = 0; step < 3; step++) {
      const { field } = adapter.checkoutState(customerId);
      let answer = null;
      if (field === "fulfillment_type" && (details.fulfillment === "pickup" || details.address)) {
        answer = details.fulfillment === "pickup" ? "mang về" : "giao hàng";
      } else if (field === "address" && details.address) answer = details.address;
      else if (field === "phone" && details.phone) answer = details.phone;
      if (!answer) break;
      result = await this.merchantRouter.routeMessage(merchantId, customerId, answer);
      used.push(field);
      if (!result.ok) break;
    }
    if (!result) return null;
    // details handed over to the module's order are not reused for a later one
    const remaining = { ...details };
    if (used.includes("address") || used.includes("fulfillment_type")) {
      delete remaining.address;
      delete remaining.fulfillment;
    }
    if (used.includes("phone")) delete remaining.phone;
    this._saveLegacyDetails(merchantId, customerId, remaining);
    const note = ["Dạ em dùng thông tin anh/chị đã cho:", ...legacyDetailLines(details)].join("\n");
    return { result, note };
  }

  // "Có hủ tiếu không?" while several merchants from the last search are
  // still open: answered within THOSE merchants only, never marketplace-wide.
  // The list narrows to the merchants that have it, so "1"/"A Tiểu" picks one.
  async _productAcrossCandidates(session, candidates, query) {
    const found = [];
    for (const c of candidates) {
      const merchant = this.services.merchantData.getById(c.merchant_id);
      if (!this.merchantRouter.isRoutable(merchant)) continue;
      const matches = await this.merchantRouter.registry.getAdapter(c.merchant_id).searchProducts(query);
      const available = matches.filter((m) => m.available);
      if (available.length) found.push({ result: c, merchant, matches: available });
    }
    if (found.length === 0) {
      return { replyText: `Dạ các quán vừa tìm chưa có món "${query}" ạ. Anh/chị thử tìm món khác nha.`, session };
    }
    const updated = this.services.sessions.update(session.id, { lastSearchResults: found.map((f) => f.result) });
    const blocks = found.map((f, i) => {
      const dishes = f.matches.slice(0, 3).map((m) => `   • ${m.name}: ${Number(m.price).toLocaleString("vi-VN")}đ`);
      const more = f.matches.length > 3 ? [`   … và ${f.matches.length - 3} món khác`] : [];
      return [`${i + 1}. ${f.merchant.name}`, ...dishes, ...more].join("\n");
    });
    const ask =
      found.length === 1
        ? `Anh/chị muốn đặt ở ${found[0].merchant.name} không ạ? (VD: "cho 2 ${found[0].matches[0].name}" hoặc "menu")`
        : 'Anh/chị muốn chọn quán nào ạ? (gõ số thứ tự hoặc tên quán)';
    return { replyText: `Dạ trong các quán vừa tìm, món "${query}" có ở:\n${blocks.join("\n")}\n\n${ask}`, session: updated };
  }

  async _handleFollowUp(customer, session, text, followUp) {
    // The follow-up may itself name a merchant ("menu nom nom") — that wins.
    let merchant = null;
    if (followUp.rest.length >= 3) {
      const named = this.discovery.searchByMerchantName(followUp.rest);
      if (named.length === 1) merchant = named[0];
    }
    if (!merchant) {
      const recent = this._recentMerchant(session);
      const question = understandMessage(text);
      const isProductQuestion = ["ask_product_availability", "ask_product_price"].includes(question.intent) && question.query;
      if (isProductQuestion && recent.candidates.length > 1) {
        return this._productAcrossCandidates(session, recent.candidates, question.query);
      }
      const { merchantId, candidates } = recent;
      if (!merchantId) {
        if (candidates.length < 2) return null; // no context: normal handling
        const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        return {
          replyText: `Dạ lần tìm trước có ${candidates.length} quán:\n${list}\n\nAnh/chị muốn hỏi quán nào ạ? (Gõ số thứ tự, VD: "1", hoặc "xem <tên quán>")`,
          session,
        };
      }
      merchant = this.services.merchantData.getById(merchantId);
    }

    if (!this.merchantRouter.isRoutable(merchant)) {
      return { replyText: `Dạ ${merchant?.name ?? "quán này"} hiện không khả dụng, anh/chị tìm quán khác giúp em nha.`, session };
    }
    if (followUp.kind === "menu") {
      return this._openMerchant(customer, session, merchant, { entrySource: "search_followup" });
    }

    const updated = this.services.sessions.enterMerchantContext(session.id, merchant.merchant_id, {
      entrySource: "search_followup",
      searchQuery: session.last_search_query,
    });
    if (followUp.kind === "location") {
      const { name, address } = await this.merchantRouter.registry.getAdapter(merchant.merchant_id).getMenuSummary();
      return {
        replyText: address ? `📍 ${name}: ${address}` : `Dạ ${name} chưa cập nhật địa chỉ ạ.`,
        session: updated,
        activeMerchantId: merchant.merchant_id,
      };
    }
    const result = await this._routeToMerchant(merchant.merchant_id, customer.id, text);
    if (!result.ok) {
      const back = this.services.sessions.returnToPlatform(session.id);
      return { replyText: "Quán này hiện không khả dụng, anh/chị tìm quán khác giúp em nha.", session: back };
    }
    // the place's engine could not handle it (conversation ownership): not a follow-up for this place — the Core
    // handles it normally; a customer who was not in the place does not stay in it
    if (result.handBack) {
      if (session.context !== "merchant") this.services.sessions.returnToPlatform(session.id);
      return null;
    }
    return {
      replyText: result.replyText,
      session: updated,
      merchantIntent: result.merchantIntent,
      orderRef: result.orderRef,
      activeMerchantId: merchant.merchant_id,
    };
  }

  // "A Tiểu có bún bò không?": the message starts with the name of exactly one routable catalog place and asks
  // whether it has a dish. Menu questions ("… có món gì") and place questions ("… có quán nào …") are left to
  // the existing search. Returns the place's own answer, in that place's context, or null.
  async _questionToNamedMerchant(customer, session, text) {
    const m = String(text ?? "").trim().match(/^(.+?)\s+(?:có|bán|co|ban)\s+(.+?)\s*(?:không|ko|k|hông|hem|chưa)?\s*\??$/iu);
    if (!m) return null;
    const [, name, dish] = m;
    if (/(?:^|\s)(?:món gì|gì|menu|thực đơn|quán|chỗ|nào|mon gi|gi|thuc don|quan|nao)(?:\s|$)/iu.test(dish) || /(?:^|\s)(?:quán|chỗ|nào|quan|nao)(?:\s|$)/iu.test(name)) return null;
    const matches = this.discovery.searchByMerchantName(name).filter((x) => this.merchantRouter.isRoutable(x) && matchesMerchantName(x, normalizeForMatch(name)));
    if (matches.length !== 1) return null;
    const updated = this.services.sessions.enterMerchantContext(session.id, matches[0].merchant_id, { entrySource: "name_question", searchQuery: session.last_search_query });
    const result = await this._routeToMerchant(matches[0].merchant_id, customer.id, `có ${dish} không`);
    if (!result.ok) return null;
    return { replyText: result.replyText, session: updated, merchantIntent: result.merchantIntent, activeMerchantId: matches[0].merchant_id };
  }

  // "Bún Cá Mịn có món gì?": a Food Knowledge reference place named in the sentence (distinctive names only,
  // adapter placeMatcher). Returns its name to search by, or null (catalog places keep their own path).
  _namedReferencePlace(text) {
    const fk = this.agentSearch.foodKnowledge;
    if (!fk?.placeMatcher) return null;
    let r;
    try {
      r = fk.placeMatcher().match(text);
    } catch {
      return null;
    }
    const hits = [...r.matches, ...r.ambiguous.flatMap((a) => a.candidates.map((c) => ({ ...c, text: a.text })))];
    if (!hits.length || !hits.every((h) => String(h.foodEntityId).startsWith("kb:"))) return null;
    const names = new Set(hits.map((h) => normalizeForMatch(h.canonicalName)));
    return names.size === 1 ? hits[0].canonicalName : null;
  }

  async _openMerchant(customer, session, merchant, { entrySource }) {
    if (!this.merchantRouter.isRoutable(merchant)) {
      return { replyText: `Dạ ${merchant.name} hiện không khả dụng, anh/chị tìm quán khác giúp em nha.`, session };
    }
    const adapter = this.merchantRouter.registry.getAdapter(merchant.merchant_id);
    const updated = this.services.sessions.enterMerchantContext(session.id, merchant.merchant_id, {
      entrySource,
      searchQuery: session.last_search_query,
    });
    const menu = await adapter.getMenuSummary();
    const replyText = formatMenuSummary(menu);
    await this._recordMerchantMenu(customer.id, merchant.merchant_id, replyText, menu);
    return { replyText, session: updated, openedMerchantId: merchant.merchant_id };
  }

  _greetingText() {
    return [
      "Dạ em chào anh/chị, em là trợ lý của TỔNG ĐÀI — nơi tìm và đặt món từ nhiều quán ăn qua Zalo.",
      "Anh/chị muốn ăn gì hôm nay ạ? (VD: \"tìm quán bún cá ở Nha Trang\", \"có quán nào bán cơm gà?\")",
    ].join("\n");
  }
}
