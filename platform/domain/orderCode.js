// Same shape as src/domain/orderCode.js (A Tiểu's own order-code
// generator) — not imported directly because that function hard-reads
// A Tiểu's own src/config.js `orderCodePrefix`, which would tag every
// platform order (including non-A-Tiểu merchants' orders) with A Tiểu's
// "AT-" prefix. This is a small, independent copy with the prefix passed
// in explicitly instead, so platform order codes carry the platform's own
// prefix (platformConfig.orderCodePrefix).
//
// PREFIX-YYYYMMDD-<seq> — seq is the per-day count, computed by the
// caller inside the same DB transaction as the insert (see
// PlatformOrderRepository.createDraft, same technique A Tiểu's own
// OrderRepository.createDraftFromCart already uses).
export function generateOrderCode(date, seqForDay, prefix) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const seq = String(seqForDay).padStart(3, "0");
  return `${prefix}-${y}${m}${d}-${seq}`;
}
