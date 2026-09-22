import { config } from "../config.js";

// AT-YYYYMMDD-<seq> — seq is the per-day count passed in by the caller
// (repository counts existing orders for the day inside the same transaction).
export function generateOrderCode(date, seqForDay) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const seq = String(seqForDay).padStart(3, "0");
  return `${config.orderCodePrefix}-${y}${m}${d}-${seq}`;
}
