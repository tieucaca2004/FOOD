// SEARCH INTELLIGENCE V2 — the planner: steps 1–5 + 11 (normalize -> intent -> entities -> context -> plan,
// with confidence). Pure over a read-only snapshot; it never searches and never answers. The router executes
// the plan (steps 6–10 in FoodDiscoveryService, 12–13 in composer.js).
//
// Precedence (explainable):
//   order-like message                           -> DEFER (the ordering engines own it)
//   a place named by its own words (HIGH/MEDIUM) -> MERCHANT_OPERATION (unless the words are only a dish-name prefix)
//   a whole dish                                 -> FOOD_DISCOVERY (+ price / region / exclusion)
//   a dish-name prefix / typo                    -> CLARIFY (candidates / did-you-mean) — never broadened, never guessed
//   a name-like phrase FOOD does not know        -> UNKNOWN_PLACE
//   "có món gì" + area words / region            -> AREA_DISCOVERY
//   no entity + a fresh list                     -> CONTEXT_DISCOVERY / PRICE_REFINE / DEFER (list follow-ups)
//   no entity, no list, a question               -> CLARIFY (what dish / place)
import { normalizeInput, toneSig } from "./normalize.js";
import { detectIntent } from "./intent.js";
import { parsePriceFilter } from "./priceFilter.js";
import { wordClass } from "./lexicon.js";
import { readContext } from "./searchContext.js";
import { HIGH, MEDIUM, AMBIGUOUS, NO_MATCH } from "./merchantResolver.js";

export { FoodResolver } from "./foodResolver.js";
export { MerchantIndex } from "./merchantResolver.js";
export * as composer from "./composer.js";
export { parsePriceFilter, describePriceFilter, APPROX_TOLERANCE } from "./priceFilter.js";
export { normalizeInput } from "./normalize.js";
export { detectIntent } from "./intent.js";
export { readContext, withSearchState, withPending } from "./searchContext.js";
export { toGptContext, SEARCH_INTELLIGENCE_RULES } from "./gptContext.js";

const REFERENCE_WORDS = new Set(["do", "nay", "kia", "ay"]);
// what the customer ASKS FOR, never a place's name: "(cho tôi) danh sách / danh mục / tổng hợp (quán …)", "địa điểm (bán …)"
// — two-word phrases only (folded), so a place really called "Quán Danh" / "Tổng …" keeps its name words (FORM 11)
const REQUEST_PHRASES = new Set(["danh sach", "danh muc", "tong hop", "dia diem"]);
const REFERENCE_HEADS = new Set(["quan", "mon", "cho", "tiem", "cai"]);

// Which existing FOOD tool answers the plan (the GPT concierge's tool map; V2 decides, the model may follow)
function suggestedTool(p, r, ctx) {
  const args = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  if (["FOOD_DISCOVERY", "CONTEXT_DISCOVERY", "PRICE_REFINE"].includes(p.type)) {
    return { name: "search_food", args: args({ query: p.foods.map((f) => f.name).join(", "), location: r.location?.name ?? null, min_price: r.priceFilter?.min ?? null, max_price: r.priceFilter?.max ?? null }) };
  }
  if (p.type === "MERCHANT_OPERATION" && p.groups?.length === 1) {
    const id = p.groups[0][0].id;
    return { name: ["menu", "price", "place"].includes(p.operation) ? "get_menu" : "get_merchant", args: { merchant_id: id } };
  }
  if (p.type === "MERCHANT_OPERATION") return { name: "search_merchants", args: { query: p.said } };
  if (p.type === "DEFER" && p.reason === "LIST_FOLLOW_UP") return { name: "get_previous_knowledge_results", args: {} };
  if (p.type === "UNKNOWN_PLACE" && p.foods?.length) return { name: "search_food", args: { query: p.foods.map((f) => f.name).join(", ") } };
  return null;
}

const ORDINAL_PHRASES = new Set([
  "dau tien", "dau", "cuoi cung", "cuoi", "thu nhat", "thu hai", "thu ba", "thu tu", "thu nam",
  ...Array.from({ length: 20 }, (_, i) => `thu ${i + 1}`), ...Array.from({ length: 20 }, (_, i) => `so ${i + 1}`),
]);
const PLACE_WORD = new Set(["quán", "tiệm", "nhà", "quan", "tiem", "nha", "restaurant"]);

export class SearchIntelligenceV2 {
  /**
   * @param {{foodResolver: import("./foodResolver.js").FoodResolver, merchants: import("./merchantResolver.js").MerchantIndex,
   *          vocabularySpans?: (text: string) => {start: number, end: number}[], foodByKey?: (key: string) => object|null}} deps
   */
  constructor({ foodResolver, merchants, vocabularySpans = () => [], foodByKey = () => null }) {
    this.foods = foodResolver;
    this.merchants = merchants;
    this.vocabularySpans = vocabularySpans;
    this.foodByKey = foodByKey;
  }

  /**
   * @param {string} text
   * @param {{context?: object|null, currentMerchantId?: string|null, now?: number}} [opts]
   * @returns {object} SearchResult (see SEARCH_INTELLIGENCE_V2_ARCHITECTURE.md §9)
   */
  understand(text, { context = null, currentMerchantId = null, now = Date.now() } = {}) {
    const input = normalizeInput(text);
    const intent = detectIntent(input);
    const ctx = readContext(context, now);
    const explain = [];
    const result = {
      query: input.originalQuery,
      normalizedQuery: input.normalizedQuery,
      foldedQuery: input.foldedQuery,
      intent,
      entities: { foods: [], foodCandidates: [], suggestions: [], merchants: [], merchantGroups: [], location: null, price: null, exclusion: null },
      filters: { price: null, regionId: null },
      plan: { type: "DEFER", reason: "EMPTY" },
      matchType: null,
      confidence: NO_MATCH,
      ambiguity: null,
      contextUsed: [],
      explain,
    };
    const plan = (p, extra = {}) => {
      result.plan = p;
      Object.assign(result, extra);
      return this._finalize(result, input, ctx);
    };
    if (!input.tokens.length) return this._finalize(result, input, ctx);
    if (intent.orderLike) return plan({ type: "DEFER", reason: "ORDER" });

    // a pending "did you mean": "đúng" runs it, "không" drops it
    const pending = ctx.fresh ? ctx.si?.pendingSuggestion : null;
    if (pending && intent.yes) {
      result.contextUsed.push("pendingSuggestion");
      result.entities.foods = [pending.food];
      return plan({ type: "FOOD_DISCOVERY", foods: [pending.food], price: pending.price ?? null, regionId: pending.regionId ?? null, exclude: [], operation: "none", confirmed: true }, { matchType: "APPROVED_TYPO", confidence: HIGH });
    }
    if (pending && intent.no) return plan({ type: "CLARIFY", reason: "SUGGESTION_REJECTED", clearPending: true }, { confidence: NO_MATCH });

    // ---- spans that are not names: price, "ngoài … ra", ordinal phrases, attribute words
    const blocked = new Set();
    const tokensIn = (start, end) => input.tokens.filter((t) => t.start >= start && t.end <= end).map((t) => t.i);
    const price = parsePriceFilter(input.normalizedQuery);
    if (price) {
      tokensIn(price.index, price.index + price.length).forEach((i) => blocked.add(i));
      result.entities.price = price;
      result.filters.price = price;
    }
    const exclusionIdx = this._exclusionTokens(input);
    exclusionIdx.forEach((i) => blocked.add(i));
    this._ordinalTokens(input).forEach((i) => blocked.add(i));
    this._requestPhraseTokens(input).forEach((i) => blocked.add(i));
    // a location FOOD cannot resolve ("gần biển", "trung tâm") is a location phrase, never a place's name words
    if (intent.unsupportedArea) {
      const words = intent.unsupportedArea.split(" ");
      const f = input.tokens.map((t) => t.folded);
      for (let i = 0; i + words.length <= f.length; i++) if (words.every((w, j) => f[i + j] === w)) words.forEach((_, j) => blocked.add(i + j));
    }
    const attribute = new Set(); // attribute / ingredient / cuisine words ("cay", "hải sản", "mực"): never a place name
    const notDishStart = new Set(); // …and, except a dish FAMILY word ("bánh", "bún"), never the start of a dish name
    for (const s of this.vocabularySpans(input.normalizedQuery)) {
      for (const i of tokensIn(s.start, s.end)) {
        attribute.add(i);
        if (!/^facet:(?:lexical_family|carb_base)$/.test(s.concept ?? "")) notDishStart.add(i);
      }
    }

    // ---- entities
    const food = this.foods.resolve(input, blocked);
    let exclude = [];
    if (exclusionIdx.length) {
      const ex = this.foods.resolve(input, new Set(input.tokens.map((t) => t.i).filter((i) => !exclusionIdx.includes(i))));
      exclude = ex.foods.map((f) => ({ type: "food", key: f.key, name: f.name }));
      const exWords = exclusionIdx.map((i) => input.tokens[i].folded).join(" ");
      if (intent.exclusion.current || /(?:^| )(?:quan|cho|tiem) (?:nay|do|kia)(?= |$)/.test(exWords)) if (currentMerchantId) exclude.push({ type: "merchant", id: currentMerchantId });
      explain.push(`excluded: ${exclusionIdx.map((i) => input.tokens[i].original).join(" ")}`);
    } else if (intent.exclusion.current && currentMerchantId) exclude.push({ type: "merchant", id: currentMerchantId });
    result.entities.exclusion = exclude;
    const regionId = food.regions[0]?.regionId ?? null;
    if (regionId) {
      result.entities.location = { regionId, name: food.regions[0].name };
      result.filters.regionId = regionId;
    }
    const regionIdx = new Set(food.regions.flatMap((r) => r.tokens));
    const foodIdx = new Set([...food.foods, ...food.candidates, ...food.suggestions].flatMap((f) => f.tokens));
    // "<place> có / bán <dish> (không)": what follows "có" is the product asked about, not part of the place's name
    const asksProductOf = this._productQuestionSplit(input, blocked, regionIdx);
    if (asksProductOf !== null) {
      const words = input.tokens.slice(asksProductOf + 1).filter((t) => wordClass(t) !== "dropped").map((t) => t.original);
      if (words.length) result.entities.product = { said: words.join(" ") }; // the product asked about a named place
    }
    const required = [];
    const soft = [];
    const optional = [];
    for (const t of input.tokens) {
      if (blocked.has(t.i) || regionIdx.has(t.i) || (asksProductOf !== null && t.i > asksProductOf)) continue;
      if (foodIdx.has(t.i) || attribute.has(t.i)) soft.push(t);
      else if (wordClass(t) === "required") required.push(t);
      else if (wordClass(t) === "optional") optional.push(t);
    }
    explain.push(`name words: required=[${required.map((t) => t.original)}] soft=[${soft.map((t) => t.original)}] optional=[${optional.map((t) => t.original)}]`);
    let merchant = this.merchants.resolve({ required, soft, optional });
    let nameWords = required;
    // typed without accents, a filler-looking word may be a name word ("pho hong", "co ba"): retry with it
    const promotable = optional.filter((t) => t.folded.length >= 2);
    if (merchant.confidence === NO_MATCH && (required.length || soft.length) && promotable.length) {
      const promoted = [...required, ...promotable].sort((a, b) => a.i - b.i);
      const retry = this.merchants.resolve({ required: promoted, soft, optional: [] });
      if (retry.confidence === HIGH) {
        merchant = retry;
        nameWords = promoted;
        explain.push(`unaccented words ${promotable.map((t) => `"${t.original}"`).join(", ")} read as part of a place name`);
      }
    }
    // words that BEGIN dish names ("Kem", "Bơ", "Nước" in "Vfruit Kem Bơ & Nước Ép") may describe the place rather
    // than name it: retry with them as dish words — never better than MEDIUM
    if (merchant.confidence === NO_MATCH && required.length > 1) {
      const dishy = required.filter((t) => this._startsDishName(t));
      const rest = required.filter((t) => !dishy.includes(t));
      if (dishy.length && rest.length) {
        const retry = this.merchants.resolve({ required: rest, soft: [...soft, ...dishy], optional });
        if (retry.confidence === HIGH || retry.confidence === MEDIUM) {
          merchant = { ...retry, confidence: MEDIUM };
          nameWords = rest;
          explain.push(`${dishy.map((t) => `"${t.original}"`).join(", ")} read as dish words next to the name: MEDIUM only`);
        }
      }
    }
    if (merchant.corrected) explain.push(`place word "${merchant.corrected.said}" read as "${merchant.corrected.as}" (one-letter slip): MEDIUM only`);
    const dishPrefix = nameWords.length > 0 && this._isDishPrefix(input, food, nameWords);
    if (merchant.confidence !== NO_MATCH && !dishPrefix) {
      const saidIdx = [...soft.map((t) => t.i), ...nameWords.map((t) => t.i)].sort((a, b) => a - b);
      const said = input.tokens.slice(saidIdx[0], saidIdx.at(-1) + 1).filter((t) => wordClass(t) !== "dropped" && !blocked.has(t.i)).map((t) => t.original).join(" ");
      result.entities.merchants = merchant.candidates;
      result.entities.merchantGroups = merchant.groups;
      explain.push(`place: ${merchant.candidates.map((c) => `${c.id} ${c.name}`).join("; ")} (${merchant.confidence})`);
      // a CATALOG place among them: the catalog is the source of truth for places FOOD serves — its own path answers
      if (merchant.candidates.some((c) => c.kind === "catalog")) return plan({ type: "DEFER", reason: "CATALOG_PLACE" }, { confidence: merchant.confidence, matchType: "EXACT_MERCHANT" });
      const groups = merchant.groups.map((g) => g.filter((c) => c.kind === "kb")).filter((g) => g.length);
      if (merchant.confidence === AMBIGUOUS) return plan({ type: "CLARIFY", reason: "AMBIGUOUS_PLACE", said, groups }, { confidence: AMBIGUOUS, ambiguity: { kind: "merchant", count: groups.length }, matchType: "TOKEN_MATCH" });
      const operation = intent.operation === "none" || intent.operation === "more" ? "place" : intent.operation;
      return plan({ type: "MERCHANT_OPERATION", operation, groups, said }, { confidence: merchant.confidence, matchType: merchant.confidence === HIGH ? "EXACT_MERCHANT" : "TOKEN_MATCH" });
    }

    // ---- shortened dish names (after place names, so a place's own words are never a dish prefix)
    this.foods.applyPrefixes(input, food, notDishStart);
    result.entities.foods = food.foods;
    result.entities.foodCandidates = food.candidates;
    result.entities.suggestions = food.suggestions;
    const leftover = required.filter((t) => !food.used.has(t.i));
    // what is left for the attribute reader (spice, cheap, open now …): no dish, price, region, exclusion or list words
    const attributeText = input.tokens.filter((t) => !food.used.has(t.i) && !regionIdx.has(t.i)).map((t) => t.original).join(" ");
    const operationAsksPlace = ["address", "hours", "menu"].includes(intent.operation);
    // a name the customer asks about as a PLACE: an operation on it ("… ở đâu"), a place word before it ("quán X"), or
    // a capitalized name next to a dish ("Union Pizza") — a capitalized phrase alone ("lịch sử La Mã") is not a place
    const dishNamed = food.foods.length > 0 || food.candidates.length > 0 || food.suggestions.length > 0;
    const nameLike = leftover.map((t) => t.folded).join("").length >= 3 && (operationAsksPlace || (dishNamed && leftover.some((t) => /^\p{Lu}/u.test(t.original) && t.i > 0)) || leftover.some((t) => t.i > 0 && PLACE_WORD.has(input.tokens[t.i - 1].lower)));
    // a place asked for by a name FOOD does not know is said as such — before any dish reading of its words
    if (nameLike) {
      // the whole name as typed: the unbroken run of non-filler words around the unknown words
      const named = (i) => !blocked.has(i) && !regionIdx.has(i) && wordClass(input.tokens[i]) !== "dropped";
      let a = leftover[0].i;
      let b = leftover.at(-1).i;
      while (a > 0 && named(a - 1)) a -= 1;
      while (b < input.tokens.length - 1 && named(b + 1)) b += 1;
      const name = input.tokens.slice(a, b + 1).map((t) => t.original).join(" ");
      explain.push(`"${name}" names no place FOOD knows`);
      return plan({ type: "UNKNOWN_PLACE", name, foods: food.foods, price, regionId, exclude, attributeText: "" }, { confidence: NO_MATCH });
    }
    if (food.foods.length) {
      const f = food.foods;
      explain.push(`dish: ${f.map((x) => `${x.name} (${x.matchType})`).join(", ")}`);
      return plan({ type: "FOOD_DISCOVERY", foods: f, price, regionId, exclude, operation: intent.operation, attributeText }, { matchType: f[0].matchType, confidence: f.every((x) => x.matchType !== "APPROVED_TYPO") ? HIGH : MEDIUM });
    }
    if (food.candidates.length) {
      const c = food.candidates[0];
      return plan({ type: "CLARIFY", reason: "AMBIGUOUS_FOOD", said: c.said, options: c.options }, { confidence: AMBIGUOUS, ambiguity: { kind: "food", count: c.options.length }, matchType: c.reason === "TYPO_CANDIDATES" ? "CONTROLLED_FUZZY" : "TOKEN_MATCH" });
    }
    if (food.suggestions.length) {
      const s = food.suggestions[0];
      return plan({ type: "CLARIFY", reason: "DID_YOU_MEAN", said: s.said, food: s.food, pending: { food: { id: s.food.id, key: s.food.key, name: s.food.name }, price, regionId } }, { confidence: MEDIUM, matchType: s.reason === "PREFIX" ? "TOKEN_MATCH" : "CONTROLLED_FUZZY" });
    }

    // ---- no dish, no place
    const areaAsk = intent.area || (regionId && intent.operation === "menu") || (exclude.some((e) => e.type === "food") && intent.operation === "menu");
    // areaAsk: "có món gì" about an area -> the dish summary of the data; otherwise only a location FOOD cannot use
    if (areaAsk) return plan({ type: "AREA_DISCOVERY", areaAsk: true, regionId, nearMe: intent.nearMe || intent.proximity, unsupportedArea: intent.unsupportedArea, exclude }, { confidence: HIGH });
    if (intent.unsupportedArea || intent.nearMe) return plan({ type: "AREA_DISCOVERY", areaAsk: false, regionId, nearMe: intent.nearMe || intent.proximity, unsupportedArea: intent.unsupportedArea, exclude }, { confidence: MEDIUM });
    if (ctx.fresh) {
      const inherited = ctx.food ? (ctx.food.id ? ctx.food : this.foodByKey(ctx.food.key)) : null;
      if (price && inherited) {
        result.contextUsed.push("currentFoodEntity");
        return plan({ type: "PRICE_REFINE", foods: [inherited], price, regionId: regionId ?? ctx.si?.currentFilters?.regionId ?? ctx.context?.regionId ?? null, exclude, operation: "none" }, { confidence: HIGH, matchType: "ENTITY_RELATION" });
      }
      // "quán nào bán?" — or "quán nào khác?" when no list was shown yet — asks for the places of the conversation's dish
      if (intent.askPlaces && (intent.operation === "none" || (intent.operation === "more" && !ctx.hasList)) && inherited && intent.ordinal === null && !intent.reference) {
        result.contextUsed.push("currentFoodEntity");
        return plan({ type: "CONTEXT_DISCOVERY", foods: [inherited], price: ctx.si?.currentFilters?.price ?? null, regionId: ctx.si?.currentFilters?.regionId ?? ctx.context?.regionId ?? null, exclude, operation: "none" }, { confidence: HIGH, matchType: "ENTITY_RELATION" });
      }
      if (ctx.hasList) return plan({ type: "DEFER", reason: "LIST_FOLLOW_UP" });
    }
    if (price) return plan({ type: "CLARIFY", reason: "ASK_DISH", price });
    if (intent.operation !== "none" || intent.reference || intent.askPlaces || food.contextReference) return plan({ type: "CLARIFY", reason: "NO_CONTEXT", operation: intent.operation });
    return plan({ type: "DEFER", reason: "NOTHING_RESOLVED" });
  }

  // The SearchResult contract as every consumer reads it (router, GPT context, tests): derived from the plan —
  // nothing here is a new interpretation.
  _finalize(result, input, ctx) {
    const p = result.plan;
    const e = result.entities;
    const food = (f) => ({ id: f.id ?? null, key: f.key, name: f.name, said: f.said ?? null, matchType: f.matchType ?? null });
    const refs = input.tokens.filter((t, i) => REFERENCE_WORDS.has(t.folded) && (i === 0 || REFERENCE_HEADS.has(input.tokens[i - 1].folded) || input.tokens.length <= 2)).map((t) => {
      const head = input.tokens[t.i - 1];
      return head && REFERENCE_HEADS.has(head.folded) ? `${head.original} ${t.original}` : t.original;
    });
    const planFoods = p.foods ?? [];
    result.originalQuery = result.query;
    result.foodEntities = (planFoods.length ? planFoods : e.foods).map(food);
    result.foodCandidates = [...e.foodCandidates.map((c) => ({ said: c.said, options: c.options.map((o) => o.name), reason: c.reason })), ...e.suggestions.map((s) => ({ said: s.said, options: [s.food.name], reason: `DID_YOU_MEAN:${s.reason}` }))];
    const groups = p.groups ?? [];
    result.merchant = p.type === "MERCHANT_OPERATION" && groups.length === 1 ? { ids: groups[0].map((m) => m.id), name: groups[0][0].name, address: groups[0][0].address ?? null } : null;
    result.merchantCandidates = groups.map((g) => ({ ids: g.map((m) => m.id), names: [...new Set(g.map((m) => m.name))], address: g[0].address ?? null }));
    result.product = e.product ?? null;
    result.location = e.location;
    result.priceFilter = result.filters.price ? { kind: result.filters.price.kind, min: result.filters.price.min, max: result.filters.price.max, target: result.filters.price.target } : null;
    result.exclusions = e.exclusion ?? [];
    result.followUp = p.type === "DEFER" && p.reason === "LIST_FOLLOW_UP" ? { operation: result.intent.operation, ordinal: result.intent.ordinal, reference: result.intent.reference } : null;
    result.conversationalReferences = refs;
    result.currentContextUsed = result.contextUsed;
    result.searchQuery = planFoods.length ? { foods: planFoods.map((f) => f.key), price: result.priceFilter, regionId: p.regionId ?? null, exclude: (p.exclude ?? []).map((x) => x.key ?? x.id) } : null;
    result.explanation = result.explain;
    result.recovery =
      p.type === "UNKNOWN_PLACE" ? { action: planFoods.length || p.foods?.length ? "SAY_UNKNOWN_THEN_SHOW_DISH" : "SAY_UNKNOWN", name: p.name }
      : p.type === "CLARIFY" ? { action: "ASK_ONE_QUESTION", reason: p.reason }
      : p.type === "AREA_DISCOVERY" && (p.nearMe || p.unsupportedArea) ? { action: "SAY_NO_COORDINATES" }
      : null;
    result.suggestedTool = suggestedTool(p, result, ctx);
    return result;
  }

  // index of the "có"/"bán" that separates a NAME before it from the product asked after it; null otherwise
  _productQuestionSplit(input, blocked, regionIdx) {
    const t = input.tokens;
    const k = t.findIndex((x, i) => i > 0 && (x.lower === "có" || x.lower === "bán" || (!x.accented && (x.folded === "co" || x.folded === "ban"))));
    if (k < 0) return null;
    const before = t.slice(0, k).filter((x) => !blocked.has(x.i) && !regionIdx.has(x.i) && wordClass(x) === "required");
    const after = t.slice(k + 1).filter((x) => !blocked.has(x.i) && wordClass(x) !== "dropped");
    return before.length && after.length ? k : null;
  }

  _startsDishName(t) {
    this._firstWords ??= this.foods.foods.map((f) => f.words[0]).filter(Boolean);
    return this._firstWords.some((w) => (t.accented ? toneSig(t.lower) === toneSig(w.lower) : t.folded === w.folded));
  }

  // "ngoài <X> ra": the tokens from "ngoài" to "ra"
  _exclusionTokens(input) {
    const t = input.tokens;
    const start = t.findIndex((x) => x.folded === "ngoai");
    if (start < 0) return [];
    const end = t.findIndex((x, i) => i > start && x.folded === "ra");
    if (end > start) return t.slice(start, end + 1).map((x) => x.i);
    // "ngoài quán này / chỗ đó …" without "ra": the place reference right after "ngoài"
    if (/^(?:quan|cho|tiem)$/.test(t[start + 1]?.folded ?? "") && /^(?:nay|do|kia|ay)$/.test(t[start + 2]?.folded ?? "")) return [start, start + 1, start + 2].map((k) => t[k].i);
    return [];
  }

  // "quán đầu tiên", "quán thứ 2", "quán cuối": list positions, never name words
  /** Token indexes of list / discovery request phrases ("danh sách", "danh mục", "tổng hợp", "địa điểm"). */
  _requestPhraseTokens(input) {
    const f = input.tokens.map((t) => t.folded);
    const out = [];
    for (let i = 0; i + 1 < f.length; i++) if (REQUEST_PHRASES.has(`${f[i]} ${f[i + 1]}`)) out.push(input.tokens[i].i, input.tokens[i + 1].i);
    return out;
  }

  _ordinalTokens(input) {
    const t = input.tokens;
    const f = t.map((x) => x.folded);
    for (let i = 0; i < t.length; i++) {
      const place = /^(?:quan|cho|tiem)$/.test(f[i]);
      const from = place ? i + 1 : i;
      for (const len of [2, 1]) {
        const phrase = f.slice(from, from + len).join(" ");
        if (f.slice(from, from + len).length !== len) continue;
        // a lone "đầu" / "cuối" / "thứ N" is a position only right after a place word
        const ok = ORDINAL_PHRASES.has(phrase) && (place || len === 2 || /^\d+$/.test(f[from + 1] ?? ""));
        if (ok && (place || len === 2)) return t.slice(i, from + len).map((x) => x.i);
      }
    }
    return [];
  }

  // the dish words + the remaining words together only BEGIN a dish name ("bún bò", "bun bo"): a dish question,
  // not a place (places named "Bún bò …" are found through the dish, not by these two words)
  _isDishPrefix(input, food, required) {
    const idx = [...food.foods.flatMap((f) => f.tokens), ...required.map((t) => t.i)].sort((a, b) => a - b);
    if (!idx.length || idx.at(-1) - idx[0] + 1 !== idx.length) return false;
    const typed = idx.map((i) => input.tokens[i]);
    return this.foods.foods.some((f) => f.words.length > typed.length && typed.every((t, k) => (t.accented ? toneSig(t.lower) === toneSig(f.words[k].lower) : t.folded === f.words[k].folded)));
  }
}
