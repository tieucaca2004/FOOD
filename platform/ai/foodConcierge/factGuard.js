import { fold } from "../../conversation/understand.js";
import { displayText } from "../../services/displayText.js";

// formatting only (the knowledge layer is reachable solely through its adapter — architecture test)
const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "nguồn đã ghi";
  }
};

// FACT GUARD for the GPT concierge.
//
// Business facts are never taken from the model's prose. The model returns
// JSON: free text (`reply`, per-item `note`) plus the ids of the places and
// products it chose. The backend renders every merchant / address / product /
// price / source / date / orderability line itself, from the tool results of
// this turn (the ledger). The guard then checks the free text:
//   ids        every merchant_id / product_id must be in the ledger (and the product must be that place's);
//   money      every amount must be a recorded price of this turn, or one the customer said themself;
//   hours      "đang mở" / "giờ mở cửa…" only when the ledger has hours / a known open status;
//   ordering   "đặt được / thêm vào giỏ / giao…" only when a place in the ledger is orderable;
//   ratings    "4.5/5", "… sao", "đánh giá …" only with recorded ratings;
//   ranking    "ngon nhất / tốt nhất / nổi tiếng nhất / số 1" never (FOOD does not rank);
//   names      a Proper Name must come from the ledger or the customer's own words;
//   address    a house number + street in the prose must be a recorded address of this turn (a street FOOD knows
//              with another number is NOT that address);
//   evaluation "nổi tiếng / được yêu thích / đặc biệt ngon / … hơn …" never — no source says it (FOOD has no such data).
// Knowledge layers (additive; the rules above are unchanged and still decide every FACT):
//   guidance   founder guidance is advice, never a fact (it adds nothing to prices / hours / orderability above);
//              when this turn used it, a recommendation must be labelled "FOOD gợi ý";
//   internal   founders / internal notes are never mentioned to a customer;
//   budget     an amount the customer said comes back only as their budget, never as a price of something;
//   alias      "X còn gọi là Y" only for a mapping an approved-relation tool returned this turn.
//   candidate  a value that exists ONLY as a customer contribution (USER_CONTRIBUTED_UNVERIFIED_EVIDENCE) may appear
//              only in a sentence that attributes it as unverified, never as the place's current / official fact
//              (UNATTRIBUTED_CANDIDATE); contributions never count as recorded prices, hours or orderability.
// Anything else is a violation: the caller retries once with the violations, then falls back.

export class Ledger {
  constructor() {
    this.merchants = new Map();
    this.guidance = []; // founder guidance used this turn (FOUNDER_GUIDANCE — never a fact)
    this.aliases = []; // approved name mappings returned this turn (ALIAS_MAPPING)
    this.contributions = []; // customer contributions returned this turn (USER_CONTRIBUTED_UNVERIFIED_EVIDENCE — never a fact)
  }

  add(facts) {
    for (const f of facts ?? []) {
      if (f?.kind === "guidance") {
        this.guidance.push(f);
        continue;
      }
      if (f?.kind === "alias") {
        this.aliases.push(f);
        continue;
      }
      if (f?.kind === "contribution") {
        this.contributions.push(f);
        continue;
      }
      const known = this.merchants.get(f.id);
      if (!known) {
        this.merchants.set(f.id, { ...f, products: new Map(f.products.map((p) => [p.id, p])) });
        continue;
      }
      for (const p of f.products) known.products.set(p.id, p);
      for (const key of ["address", "openStatus"]) if (known[key] == null && f[key] != null) known[key] = f[key];
      if (f.openingHours?.length) known.openingHours = f.openingHours;
      if (f.ratings?.length) known.ratings = f.ratings;
    }
  }

  get size() {
    return this.merchants.size;
  }

  prices() {
    const out = new Set();
    for (const m of this.merchants.values()) {
      for (const p of m.products.values()) for (const x of p.prices ?? []) for (const v of [x.price, x.price_max]) if (typeof v === "number") out.add(v);
      if (typeof m.cartSubtotal === "number") out.add(m.cartSubtotal);
    }
    return out;
  }

  allPriceRecords() {
    const out = [];
    for (const m of this.merchants.values()) for (const p of m.products.values()) out.push(...(p.prices ?? []));
    return out;
  }

  corpus() {
    const parts = [];
    for (const m of this.merchants.values()) {
      parts.push(m.name, m.address ?? "", ...(m.openingHours ?? []));
      for (const p of m.products.values()) parts.push(p.name);
    }
    return foldText(parts.join(" \n "));
  }
}

const foldText = (s) => fold(String(s ?? "")).folded.toLowerCase();

const MONEY = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|ngan|nghin|tr|triệu|trieu|đ|₫|vnd|vnđ|đồng|dong)(?![\p{L}])/giu;

export function moneyAmounts(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MONEY)) {
    const unit = m[2].toLowerCase();
    let n;
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(m[1])) n = Number(m[1].replace(/[.,]/g, ""));
    else n = Number(m[1].replace(",", "."));
    if (["k", "nghìn", "ngàn", "ngan", "nghin"].includes(unit)) n *= 1000;
    if (["tr", "triệu", "trieu"].includes(unit)) n *= 1_000_000;
    out.push({ text: m[0], value: Math.round(n) });
  }
  return out;
}

const OPEN_CLAIM = /(đang mở|còn mở|mở cửa (?:lúc|từ|đến|tới|vào)|giờ mở cửa|mở từ|đóng cửa (?:lúc|vào)|mở 24)/iu;
const OPEN_NOW = /(đang mở|còn mở|vẫn mở)/iu;
const NEGATED_ORDER = /(chưa|không|ko|k)\s+(?:thể\s+)?(đặt|order|giao)/giu;
const ORDER_CLAIM = /(đặt được|đặt qua food|đặt món|có thể đặt|thêm vào giỏ|giao (?:hàng|tận|tới|đến)|ship)/iu;
// FORM 15D — an ordering phrase inside an OFFER / QUESTION to the customer claims nothing about any place: in the same
// clause, before the phrase, the customer is asked or offered ("có muốn … đặt món không?", "nếu muốn đặt món", "em có
// thể giúp … đặt món", "muốn hỏi quán nào có ship không?"), or it is a "… nào … ?" question
const ORDER_CLAIM_ALL = new RegExp(ORDER_CLAIM.source, "giu");
const ORDER_OFFER = /(?:^|[\s,])(?:muốn|nếu|giúp|có cần|cần em|hỏi)(?=[\s,]|$)/iu;
const ORDER_WHICH = /(?:^|\s)nào(?=[\s,?]|$)/iu;
const RATING_CLAIM = /(\d(?:[.,]\d)?\s*(?:\/\s*5|sao)(?![\p{L}])|đánh giá (?:cao|tốt|\d)|review)/iu;
const RANKING = /(ngon nhất|tốt nhất|rẻ nhất|nổi tiếng nhất|đông khách nhất|số\s*1|number one|best)/iu;
const PROPER = /\p{Lu}[\p{Ll}\p{M}]+(?:\s+\p{Lu}[\p{Ll}\p{M}]*)+/gu;
// "<cue> [số] <house number> [đường] <Street Name>": 170 Bạch Đằng, số 24 Tô Hiến Thành, 6A Tháp Bà, 12/3 Lê Lợi
const ADDRESS_CLAIM = /(?<![\p{L}\d])(?:(ở|tại|địa chỉ(?:\s+là)?|nằm\s+(?:ở|tại|trên)|trên\s+đường|đường|số)\s+)?(?:số\s+)?(\d{1,5}[A-Za-z]?(?:\/\d{1,5}[A-Za-z]?)*)\s+(?:đường\s+|phố\s+|Đ\.\s*)?(\p{Lu}[\p{Ll}\p{M}]+(?:\s+\p{Lu}[\p{Ll}\p{M}]*)*)(?![\p{L}\d])/gu;
// reputation / praise / comparison: no FOOD source records any of it (ratings are their own rule)
const EVALUATIVE = /(nổi tiếng|được\s+(?:nhiều\s+(?:người|khách)\s+)?(?:yêu thích|ưa chuộng|săn đón|khen)|yêu thích nhất|đông khách|hút khách|đặc biệt ngon|ngon đặc biệt|ngon tuyệt|tuyệt vời|xuất sắc|chất lượng (?:cao|nhất)|(?:ngon|tốt|chất lượng|đáng thử|đáng ăn)\s+hơn|hơn hẳn|không đâu bằng|(?:rất|cực kỳ|cực|siêu|khá)\s+ngon)/giu;
const NEGATED = /(không|chưa|ko)\s/iu;
// folded, punctuation-free, without the connector words "số" / "đường" / "phố" / "Đ." ("Số 3A đường Tháp Bà" = "3A Tháp Bà")
const CONNECTORS = new Set(["so", "duong", "pho", "d"]);
const addressKey = (text) => ` ${foldText(text).replace(/(?<!\d)\/|\/(?!\d)/g, " ").replace(/[^\p{L}\p{N}/]+/gu, " ").split(" ").filter((w) => w && !CONNECTORS.has(w)).join(" ")} `;

/**
 * @param {{reply: string, items: {merchant_id: string, product_ids: string[], note: string}[]}} answer
 * @param {Ledger} ledger
 * @param {{userText: string, contextText?: string}} opts
 * @returns {string[]} violations (empty = allowed)
 */
export function checkAnswer(answer, ledger, { userText = "", contextText = "" } = {}) {
  const violations = [];
  if (!answer || typeof answer.reply !== "string" || !Array.isArray(answer.items)) return ["ANSWER_NOT_IN_SCHEMA"];
  const referenced = [];
  for (const item of answer.items) {
    const m = ledger.merchants.get(item.merchant_id);
    if (!m) {
      violations.push(`UNKNOWN_MERCHANT ${item.merchant_id}`);
      continue;
    }
    referenced.push(m);
    for (const pid of item.product_ids ?? []) if (!m.products.has(pid)) violations.push(`UNKNOWN_PRODUCT ${pid} for ${item.merchant_id}`);
  }
  const prose = [answer.reply, ...answer.items.map((i) => i.note ?? "")].join("\n");
  const spoken = new Set(moneyAmounts(userText).map((a) => a.value));
  // a price in the prose must be a recorded price of what the answer SHOWS (never another place's / dish's);
  // with nothing shown, of anything the tools returned this turn
  const shownPrices = scopedPrices(answer.items, ledger);
  const recorded = shownPrices ? new Set(shownPrices.map((x) => x.price).concat(shownPrices.map((x) => x.price_max)).filter((v) => typeof v === "number")) : ledger.prices();
  const candidateValues = new Set((ledger.contributions ?? []).flatMap((c) => [c.value, c.value_max]).filter((v) => typeof v === "number"));
  for (const a of moneyAmountsAt(prose)) {
    if (recorded.has(a.value) || spoken.has(a.value)) continue;
    if (!candidateValues.has(a.value)) {
      violations.push(`UNSUPPORTED_PRICE ${a.text}`);
      continue;
    }
    // a customer-contributed amount: only attributed as unverified, never as the place's current / official price
    const sentence = sentenceAt(prose, a.index);
    if (!ATTRIBUTED.test(sentence) || PRESENT_FACT.test(sentence)) violations.push(`UNATTRIBUTED_CANDIDATE ${a.text}`);
  }
  // a recorded (reference) price is "ghi nhận ngày …", never "giá hiện tại" — only a FOOD catalog price is current
  const pricesInScope = shownPrices ?? ledger.allPriceRecords();
  if (CURRENT_PRICE.test(prose) && pricesInScope.some((x) => x.source !== "FOOD catalog")) violations.push("UNSUPPORTED_CURRENT_PRICE");
  // a source named in the prose must be a source of this turn's data
  const hosts = new Set(ledger.allPriceRecords().map((x) => sourceHost(x.source)).filter(Boolean));
  for (const d of prose.matchAll(DOMAIN)) if (!hosts.has(d[0].toLowerCase().replace(/^www\./, ""))) violations.push(`UNSUPPORTED_SOURCE ${d[0]}`);
  for (const t of prose.matchAll(SOURCE_CLAIM)) {
    const word = foldText(t[1]);
    if (!/\./.test(word) && ![...hosts].some((h) => h.includes(word) || word === "food")) violations.push(`UNSUPPORTED_SOURCE ${t[1]}`);
  }
  // a date in the prose must be a capture date of this turn's data (or one the customer said)
  const days = new Set(ledger.allPriceRecords().map((x) => ddmm(x.captured_at)).filter(Boolean));
  const dayKey = (m) => `${Number(m[1] ?? m[3])}/${Number(m[2] ?? m[4])}`;
  const saidDays = new Set([...String(userText).matchAll(DATE)].map(dayKey));
  for (const m of prose.matchAll(DATE)) {
    const key = dayKey(m);
    if (!days.has(key) && !saidDays.has(key)) violations.push(`UNSUPPORTED_DATE ${m[0]}`);
  }
  const pool = referenced.length ? referenced : [...ledger.merchants.values()];
  if (OPEN_NOW.test(prose) && !pool.some((m) => m.openStatus === "open")) violations.push("UNSUPPORTED_OPEN_NOW");
  else if (OPEN_CLAIM.test(prose) && !pool.some((m) => (m.openingHours ?? []).length)) violations.push("UNSUPPORTED_OPENING_HOURS");
  if (!pool.some((m) => m.orderable) && orderClaims(prose).length) violations.push("UNSUPPORTED_ORDERABILITY");
  if (RATING_CLAIM.test(prose) && !pool.some((m) => (m.ratings ?? []).length)) violations.push("UNSUPPORTED_RATING");
  if (RANKING.test(prose)) violations.push("RANKING_NOT_ALLOWED");
  const known = `${ledger.corpus()} \n ${foldText(userText)} \n ${foldText(contextText)}`;
  for (const m of prose.matchAll(PROPER)) {
    const name = foldText(m[0]);
    if (!known.includes(name)) violations.push(`UNSUPPORTED_NAME ${m[0]}`);
  }
  // ADDRESS: street match != address match — the number and the street must be one recorded address
  const addresses = pool.map((m) => addressKey(m.address ?? "")).filter((a) => a.trim());
  const placeNames = [...ledger.merchants.values()].map((m) => foldText(m.name));
  for (const m of prose.matchAll(ADDRESS_CLAIM)) {
    const [, cue, number, street] = m;
    const streetKey = addressKey(street);
    const knownStreet = addresses.some((a) => a.includes(streetKey));
    if (!cue && !knownStreet) continue; // "3 Quán …": a number before a name, not an address
    if (placeNames.some((n) => n.startsWith(foldText(street)))) continue; // "2 Bún Cá Mẫu": a place's name
    if (!addresses.some((a) => a.includes(addressKey(`${number} ${street}`)))) violations.push(`UNSUPPORTED_ADDRESS ${number} ${street}`);
  }
  // EVALUATION: reputation / praise / comparison is never a fact FOOD holds (a negated sentence says nothing)
  for (const m of prose.matchAll(EVALUATIVE)) {
    const sentence = sentenceAt(prose, m.index);
    const before = sentence.slice(0, Math.max(0, sentence.indexOf(m[0])));
    if (!NEGATED.test(before)) violations.push(`UNSUPPORTED_EVALUATION ${m[0]}`);
  }
  // the customer's own number may come back only as their budget ("dưới / khoảng / tầm 50k"), never as a price
  for (const m of prose.matchAll(MONEY)) {
    const a = moneyAmounts(m[0])[0];
    if (!a || recorded.has(a.value) || !spoken.has(a.value)) continue;
    const before = prose.slice(Math.max(0, m.index - 30), m.index);
    if (!BUDGET_BEFORE.test(before) || PRICE_BEFORE.test(before)) violations.push(`CUSTOMER_PRICE_AS_FACT ${m[0]}`);
  }
  // RECOMMENDATION: advice drawn from founder guidance is FOOD's suggestion, and says so
  if (ledger.guidance?.length && RECOMMEND.test(prose) && !FOOD_SUGGESTS.test(prose)) violations.push("UNLABELLED_RECOMMENDATION");
  if (INTERNAL.test(prose)) violations.push("INTERNAL_DISCLOSURE");
  // ALIAS_MAPPING: two names are the same dish only when an approved relation of this turn says so
  if (ALIAS_CLAIM.test(prose)) {
    const folded = foldText(prose);
    if (!(ledger.aliases ?? []).some((a) => folded.includes(foldText(a.term)) && folded.includes(foldText(a.canonical)))) violations.push("UNSUPPORTED_ALIAS");
  }
  return violations;
}

const ATTRIBUTED = /(bạn gửi|anh\/chị gửi|anh chị gửi|chị gửi|anh gửi|khách gửi|khách hàng (?:cung cấp|gửi)|người dùng (?:cung cấp|gửi)|chưa xác minh|chưa được xác minh|theo ảnh|theo tin nhắn)/iu;
const PRESENT_FACT = /(hiện bán|đang bán|hiện có giá|giá hiện tại|giá hiện nay|giá chính thức|giá mới nhất|chắc chắn)/iu;

function moneyAmountsAt(text) {
  return [...String(text ?? "").matchAll(MONEY)].map((m) => ({ ...moneyAmounts(m[0])[0], index: m.index }));
}

/** The ordering CLAIMS of a text: ordering phrases that are neither negated nor part of an offer / question. */
function orderClaims(prose) {
  const text = String(prose);
  const positive = text.replace(NEGATED_ORDER, (m) => " ".repeat(m.length)); // same length: indexes stay valid
  const claims = [];
  for (const m of positive.matchAll(ORDER_CLAIM_ALL)) {
    const sentence = sentenceAt(text, m.index);
    const start = text.lastIndexOf(sentence, m.index);
    const before = sentence.slice(0, Math.max(0, m.index - start));
    const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":")) + 1);
    const question = text[start + sentence.length] === "?";
    if (ORDER_OFFER.test(clause) || (question && ORDER_WHICH.test(clause))) continue;
    claims.push(m[0]);
  }
  return claims;
}

/** The sentence around a position (the unit an attribution must share with the amount). */
function sentenceAt(text, index) {
  const s = String(text);
  // a "." between two digits is a thousands separator ("40.000đ", "1.200.000đ"), never the end of a sentence
  const isStop = (i) => ".!?\n".includes(s[i]) && !(s[i] === "." && /\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? ""));
  let start = 0;
  for (let i = index - 1; i >= 0; i--) if (isStop(i)) {
    start = i + 1;
    break;
  }
  let end = s.length;
  for (let i = index; i < s.length; i++) if (isStop(i)) {
    end = i;
    break;
  }
  return s.slice(start, end);
}

const BUDGET_BEFORE = /(?:dưới|trên|hơn|khoảng|tầm|không quá|tối đa|ngân sách|budget|trong|với|từ|đến|tới|(?:tầm|mức|khoảng) giá)\s*$/iu;
const PRICE_BEFORE = /(?<!(?:tầm|mức|khoảng)\s)giá\s*(?:khoảng|tầm|chỉ|là)?\s*$/iu;
const RECOMMEND = /(gợi ý|nên thử|nên ăn|nên chọn|nên gọi|khuyên|đề xuất|recommend)/iu;
const FOOD_SUGGESTS = /FOOD gợi ý/iu;
const INTERNAL = /(founder|nhà sáng lập|người sáng lập|ghi chú nội bộ|thông tin nội bộ|internal note)/iu;
const ALIAS_CLAIM = /(còn gọi là|còn được gọi là|hay gọi là|hay được gọi là|tên gọi khác|tên khác (?:là|của)|cũng chính là|chính là món|tức là món|là cách gọi)/iu;

const CURRENT_PRICE = /(giá hiện tại|giá hiện nay|giá bây giờ|hiện đang bán|hiện có giá|hiện giá|giá mới nhất hiện nay|giá hôm nay)/iu;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|vn|net|org|info|biz|io|app)(?:\.vn)?\b/giu;
const SOURCE_CLAIM = /theo\s+(?:nguồn|trang|website|web|ứng dụng|app)\s+([\p{L}\d.-]+)/giu;
const DATE = /\b(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*\d{2,4})?\b|\bngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\b/giu;

function sourceHost(source) {
  if (!source || source === "FOOD catalog") return null;
  try {
    return new URL(source).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function ddmm(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

/** Price records of the products an answer shows (null when it shows nothing: then the whole turn counts). */
function scopedPrices(items, ledger) {
  if (!items?.length) return null;
  const out = [];
  for (const item of items) {
    const m = ledger.merchants.get(item.merchant_id);
    if (!m) continue;
    const products = item.product_ids?.length ? item.product_ids.map((id) => m.products.get(id)).filter(Boolean) : [...m.products.values()];
    for (const p of products) out.push(...(p.prices ?? []));
    if (typeof m.cartSubtotal === "number") out.push({ price: m.cartSubtotal, source: "FOOD catalog" });
  }
  return out;
}

/** The customer-facing text: model prose + backend-rendered facts (Phase 5 answer contract). */
export function renderAnswer(answer, ledger) {
  const blocks = [answer.reply.trim()].filter(Boolean);
  for (const item of answer.items) {
    const m = ledger.merchants.get(item.merchant_id);
    if (!m) continue;
    const lines = [`📍 ${displayText(m.name)}`, `📌 ${m.address ? displayText(m.address) : "Chưa có địa chỉ trong nguồn hiện có"}`];
    for (const pid of item.product_ids ?? []) {
      const p = m.products.get(pid);
      if (!p) continue;
      lines.push(`🍜 ${displayText(p.name)}`);
      lines.push(...priceLines(p));
    }
    if (item.note?.trim()) lines.push(`💬 ${item.note.trim()}`);
    lines.push(m.orderable ? "✅ Đặt được qua FOOD" : "ℹ️ Thông tin tham khảo — chưa đặt qua FOOD được.");
    blocks.push(lines.join("\n"));
  }
  // customer contributions of this turn: rendered by the backend, always labelled (the model never formats them)
  const contributed = [...new Set((ledger.contributions ?? []).map((c) => c.display_line).filter(Boolean))].slice(0, 3);
  if (contributed.length) blocks.push(["ℹ️ Thông tin khách hàng cung cấp — chưa xác minh:", ...contributed].join("\n"));
  return blocks.join("\n\n");
}

function priceLines(p) {
  const recorded = (p.prices ?? []).filter((x) => typeof x.price === "number");
  if (p.priceStatus === "unavailable" || !recorded.length) return ["⚠️ Chưa có giá xác thực từ nguồn hiện có."];
  const label = (x) => `${x.variant ? `${x.variant}: ` : ""}${vnd(x.price)}${x.price_max ? `–${vnd(x.price_max)}` : ""}`;
  const sourceLine = (x) => (x.source && x.source !== "FOOD catalog" ? `🔗 ${host(x.source)}${x.captured_at ? ` · 🕒 ghi nhận ${day(x.captured_at)}` : ""}` : "🔗 Giá trên FOOD");
  if (p.priceStatus === "conflicting") {
    return [`⚠️ Các nguồn đang ghi giá khác nhau: ${recorded.map(label).join(" / ")} — em không chọn giá nào.`, sourceLine(recorded[0])];
  }
  return [`💰 ${recorded.map(label).join(" · ")}`, sourceLine(recorded[0])];
}
