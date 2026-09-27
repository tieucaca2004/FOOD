// OSM opening_hours -> {mo: [["06:00","22:00"]], …} for the simple, common
// forms only. Anything more complex (holidays, "off", week numbers, months,
// sunrise…) -> null: the original text is always kept by the caller and a
// null structure means "open now" is never answered from it.

const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const TIME = /^([01]\d|2[0-4]):([0-5]\d)$/;

function dayRange(spec) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const [a, b] = part.trim().toLowerCase().split("-");
    const i = DAYS.indexOf(a);
    const j = b === undefined ? i : DAYS.indexOf(b);
    if (i < 0 || j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) {
      out.add(DAYS[k]);
      if (k === j) break;
    }
  }
  return [...out];
}

function timeRanges(spec) {
  const ranges = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.trim().split("-");
    if (!TIME.test(a ?? "") || !TIME.test(b ?? "")) return null;
    ranges.push([a, b]);
  }
  return ranges;
}

export function parseOpeningHours(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (s === "24/7") return Object.fromEntries(DAYS.map((d) => [d, [["00:00", "24:00"]]]));
  const week = {};
  for (const rule of s.split(";").map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^(?:([A-Za-z,-]+)\s+)?([\d:,\s-]+)$/);
    if (!m) return null;
    const days = m[1] ? dayRange(m[1]) : DAYS;
    const times = timeRanges(m[2].replace(/\s+/g, ""));
    if (!days || !times) return null;
    for (const d of days) week[d] = times;
  }
  return Object.keys(week).length ? week : null;
}
