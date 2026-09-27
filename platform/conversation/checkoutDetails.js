import { stripAccents } from "../../src/nlp/normalize.js";

// Deterministic extraction of checkout details from ANY message — alone
// ("giao qua 76 Nguyễn Thị Minh Khai") or mixed with an order ("cho 2 đặc
// biệt + 1 thập cẩm, gửi về 76 …, phone 0912…, 4h30 chiều nay"). Matching
// runs on accent-free text of identical length, so every span slices the
// ORIGINAL text: the address reaches the domain exactly as typed. No street,
// city or merchant is known here — only the grammar of giving an address.

const VERB = "(?:giao(?:\\s+hang)?|ship|chuyen(?:\\s+hang)?|gui(?:\\s+hang)?)";
const FOR_ME = "(?:\\s+cho\\s+(?:toi|minh|em|tui))?";
const PREP = "(?:qua|toi|den|ve|vao|tai|o)";
const QTY_START = "(?:\\d{1,3}|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\\s";
// The address ends at the end of the text or where a phone / time / note clause starts.
const END =
  "(?=\\s*[,;]\\s*(?:phone|sdt|so dien thoai|dien thoai|dt|so\\s+\\d|ghi chu|luc|vao luc|khoang|\\d{1,2}\\s*(?:h|gio)\\b|sang\\b|trua\\b|chieu\\b|toi nay)|\\s+(?:sdt|phone|so dien thoai)\\b|\\s*[,;.!?]*\\s*$)";

const ADDRESS_PATTERNS = [
  // "giao 2 phần hủ tiếu đến 76 …" — items between the verb and the address
  new RegExp(`^\\s*(${VERB}\\s+)(?=${QTY_START})(.+?)(\\s+(?:den|toi|qua|ve|tai)\\s+)(\\d.*?)${END}`),
  // "địa chỉ (giao / của tôi) là 76 …"
  new RegExp(`(?:^|[\\s,;.+])(dia chi(?:\\s+(?:giao hang|giao|nhan hang|nhan|cua toi|cua minh|nha toi|nha minh|la|o))*\\s*:?\\s+)(.+?)${END}`),
  // "giao qua / chuyển về / ship tới / gửi tới / giao hàng cho tôi tại 76 …"
  new RegExp(`(?:^|[\\s,;.+])(${VERB}${FOR_ME}\\s+${PREP}\\s+)(.+?)${END}`),
  // "giao 76 Nguyễn Thị Minh Khai" — verb straight into a house number
  new RegExp(`^\\s*(${VERB}\\s+)(\\d{1,4}[a-z]?(?:\\/\\d{1,4}[a-z]?)*\\s+[a-z]{2,}(?:\\s+[a-z0-9]+)+.*?)${END}`),
];
const NO_PREPOSITION_PATTERN = ADDRESS_PATTERNS.length - 1;

const PHONE_LABELLED = /(?:^|[\s,;])((?:phone|sdt|so dien thoai|dien thoai|dt)\s*:?\s*)(\+?\d[\d .]{6,14}\d)/;
const PHONE_BARE = /(?:^|[\s,;])((?:0|\+84)\d{9})(?![\d])/;
const TIME = /(?:^|[\s,;])((?:luc\s+|vao luc\s+|khoang\s+)?\d{1,2}\s*(?:h|gio)(?:\s*\d{1,2})?(?:\s*phut)?(?:\s+(?:sang|trua|chieu|toi))?(?:\s+nay)?)(?=[\s,;.!?]|$)/;

const VAGUE_ADDRESS = /^(day|do|nha|nha toi|nha minh|o day|cho nay|cho toi|toi|tui|minh|em|tan noi)$/;

function fold(text) {
  const original = String(text ?? "").normalize("NFC");
  const folded = stripAccents(original);
  return folded.length === original.length ? { original, folded } : { original: folded, folded };
}

function cleanVerbatim(text) {
  return text
    .replace(/(?:[\s,]+(?:nha|nhé|nhe|nhen|ạ|giúp em|giùm|giùm em|nha em|nhé ạ|em nhé|em nha))+[\s.!?]*$/iu, "")
    .replace(/^[\s,:;.\-–]+|[\s,;.!?]+$/g, "")
    .trim();
}

/** Accent-free words of the text, for vagueness checks. */
function words(text) {
  return stripAccents(text).replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * @returns {{
 *   addressFound: boolean, address: string|null,   // null = vague ("giao đây")
 *   phone: string|null, invalidPhone: string|null,
 *   note: string|null,
 *   remainder: string,                              // the rest of the message (the order part, if any)
 * }}
 */
export function extractCheckoutDetails(text) {
  const { original, folded } = fold(text);
  const spans = [];
  const out = { addressFound: false, address: null, phone: null, invalidPhone: null, note: null };

  for (const [patternIndex, re] of ADDRESS_PATTERNS.entries()) {
    const m = folded.match(re);
    if (!m) continue;
    // "giao 2 pizza hải sản" has the same shape as "giao 76 Nguyễn …": a
    // small leading number without "/" may be a quantity — flagged, and the
    // caller checks the menu before treating it as an address.
    if (patternIndex === NO_PREPOSITION_PATTERN) {
      const houseNumber = m[2].match(/^\d+/)[0];
      out.uncertain = Number(houseNumber) <= 50 && !/^\d+[a-z]?\//.test(m[2]);
    }
    const groups = m.slice(1);
    // the address is the last group; everything matched but the items is removed
    const addressGroup = groups[groups.length - 1];
    const matchStart = m.index + m[0].indexOf(groups[0]);
    const addressStart = m.index + m[0].length - addressGroup.length;
    const address = cleanVerbatim(original.slice(addressStart, addressStart + addressGroup.length));
    out.addressFound = true;
    out.address = !address || VAGUE_ADDRESS.test(words(address)) ? null : address;
    if (groups.length === 4) {
      // items pattern: keep the items, drop verb + preposition + address
      const itemsStart = matchStart + groups[0].length;
      spans.push([matchStart, itemsStart], [itemsStart + groups[1].length, addressStart + addressGroup.length]);
    } else {
      spans.push([matchStart, addressStart + addressGroup.length]);
    }
    break;
  }

  const outside = (idx) => !spans.some(([a, b]) => idx >= a && idx < b);
  let m = folded.match(PHONE_LABELLED);
  if (m && outside(m.index + m[0].indexOf(m[1]))) {
    const start = m.index + m[0].indexOf(m[1]);
    const digits = m[2].replace(/[ .]/g, "").replace(/^\+84/, "0").replace(/^84(?=\d{9}$)/, "0");
    if (/^0\d{9}$/.test(digits)) out.phone = digits;
    else out.invalidPhone = m[2].trim();
    spans.push([start, start + m[1].length + m[2].length]);
  } else if ((m = folded.match(PHONE_BARE)) && outside(m.index + m[0].indexOf(m[1]))) {
    const start = m.index + m[0].indexOf(m[1]);
    out.phone = m[1].replace(/^\+84/, "0");
    spans.push([start, start + m[1].length]);
  }

  m = folded.match(TIME);
  if (m && outside(m.index + m[0].indexOf(m[1]))) {
    const start = m.index + m[0].indexOf(m[1]);
    out.note = cleanVerbatim(original.slice(start, start + m[1].length));
    spans.push([start, start + m[1].length]);
  }

  let remainder = original;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) remainder = `${remainder.slice(0, a)} ${remainder.slice(b)}`;
  remainder = remainder.replace(/(?:\s*[,;]\s*)+/g, ", ").replace(/^[\s,;+]+|[\s,;+]+$/g, "").trim();
  return { ...out, remainder };
}

/**
 * "76 Nguyễn Thị Minh Khai", "12/3 Lê Lợi" — a house number followed by
 * words. Only ever used together with context (an address was just asked
 * for) or to ASK whether the text is an address — never alone to decide.
 */
export function looksLikeAddress(text) {
  return /^\s*\d{1,4}[a-z]?(?:\/\d{1,4}[a-z]?)*\s+\p{L}{2,}(?:\s+\p{L}+)+/iu.test(String(text ?? "").normalize("NFC"));
}
