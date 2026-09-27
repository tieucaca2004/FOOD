// FOOD Agent — controlled learning (OBSERVE -> PROPOSE; never publish).
//
// A customer statement about how a dish is CALLED ("ở đây mọi người gọi bánh căn là …", "chỗ tôi gọi món đó là …",
// "X còn gọi là Y") becomes, at most, a DRAFT term relation (a learning candidate) in the working knowledge DB, with
// the verbatim message as evidence and pseudonymous provenance. Only a person approves it (TermRelationService); only
// APPROVED relations ever reach the matcher that Search V2 and the Agent read — so a candidate changes nothing.
//
// Deterministic (no model call to "learn"); the message is UNTRUSTED data: it is only ever parsed for a term and a
// dish, never obeyed. Prices, menus, places, orders, payment and delivery are never learning types here.

// "… gọi <dish> là <term>" (who: ở đây / chỗ tôi / ở Nha Trang / mọi người / người ta / dân …)
const CALLS = /(?:^|[\s,])(?:hay\s+|thường\s+|vẫn\s+)?(?:gọi|kêu)\s+(.+?)\s+là\s+(.+?)\s*[.!…]*$/iu;
// "<term> còn gọi là / tức là / cũng là <dish>" (either side may be the known dish)
const ALSO = /^(.+?)\s+(?:còn\s+(?:được\s+)?gọi\s+là|hay\s+(?:được\s+)?gọi\s+là|tức\s+là|cũng\s+là|chính\s+là)\s+(.+?)\s*[.!…]*$/iu;
const CONTEXT_DISH = /^(?:món|cái)\s+(?:đó|này|kia|ấy|nãy)$/iu;
const QUESTION = /\?|(?:^|\s)(?:không|ko|hả|nhỉ|gì|nào|sao|bao nhiêu|đâu)\s*[?!.]*$/iu;
const MONEY = /\d\s*(?:k|nghìn|ngàn|đ|₫|vnd|đồng|tr|triệu)(?![\p{L}])/iu;
const LEADS = /^(?:à|ừ|dạ|vâng|ờ|ah|ồ)[\s,]+/iu;
const WHO = /^(?:ở\s+(?:đây|chỗ\s+(?:tôi|em|mình)|[^,]+?)|chỗ\s+(?:tôi|em|mình)|mọi\s+người|người\s+ta|dân\s+\S+|bọn\s+tôi|tụi\s+tôi|nhà\s+tôi)\s+/iu;

const clean = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().replace(/^["“'‘]|["”'’]$/gu, "").trim();

/** Pure: a naming statement in the text, or null. */
export function parseNamingStatement(text) {
  const t = clean(text).replace(LEADS, "");
  if (!t || QUESTION.test(t) || MONEY.test(t)) return null;
  const calls = t.match(CALLS);
  if (calls) {
    const raw = clean(calls[1]).replace(WHO, "");
    const contextDish = CONTEXT_DISH.test(raw);
    const dish = contextDish ? raw : raw.replace(/^món\s+/iu, "");
    const term = clean(calls[2]).replace(/\s+(?:đó|đấy|ạ|á|nha|nhé)$/iu, "");
    if (dish && term && dish.split(" ").length <= 6 && term.split(" ").length <= 6) return { dish, term, contextDish };
  }
  const also = t.replace(WHO, "").match(ALSO);
  if (also) {
    const [a, b] = [clean(also[1]), clean(also[2])];
    if (a && b && a.split(" ").length <= 6 && b.split(" ").length <= 6) return { dish: b, term: a, either: true, contextDish: false };
  }
  return null;
}

const coversWhole = (m, text) => clean(m.text).toLowerCase() === clean(text).toLowerCase();

/**
 * @param {{sink: {propose: Function}, matcher: () => object|null, logger?: object}} deps
 *   sink.propose({foodEntityId, term, relationType, regionId, quote, provenance}) -> {recorded, id?, status?, reason?}
 *   matcher: the APPROVED-only term matcher (what Search V2 reads)
 */
export function createAgentLearning({ sink, matcher, logger = null }) {
  return {
    /**
     * OBSERVE one customer turn; PROPOSE a candidate when it clearly states a dish's name. Never throws.
     * @returns {{observed: boolean, recorded?: boolean, reason?: string, candidate?: object}}
     */
    observe({ customer, session, text, previousQuery = null }) {
      try {
        const s = parseNamingStatement(text);
        if (!s) return { observed: false };
        const m = matcher?.();
        if (!m) return { observed: true, recorded: false, reason: "NO_MATCHER" };
        const resolve = (words) => {
          const r = m.match(words);
          const whole = (r.matches ?? []).filter((x) => coversWhole(x, words) && !x.typo);
          return whole.length === 1 ? whole[0] : null;
        };
        let dish = s.contextDish ? (previousQuery ? resolve(previousQuery) : null) : resolve(s.dish);
        let term = s.term;
        // "<a> còn gọi là <b>": whichever side FOOD already knows is the dish
        if (!dish && s.either) {
          const other = resolve(s.term);
          if (other) [dish, term] = [other, s.dish];
        }
        if (!dish) return { observed: true, recorded: false, reason: s.contextDish ? "CONTEXT_DISH_UNKNOWN" : "DISH_UNKNOWN" };
        // a term FOOD already resolves (to this dish or another) teaches nothing — and must not be re-pointed
        const known = resolve(term);
        if (known) return { observed: true, recorded: false, reason: known.foodEntityId === dish.foodEntityId ? "ALREADY_KNOWN" : "NAMES_ANOTHER_DISH" };
        const region = (m.match(text).modifiers ?? []).find((x) => x.type === "region" && x.regionId);
        const z = String(customer?.zalo_user_id ?? "");
        const provenance = { channel: z.startsWith("telegram:") ? "telegram" : "zalo", userId: z.startsWith("telegram:") ? z.slice(9) : z || null, sessionId: session?.id ?? null };
        const r = sink.propose({ foodEntityId: dish.foodEntityId, term, relationType: region ? "REGIONAL_ALIAS" : "COMMON_QUERY", regionId: region?.regionId ?? null, quote: clean(text), provenance });
        logger?.info?.("AI", "agent learning signal", { sessionId: session?.id ?? null, recorded: Boolean(r?.recorded), reason: r?.reason ?? null, relationId: r?.id ?? null });
        return { observed: true, ...r, candidate: r?.recorded ? { term, canonicalName: dish.canonicalName, status: r.status } : undefined };
      } catch (err) {
        logger?.warn?.("AI", "agent learning failed", { error: String(err?.message ?? err).slice(0, 160) });
        return { observed: true, recorded: false, reason: "LEARNING_UNAVAILABLE" };
      }
    },
  };
}
