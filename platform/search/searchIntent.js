import { classifyKnowledgeFollowUp } from "../nlp/knowledgeFollowUp.js";
import { fold } from "../conversation/understand.js";

// SEARCH INTELLIGENCE — customer text -> structured search intent. Deterministic and explainable; READ-ONLY.
// It does not search and does not decide facts: it says WHAT was asked (dish, place, location, price, follow-up)
// and which existing FOOD tool answers it. The data comes through the Food Knowledge adapter only:
//   dishes  canonical names + APPROVED term relations (never unreviewed aliases); a typo or typing variant is
//           a did_you_mean, never a dish (PRECISION > RECALL)
//   places  reference + catalog place names that are distinctive (a place called just "Bún cá" never wins)
//   regions known regions only; "gần biển" is reported as UNSUPPORTED (no geo data), "gần đây" needs the
//           customer's location — nothing is guessed.
// Priority of a dish reading (explainable): exact canonical > approved alias > regional alias; a place named in
// the sentence beats the dish words inside its name ("Bún Cá Mịn" is a place, not bún cá).

const APPROVED = { CANONICAL: "exact_canonical", EXACT_ALIAS: "approved_alias", SPELLING_VARIANT: "approved_alias", DIACRITIC_VARIANT: "approved_alias", COMMON_QUERY: "approved_alias", ABBREVIATION: "approved_alias", REGIONAL_ALIAS: "regional_alias" };

const AMOUNT = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|ngan|nghin|đ|₫|vnd|vnđ|đồng|dong|tr|triệu|trieu)?`;
const re = (s) => new RegExp(s, "iu");
const RANGE = re(String.raw`(?:từ|tu|khoảng|khoang|tầm|tam)?\s*${AMOUNT}\s*(?:đến|den|tới|toi|-|–)\s*${AMOUNT}`);
const MAX = re(String.raw`(?:dưới|duoi|không quá|khong qua|ko quá|ko qua|tối đa|toi da|nhỏ hơn|ít hơn|<=?|khoảng|khoang|tầm|tam|cỡ|co|chừng|chung|quanh|~|ngân sách|ngan sach|budget)\s*${AMOUNT}`);
const MIN = re(String.raw`(?:trên|tren|hơn|lớn hơn|>=?)\s*${AMOUNT}|(?:từ|tu)\s*${AMOUNT}\s*(?:trở lên|tro len)`);

/** "50k" / "50 nghìn" / "50.000đ" / "1tr" -> VND; a bare small number (a quantity) is not money. */
export function amount(num, unit) {
  let n = /^\d{1,3}(?:[.,]\d{3})+$/.test(num) ? Number(num.replace(/[.,]/g, "")) : Number(num.replace(",", "."));
  const u = (unit ?? "").toLowerCase();
  if (["k", "nghìn", "ngàn", "ngan", "nghin"].includes(u)) n *= 1000;
  else if (["tr", "triệu", "trieu"].includes(u)) n *= 1_000_000;
  else if (!u && n < 1000) return null;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function parsePrice(text) {
  const t = String(text ?? "");
  const r = t.match(RANGE);
  if (r) {
    const a = amount(r[1], r[2] ?? r[4]);
    const b = amount(r[3], r[4] ?? r[2]);
    if (a && b) return { price_min: Math.min(a, b), price_max: Math.max(a, b) };
  }
  const max = t.match(MAX);
  if (max && amount(max[1], max[2])) return { price_max: amount(max[1], max[2]) };
  const min = t.match(MIN);
  if (min) {
    const v = amount(min[1] ?? min[3], min[2] ?? min[4]);
    if (v) return { price_min: v };
  }
  return {};
}

const NEAR_ME = /(?:gần|gan)\s+(?:đây|day|tôi|toi|mình|minh|em|nhất|nhat)|quanh\s+(?:đây|day)/iu;
const UNSUPPORTED_PLACE = /(?:gần|gan|ven|sát|sat|view|nhìn ra|nhin ra|bên|ben)\s+(?:bãi biển|bai bien|bờ biển|bo bien|biển|bien|sông|song|hồ|chợ|cho|sân bay|san bay|trung tâm|trung tam)/iu;
const LOCATION_TEXT = /(?:^|\s)(?:ở|tại|khu vực|khu|phường|quận|xã)\s+((?:\p{Lu}[\p{L}]*)(?:\s+\p{Lu}[\p{L}]*){0,3})/u;
const PLACE_WORDS = /(?:^|[^\p{L}])(?:quán|quan|chỗ|nơi|tiệm|tiem|nhà hàng|nha hang|ở đâu|o dau|bán|địa chỉ|dia chi)(?:$|[^\p{L}])/iu;
const MENU_WORDS = /(?:menu|thực đơn|thuc don|có món gì|co mon gi|món gì|mon gi|bán gì|ban gi|có gì|co gi)/iu;
const DETAIL_WORDS = /(?:ở đâu|o dau|địa chỉ|dia chi|mấy giờ|may gio|giờ mở|gio mo|mở cửa|mo cua|số điện thoại|so dien thoai|sđt)/iu;

// "quán Phở Hà Nội 99": a place the customer names that FOOD does not know — never turned into a dish search
const NAMED_PLACE = /(?:quán|tiệm|nhà hàng)\s+((?:\p{Lu}[\p{L}]*|\d+)(?:\s+(?:\p{Lu}[\p{L}]*|\d+))+)/u;
const PLACE_KIND_WORD = /^(?:nào|gì|ăn|này|đó|kia|ngon|rẻ)$/iu;

// words that may follow a dish without changing it (quantity, place, price, question and polite words)
const GENERICISH = new Set("o tai gan khu quan cho nao dau khong ko k gi a nhe nha di voi va hoac ngon re nong lanh cay it nhieu them nua thi la co con bao nhieu gia khoang tam duoi tren tu den toi mot hai ba to dia phan suat ly chen hop goi mang ve an uong".split(" "));
const CHEAP = /(?:rẻ nhất|re nhat|giá rẻ|gia re|món nào rẻ|mon nao re|quán nào rẻ|quan nao re|bình dân|binh dan|(?<![\p{L}])rẻ(?![\p{L}]))/iu;
const PRICE_ASK = /(?:giá|bao nhiêu|bao nhieu|mấy tiền|may tien)/iu;

/**
 * The intent in the brief's vocabulary (dish_search, merchant_search, merchant_by_dish, menu, product, price,
 * location, price_filtered_discovery, follow_up, clarification) — a label over `intent`, same decision.
 */
function intentType(out, raw) {
  if (out.intent === "clarify") return "clarification";
  if (out.intent === "follow_up") return "follow_up";
  if (out.intent === "price_filter") return "price_filtered_discovery";
  if (out.intent === "merchant_menu") return out.dishes.length ? "product" : "menu";
  if (out.intent === "merchant_detail") return /(?:ở đâu|o dau|địa chỉ|dia chi)/iu.test(raw) ? "location" : "merchant_search";
  if (out.intent === "merchant_discovery" && !out.dish) return "merchant_search";
  if (out.dish) {
    if (out.price_max || out.price_min || out.sort) return "price_filtered_discovery";
    if (PRICE_ASK.test(raw)) return "price";
    return out.intent === "merchant_discovery" ? "merchant_by_dish" : "dish_search";
  }
  return "unknown";
}

const dishOf = (m) => ({ canonical: m.canonicalName, food_entity_id: m.foodEntityId, said: m.text, match_reason: APPROVED[m.relationType], ...(m.regionMatch ? { region_match: m.regionMatch } : {}) });

export class SearchIntelligence {
  /** @param {{foodKnowledge: object}} deps the Food Knowledge adapter (searchMatcher / placeMatcher) */
  constructor({ foodKnowledge }) {
    this.fk = foodKnowledge;
  }

  /**
   * @param {string} text
   * @param {{hasPreviousList?: boolean, currentMerchantId?: string|null}} [ctx]
   *   hasPreviousList: the conversation has a fresh reference list (follow-ups);
   *   currentMerchantId: "cat:<id>" when the customer is inside a catalog place ("quán đó" = that place);
   *   previousPlaceIds: the reference place(s) the list is about ("kb:<id>" — the focus, or the places shown)
   */
  understand(text, { hasPreviousList = false, currentMerchantId = null, previousPlaceIds = [] } = {}) {
    const explain = [];
    const out = { intent: "unknown", dish: null, dishes: [], dish_candidates: [], did_you_mean: [], merchant: null, merchant_candidates: [], location: null, location_text: null, location_known: null, near_me: false, unsupported_location: null, price_min: null, price_max: null, follow_up: null, clarify_reason: null, suggested_tool: null, recovery: null, sort: null, intent_type: "unknown", explain };
    const raw = String(text ?? "").normalize("NFC").trim();
    if (!raw) return out;

    // ---- place named in the sentence (longest name; must be distinctive)
    const places = this.fk.placeMatcher?.()?.match(raw) ?? null;
    const placeHits = places ? places.matches.map((m) => ({ id: m.foodEntityId, name: m.canonicalName, said: m.text })) : [];
    const placeAmbig = places ? places.ambiguous.flatMap((a) => a.candidates.map((c) => ({ id: c.foodEntityId, name: c.canonicalName, said: a.text }))) : [];

    // ---- dishes (canonical + approved only)
    const terms = this.fk.searchMatcher?.()?.match(raw) ?? null;
    const placeSaid = [...placeHits, ...placeAmbig].map((p) => fold(p.said).folded.toLowerCase());
    const insidePlace = (said) => placeSaid.some((p) => ` ${p} `.includes(` ${fold(said).folded.toLowerCase()} `));
    if (terms) {
      for (const m of terms.matches) {
        if (insidePlace(m.text)) {
          explain.push(`"${m.text}" is part of a place name, not a dish`);
          continue;
        }
        if (APPROVED[m.relationType]) out.dishes.push(dishOf(m));
        else out.did_you_mean.push({ said: m.text, canonical: m.canonicalName, reason: m.typo?.kind ?? m.relationType }); // typing variant: confirm first
      }
      for (const a of terms.ambiguous) if (!insidePlace(a.text)) out.dish_candidates.push({ said: a.text, candidates: a.candidates.map((c) => c.canonicalName), ...(a.fuzzy ? { possible_typo: true } : {}) });
      for (const s of terms.suggestions) if (!insidePlace(s.text)) out.did_you_mean.push({ said: s.text, canonical: s.canonicalName, reason: s.typo?.kind ?? "TYPO" });
      const region = terms.modifiers.find((m) => m.type === "region" && m.regionId);
      if (region) {
        out.location = { region_id: region.regionId, name: region.name };
        out.location_known = true;
        explain.push(`location "${region.text}" = known region ${region.name}`);
      }
    }
    // a one-word dish followed by words FOOD does not know is not that dish ("bún thần thánh" is not all "Bún")
    const known = new Set([...(terms?.matches ?? []), ...(terms?.modifiers ?? [])].map((m) => fold(m.text).folded.toLowerCase()));
    out.dishes = out.dishes.filter((d) => {
      if (d.said.trim().includes(" ")) return true;
      const after = raw.slice(raw.toLowerCase().indexOf(d.said.toLowerCase()) + d.said.length).trim().split(/\s+/)[0] ?? "";
      const next = fold(after).folded.toLowerCase().replace(/[^a-z0-9]/g, "");
      const unknownNext = next && !/^\d/.test(next) && !known.has(next) && !GENERICISH.has(next) && !/^(?:k|nghin|ngan|d|dong|vnd|tr|trieu)$/.test(next);
      if (unknownNext) {
        out.dish_candidates.push({ said: `${d.said} ${after}`, candidates: [d.canonical], partial: true });
        explain.push(`"${d.said} ${after}": FOOD only knows "${d.canonical}" in general — ask before searching all of it`);
      }
      return !unknownNext;
    });
    out.dish = out.dishes[0] ?? null;

    // ---- location words that are NOT data we have
    if (NEAR_ME.test(raw)) {
      out.near_me = true;
      explain.push("near me: needs the customer's location (not known)");
    }
    const unsupported = raw.match(UNSUPPORTED_PLACE);
    if (unsupported) {
      out.unsupported_location = unsupported[0];
      explain.push(`"${unsupported[0]}": FOOD has no data for this kind of location`);
    }
    if (!out.location) {
      const loc = raw.match(LOCATION_TEXT);
      if (loc && !placeHits.some((p) => p.said.toLowerCase().includes(loc[1].toLowerCase()))) {
        out.location_text = loc[1];
        out.location_known = false;
        explain.push(`location "${loc[1]}" is not a region FOOD knows: results may be empty — never claim coverage`);
      }
    }

    // ---- price
    Object.assign(out, parsePrice(raw));
    out.sort = CHEAP.test(raw) ? "price_asc" : null;
    if (out.sort) explain.push("cheapest first — among verified prices only; places without a price are not 'rẻ'");
    if (out.price_max || out.price_min) explain.push(`price ${out.price_min ?? "…"}–${out.price_max ?? "…"} VND (verified prices only)`);

    // ---- intent (first rule that applies)
    const fu = classifyKnowledgeFollowUp(raw);
    const tool = (name, args = {}) => (out.suggested_tool = { name, args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined)) });
    const searchArgs = (query) => ({ query, location: out.location?.name ?? out.location_text ?? null, max_price: out.price_max, min_price: out.price_min });
    const placeIds = [...new Set([...placeHits, ...placeAmbig].map((p) => p.id))];
    const placeKind = MENU_WORDS.test(raw) ? "merchant_menu" : DETAIL_WORDS.test(raw) ? "merchant_detail" : "merchant_discovery";
    if (placeIds.length === 1) {
      out.merchant = placeHits[0] ?? placeAmbig[0];
      out.intent = placeKind;
      if (placeKind === "merchant_menu") tool("get_menu", { merchant_id: out.merchant.id });
      else if (placeKind === "merchant_detail") tool("get_merchant", { merchant_id: out.merchant.id });
      else tool("search_merchants", { query: out.merchant.name });
      explain.push(`place named: ${out.merchant.name} (${out.merchant.id})`);
    } else if (placeIds.length > 1) {
      const seen = new Set();
      out.merchant_candidates = [...placeHits, ...placeAmbig].filter((p) => !seen.has(p.id) && seen.add(p.id));
      out.intent = placeKind;
      tool("search_merchants", { query: out.merchant_candidates[0].name });
      explain.push(`${placeIds.length} places are called "${out.merchant_candidates[0].said}": list them first, never pick one`);
    } else if (raw.match(NAMED_PLACE) && !PLACE_KIND_WORD.test(raw.match(NAMED_PLACE)[1].split(/\s+/)[0])) {
      const name = raw.match(NAMED_PLACE)[1];
      out.intent = placeKind;
      out.clarify_reason = "UNKNOWN_PLACE";
      out.dishes = [];
      out.dish = null;
      out.location = null;
      tool("search_merchants", { query: name });
      explain.push(`"${name}" is not a place FOOD knows: check with search_merchants, never invent it`);
    } else if (out.dish) {
      out.intent = PLACE_WORDS.test(raw) ? "merchant_discovery" : "dish_discovery";
      tool("search_food", searchArgs(out.dish.canonical));
      explain.push(`dish: ${out.dish.canonical} (${out.dish.match_reason})`);
    } else if (out.dish_candidates.length) {
      out.intent = "clarify";
      out.clarify_reason = "AMBIGUOUS_DISH";
      explain.push(`"${out.dish_candidates[0].said}" names several dishes: ask, never choose`);
    } else if (out.did_you_mean.length) {
      out.intent = "clarify";
      out.clarify_reason = "DID_YOU_MEAN";
      explain.push(`"${out.did_you_mean[0].said}" may be ${out.did_you_mean[0].canonical}: confirm before searching`);
    } else if (currentMerchantId && (fu || MENU_WORDS.test(raw) || DETAIL_WORDS.test(raw))) {
      out.merchant = { id: currentMerchantId, name: null, said: null };
      out.follow_up = fu ? { kind: fu.kind, ordinal: fu.ordinal, ref: fu.ref } : null;
      out.intent = DETAIL_WORDS.test(raw) || fu?.kind === "address" || fu?.kind === "hours" ? "merchant_detail" : "merchant_menu";
      tool(out.intent === "merchant_detail" ? "get_merchant" : "get_menu", { merchant_id: currentMerchantId });
      explain.push("about the place the customer is in");
    } else if (fu && hasPreviousList && previousPlaceIds.length === 1 && this.fk.catalogTwin?.(previousPlaceIds[0])) {
      // the place the list is about is also in the FOOD catalog: the catalog place answers (source of truth)
      const twin = this.fk.catalogTwin(previousPlaceIds[0]);
      out.merchant = { id: twin, name: null, said: null };
      out.follow_up = { kind: fu.kind, ordinal: fu.ordinal, ref: fu.ref };
      out.intent = fu.kind === "address" || fu.kind === "hours" || DETAIL_WORDS.test(raw) ? "merchant_detail" : "merchant_menu";
      tool(out.intent === "merchant_detail" ? "get_merchant" : "get_menu", { merchant_id: twin });
      explain.push(`${previousPlaceIds[0]} is the same place as catalog ${twin}: the catalog answers`);
    } else if (fu) {
      out.follow_up = { kind: fu.kind, ordinal: fu.ordinal, ref: fu.ref };
      if (hasPreviousList) {
        out.intent = "follow_up";
        tool("get_previous_knowledge_results");
      } else {
        out.intent = "clarify";
        out.clarify_reason = "NO_PREVIOUS_LIST";
      }
    } else if (out.price_max || out.price_min || out.sort) {
      if (hasPreviousList) {
        out.intent = "price_filter";
        tool("get_previous_knowledge_results");
        explain.push("budget about the list already shown");
      } else {
        out.intent = "clarify";
        out.clarify_reason = "ASK_DISH";
        explain.push("a budget without a dish: ask what to eat");
      }
    } else if (out.unsupported_location || out.near_me) {
      out.intent = "clarify";
      out.clarify_reason = out.unsupported_location ? "UNSUPPORTED_LOCATION" : "NEED_USER_LOCATION";
    }
    if (out.suggested_tool?.name === "search_food" && out.location_known === false) {
      const { location, ...args } = out.suggested_tool.args;
      out.recovery = { tool: "search_food", args, reason: "LOCATION_NOT_IN_DATA", say: `FOOD chưa có dữ liệu khu vực "${location}"` };
    }
    // "rẻ": cheapest first among VERIFIED prices (Food Knowledge's own "rẻ" sort reads it from the query words)
    if (out.sort === "price_asc" && out.suggested_tool?.name === "search_food") out.suggested_tool.args.query = `${out.suggested_tool.args.query} rẻ`;
    out.intent_type = intentType(out, raw);
    return out;
  }
}
