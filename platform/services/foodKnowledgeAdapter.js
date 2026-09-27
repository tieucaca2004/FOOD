import { FoodDiscoveryService, openKnowledgeReadOnly } from "../knowledge/foodDiscovery.js";
import { AnswerBuilder } from "../knowledge/answer.js";
import { normalizeName } from "../knowledge/text.js";
import { buildFollowUpAnswer } from "../knowledge/followUpAnswer.js";
import { FounderKnowledgeService } from "../knowledge/founder/founderKnowledgeService.js";
import { TermRelationService } from "../knowledge/terms/termRelationService.js";
import { TermMatcher } from "../knowledge/terms/termMatcher.js";
import { termKey } from "../knowledge/terms/termNormalize.js";
import { SearchIntelligenceV2, FoodResolver, MerchantIndex, normalizeInput } from "../search/v2/index.js";
import { displayText } from "./displayText.js";

const RECALL_LIMIT = 500; // every place of a list, so a follow-up is about the whole list, not only the ones shown

// The ONLY bridge from the platform to Food Knowledge (loaded by server.js
// only when FOOD_KNOWLEDGE_DISCOVERY_ENABLED=true). Read-only in both
// directions:
//   - knowledge.db is opened read-only (it must already exist);
//   - the platform catalog is only READ, to answer "is this orderable?" —
//     through MerchantDataService / MenuService, never a repository write.
// Nothing here creates merchants, products, carts or orders.

/**
 * @param {object} deps
 * @param {string} deps.dbPath knowledge.db path
 * @param {object} deps.services platform services (merchantData, menu)
 * @param {(merchant) => boolean} deps.isRoutable the merchant router's own routability rule
 */
export function createFoodKnowledge({ dbPath, services, isRoutable }) {
  const db = openKnowledgeReadOnly(dbPath);

  // Orderable = the platform merchant is routable, its menu is visible, and
  // the product exists there and is available. Discovery data never decides it.
  const isOrderable = ({ platformMerchantId, platformProductId = null, productName = null }) => {
    const merchant = services.merchantData.getById(platformMerchantId);
    if (!merchant || !isRoutable(merchant)) return false;
    // a module with its own ordering engine (A Tiểu): a routable merchant takes orders; its products live in the
    // module's own catalog, which this read-only bridge does not see — so no PRODUCT is claimed orderable here
    if (merchant.module !== "generic") return platformProductId === null && productName === null;
    if (!services.menu.isMenuVisible(platformMerchantId)) return false;
    const products = services.menu.listProducts(platformMerchantId, { includeUnavailable: false });
    if (platformProductId !== null) return products.some((p) => p.id === platformProductId);
    if (productName !== null) return products.some((p) => normalizeName(p.name) === normalizeName(productName));
    return products.length > 0;
  };

  const discovery = new FoodDiscoveryService({ db, isOrderable });
  // Fact guard at the bridge: only places the runtime serves (candidate / verified) are ever an answer. The dish
  // search also matches products by name, which does not look at the place's own status (a rejected / duplicate /
  // closed place must never be listed, whatever its products say).
  const served = new Set(db.prepare(`SELECT id FROM kb_merchants WHERE status IN ('candidate', 'verified')`).all().map((r) => r.id));
  // Trust boundary: names and addresses in knowledge.db are DATA from outside sources. What leaves this bridge (for
  // the deterministic answers, the follow-ups, the Agent's tools) carries them as one-line display values
  // (displayText): a stored name can never start a line of its own in a reply. The stored records are not changed.
  const safeMerchant = (m) =>
    m && {
      ...m,
      name: displayText(m.name),
      location: m.location ? { ...m.location, address: m.location.address == null ? m.location.address : displayText(m.location.address) } : m.location,
      products: (m.products ?? []).map((p) => ({ ...p, name: displayText(p.name) })),
    };
  const searchServed = (input, opts = {}) => {
    const r = discovery.search(input, { ...opts, limit: RECALL_LIMIT });
    const merchants = r.merchants.filter((m) => served.has(m.id));
    return { ...r, foods: (r.foods ?? []).map((x) => ({ ...x, name: displayText(x.name) })), merchants: merchants.slice(0, opts.limit ?? 10).map(safeMerchant), totalMerchants: r.totalMerchants - (r.merchants.length - merchants.length) };
  };
  const hasTable = (name) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  let matcher = null; // the runtime DB is a read-only snapshot: one matcher per process
  let searchMatcher = null;
  let placeMatcher = null; // rebuilt when the catalog's discoverable places change
  let v2 = null; // Search Intelligence V2 planner, rebuilt when the catalog's discoverable places change
  let stats = null;
  const answers = new AnswerBuilder({ taxonomy: discovery.taxonomy });

  // Which places have a dish on record: published links, plus published products whose name contains the dish's
  // CANONICAL name as whole words (aliases are not used — unreviewed ones swallow other dishes). A one-word
  // accented name ("Cốm") is not matched by letters ("com" is also cơm): links only. Built once per snapshot.
  const foodStats = () => {
    if (stats) return stats;
    const region = new Map(
      db
        .prepare(`SELECT m.id, (SELECT l.region_id FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published' LIMIT 1) AS region_id FROM kb_merchants m WHERE m.status IN ('candidate', 'verified')`)
        .all()
        .map((r) => [r.id, r.region_id])
    );
    const byFood = new Map();
    const add = (key, merchantId) => {
      if (!region.has(merchantId)) return;
      if (!byFood.has(key)) byFood.set(key, new Set());
      byFood.get(key).add(merchantId);
    };
    for (const l of db.prepare(`SELECT food_key, kb_merchant_id FROM kb_v_food_merchant_products WHERE kb_merchant_id IS NOT NULL`).all()) add(l.food_key, l.kb_merchant_id);
    const products = db.prepare(`SELECT merchant_id, normalized_name FROM kb_merchant_products WHERE status = 'published'`).all();
    const canon = db.prepare(`SELECT key, canonical_name FROM kb_food_entities WHERE status = 'published'`).all();
    const names = canon.map((c) => ({ key: c.key, n: normalizeName(c.canonical_name), oneAccented: !c.canonical_name.trim().includes(" ") && normalizeName(c.canonical_name) !== c.canonical_name.trim().toLowerCase() }));
    for (const p of products) for (const c of names) if (!c.oneAccented && ` ${p.normalized_name} `.includes(` ${c.n} `)) add(c.key, p.merchant_id);
    // a one-word name that begins 3+ other dish names is a FAMILY ("Bún", "Bánh"), not a dish to list
    const folded = canon.map((c) => normalizeName(c.canonical_name));
    const families = new Set(folded.filter((n) => !n.includes(" ") && folded.filter((o) => o.startsWith(`${n} `)).length >= 3));
    stats = { merchantsOf: (key) => byFood.get(key) ?? new Set(), regionOf: (id) => region.get(id) ?? null, isFamily: (name) => families.has(normalizeName(name)) };
    return stats;
  };
  return {
    /**
     * @param {{limit?: number, exclude?: (merchant) => boolean, remember?: boolean}} [opts]
     *   exclude: places the caller already shows;
     *   remember: also return matchedIds — EVERY matching place in answer order — so a follow-up
     *   ("sao ko có giá?") can be answered about this list without searching again.
     */
    search(text, { exclude = null, remember = false, ...opts } = {}) {
      if (remember) {
        const limit = opts.limit ?? 10;
        const all = searchServed(text, { ...opts, limit: RECALL_LIMIT });
        const kept = exclude ? all.merchants.filter((m) => !exclude(m)) : all.merchants;
        const result = { ...all, merchants: kept.slice(0, limit), totalMerchants: kept.length };
        return { result, answer: answers.build(result), matchedIds: kept.map((m) => m.id) };
      }
      if (!exclude) {
        const result = searchServed(text, opts);
        return { result, answer: answers.build(result) };
      }
      const limit = opts.limit ?? 10;
      const wide = searchServed(text, { ...opts, limit: limit + 10 });
      const kept = wide.merchants.filter((m) => !exclude(m));
      const removed = wide.merchants.length - kept.length;
      const result = { ...wide, merchants: kept.slice(0, limit), totalMerchants: Math.max(kept.length, wide.totalMerchants - removed) };
      return { result, answer: answers.build(result) };
    },
    /** The places of a remembered list, in the order they were listed (same read-only data, same query). */
    recall({ rawQuery, matchedIds, searchQuery = null, searchIds = null }) {
      // a list of places asked for BY NAME (Search Intelligence V2): the places themselves; a structured dish
      // search: the same FoodQuery again; otherwise the original words (unchanged behaviour)
      if (Array.isArray(searchIds)) return matchedIds.map((id) => this.merchant(id)).filter(Boolean);
      const byId = new Map(searchServed(searchQuery ?? rawQuery, { limit: RECALL_LIMIT }).merchants.map((m) => [m.id, m]));
      return matchedIds.map((id) => byId.get(id)).filter(Boolean);
    },
    /** Does this message name a dish, a place or a region of its own? Then it is a new question, not a follow-up. */
    namesSomething(text) {
      const r = searchServed(text, { limit: 1 });
      return r.query.foods.length > 0 || Boolean(r.query.location.regionId) || r.notes.includes("MERCHANT_NAME") || (r.notes.includes("KIND_OF_PLACE") && r.totalMerchants > 0);
    },
    /** One reference place with ALL its published products and recorded prices (read-only; null if unknown). */
    merchant(id) {
      if (!db.prepare(`SELECT 1 FROM kb_merchants WHERE id = ? AND status IN ('candidate', 'verified')`).get(id)) return null;
      const details = discovery._merchantDetails(id);
      const products = db
        .prepare(`SELECT id, original_name FROM kb_merchant_products WHERE merchant_id = ? AND status = 'published' ORDER BY id`)
        .all(id)
        .map((p) => ({ id: p.id, name: p.original_name, foods: [], prices: discovery._latestPrice(p.id), orderable: false }));
      return safeMerchant({ ...details, products, openStatus: discovery.openStatus(details) });
    },
    /** The evidence behind a product's published prices: which source, what kind, when (read-only). */
    priceEvidence(productId) {
      return db
        .prepare(
          `SELECT x.price, x.price_max, x.variant, x.evidence_id, x.captured_at, s.url, s.domain, s.source_type
           FROM kb_product_prices x JOIN kb_evidence e ON e.id = x.evidence_id JOIN kb_sources s ON s.id = e.source_id
           WHERE x.product_id = ? AND x.status = 'published' ORDER BY x.id`
        )
        .all(productId);
    },
    /** A follow-up answer about a remembered list (see knowledge/followUpAnswer.js). */
    followUp(kind, { context, ordinal = null, targetId = null }) {
      return buildFollowUpAnswer(kind, { context, merchants: this.recall(context), ordinal, targetId, renderMerchant: (m) => answers.merchantLine(m) });
    },
    /**
     * Founder guidance in force for CUSTOMERS (APPROVED, in its validity window; never an INTERNAL_NOTE or an internal
     * item), read-only — or null when this knowledge DB has no founder knowledge (migration 006 not applied).
     */
    founderGuidance() {
      if (!hasTable("kb_founder_items")) return null;
      const fk = new FounderKnowledgeService({ db, rawRoot: null });
      return { active: ({ scope = null, scopeRef = null, type = null } = {}) => fk.getActiveApproved({ audience: "customer", scope, scopeRef, type }) };
    },
    /** The food-name matcher over APPROVED term relations (built once per snapshot), or null without migration 007. */
    termMatcher() {
      if (!hasTable("kb_term_relations")) return null;
      matcher ??= new TermRelationService({ db }).buildMatcher();
      return matcher;
    },
    /**
     * Dish-name matcher for query understanding: canonical names + APPROVED relations when migration 007 exists,
     * canonical names only otherwise (never the unreviewed kb_food_names aliases). Built once per snapshot.
     */
    searchMatcher() {
      if (hasTable("kb_term_relations")) return this.termMatcher();
      searchMatcher ??= new TermMatcher({
        canonicals: db.prepare(`SELECT id AS foodEntityId, canonical_name AS canonicalName FROM kb_food_entities WHERE status = 'published'`).all(),
        relations: [],
        regions: db.prepare(`SELECT id, name, parent_id FROM kb_regions`).all(),
        regionNames: [...db.prepare(`SELECT id AS regionId, name FROM kb_regions`).all(), ...db.prepare(`SELECT region_id AS regionId, name FROM kb_region_names`).all()],
      });
      return searchMatcher;
    },
    /**
     * Place-name matcher (reference places kb:… + discoverable catalog places cat:…), read-only, for recognizing a
     * place the customer names inside a sentence ("Bún Cá Mịn có món gì?"). A name that is only dish names,
     * everyday words or a region ("Bún cá", "Quán ăn Nha Trang") never counts as a place name.
     */
    placeMatcher() {
      const catalog = services.merchantData.listDiscoverable().map((m) => ({ id: `cat:${m.merchant_id}`, name: m.name }));
      const stamp = catalog.map((c) => c.id).join(",");
      if (placeMatcher?.stamp === stamp) return placeMatcher.matcher;
      const dishKeys = new Set(db.prepare(`SELECT canonical_name AS n FROM kb_food_entities WHERE status = 'published'`).all().map((r) => termKey(r.n)));
      const regionKeys = new Set([...db.prepare(`SELECT name AS n FROM kb_regions`).all(), ...db.prepare(`SELECT name AS n FROM kb_region_names`).all()].map((r) => termKey(r.n)));
      // what a place is called without its kind-of-place words ("Nôm Nôm Restaurant" -> "Nôm Nôm")
      const KIND = /(?<![\p{L}\p{N}])(?:restaurant|nhà hàng|quán ăn|quán|tiệm|cửa hàng|cafe|café|coffee)(?![\p{L}\p{N}])/giu;
      const core = (name) => name.replace(/^\s*\[[^\]]*\]\s*/, "").replace(KIND, " ").replace(/\s+/g, " ").trim();
      // distinctive: something is left once dish names, regions, kind-of-place words and numbers are removed
      const distinctive = (name) => {
        let rest = ` ${termKey(core(name))} `;
        for (const k of [...dishKeys, ...regionKeys].sort((a, b) => b.length - a.length)) rest = rest.split(` ${k} `).join(" ");
        return rest.split(" ").some((w) => w && !/^\d+$/.test(w));
      };
      const kb = db.prepare(`SELECT id, name FROM kb_merchants WHERE status IN ('candidate', 'verified')`).all().map((m) => ({ id: `kb:${m.id}`, name: m.name }));
      const names = [];
      for (const p of [...catalog, ...kb]) {
        const full = p.name.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
        if (!full || !distinctive(full)) continue;
        for (const n of new Set([full, core(full)])) if (n && termKey(n).includes(" ")) names.push({ foodEntityId: p.id, canonicalName: n }); // one-word names are too loose
      }
      const matcher = new TermMatcher({ canonicals: names, relations: [], resolveTypoAt: 2 });
      // the same place in the catalog and in reference data (same core name): the catalog one is authoritative
      const byName = new Map();
      for (const n of names) {
        const k = termKey(core(n.canonicalName));
        if (!byName.has(k)) byName.set(k, new Set());
        byName.get(k).add(n.foodEntityId);
      }
      const twins = new Map();
      for (const ids of byName.values()) {
        const cats = [...ids].filter((id) => id.startsWith("cat:"));
        if (cats.length === 1) for (const id of ids) if (id.startsWith("kb:")) twins.set(id, cats[0]);
      }
      placeMatcher = { stamp, matcher, twins };
      return matcher;
    },
    /** The catalog place ("cat:…") that is the same place as this reference place ("kb:…"), or null. */
    catalogTwin(kbId) {
      this.placeMatcher();
      return placeMatcher?.twins.get(kbId) ?? null;
    },
    // ------------------------------------------------------------------ Search Intelligence V2
    /** The V2 planner over this read-only snapshot (+ the catalog's discoverable places), rebuilt when those change. */
    searchIntelligence() {
      const catalog = services.merchantData.listDiscoverable().map((m) => ({ id: `cat:${m.merchant_id}`, name: m.name.replace(/^\s*\[[^\]]*\]\s*/, ""), address: m.address ?? null, kind: "catalog" }));
      const stamp = catalog.map((c) => c.id).join(",");
      if (v2?.stamp === stamp) return v2.si;
      const stats = foodStats();
      const foods = db
        .prepare(`SELECT id, key, canonical_name AS name FROM kb_food_entities WHERE status = 'published'`)
        .all()
        .map((f) => ({ ...f, name: displayText(f.name) }))
        .map((f) => ({ ...f, words: normalizeInput(f.name).tokens.map((t) => ({ lower: t.lower, folded: t.folded })), merchants: stats.merchantsOf(f.key).size }));
      const kb = db
        .prepare(
          `SELECT m.id, m.name, (SELECT l.address_original FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published' ORDER BY l.captured_at DESC, l.id DESC LIMIT 1) AS address
           FROM kb_merchants m WHERE m.status IN ('candidate', 'verified')`
        )
        .all()
        .map((m) => ({ id: `kb:${m.id}`, name: displayText(m.name), address: m.address == null ? null : displayText(m.address), kind: "kb" }));
      const byKey = new Map(foods.map((f) => [f.key, f]));
      const vocabulary = discovery.parser().vocabulary;
      const si = new SearchIntelligenceV2({
        foodResolver: new FoodResolver({ matcher: this.searchMatcher(), foods }),
        merchants: new MerchantIndex({ merchants: [...catalog, ...kb] }),
        vocabularySpans: (text) => vocabulary.match(text).matches.filter((m) => !m.ambiguous).map((m) => ({ start: m.start, end: m.start + m.text.length, concept: m.concept })),
        foodByKey: (key) => byKey.get(key) ?? null,
      });
      v2 = { stamp, si };
      return si;
    },
    /**
     * Execute a V2 dish plan: the structured FoodQuery (resolved dishes, price filter, region) + the frozen
     * parser's reading of the remaining words (attributes, sort, open-now). Read-only.
     */
    foodQuery(plan, attributeText, rawText = null) {
      const q = discovery.parser().parse(attributeText ?? "");
      // the dish as the frozen parser names it in the customer's own sentence, when it reads the same dish
      // (follow-ups quote that name: "Thêm 5 quán cho “bún cá”")
      const parsedName = new Map(rawText ? discovery.parser().parse(rawText).foods.map((f) => [f.entityKey, f.name]) : []);
      const region = plan.regionId ? db.prepare(`SELECT name FROM kb_regions WHERE id = ?`).get(plan.regionId)?.name ?? null : null;
      return {
        ...q,
        text: [...plan.foods.map((f) => f.name), region].filter(Boolean).join(" "),
        intent: "find_merchant",
        foods: plan.foods.map((f) => ({ entityKey: f.key, name: parsedName.get(f.key) ?? f.name, text: f.said ?? f.name })),
        categories: [],
        price: { ...(plan.price?.min != null ? { min: plan.price.min } : {}), ...(plan.price?.max != null ? { max: plan.price.max } : {}) },
        location: { ...(plan.regionId ? { regionId: plan.regionId } : q.location.text ? { text: q.location.text } : {}), ...(q.location.nearMe ? { nearMe: true } : {}) },
      };
    },
    /** A place card exactly as in every Food Knowledge list. */
    renderMerchant(m) {
      return answers.merchantLine(m);
    },
    regionName(id) {
      return id ? discovery.regionName(id) : null;
    },
    /** Dishes with recorded places in a region (a count of records, never a ranking of quality). */
    areaSummary({ regionId = null, excludeKeys = [], limit = 8 } = {}) {
      const stats = foodStats();
      const inside = regionId ? discovery._regionAndDescendants(regionId) : null;
      const skip = new Set(excludeKeys);
      return db
        .prepare(`SELECT key, canonical_name AS name FROM kb_food_entities WHERE status = 'published'`)
        .all()
        .filter((f) => !skip.has(f.key) && !stats.isFamily(f.name))
        .map((f) => ({ ...f, merchants: [...stats.merchantsOf(f.key)].filter((id) => !inside || inside.has(stats.regionOf(id))).length }))
        .filter((f) => f.merchants >= 2)
        .sort((a, b) => b.merchants - a.merchants || a.name.localeCompare(b.name, "vi"))
        .slice(0, limit);
    },
    close() {
      db.close();
    },
  };
}
