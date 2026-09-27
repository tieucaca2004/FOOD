// SEARCH INTELLIGENCE V2 -> GPT concierge: the structured context the model receives about THIS message (pure).
// It is FOOD's own reading of the words — the model must not re-interpret the dish, the place, the price filter or
// the references. It carries ids and names FOOD resolved, never prices or menus (those come from the tools).

export const SEARCH_INTELLIGENCE_RULES = [
  "search_intelligence is FOOD's reading of this message (dish, place, price filter, location, references, context). Do not re-interpret it and do not search other words than it gives.",
  "plan FOOD_DISCOVERY / CONTEXT_DISCOVERY / PRICE_REFINE: call suggested_tool (search_food) with its args as given; the price filter is the customer's budget, never a price fact; places without a recorded price never fit it.",
  "plan MERCHANT_OPERATION: the place is resolved (entities.merchant, ids kb:… / cat:…): call suggested_tool for it; never answer about another place with a similar name. confidence MEDIUM_CONFIDENCE: say it may not be the exact place asked about.",
  "plan CLARIFY: ask ONE short question using candidates (which dish / which place / confirm a possible typo) — no search, no list, no guess.",
  "plan UNKNOWN_PLACE: FOOD has no data about that name; say so first, never describe it; recovery may show places for the dish instead.",
  "plan AREA_DISCOVERY or recovery SAY_NO_COORDINATES: FOOD has no coordinates — never say how near or far anything is.",
  "context.references (\"quán đó\", \"món này\", \"quán thứ 2\") point to the conversation's previous list / focus — never search them as words. follow_up: read get_previous_knowledge_results.",
  "intent.order_like: an order for the place the customer is in — never a search.",
].join(" ");

const place = (g) => ({ ids: g.ids, names: g.names ?? [g.name], address: g.address ?? null });

/**
 * @param {object} r SearchResult (SearchIntelligenceV2.understand)
 * @param {object|null} results what the deterministic retrieval found for this plan (ids / counts only)
 */
export function toGptContext(r, results = null) {
  if (!r) return null;
  return {
    query: r.originalQuery,
    normalized_query: r.normalizedQuery,
    plan: { type: r.plan.type, reason: r.plan.reason ?? null, operation: r.plan.operation ?? null },
    intent: {
      operation: r.intent.operation,
      ordinal: r.intent.ordinal,
      reference: r.intent.reference,
      ask_places: r.intent.askPlaces,
      area: r.intent.area,
      near_me: Boolean(r.intent.nearMe || r.intent.proximity),
      order_like: r.intent.orderLike,
    },
    entities: {
      foods: r.foodEntities.map((f) => ({ key: f.key, name: f.name, said: f.said, match_type: f.matchType })),
      merchant: r.merchant ? place(r.merchant) : null,
      product: r.product,
      location: r.location ? { region_id: r.location.regionId, name: r.location.name } : null,
      exclusions: r.exclusions,
    },
    candidates: { foods: r.foodCandidates, merchants: r.merchantCandidates.map(place) },
    filters: { price: r.priceFilter, region_id: r.filters.regionId },
    context: { used: r.currentContextUsed, references: r.conversationalReferences, follow_up: r.followUp },
    confidence: r.confidence,
    ambiguity: r.ambiguity,
    match_type: r.matchType,
    search_query: r.searchQuery,
    suggested_tool: r.suggestedTool,
    recovery: r.recovery,
    results,
    explanation: (r.explanation ?? []).slice(0, 6),
    rules: SEARCH_INTELLIGENCE_RULES,
  };
}
