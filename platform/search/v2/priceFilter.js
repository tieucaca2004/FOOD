// SEARCH INTELLIGENCE V2 — structured PriceFilter (pure).
//
// Semantics (documented, and echoed to the customer so a filter is never silently dropped):
//   dưới / không quá / tối đa / ít hơn / nhỏ hơn / <= X      -> max = X
//   trên / hơn / lớn hơn / từ X trở lên / >= X              -> min = X
//   (từ) X đến / tới / - Y, "X-Yk"                          -> min = X, max = Y (a unit on one side applies to both)
//   khoảng / tầm / cỡ / chừng / quanh / ~ X                 -> approx: X ± APPROX_TOLERANCE, rounded to 1.000 đ
// Units: k, nghìn/ngàn, đ/vnđ/vnd/đồng, tr/triệu; "30.000" / "30,000". A bare small number is a quantity, not money.
// Only RECORDED prices are compared later (reference prices, with source and date).

export const APPROX_TOLERANCE = 0.2;

const NUM = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(k|nghìn|nghin|ngàn|ngan|đồng|dong|đ|vnđ|vnd|tr|triệu|trieu)?`;
const AMT = String.raw`${NUM}\s*${UNIT}`;
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const rx = (s) => new RegExp(s, "iu");

const RANGE = rx(String.raw`${B}(?:(?:từ|tu)\s+)?${AMT}\s*(?:đến|den|tới|toi|-|~)\s*${AMT}${E}`);
const APPROX = rx(String.raw`${B}(?:khoảng|khoang|tầm|tam|cỡ|co|chừng|chung|quanh|xấp xỉ|xap xi|~)\s*${AMT}${E}`);
const MAX = rx(String.raw`${B}(?:dưới|duoi|không quá|khong qua|ko quá|ko qua|k quá|tối đa|toi da|nhỏ hơn|nho hon|ít hơn|it hon|bé hơn|be hon|<=?)\s*${AMT}${E}`);
const MIN = rx(String.raw`${B}(?:trên|tren|lớn hơn|lon hon|hơn|hon|>=?)\s*${AMT}${E}|${B}(?:từ|tu)\s*${AMT}\s*(?:trở lên|tro len)${E}`);

/** A written amount -> VND, or null ("45" alone is a quantity). */
export function toVnd(num, unit) {
  if (!num) return null;
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(num);
  let n = grouped ? Number(num.replace(/[.,]/g, "")) : Number(num.replace(",", "."));
  const u = String(unit ?? "").toLowerCase();
  if (["k", "nghìn", "nghin", "ngàn", "ngan"].includes(u)) n *= 1000;
  else if (["tr", "triệu", "trieu"].includes(u)) n *= 1_000_000;
  else if (!u && !grouped && n < 1000) return null;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const round1000 = (n) => Math.round(n / 1000) * 1000;

/**
 * @returns {null | {kind: "max"|"min"|"range"|"approx", min: number|null, max: number|null, target: number|null,
 *                   tolerance: number|null, text: string, index: number, length: number}}
 */
export function parsePriceFilter(text) {
  const t = String(text ?? "").normalize("NFC");
  const r = t.match(RANGE);
  if (r) {
    const a = toVnd(r[1], r[2] || r[4]);
    const b = toVnd(r[3], r[4] || r[2]);
    if (a && b) return { kind: "range", min: Math.min(a, b), max: Math.max(a, b), target: null, tolerance: null, text: r[0], index: r.index, length: r[0].length };
  }
  const ap = t.match(APPROX);
  if (ap) {
    const v = toVnd(ap[1], ap[2]);
    if (v) return { kind: "approx", min: round1000(v * (1 - APPROX_TOLERANCE)), max: round1000(v * (1 + APPROX_TOLERANCE)), target: v, tolerance: APPROX_TOLERANCE, text: ap[0], index: ap.index, length: ap[0].length };
  }
  const mx = t.match(MAX);
  if (mx) {
    const v = toVnd(mx[1], mx[2]);
    if (v) return { kind: "max", min: null, max: v, target: null, tolerance: null, text: mx[0], index: mx.index, length: mx[0].length };
  }
  const mn = t.match(MIN);
  if (mn) {
    const v = toVnd(mn[1] ?? mn[3], mn[2] ?? mn[4]);
    if (v) return { kind: "min", min: v, max: null, target: null, tolerance: null, text: mn[0], index: mn.index, length: mn[0].length };
  }
  return null;
}

const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;

/** How the filter is said back to the customer. */
export function describePriceFilter(f) {
  if (!f) return "";
  if (f.kind === "approx") return `khoảng ${vnd(f.target)} (em lọc ${vnd(f.min)}–${vnd(f.max)})`;
  if (f.kind === "range") return `từ ${vnd(f.min)} đến ${vnd(f.max)}`;
  if (f.kind === "max") return `không quá ${vnd(f.max)}`;
  return `từ ${vnd(f.min)} trở lên`;
}
