// All money values are integer VND. Never floats, never client-supplied.

export function formatVnd(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}

export function isValidQuantity(qty, maxQuantity) {
  return Number.isInteger(qty) && qty > 0 && qty <= maxQuantity;
}

export function sumLineTotals(items) {
  return items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
}
