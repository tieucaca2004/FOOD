import { stripAccents } from "../../src/nlp/normalize.js";

// Deterministic entity extraction for the generic merchant chat cart
// (GenericMerchantAdapter). Intent classification itself reuses A Tiểu's
// pure classifyIntent() unchanged; this module only answers "which
// product(s)?" and "how many?" against a generic merchant's own catalog.
//
// Quantity is read ONLY from the first token after the command words (or a
// trailing "x2"/"2"), never from anywhere in the text: dish names contain
// words like "Nấm" -> "nam" which A Tiểu's extractQuantity() would read as 5.

const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };

// Command/filler tokens (accent-stripped) that never identify a product.
const FILLER = new Set([
  "them", "lay", "order", "mua", "cho", "toi", "minh", "em", "anh", "chi", "ban", "xin", "gium", "giup",
  "phan", "suat", "mon", "cai", "ly", "dia", "chai", "lon", "nha", "nhe", "a", "voi", "nua", "di", "nhen",
  "bao", "nhieu", "tien", "gia", "vay", "the", "so", "luong", "khong", "con",
]);

export function normalizeText(text) {
  return stripAccents(text || "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(text) {
  const n = normalizeText(text);
  return n ? n.split(" ") : [];
}

function parseQuantityToken(token) {
  if (token === undefined) return null;
  const m = token.match(/^x?(\d{1,3})$/);
  if (m) return Number(m[1]);
  return NUMBER_WORDS[token] ?? null;
}

/**
 * "thêm 2 pizza hải sản nha" -> { quantity: 2, query: "pizza hai san" }
 * quantity is null when the text doesn't state one (caller defaults to 1).
 */
export function parseItemRequest(text) {
  let t = tokens(text);
  while (t.length && FILLER.has(t[0])) t.shift();

  let quantity = parseQuantityToken(t[0]);
  if (quantity !== null) t = t.slice(1);
  else {
    const last = t[t.length - 1];
    const trailing = last !== undefined && /^x?\d{1,3}$/.test(last) ? parseQuantityToken(last) : null;
    if (trailing !== null) {
      quantity = trailing;
      t = t.slice(0, -1);
    }
  }
  return { quantity, query: t.filter((w) => !FILLER.has(w)).join(" ") };
}

/**
 * Like parseItemRequest, but checked against the catalog: a leading number
 * that is really the start of a dish name ("thêm 3 cheeses Pizza" for
 * "3 cheeses Pizza - …") is kept as part of the name, not read as a
 * quantity. "thêm 2 phần 3 cheeses Pizza" still means two of that dish.
 * @returns {{quantity: number|null, query: string, match: object|null, candidates: object[]}}
 */
export function resolveItemRequest(text, products) {
  const req = parseItemRequest(text);
  if (req.quantity !== null) {
    const leading = tokens(text).find((t) => !FILLER.has(t));
    const withNumber = [leading, req.query].filter(Boolean).join(" ");
    const whole = matchByName(withNumber, products);
    if (whole.match && tokens(whole.match.name)[0] === leading) {
      return { quantity: null, query: withNumber, ...whole };
    }
  }
  return { ...req, ...matchByName(req.query, products) };
}

/**
 * "đổi pizza hải sản thành 3 phần" / "tăng pizza hải sản lên 3"
 *   -> { query: "pizza hai san", quantity: 3 }
 * Returns null when the text isn't a quantity change.
 */
export function parseQuantityChange(text) {
  const m = normalizeText(text).match(/\b(?:doi|sua|thay|tang|giam)\s+(.*?)\s*\b(?:thanh|len|xuong)\s+(\S+)/);
  if (!m) return null;
  const quantity = parseQuantityToken(m[2]) ?? (m[2] === "khong" ? 0 : null);
  return { query: m[1].split(" ").filter((w) => w && !FILLER.has(w)).join(" "), quantity };
}

/** "bỏ coca" / "xóa món pizza hải sản" -> "coca" / "pizza hai san" */
export function parseRemoval(text) {
  const m = normalizeText(text).match(/(?:bo|huy|xoa)\s+(.+)/);
  if (!m) return "";
  return m[1].split(" ").filter((w) => w && !FILLER.has(w)).join(" ");
}

function tokenCovered(queryToken, nameTokens) {
  return nameTokens.some((n) => n === queryToken || (queryToken.length >= 4 && n.startsWith(queryToken)));
}

/**
 * Matches a normalized query against items with a `name`. Every query token
 * must appear in the name (or prefix a name word, for 4+ chars), or the
 * query must appear as a compact substring ("cocacola" in "coca cola").
 * Several candidates are narrowed to an exact full-name / " - " half match
 * when exactly one exists; otherwise the caller must ask the customer.
 * @returns {{match: object|null, candidates: object[]}}
 */
export function matchByName(query, items) {
  const q = tokens(query);
  if (q.length === 0) return { match: null, candidates: [] };
  const compactQuery = q.join("");

  const candidates = items.filter((item) => {
    const nameTokens = tokens(item.name);
    if (q.every((t) => tokenCovered(t, nameTokens))) return true;
    return compactQuery.length >= 4 && nameTokens.join("").includes(compactQuery);
  });

  if (candidates.length === 1) return { match: candidates[0], candidates };
  if (candidates.length > 1) {
    const wanted = q.join(" ");
    const exact = candidates.filter((item) =>
      [item.name, ...item.name.split(" - ")].some((part) => normalizeText(part) === wanted)
    );
    if (exact.length === 1) return { match: exact[0], candidates };
  }
  return { match: null, candidates };
}
