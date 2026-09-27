// Vietnamese price text -> integer VND. The ORIGINAL text is always kept by
// the caller; this only reads what is unambiguously written. Anything else
// -> null (never guessed).
//   "45K" / "45k" / "45 nghìn" / "45 ngàn"  -> 45000
//   "45.000đ" / "45,000 VND" / "45000"      -> 45000
//   "45-60k" / "45k - 60k"                  -> { price: 45000, priceMax: 60000 }
//   "1tr2" / "1,2 triệu"                    -> 1200000
//   "giá liên hệ", "thời giá"               -> null

const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?`;
const UNIT = String.raw`k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|đ|₫|d|vnd|vnđ|đồng|dong`;
const ONE = new RegExp(`^(${NUMBER})\\s*(${UNIT})?(\\d{1,3})?$`, "i");

function toNumber(text, unit, trailing) {
  const u = (unit || "").toLowerCase();
  const thousandsGrouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(text);
  let n;
  if (thousandsGrouped) n = Number(text.replace(/[.,]/g, ""));
  else n = Number(text.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (["k", "nghìn", "nghin", "ngàn", "ngan"].includes(u)) n *= 1000;
  else if (["tr", "triệu", "trieu"].includes(u)) {
    // "1tr2" = 1.2 triệu
    n = (trailing ? Number(`${n}.${trailing}`) : n) * 1_000_000;
  } else if (trailing) return null;
  n = Math.round(n);
  // a bare small number ("45") is not a price in VND without a unit
  if (!u && !thousandsGrouped && n < 1000) return null;
  return n;
}

/**
 * @returns {{price: number|null, priceMax: number|null, currency: "VND"}}
 */
export function parsePrice(text) {
  const clean = String(text ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[/]\s*(phần|tô|dĩa|đĩa|ly|cái|suất|kg|con)$/i, "")
    .trim();
  const none = { price: null, priceMax: null, currency: "VND" };
  if (!clean) return none;
  const parts = clean.split(/\s*(?:-|–|~|đến)\s*/);
  if (parts.length > 2) return none;
  const read = (part, fallbackUnit) => {
    const m = part.match(ONE);
    if (!m) return null;
    return toNumber(m[1], m[2] || fallbackUnit, m[3]);
  };
  if (parts.length === 2) {
    const unit2 = parts[1].match(ONE)?.[2];
    const lo = read(parts[0], unit2);
    const hi = read(parts[1]);
    if (lo === null || hi === null || hi < lo) return none;
    return { price: lo, priceMax: hi, currency: "VND" };
  }
  const value = read(clean);
  return value === null ? none : { price: value, priceMax: null, currency: "VND" };
}
