// The Food Knowledge reference list a conversation is about (migration 013,
// platform_sessions.knowledge_context_json). Written when a reference list is
// shown — by the router's search or by the GPT concierge's search_food tool —
// and read by follow-ups ("sao ko có giá?", "còn quán nào nữa?").

// How long a reference list stays the subject of follow-ups after it was last used. The codebase has no
// session-expiry convention (sessions and last_search_results never expire), so this is set here: long
// enough for a chat about the list, short enough that a later "giá?" is not answered about it.
export const KNOWLEDGE_CONTEXT_TTL_MS = 30 * 60 * 1000;

/** What a follow-up needs to answer about a reference list without searching again. */
export function buildKnowledgeContext(knowledge, { rawQuery, keywords }) {
  const { result } = knowledge;
  const named = result.notes.includes("MERCHANT_NAME");
  const foods = result.query.foods.map((f) => f.name ?? f.entityKey);
  return {
    type: "food_knowledge_results",
    rawQuery,
    query: !named && foods.length ? foods.join(", ") : keywords,
    named, // the list answers a place asked for BY NAME: "còn quán nào khác" then means other places, not more of it
    foodKeys: result.query.foods.map((f) => f.entityKey),
    regionId: result.query.location.regionId ?? null,
    matchedIds: knowledge.matchedIds,
    shownCount: result.merchants.length,
    total: result.totalMerchants,
    touchedAt: new Date().toISOString(),
  };
}

export function isFresh(context, now = Date.now()) {
  return Boolean(context) && now - Date.parse(context.touchedAt) <= KNOWLEDGE_CONTEXT_TTL_MS;
}
