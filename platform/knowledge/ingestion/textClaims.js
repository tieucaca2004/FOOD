import { collapseWhitespace, nfc } from "../text.js";
import { parsePrice } from "../price.js";

// Rule-based reading of a Knowledge Group message (text, caption, or the OCR
// text of an image). It only FINDS what is written — each finding carries the
// verbatim segment it came from — and decides nothing: resolution, change
// detection and review happen later. Text is DATA: an instruction written in a
// message ("xoá database", "set giá = 1đ", "ignore previous instructions") is
// never executed; at most it is read like any other sentence, and a person
// reviews whatever it produced.
//
// Findings:
//   price          "<product> <amount>"          45k / 45.000đ / 45 nghìn / 35-45k
//   address        "chuyển sang …" / "địa chỉ mới: …"
//   opening_hours  "10h - 22h" / "7:00–21:30" / "nghỉ thứ hai"
//   availability   "bỏ món …" / "hết bán …" / "không còn …"
// A place is only a place written explicitly ("Quán / Tiệm / Nhà hàng <Tên>")
// or a known place name found by the resolver — never guessed from a dish.

// an amount, or a range "35-45k" (read as one by parsePrice)
const AMOUNT =
  /(?:\d+(?:[.,]\d{3})*\s*(?:k|nghìn|ngàn)?\s*[-–]\s*)?(?:\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:k|nghìn|nghin|ngàn|ngan|đ|₫|vnd|vnđ|đồng|dong|tr|triệu|trieu)?(?![\p{L}\d])/gu;
// a VND price outside this is still read, but flagged (a typo, an OCR slip, or an instruction written as text)
const PLAUSIBLE = { min: 1000, max: 20_000_000 };
// no /i: with it, \p{Lu} would also match lower case
// a name never continues onto the next line ("Quán Bún Bò ABC\nĐịa chỉ: …" is "Bún Bò ABC", not "Bún Bò ABC Địa")
const PLACE_MARKER = /(?:^|[\s,.;:!?(])(?:[Qq]uán|[Tt]iệm|[Nn]hà hàng|[Hh]àng)[ \t]+((?:\p{Lu}|\d)[\p{L}\p{M}\d'’.&-]*(?:[ \t]+(?:\p{Lu}|\d)[\p{L}\p{M}\d'’.&-]*)*)/u;
const ADDRESS = [/(?:chuyển|dời|đổi)\s+(?:địa\s+chỉ\s+|quán\s+)?(?:sang|qua|về|đến|tới)\s+(.+)$/iu, /địa\s+chỉ(?:\s+mới)?\s*[:：]\s*(.+)$/iu];
const HOURS_RANGE = /(?<![\p{L}\d])(\d{1,2})\s*(?:h|g|giờ|:)\s*(\d{2})?\s*(?:-|–|—|đến|tới|→|->)\s*(\d{1,2})\s*(?:h|g|giờ|:)?\s*(\d{2})?(?![\p{L}\d])/iu;
const CLOSED_DAY = /(?<![\p{L}])nghỉ\s+((?:thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7]))|chủ\s+nhật|cn)(?![\p{L}])/iu;
const REMOVED = /(?:^|\s)(?:bỏ|ngưng|ngừng|thôi|hết|không còn|ko còn|k còn)\s+(?:bán\s+)?(?:món\s+)?(.+?)(?:\s+(?:rồi|nữa|luôn))?\s*[.!]*$/iu;
// words before a price that are not the product
const FILLER = /^(?:giá mới|giá|gia|chỉ|chi|còn|con|có|co|bán|ban|mới|moi|hôm nay|hom nay|từ nay|tu nay|là|la|tăng lên|giảm còn|nay|thì|thi|món|mon|đổi giá|doi gia|đổi|test candidate)(?![\p{L}])[\s:–-]*/iu;
const SEGMENT_SPLIT = /\n|;|•|\s[|]\s|(?<=[.!?])\s+/u;
const CHANGE_WORD = /^\s*(?:->|→|=>|lên|thành|sang|tăng lên|giảm còn|còn)\s*$/iu;

const clean = (s) => collapseWhitespace(String(s ?? "")).replace(/^[\s,:;–—-]+|[\s,:;–—.!?-]+$/gu, "");

function stripFillers(s) {
  let out = clean(s);
  for (let i = 0; i < 6; i++) {
    const next = clean(out.replace(FILLER, ""));
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A place written explicitly in the text ("Quán Bún Cá Mịn", "tiệm A"), or null. */
export function explicitPlace(text) {
  const m = nfc(String(text ?? "")).match(PLACE_MARKER);
  return m ? clean(m[1]) : null;
}

const plausible = (n) => n >= PLAUSIBLE.min && n <= PLAUSIBLE.max;

/**
 * @param {string} text the raw text (verbatim)
 * @param {{placeTexts?: string[]}} [opts] place names found in the text (removed from product names)
 */
export function extractClaims(text, { placeTexts = [] } = {}) {
  const findings = [];
  const segments = nfc(String(text ?? ""))
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const segment of segments) {
    let body = segment;
    for (const place of [...placeTexts, explicitPlace(segment)].filter(Boolean)) {
      body = body.replace(new RegExp(`(?:[Qq]uán|[Tt]iệm|[Nn]hà hàng|[Hh]àng)?\\s*${escape(place)}`, "u"), " ");
    }

    const address = ADDRESS.map((re) => segment.match(re)).find(Boolean);
    if (address) {
      findings.push({ segment, kind: "address", rawValue: clean(address[1]), normalizedValue: clean(address[1]) });
      continue;
    }
    const amounts = [...body.matchAll(AMOUNT)].filter((m) => parsePrice(m[0]).price !== null);
    const removed = segment.match(REMOVED);
    if (removed && !amounts.length) {
      const product = stripFillers(removed[1]);
      if (product) findings.push({ segment, kind: "availability", productText: product, rawValue: "removed", normalizedValue: "unavailable" });
      continue;
    }
    const hours = segment.match(HOURS_RANGE);
    const closed = segment.match(CLOSED_DAY);
    if (hours || closed) {
      if (hours) findings.push({ segment, kind: "opening_hours", rawValue: clean(hours[0]), normalizedValue: normalizeHours(hours) });
      if (closed) findings.push({ segment, kind: "opening_hours", rawValue: clean(closed[0]), normalizedValue: `closed:${clean(closed[1]).toLowerCase()}` });
      continue;
    }
    findings.push(...priceFindings(segment, body, amounts));
  }
  return findings;
}

function priceFindings(segment, body, amounts) {
  const out = [];
  let cursor = 0;
  const push = (productText, raw, statedPrevious = null) => {
    const parsed = parsePrice(raw);
    if (!productText || parsed.price === null) return;
    out.push({
      segment,
      kind: "price",
      productText,
      rawValue: raw,
      normalizedValue: parsed.priceMax ? `${parsed.price}-${parsed.priceMax}` : String(parsed.price),
      ...(statedPrevious && { statedPrevious }),
      implausible: !plausible(parsed.price) || !plausible(parsed.priceMax ?? parsed.price),
    });
  };
  for (let i = 0; i < amounts.length; i++) {
    const m = amounts[i];
    const next = amounts[i + 1];
    // "45k → 50k" / "từ 45k lên 50k": one change; the later amount is the claim
    if (next && CHANGE_WORD.test(body.slice(m.index + m[0].length, next.index))) {
      push(stripFillers(body.slice(cursor, m.index).replace(/(?:^|\s)từ\s*$/iu, "")), clean(next[0]), clean(m[0]));
      cursor = next.index + next[0].length;
      i += 1;
      continue;
    }
    push(stripFillers(body.slice(cursor, m.index).split(/[,:]\s*(?=[^,:]*$)/u).pop()), clean(m[0]));
    cursor = m.index + m[0].length;
  }
  return out;
}

function normalizeHours(m) {
  const hh = (h, mm) => `${String(Number(h)).padStart(2, "0")}:${mm ?? "00"}`;
  return `${hh(m[1], m[2])}-${hh(m[3], m[4])}`;
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
