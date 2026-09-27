// How long an observation may be presented as "recently seen". Older data is
// never deleted — it is labelled stale and shown with its date, or not used
// for "current" questions (price now, open now, rating now).
export const FRESHNESS_DAYS = Object.freeze({
  price: 180,
  rating: 90,
  menu: 180,
  opening_hours: 365,
  merchant_claim: 365,
  location: 730,
});

export function ageDays(isoDate, now = new Date()) {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

export function isStale(kind, lastSeenAt, now = new Date()) {
  const limit = FRESHNESS_DAYS[kind];
  const age = ageDays(lastSeenAt, now);
  return limit === undefined || age === null ? true : age > limit;
}
