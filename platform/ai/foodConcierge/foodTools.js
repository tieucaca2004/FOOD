import { buildKnowledgeContext, isFresh, KNOWLEDGE_CONTEXT_TTL_MS } from "../../conversation/knowledgeContext.js";
import { normalizeForMatch } from "../../nlp/searchQuery.js";

// FOOD tools for the GPT concierge. READ-ONLY over the existing services —
// the model never sees SQLite, never writes a merchant / product / price /
// cart / order. The one write here is conversation state the router already
// keeps: search_food remembers its reference list (knowledge_context_json),
// exactly like a deterministic search does, so follow-ups work either way.
//
// Ids are namespaced so a reference place can never be mistaken for an
// orderable one:  kb:<id> / kbp:<id>  = Food Knowledge (reference only)
//                 cat:<merchantId> / catp:<merchantId>:<n> = FOOD catalog
//
// Every tool returns { data, facts }: `data` goes to the model; `facts` are
// the same records normalised for the Fact Guard's ledger.

const MAX_RESULTS = 10;
const REFERENCE_SEARCH_LIMIT = 50;
const PREVIOUS_LIMIT = 30;

const str = { type: "string" };
const num = { type: "number" };

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_food",
    description:
      "Search dishes and places that serve them: FOOD catalog (orderable) and Food Knowledge (reference only). Use for any request to find food or places. Put the customer's dish/place words in query; never invent them.",
    parameters: {
      type: "object",
      properties: {
        query: { ...str, description: "Dish / place / kind of place, in the customer's words" },
        location: { ...str, description: "Area or city the customer named, if any" },
        max_price: { ...num, description: "Upper budget in VND the customer stated" },
        min_price: { ...num, description: "Lower budget in VND the customer stated" },
        dietary: str,
        taste: str,
        temperature: str,
        texture: str,
        meal_period: str,
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_merchants",
    description: "Find places by name or kind (catalog + reference). Use when the customer names a place or asks for a kind of place.",
    parameters: {
      type: "object",
      properties: { query: str, location: str, category: str, budget_max: num, limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_merchant",
    description: "Authoritative details of one place by merchant_id (kb:… reference or cat:… catalog).",
    parameters: { type: "object", properties: { merchant_id: str }, required: ["merchant_id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "get_menu",
    description: "Menu of one place: catalog menu (orderable, FOOD price) or recorded reference products.",
    parameters: { type: "object", properties: { merchant_id: str }, required: ["merchant_id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "get_product",
    description: "One product of one place with its price status and sources.",
    parameters: { type: "object", properties: { merchant_id: str, product_id: str }, required: ["merchant_id", "product_id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "get_previous_knowledge_results",
    description:
      "The reference list this conversation is about (the last food search): query, places, products, prices. Use FIRST for follow-ups such as 'sao không có giá?', 'còn quán nào nữa?', 'quán nào có giá?'.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "get_customer_cart",
    description: "The customer's current FOOD carts (read-only).",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

/** Price status of one product from its published prices: never picks one of conflicting prices. */
export function priceStatus(prices) {
  const withNumber = prices.filter((p) => p.price !== null && p.price !== undefined);
  if (!withNumber.length) return "unavailable";
  const byVariant = new Map();
  for (const p of withNumber) {
    const key = p.variant ?? "";
    if (!byVariant.has(key)) byVariant.set(key, new Set());
    byVariant.get(key).add(`${p.price}-${p.priceMax ?? p.price_max ?? ""}`);
  }
  return [...byVariant.values()].some((s) => s.size > 1) ? "conflicting" : "available";
}

export class FoodTools {
  constructor({ services, repos, agentSearch, merchantRouter }) {
    this.services = services;
    this.repos = repos;
    this.agentSearch = agentSearch;
    this.merchantRouter = merchantRouter;
  }

  get knowledge() {
    return this.agentSearch.foodKnowledge ?? null;
  }

  /** @returns {Promise<{data: object, facts: object[]}>} */
  async run(name, args, ctx) {
    switch (name) {
      case "search_food":
        return this.searchFood(args, ctx);
      case "search_merchants":
        return this.searchMerchants(args, ctx);
      case "get_merchant":
        return this.getMerchant(args);
      case "get_menu":
        return this.getMenu(args);
      case "get_product":
        return this.getProduct(args);
      case "get_previous_knowledge_results":
        return this.previousResults(ctx);
      case "get_customer_cart":
        return this.customerCart(ctx);
      default:
        return { data: { error: "UNKNOWN_TOOL", tool: name }, facts: [] };
    }
  }

  // ------------------------------------------------------------ reference (Food Knowledge)

  _referenceMerchant(m, { products = m.products } = {}) {
    const rows = products.map((p) => this._referenceProduct(m, p));
    const fact = {
      id: `kb:${m.id}`,
      name: m.name,
      address: m.location?.address ?? null,
      orderable: Boolean(m.orderable),
      openStatus: m.openStatus ?? "unknown",
      openingHours: (m.openingHours ?? []).map((h) => h.text),
      ratings: (m.ratings ?? []).filter((r) => r.rating !== null),
      products: rows.map((r) => r.fact),
    };
    return {
      data: {
        merchant_id: fact.id,
        merchant_name: m.name,
        address: fact.address,
        orderable: fact.orderable,
        reference_only: !fact.orderable,
        opening_hours: fact.openingHours,
        open_status: fact.openStatus,
        products: rows.map((r) => r.data),
      },
      fact,
    };
  }

  _referenceProduct(m, p) {
    const evidence = this.knowledge?.priceEvidence(p.id) ?? [];
    const prices = p.prices.map((x) => {
      const ev = evidence.find((e) => e.price === x.price && (e.variant ?? null) === (x.variant ?? null));
      return { variant: x.variant ?? null, price: x.price, price_max: x.priceMax ?? null, source: x.sourceUrl, official: ev?.source_type === "merchant_official", captured_at: x.capturedAt, evidence_id: ev?.evidence_id ?? null };
    });
    const status = priceStatus(p.prices);
    const single = status === "available" && prices.length === 1 ? prices[0] : null;
    const data = {
      product_id: `kbp:${p.id}`,
      product_name: p.name,
      food_name: p.foods?.[0]?.name ?? null,
      price_status: status,
      price: single?.price ?? null,
      price_max: single?.price_max ?? null,
      currency: "VND",
      prices,
      orderable: Boolean(p.orderable),
      source: single?.source ?? prices[0]?.source ?? null,
      captured_at: single?.captured_at ?? prices[0]?.captured_at ?? null,
      evidence_id: single?.evidence_id ?? null,
    };
    return { data, fact: { id: data.product_id, name: p.name, priceStatus: status, prices, orderable: data.orderable } };
  }

  // ------------------------------------------------------------ catalog (orderable)

  async _catalogMerchant(merchantId, { onlyNames = null } = {}) {
    const merchant = this.services.merchantData.getById(merchantId);
    if (!merchant) return null;
    const orderable = this.merchantRouter.isRoutable(merchant);
    let summary = { name: merchant.name, address: merchant.address ?? null, items: [] };
    try {
      summary = await this.merchantRouter.registry.getAdapter(merchantId).getMenuSummary();
    } catch {
      // a module without a readable menu: the merchant is still listed, with no products
    }
    const wanted = onlyNames ? new Set(onlyNames.map(normalizeForMatch)) : null;
    const products = (summary.items ?? [])
      .map((item, n) => ({ item, n }))
      .filter(({ item }) => !wanted || wanted.has(normalizeForMatch(item.name)))
      .map(({ item, n }) => ({
        product_id: `catp:${merchantId}:${n}`,
        product_name: item.name,
        price_status: "available",
        price: item.price,
        price_max: null,
        currency: "VND",
        orderable: orderable && item.available !== false,
        available: item.available !== false,
        source: "FOOD catalog",
        captured_at: null,
        evidence_id: null,
      }));
    const fact = {
      id: `cat:${merchantId}`,
      name: summary.name ?? merchant.name,
      address: summary.address ?? null,
      orderable,
      openStatus: "unknown",
      openingHours: [],
      ratings: [],
      products: products.map((p) => ({ id: p.product_id, name: p.product_name, priceStatus: "available", prices: [{ price: p.price, price_max: null, source: "FOOD catalog" }], orderable: p.orderable })),
    };
    return { data: { merchant_id: fact.id, merchant_name: fact.name, address: fact.address, orderable, reference_only: false, products }, fact };
  }

  async _catalogMatches(query) {
    if (!query) return [];
    const { organic, sponsored } = await this.agentSearch.searchMerchants(query);
    const out = [];
    for (const c of [...organic, ...sponsored].slice(0, MAX_RESULTS)) {
      const names = (c.matches ?? []).map((x) => x.name);
      const entry = await this._catalogMerchant(c.merchant.merchant_id, { onlyNames: names.length ? names : null });
      if (entry) out.push({ ...entry, data: { ...entry.data, sponsored: sponsored.includes(c) } });
    }
    return out;
  }

  // ------------------------------------------------------------ tools

  // The tool's words go through Search Intelligence V2 — the same reading the router uses. A shortened / mistyped
  // dish is not searched (the model must ask), a place asked by name is that place, and a dish search uses V2's
  // resolved dish + price filter + region. Without V2 (Food Knowledge off) the words are searched as before.
  _understand(text, ctx) {
    const si = this.knowledge?.searchIntelligence?.();
    if (!si) return null;
    try {
      const context = ctx?.session ? this.services.sessions.getKnowledgeContext(ctx.session.id) : null;
      // the same inputs as the router's reading (the place the customer is in, if any)
      const currentMerchantId = ctx?.session?.context === "merchant" && ctx.session.active_merchant_id ? `cat:${ctx.session.active_merchant_id}` : null;
      return si.understand(text, { context, currentMerchantId });
    } catch {
      return null;
    }
  }

  async searchFood(args, ctx) {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), MAX_RESULTS);
    const text = [args.query, args.location ? `ở ${args.location}` : null, args.dietary, args.taste, args.temperature, args.texture, args.meal_period]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ");
    const understood = this._understand(text, ctx);
    const plan = understood?.plan ?? null;
    const reading = understood ? { plan: plan.type, reason: plan.reason ?? null, confidence: understood.confidence, foods: understood.foodEntities.map((f) => f.name), candidates: understood.foodCandidates, price_filter: understood.priceFilter } : null;
    // V2 says the words are ambiguous / a possible typo: nothing is searched, the model asks
    if (plan?.type === "CLARIFY" && ["AMBIGUOUS_FOOD", "DID_YOU_MEAN", "AMBIGUOUS_PLACE"].includes(plan.reason)) {
      return { data: { catalog: [], reference: [], total_catalog: 0, total_reference: 0, needs_clarification: true, search_intelligence: reading, note: "Ask the customer which one they mean (candidates); nothing was searched." }, facts: [] };
    }
    // a place asked for by name: that place (and its records), never every place with the dish words
    if (plan?.type === "MERCHANT_OPERATION") {
      const entries = plan.groups.flat().map((m) => (m.kind === "kb" && this.knowledge ? this.knowledge.merchant(Number(String(m.id).slice(3))) : null)).filter(Boolean).map((m) => this._referenceMerchant(m));
      return { data: { catalog: [], reference: entries.slice(0, limit).map((r) => r.data), total_catalog: 0, total_reference: entries.length, search_intelligence: reading, note: "reference = information only, NOT orderable on FOOD." }, facts: entries.slice(0, limit).map((r) => r.fact) };
    }
    const dishPlan = plan && ["FOOD_DISCOVERY", "CONTEXT_DISCOVERY", "PRICE_REFINE", "UNKNOWN_PLACE"].includes(plan.type) && plan.foods?.length ? plan : null;
    // V2's budget when it read one (the customer's words); the model's numbers only when V2 found none
    if (dishPlan?.price && args.max_price == null && args.min_price == null) args = { ...args, max_price: dishPlan.price.max ?? undefined, min_price: dishPlan.price.min ?? undefined };
    // a place this turn excludes ("ngoài quán này …", Search Intelligence V2 of the customer's message) is never listed
    const excluded = new Set((ctx?.searchResult?.exclusions ?? []).filter((e) => e.type === "merchant").map((e) => String(e.id)));
    const catalog = (await this._catalogMatches(dishPlan ? dishPlan.foods.map((f) => f.said ?? f.name).join(" ") : args.query)).filter((c) => !excluded.has(c.fact.id));
    const facts = catalog.map((c) => c.fact);
    let reference = [];
    let meta = { total_reference: 0, parsed_foods: [], region: null };
    const query = dishPlan && this.knowledge?.foodQuery ? this.knowledge.foodQuery({ ...dishPlan, type: "FOOD_DISCOVERY" }, dishPlan.attributeText ?? "", text) : text;
    const k = this.agentSearch.searchFoodKnowledge(query, { limit: REFERENCE_SEARCH_LIMIT, remember: true });
    if (k.enabled) {
      reference = k.result.merchants.map((m) => this._referenceMerchant(m)).filter((r) => !excluded.has(r.fact.id));
      meta = { total_reference: k.result.totalMerchants, parsed_foods: k.result.query.foods.map((f) => f.name ?? f.entityKey), region: k.result.query.location.regionId ?? null, notes: k.result.notes };
    }
    // a stated budget keeps only products whose recorded price proves it; unpriced ones are counted, never guessed
    const budget = args.max_price || args.min_price ? { max_price: args.max_price ?? null, min_price: args.min_price ?? null, excluded_without_price: 0, excluded_out_of_range: 0 } : null;
    const within = (p) => (args.max_price ? (p.price_max ?? p.price) <= args.max_price : true) && (args.min_price ? p.price >= args.min_price : true);
    if (budget) {
      const filter = (entry) => {
        const kept = entry.data.products.filter((p) => {
          if (p.price_status !== "available" || p.price === null) {
            budget.excluded_without_price += 1;
            return false;
          }
          if (!within(p)) {
            budget.excluded_out_of_range += 1;
            return false;
          }
          return true;
        });
        return kept.length ? { ...entry, data: { ...entry.data, products: kept } } : null;
      };
      reference = reference.map(filter).filter(Boolean);
    }
    const shown = reference.slice(0, limit);
    facts.push(...shown.map((r) => r.fact));
    if (k.enabled && ctx?.session && shown.length) {
      const matchedIds = reference.map((r) => Number(r.fact.id.slice(3)));
      const context = buildKnowledgeContext({ ...k, matchedIds, result: { ...k.result, merchants: shown.map((r) => ({ id: r.fact.id })), totalMerchants: reference.length } }, { rawQuery: text, keywords: args.query });
      this.services.sessions.setKnowledgeContext(ctx.session.id, dishPlan ? { ...context, searchQuery: k.result.query } : context);
    }
    return {
      data: {
        catalog: catalog.map((c) => c.data),
        reference: shown.map((r) => r.data),
        total_catalog: catalog.length,
        total_reference: budget ? reference.length : meta.total_reference,
        query_context: { query: args.query, location: args.location ?? null, parsed_foods: meta.parsed_foods, region: meta.region, budget },
        search_intelligence: reading,
        note: "catalog = orderable on FOOD with FOOD price; reference = information only, NOT orderable on FOOD.",
      },
      facts,
    };
  }

  async searchMerchants(args, ctx) {
    const query = [args.query, args.category].filter(Boolean).join(" ");
    if (!query) return { data: { error: "QUERY_REQUIRED" }, facts: [] };
    return this.searchFood({ query, location: args.location, max_price: args.budget_max, limit: args.limit }, ctx);
  }

  async getMerchant({ merchant_id: id }) {
    const entry = await this._resolveMerchant(id);
    if (!entry) return { data: { error: "MERCHANT_NOT_FOUND", merchant_id: id }, facts: [] };
    const { products, ...merchant } = entry.data;
    return { data: { ...merchant, product_count: products.length }, facts: [{ ...entry.fact, products: [] }] };
  }

  async getMenu({ merchant_id: id }) {
    const entry = await this._resolveMerchant(id);
    if (!entry) return { data: { error: "MERCHANT_NOT_FOUND", merchant_id: id }, facts: [] };
    return { data: entry.data, facts: [entry.fact] };
  }

  async getProduct({ merchant_id: id, product_id: productId }) {
    const entry = await this._resolveMerchant(id);
    const product = entry?.data.products.find((p) => p.product_id === productId);
    if (!product) return { data: { error: "PRODUCT_NOT_FOUND", merchant_id: id, product_id: productId }, facts: [] };
    return {
      data: { merchant_id: entry.data.merchant_id, merchant_name: entry.data.merchant_name, reference_only: entry.data.reference_only, ...product },
      facts: [{ ...entry.fact, products: entry.fact.products.filter((p) => p.id === productId) }],
    };
  }

  async _resolveMerchant(id) {
    if (typeof id !== "string") return null;
    if (id.startsWith("cat:")) return this._catalogMerchant(id.slice(4));
    if (id.startsWith("kb:") && this.knowledge) {
      const m = this.knowledge.merchant(Number(id.slice(3)));
      return m ? this._referenceMerchant(m) : null;
    }
    return null;
  }

  previousResults(ctx) {
    const context = ctx?.session ? this.services.sessions.getKnowledgeContext(ctx.session.id) : null;
    if (!context) return { data: { available: false, reason: "NO_PREVIOUS_RESULTS" }, facts: [] };
    const expiresAt = new Date(Date.parse(context.touchedAt) + KNOWLEDGE_CONTEXT_TTL_MS).toISOString();
    if (!isFresh(context)) return { data: { available: false, reason: "EXPIRED", expired_at: expiresAt }, facts: [] };
    if (!this.knowledge) return { data: { available: false, reason: "KNOWLEDGE_DISABLED" }, facts: [] };
    const merchants = this.knowledge.recall(context).slice(0, PREVIOUS_LIMIT).map((m) => this._referenceMerchant(m));
    const priced = merchants.filter((m) => m.data.products.some((p) => p.price_status !== "unavailable")).length;
    return {
      data: {
        available: true,
        raw_query: context.rawQuery,
        query: context.query,
        food_keys: context.foodKeys ?? [],
        region: context.regionId ?? null,
        total: context.total,
        shown_count: context.shownCount,
        focus_merchant_id: context.focusId != null ? `kb:${context.focusId}` : null, // the place last talked about ("quán đó")
        places_with_recorded_price: priced,
        places_listed_here: merchants.length,
        created_or_used_at: context.touchedAt,
        expires_at: expiresAt,
        places: merchants.map((m) => m.data),
      },
      facts: merchants.map((m) => m.fact),
    };
  }

  customerCart(ctx) {
    if (!ctx?.customer) return { data: { carts: [] }, facts: [] };
    const carts = [];
    for (const merchant of this.services.merchantData.listAll()) {
      const cart = this.repos.carts.getActiveByCustomerAndMerchant(ctx.customer.id, merchant.merchant_id);
      if (!cart) continue;
      const items = this.repos.carts.listItems(cart.id);
      if (!items.length) continue;
      carts.push({
        merchant_id: `cat:${merchant.merchant_id}`,
        merchant_name: merchant.name,
        items: items.map((i) => ({ name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })),
        subtotal: items.reduce((s, i) => s + i.unit_price * i.quantity, 0),
      });
    }
    const facts = carts.map((c) => ({ id: c.merchant_id, name: c.merchant_name, address: null, orderable: true, openStatus: "unknown", openingHours: [], ratings: [], products: c.items.map((i, n) => ({ id: `cart:${c.merchant_id}:${n}`, name: i.name, priceStatus: "available", prices: [{ price: i.unit_price }, { price: i.unit_price * i.quantity }], orderable: true })), cartSubtotal: c.subtotal }));
    return { data: { carts }, facts };
  }
}
