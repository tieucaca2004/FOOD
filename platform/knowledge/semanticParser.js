import { FoodVocabulary } from "./vocabulary.js";
import { FoodTaxonomy } from "./taxonomy.js";
import { collapseWhitespace, normalizeName, fold, nfc, hasDiacritics } from "./text.js";
import { parsePrice } from "./price.js";

// FoodSemanticParser: customer message -> FoodQuery. Deterministic (the
// reviewed vocabulary + a few phrase rules); no model decides anything here.
// The FoodQuery only DESCRIBES what the customer asked for — whether any
// dish or merchant satisfies it is decided later against evidence.
//
// Strength of a wish:
//   must      explicit request          "món cay nhẹ", "có tôm", "món nước"
//   prefer    soft / vague               "nóng nóng", "thích cay", "trời nóng quá"
//   avoid     soft dislike               "không thích ngọt", "không cay"
//   mustNot   hard exclusion             "không ăn được cay", "dị ứng tôm", "kiêng hành"
// A hard exclusion needs KNOWN absence to be satisfied; a soft one only
// removes what is known to have it (unknown stays, labelled unknown).

/** Requested graded level -> acceptable levels. "cay nhẹ" = low|medium; plain "cay" = medium|high. */
const LEVELS_FOR = {
  low: ["low", "medium"],
  medium: ["medium", "high"],
  high: ["high"],
  null: ["medium", "high"],
  none: ["none"],
  adjustable: ["adjustable"],
};
const TEMPERATURES_FOR = {
  very_hot: ["very_hot"],
  hot: ["hot", "very_hot"],
  warm: ["warm", "hot"],
  room: ["room"],
  cool: ["cool", "cold", "iced"],
  cold: ["cold", "iced"],
  iced: ["iced"],
  either: ["either", "hot", "cold", "iced"],
};
const POSITIVE_LEVELS = ["low", "medium", "high"];

// Whole-word alternatives with Unicode boundaries (JS \b only knows ASCII letters: "rẻ", "đang" would never match).
const words = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu");

const WEATHER = words("(?:trời|thời tiết|hôm nay)\\s+(?:(?:đang|rất|hơi|quá|khá)\\s+)?(?:nóng|lạnh|oi|oi bức|mưa|nắng)(?:\\s+(?:quá|lắm|thế))?|nắng nóng|oi bức|trời mưa");
const HARD_NOT = /(?:không ăn được|không được ăn|dị ứng(?: với)?|kiêng|tránh xa|không thể ăn)\s+(?:\S+\s+){0,2}$/iu;
const SOFT_NOT = /(?:không thích|không ưa|ghét|sợ)\s+(?:\S+\s+){0,2}$/iu;
const LIKE = /(?:thích|ưa|khoái|mê|muốn)\s+(?:(?:ăn|món|đồ|vị|uống)\s+)?$/iu;
const NEAR_ME = words("gần tôi|gần đây|quanh đây|gần nhất|gần mình|gần em|chỗ tôi");
const LOCATION = /(?<![\p{L}\p{N}])(?:gần|ở|tại|quanh|khu vực|khu|đường|phố)\s+((?:đường\s+)?[\p{Lu}0-9][\p{L}0-9]*(?:\s+[\p{Lu}0-9][\p{L}0-9]*){0,4})/u;
const PRICE_MAX = /(?:dưới|không quá|tối đa|nhỏ hơn|ít hơn|bé hơn|rẻ hơn|<=?)\s*([\d.,]+\s*(?:k|nghìn|ngàn|đ|vnđ|vnd|đồng|tr|triệu)?)/iu;
const PRICE_MIN = /(?:trên|từ|hơn|lớn hơn|>=?)\s*([\d.,]+\s*(?:k|nghìn|ngàn|đ|vnđ|vnd|đồng|tr|triệu)?)(?:\s*trở lên)?/iu;
const SORTS = [
  [words("rating cao|đánh giá cao|nhiều sao|điểm cao|được đánh giá tốt"), "rating_desc"],
  [words("nhiều (?:review|đánh giá|lượt đánh giá|người đánh giá|bình luận)"), "review_count_desc"],
  [words("nhiều món|menu đa dạng|đa dạng món|thực đơn đa dạng|nhiều lựa chọn|menu nhiều món"), "menu_count_desc"],
  [words("giá rẻ|rẻ nhất|rẻ|bình dân|giá mềm"), "price_asc"],
];
const OPEN_NOW = words("đang mở|còn mở|mở cửa bây giờ|giờ này còn|đang bán|còn bán không");
const SUBJECTIVE = words("ngon nhất|ngon|tốt nhất|số một|nổi tiếng nhất|xịn nhất|đỉnh");
const MERCHANT_WORDS = words("quán|nhà hàng|tiệm|chỗ nào|ở đâu|địa chỉ|chỗ bán|nơi bán");
const VAGUE_LIGHT = words("nhẹ nhẹ|món nhẹ|ăn nhẹ|đồ nhẹ");

function blank(text, start, end) {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

export class FoodSemanticParser {
  /**
   * @param {object} [deps]
   * @param {Array<{entityKey: string, name: string}>} [deps.foodNames] known dish names (published names of the knowledge DB)
   * @param {Array<{id: string, name: string}>} [deps.regions]
   */
  constructor({ taxonomy = new FoodTaxonomy(), vocabulary = null, foodNames = [], regions = [] } = {}) {
    this.taxonomy = taxonomy;
    this.vocabulary = vocabulary ?? new FoodVocabulary(undefined, taxonomy);
    // longest names first, compared on the folded form
    // an accented name matches accent-SENSITIVELY ("tràng" is not the "Trang" of "Nha Trang"); an unaccented
    // search form ("bun ca") only matches text typed without accents at that place
    this.foodNames = [...foodNames]
      .map((f) => {
        const { original, folded } = fold(f.name);
        return { ...f, folded: folded.trim(), lower: original.trim(), accented: original.trim() !== folded.trim() };
      })
      .filter((f) => f.folded)
      .sort((a, b) => b.folded.length - a.folded.length);
    this.regions = regions;
  }

  /** @returns {object} FoodQuery */
  parse(message) {
    let text = collapseWhitespace(nfc(message));
    const q = {
      text,
      intent: "find_food",
      foods: [],
      categories: [],
      must: [],
      prefer: [],
      avoid: [],
      mustNot: [],
      price: {},
      location: {},
      sort: [],
      openNow: false,
      context: {},
      subjective: false,
      outOfScope: [],
      ambiguous: [],
      senses: {},
    };
    if (!text) return q;

    // --- context and constraints that are not about the dish itself (their words are then blanked)
    const weather = text.match(WEATHER);
    if (weather) {
      const w = normalizeName(weather[0]);
      q.context.weather = /nong|oi|nang/.test(w) ? "hot" : /lanh/.test(w) ? "cold" : "rain";
      text = blank(text, weather.index, weather.index + weather[0].length);
      // a soft, clearly labelled suggestion — never a filter
      if (q.context.weather === "hot") q.prefer.push({ concept: "temperature.serving", values: ["cool", "cold", "iced"], reason: "weather" }, { concept: "taste.light", levels: POSITIVE_LEVELS, reason: "weather" });
      if (q.context.weather === "cold") q.prefer.push({ concept: "temperature.serving", values: ["hot", "very_hot"], reason: "weather" });
    }
    if (NEAR_ME.test(text)) {
      q.location.nearMe = true;
      const m = text.match(NEAR_ME);
      text = blank(text, m.index, m.index + m[0].length);
    }
    const loc = text.match(LOCATION);
    if (loc && !this._isFoodWord(loc[1])) {
      const place = loc[1].replace(/^đường\s+/iu, "");
      // a known region ("ở Nha Trang") scopes the search; anything else is a street/area to match addresses
      const region = this.regions.find((r) => normalizeName(r.name) === normalizeName(place));
      if (region) q.location.regionId = region.id;
      else q.location.text = place;
      text = blank(text, loc.index, loc.index + loc[0].length);
    }
    const pmax = text.match(PRICE_MAX);
    if (pmax) {
      const v = parsePrice(pmax[1].trim()).price ?? parsePrice(`${pmax[1].trim()}k`).price;
      if (v) q.price.max = v;
      text = blank(text, pmax.index, pmax.index + pmax[0].length);
    }
    const pmin = text.match(PRICE_MIN);
    if (pmin && /\d/.test(pmin[1])) {
      const v = parsePrice(pmin[1].trim()).price ?? parsePrice(`${pmin[1].trim()}k`).price;
      if (v) q.price.min = v;
      text = blank(text, pmin.index, pmin.index + pmin[0].length);
    }
    for (const [re, sort] of SORTS) {
      const m = text.match(re);
      if (m) {
        q.sort.push(sort);
        text = blank(text, m.index, m.index + m[0].length);
      }
    }
    if (q.location.nearMe || (q.location.text && /\bgần\b/iu.test(q.text))) q.sort.push("distance_asc");
    if (OPEN_NOW.test(text)) q.openNow = true;
    if (SUBJECTIVE.test(text)) {
      q.subjective = true; // "ngon" is never turned into a ranking
      const m = text.match(SUBJECTIVE);
      text = blank(text, m.index, m.index + m[0].length);
    }
    if (MERCHANT_WORDS.test(q.text)) q.intent = "find_merchant";
    if (words("đặt|order|gọi món|cho (?:tôi|em|mình) \\d+").test(q.text)) q.intent = "order";

    // --- dish names (longest first); their words are not attributes ("bún cá" is not a carb filter)
    const { original: lowered, folded } = fold(text);
    // a message typed WITH accents is compared with accents (accents optional only when none were typed)
    const typedAccents = hasDiacritics(q.text);
    // a dish found only INSIDE a place name ("tràng" in "Nha Trang") is not a dish
    const placeSpans = this.regions
      .filter((r) => normalizeName(r.name).includes(" "))
      .flatMap((r) => [...folded.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${fold(r.name).folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"))].map((m) => [m.index, m.index + m[0].length]));
    const taken = [];
    for (const f of this.foodNames) {
      const sensitive = f.accented && typedAccents;
      const needle = sensitive ? f.lower : f.folded;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
      for (const m of (sensitive ? lowered : folded).matchAll(re)) {
        const [s, e] = [m.index, m.index + m[0].length];
        if (!f.accented && typedAccents && lowered.slice(s, e) !== m[0]) continue; // unaccented form vs accented text: not this dish
        if (placeSpans.some(([a, b]) => s >= a && e <= b)) continue;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        taken.push([s, e]);
        if (!q.foods.some((x) => x.entityKey === f.entityKey)) q.foods.push({ entityKey: f.entityKey, name: f.name, text: text.slice(s, e) });
      }
    }
    for (const [s, e] of taken) text = blank(text, s, e);
    if (q.foods.length > 1 && words("và|cùng|lẫn|với cả").test(q.text)) q.combine = "all";

    // --- a registered place written without "ở" ("quán ăn Nha Trang", "bún cá Nha Trang") is the place, not a dish
    // (after the dish names, so "Bún bò Huế" stays one dish); multi-word names only — "Huế" alone is left to "ở Huế"
    if (!q.location.regionId && !q.location.text) {
      const place = [...this.regions]
        .filter((r) => normalizeName(r.name).includes(" "))
        .sort((a, b) => b.name.length - a.name.length)
        .map((r) => ({ r, m: fold(text).folded.match(new RegExp(`(?<![\\p{L}\\p{N}])${fold(r.name).folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u")) }))
        .find((x) => x.m);
      if (place) {
        q.location.regionId = place.r.id;
        text = blank(text, place.m.index, place.m.index + place.m[0].length);
      }
    }

    // --- regional specialty ("đặc sản Nha Trang")
    if (/đặc sản/iu.test(q.text)) {
      for (const r of this.regions) if (normalizeName(q.text).includes(normalizeName(r.name))) q.must.push({ concept: "relation:regional_specialty", values: [r.id] });
      if (!q.must.some((m) => m.concept === "relation:regional_specialty")) q.must.push({ concept: "relation:regional_specialty", values: [] });
    }
    if (VAGUE_LIGHT.test(text)) q.prefer.push({ concept: "taste.light", levels: POSITIVE_LEVELS, reason: "vague" });

    // --- vocabulary concepts
    const found = this.vocabulary.match(text);
    for (const o of found.outOfScope) q.outOfScope.push({ text: o.text, concept: o.concept });
    for (const m of found.matches) {
      if (m.concept === "temperature.serving" || m.concept === "taste.spicy") q.senses[m.term] = m.concept === "temperature.serving" ? "temperature" : "spicy";
      const before = text.slice(0, m.start);
      const hard = HARD_NOT.test(before);
      const soft = SOFT_NOT.test(before);
      const like = LIKE.test(before);
      const bucket = hard ? "mustNot" : soft || m.negated ? "avoid" : like || m.reduplicated || m.ambiguous ? "prefer" : "must";
      if (m.ambiguous) q.ambiguous.push({ text: m.text, concept: m.concept, alternatives: m.alternatives });
      const item = this._item(m, { negative: hard || soft || m.negated });
      if (!item) continue;
      if (item.category) {
        if (!q.categories.some((c) => c.facet === item.facet && c.value === item.value)) q.categories.push({ facet: item.facet, value: item.value });
        continue;
      }
      q[bucket].push(hard ? { ...item, hard: true } : item);
    }
    return q;
  }

  _isFoodWord(text) {
    const n = fold(text).folded;
    return this.foodNames.some((f) => f.folded === n) || this.vocabulary.match(text).matches.some((m) => !m.ambiguous);
  }

  // One vocabulary match -> a filter item. Negative items list the levels to EXCLUDE.
  _item(m, { negative }) {
    if (m.concept === "temperature.serving") return { concept: m.concept, values: TEMPERATURES_FOR[m.value] ?? [m.value] };
    if (m.concept.startsWith("taste.") || m.concept.startsWith("texture.")) {
      // "không thích quá ngọt" excludes only the HIGH level; "không cay" excludes any
      if (negative) return { concept: m.concept, levels: m.level === "high" ? ["high"] : POSITIVE_LEVELS };
      return { concept: m.concept, levels: LEVELS_FOR[m.level] ?? LEVELS_FOR.null };
    }
    if (m.concept === "facet:lexical_family" || m.concept === "facet:carb_base") {
      // "bánh", "bún", "phở": a family of dishes by name — a category, not a dish fact
      if (!negative) return { category: true, facet: m.concept.slice(6), value: m.value };
      return { concept: m.concept, values: [m.value] };
    }
    if (m.concept.startsWith("facet:")) return { concept: m.concept, values: [m.value] };
    if (m.concept === "ingredient") return { concept: "ingredient", values: [m.value] };
    return null;
  }
}
