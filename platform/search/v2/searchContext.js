// SEARCH INTELLIGENCE V2 — step 4: structured search context (pure).
// Stored in the EXISTING platform_sessions.knowledge_context_json (no migration): the fields the list follow-ups
// already read (rawQuery, query, named, foodKeys, matchedIds, shownCount, total, focusId, touchedAt) stay as they
// are; V2 adds `si`:
//   currentIntent, currentFoodEntity {id, key, name}, currentMerchant, currentMerchantList (= matchedIds),
//   selectedMerchant (= focusId), currentFilters {price, regionId}, paginationState (= shownCount),
//   lastSearchPlan, lastUserQuery, lastResolvedEntities, pendingSuggestion
// Transition policy: a new dish / place / area request REPLACES the context; a follow-up READS it; a clarify or a
// no-match turn KEEPS it; entering a catalog place clears it (existing session rule).
import { isFresh } from "../../conversation/knowledgeContext.js";

export function readContext(context, now = Date.now()) {
  const fresh = isFresh(context, now);
  const si = context?.si ?? null;
  const food = si?.currentFoodEntity ?? (context?.foodKeys?.length === 1 ? { key: context.foodKeys[0], name: context.query ?? null } : null);
  return { fresh, context: context ?? null, si, food: fresh ? food : null, hasList: fresh && Array.isArray(context?.matchedIds) && context.matchedIds.length > 0 };
}

/** The context after a turn: `base` (list fields, or null) + V2 state. */
export function withSearchState(base, state, now = new Date()) {
  const touchedAt = now.toISOString();
  const b = base ?? { type: "food_knowledge_results", rawQuery: state.lastUserQuery ?? "", query: state.currentFoodEntity?.name ?? "", named: false, foodKeys: state.currentFoodEntity ? [state.currentFoodEntity.key] : [], regionId: state.currentFilters?.regionId ?? null, matchedIds: [], shownCount: 0, total: 0 };
  return {
    ...b,
    touchedAt,
    si: {
      v: 2,
      currentIntent: state.currentIntent ?? null,
      currentFoodEntity: state.currentFoodEntity ?? null,
      currentMerchant: state.currentMerchant ?? null,
      currentMerchantList: b.matchedIds ?? [],
      selectedMerchant: b.focusId ?? null,
      currentFilters: state.currentFilters ?? {},
      paginationState: { shown: b.shownCount ?? 0, total: b.total ?? 0 },
      lastSearchPlan: state.lastSearchPlan ?? null,
      lastUserQuery: state.lastUserQuery ?? null,
      lastResolvedEntities: state.lastResolvedEntities ?? null,
      pendingSuggestion: state.pendingSuggestion ?? null,
    },
  };
}

/** Keep the list and V2 state as they are, only remember a pending "did you mean" (a clarify turn keeps context). */
export function withPending(context, pendingSuggestion, now = new Date()) {
  if (!context) return withSearchState(null, { pendingSuggestion }, now);
  return { ...context, touchedAt: now.toISOString(), si: { ...(context.si ?? { v: 2 }), pendingSuggestion } };
}
