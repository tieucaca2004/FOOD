import crypto from "node:crypto";
import { GptFoodConcierge } from "./GptFoodConcierge.js";
import { createFoodToolRegistry } from "./toolRegistry.js";

// Knowledge layers for the GPT concierge, each behind its own flag (both OFF by default):
//   FOUNDER_KNOWLEDGE_ENABLED     founder guidance (FK-1): APPROVED, in its validity window, audience customer, in scope,
//                                 POLICY / ADVICE_STYLE / FAQ / FOOD_RECOMMENDATION only — an INTERNAL_NOTE never leaves.
//                                 Guidance is FOOD's advice, NEVER a fact: catalog > Food Knowledge facts > guidance.
//   FOOD_ALIAS_KNOWLEDGE_ENABLED  dish-name recognition over APPROVED term relations only (no learning from customers).
//   (search)                      Search Intelligence V2 is the ONE reading of a message for every path: the base
//                                 concierge always gives its SearchResult to the model as CONTEXT.search_intelligence
//                                 (GptFoodConcierge). SEARCH_INTELLIGENCE_ENABLED no longer selects a second reader —
//                                 the earlier search_intent (platform/search/searchIntent.js) is not used by GPT.
// Pipeline per turn: normalize -> alias / canonical match -> ambiguity check -> GPT reasoning -> tools -> Fact Guard.
// Everything here is READ-ONLY; the base concierge (GPT-2) and its system prompt are used unchanged — the layers only
// add context, two tools and a pre-GPT ambiguity question. Logs carry ids, versions and hashes, never text.

export const GUIDANCE_TYPES = ["POLICY", "ADVICE_STYLE", "FAQ", "FOOD_RECOMMENDATION"];
const CONTEXT_TYPES = ["POLICY", "ADVICE_STYLE"]; // always relevant: given in CONTEXT; FAQ / recommendations via the tool

const GUIDANCE_RULES =
  'business_guidance is FOOD\'s own advice, never a fact: never use it to state a price, address, opening hours, availability, delivery or orderability. Tool facts (FOOD catalog first, then Food Knowledge) always win over guidance. Introduce any recommendation that uses guidance with the words "FOOD gợi ý" (after "Dạ" put a comma: "Dạ, FOOD gợi ý …"). Never mention founders, internal notes or where guidance comes from. For FAQs or dish recommendations call get_business_guidance.';
const FOOD_TERMS_RULES =
  "food_terms comes from FOOD's approved dish-name list. recognized: the customer's words name that canonical dish — search with the canonical name. ambiguous: ask which dish they mean, never choose. did_you_mean: a POSSIBLE typo only — ask \"Có phải anh/chị muốn tìm <canonical_name>?\" before searching; never treat it as the dish. related: a related dish or ingredient, NOT the same dish. context_reference: \"món đó / món này\" means the conversation's previous results, not a dish name. Never say two names are the same dish unless food_terms or resolve_food_name says so.";

// What each kind of information is — given to the model with the layers, so it never mixes them up.
export const KNOWLEDGE_KINDS = {
  MERCHANT_FACT: "FOOD catalog results (ids cat:…): what FOOD can order and its current prices. Wins over everything.",
  FOOD_FACT: "Food Knowledge results (ids kb:…): recorded reference facts with source and date; not orderable.",
  CANONICAL_ENTITY: "food_terms / resolve_food_name: which dish the customer's words name. Identifies a dish only — never a price, menu, place or address.",
  FOUNDER_GUIDANCE: "business_guidance / get_business_guidance: FOOD's advice on how to help. Never a fact; facts win over it.",
  CUSTOMER_CONTEXT: "previous_list / focus_id / cart: what this conversation already showed or holds. \"món đó / quán đó\" point here.",
  RECOMMENDATION: "your suggestion; when it uses founder guidance, introduce it with \"FOOD gợi ý\". Never state it as a fact.",
};

// the seventh kind, in the legend only when the customer-contributions layer is on (the frozen legend is unchanged otherwise)
export const CONTRIBUTION_KIND = {
  USER_CONTRIBUTED_UNVERIFIED_EVIDENCE:
    "get_user_contributions (ids ic:…): what a customer SENT (photo / text), not verified. Only ever attributed (\"Ảnh menu bạn gửi có ghi …\" / \"Theo ảnh một khách gửi … (chưa xác minh)\"); never the place's current menu / price; catalog and Food Knowledge facts win.",
};

const CONTRIBUTION_RULES =
  'items are USER_CONTRIBUTED_UNVERIFIED_EVIDENCE — what customers sent (a photo or a message), NOT verified by FOOD. Never state them as a fact about the place ("Quán hiện bán …", "giá hiện tại", "giá chính thức"). Attribute every value in the same sentence: own_contribution=true -> "Ảnh menu bạn gửi có ghi <món> <giá>"; otherwise -> "Theo ảnh một khách gửi ngày dd/mm (chưa xác minh), …". A FOOD catalog (cat:) or Food Knowledge price always comes first and wins; say both when they differ. Never use them for orderability, ranking, opening status or a budget filter. Never mention who sent them.';

/** Stable short hash of the guidance versions used (what the log records instead of the text). */
export function guidanceHash(items) {
  const basis = [...items].sort((a, b) => a.id - b.id).map((i) => [i.id, i.lineageId, i.version, i.body]);
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/**
 * The layers the flags ask for AND the knowledge DB supports (a DB without migration 006 / 007 leaves that layer off).
 * @returns {{founder: {active: Function}|null, matcher: object|null, unavailable: string[]}}
 */
export function createKnowledgeLayers({ tools, founder = false, alias = false, search = false, contributions = null }) {
  const knowledge = tools.knowledge;
  const unavailable = [];
  const pick = (on, name, fn) => {
    if (!on) return null;
    try {
      const v = knowledge ? fn() : null;
      if (!v) unavailable.push(name);
      return v ?? null;
    } catch {
      unavailable.push(name);
      return null;
    }
  };
  return {
    founder: pick(founder, "founder_knowledge", () => knowledge.founderGuidance?.()),
    matcher: pick(alias, "food_alias_knowledge", () => knowledge.termMatcher?.()),
    search: pick(search, "search_intelligence", () => (knowledge.searchIntelligence ? { v2: true } : null)),
    // customer contributions (USER_CONTRIBUTIONS_ENABLED): read-only retrieval of unverified candidates
    contributions: contributions ?? null,
    unavailable,
  };
}

// customer-facing guidance only, whatever the source returns (belt and braces over getActiveApproved)
const customerGuidance = (items) => items.filter((i) => i.audience === "customer" && GUIDANCE_TYPES.includes(i.type));

function guidanceInScope(founder, { merchantId = null, regionId = null, types = GUIDANCE_TYPES } = {}) {
  const seen = new Map();
  const add = (list) => list.forEach((i) => seen.set(i.id, i));
  add(founder.active({ scope: "global" }));
  if (merchantId) add(founder.active({ scope: "merchant", scopeRef: merchantId }));
  if (regionId) add(founder.active({ scope: "region", scopeRef: regionId }));
  return customerGuidance([...seen.values()]).filter((i) => types.includes(i.type)).sort((a, b) => b.priority - a.priority || a.id - b.id);
}

const shapeGuidance = (i) => ({ guidance_id: `fk:${i.id}`, kind: "FOUNDER_GUIDANCE", type: i.type, title: i.title, text: i.body });

function shapeTerms(r) {
  return {
    status: r.status,
    recognized: r.matches.map((m) => ({ said: m.text, canonical_name: m.canonicalName, relation: m.relationType, ...(m.regionMatch ? { region_match: m.regionMatch } : {}), ...(m.typo ? { typed_as: m.typo.kind } : {}) })),
    ambiguous: r.ambiguous.map((a) => ({ said: a.text, candidates: a.candidates.map((c) => c.canonicalName), ...(a.fuzzy ? { possible_typo: true } : {}) })),
    did_you_mean: r.suggestions.map((s) => ({ said: s.text, canonical_name: s.canonicalName, ...(s.typo ? { typo: s.typo.kind, confidence: s.typo.confidence } : {}) })),
    related: r.related.map((x) => ({ said: x.text, related_dish: x.canonicalName })),
    region_modifiers: r.modifiers.filter((m) => m.type === "region").map((m) => m.name),
    context_reference: r.contextReference,
  };
}

const logGuidance = (logger, where, session, items) =>
  items.length && logger?.info("AI", "founder guidance used", { where, sessionId: session?.id ?? null, items: items.map((i) => ({ id: i.id, lineageId: i.lineageId, version: i.version, type: i.type })), hash: guidanceHash(items) });

/** The GPT-2 tool registry plus the read-only tools of the layers that are on. */
export function createKnowledgeAwareRegistry(foodTools, layers, { logger = null } = {}) {
  const registry = createFoodToolRegistry(foodTools);
  if (layers.founder) {
    registry.register({
      name: "get_business_guidance",
      description:
        "FOOD's approved business guidance for customers (policies, advice style, FAQs, dish suggestions). It is advice, never a fact about prices, addresses, hours or orderability; introduce a recommendation from it with \"FOOD gợi ý\".",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string", enum: GUIDANCE_TYPES },
          merchant_id: { type: "string", maxLength: 64 },
          region_id: { type: "string", maxLength: 128 },
        },
        required: [],
      },
      handler: async (args, ctx) => {
        const items = guidanceInScope(layers.founder, { merchantId: args.merchant_id ?? null, regionId: args.region_id ?? null, types: args.topic ? [args.topic] : GUIDANCE_TYPES });
        logGuidance(logger, "tool", ctx?.session, items);
        return {
          data: { kind: "FOUNDER_GUIDANCE", is_fact: false, items: items.map(shapeGuidance), guidance_version: items.length ? guidanceHash(items) : null, rules: GUIDANCE_RULES },
          facts: items.map((i) => ({ kind: "guidance", id: `fk:${i.id}`, type: i.type, version: i.version })),
        };
      },
    });
  }
  if (layers.contributions) {
    registry.register({
      name: "get_user_contributions",
      description:
        "What customers SENT FOOD (menu photos / messages) about a place or dish: USER_CONTRIBUTED_UNVERIFIED_EVIDENCE, never verified facts. Use after the catalog / knowledge tools, e.g. when a place has no recorded price or the customer asks about their own photo.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          merchant_id: { type: "string", maxLength: 64 },
          food: { type: "string", maxLength: 120 },
          field: { type: "string", enum: ["price", "product", "address", "opening_hours"] },
        },
        required: [],
      },
      handler: async (args, ctx) => {
        const svc = layers.contributions;
        const who = svc.identity(ctx?.customer, null);
        const senderHash = who ? svc.hasher.user(who.channel, who.userId) : null;
        const rows = svc.contributionsFor({ text: args.food ?? "", session: ctx?.session, senderHash, merchantIds: args.merchant_id ? [args.merchant_id] : [], field: args.field ?? null, limit: 5 });
        const items = svc.forModel(rows);
        return {
          data: { kind: "USER_CONTRIBUTED_UNVERIFIED_EVIDENCE", verified: false, items, rules: CONTRIBUTION_RULES },
          facts: items.map((i) => ({ kind: "contribution", id: i.contribution_id, field: i.field, value: i.value, value_max: i.value_max, display_line: i.display_line, own: i.own_contribution })),
        };
      },
    });
  }
  if (layers.matcher) {
    registry.register({
      name: "resolve_food_name",
      description: "Recognize dish names in the customer's words using FOOD's APPROVED dish-name list (aliases, spellings, regional names). Returns canonical dish names, or the candidates when a name is ambiguous.",
      inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 200 } }, required: ["text"] },
      handler: async (args) => {
        const r = layers.matcher.match(args.text);
        return {
          data: { kind: "CANONICAL_ENTITY", ...shapeTerms(r), rules: FOOD_TERMS_RULES },
          facts: r.matches.map((m) => ({ kind: "alias", term: m.text, canonical: m.canonicalName, relationType: m.relationType })),
        };
      },
    });
  }
  return registry;
}

/**
 * GPT-2 concierge + knowledge layers. Same model loop, same Fact Guard, same system prompt; adds the layers'
 * context and asks back BEFORE any model call when a dish name is ambiguous.
 */
export class KnowledgeAwareConcierge extends GptFoodConcierge {
  constructor({ layers, ...deps }) {
    super({ ...deps, registry: deps.registry ?? createKnowledgeAwareRegistry(deps.tools, layers, { logger: deps.logger }) });
    this.layers = layers;
    this.turns = new WeakMap(); // session -> this turn's term analysis (read synchronously by _contextSummary)
  }

  async respond(req) {
    const terms = this.layers.matcher && req.text ? this.layers.matcher.match(String(req.text)) : null;
    if (terms && this.enabled() && terms.status === "ambiguous" && !terms.matches.length) return this._askWhichDish(req, terms);
    if (req.session && terms) this.turns.set(req.session, { terms });
    try {
      return await super.respond(req);
    } finally {
      if (req.session) this.turns.delete(req.session);
    }
  }

  // ambiguity check: a name that approved relations give to several dishes is never resolved by the model
  _askWhichDish(req, terms) {
    const a = terms.ambiguous[0];
    const names = a.candidates.map((c) => c.canonicalName);
    const text = `Dạ “${a.text}” có thể là ${names.slice(0, -1).join(", ")} hoặc ${names.at(-1)} ạ. Anh/chị muốn tìm món nào?`;
    const meta = { model: null, intent: req.reason, reason: req.reason, sessionId: req.session?.id ?? null, mode: "alias_clarify", fallback: false, modelCalls: 0, tools: [], candidates: a.candidates.map((c) => c.foodEntityId) };
    this.logger?.info("AI", "gpt concierge turn", meta);
    return { text, meta };
  }

  _contextSummary(session, opts = {}) {
    const context = super._contextSummary(session, opts);
    context.knowledge_kinds = this.layers.contributions ? { ...KNOWLEDGE_KINDS, ...CONTRIBUTION_KIND } : KNOWLEDGE_KINDS;
    if (this.layers.founder) {
      const merchantId = context.current_merchant_id ?? null;
      const items = guidanceInScope(this.layers.founder, { merchantId, types: CONTEXT_TYPES });
      logGuidance(this.logger, "context", session, items);
      const more = guidanceInScope(this.layers.founder, { merchantId, types: ["FAQ", "FOOD_RECOMMENDATION"] }).length;
      context.business_guidance = { items: items.map(shapeGuidance), more_via_tool: more, guidance_version: items.length ? guidanceHash(items) : null, rules: GUIDANCE_RULES };
    }
    const turn = session ? this.turns.get(session) : null;
    if (turn?.terms) context.food_terms = { ...shapeTerms(turn.terms), rules: FOOD_TERMS_RULES };
    return context;
  }
}
