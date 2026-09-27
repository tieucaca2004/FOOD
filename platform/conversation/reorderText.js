// The "như cũ" proposal text, shared by the generic engine and the router
// (modules with their own engine), so both say exactly the same thing.

export function vnd(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}

/**
 * @param candidate from CustomerMemoryService.buildReorderCandidate
 * @param opts { merchantName, address, fulfillment, extraCartItems, extraCartTotal }
 */
export function formatReorderCandidate(candidate, { merchantName, address, fulfillment, extraCartItems = 0, extraCartTotal = 0 }) {
  const gone = candidate.unavailable.map((u) => `⚠️ ${u.name} hiện không còn trong menu — em không tự thay bằng món khác.`);
  if (candidate.items.length === 0) {
    return `${gone.join("\n")}\n\nAnh/chị muốn chọn món khác không ạ? (gõ "menu" để xem thực đơn)`;
  }
  const heading =
    candidate.source === "recurring_order" ? `Dạ, đơn anh/chị hay đặt ở ${merchantName}:` : `Dạ, đơn lần trước của anh/chị ở ${merchantName}:`;
  const lines = candidate.items.map((i) => `• ${i.quantity} × ${i.name} — ${vnd(i.price)} = ${vnd(i.price * i.quantity)}`);
  const notes = candidate.instructions.map((i) => i.label);
  const details = [
    notes.length ? `📝 ${notes.join(", ")}` : null,
    fulfillment === "pickup" ? "🏪 Nhận tại quán" : address ? `📍 Giao tới: ${address}` : null,
  ].filter(Boolean);
  const inCart = extraCartItems ? [`(Giỏ đang có ${extraCartItems} món khác — em sẽ đặt chung trong đơn này.)`] : [];
  const ask =
    address || fulfillment === "pickup"
      ? 'Anh/chị xác nhận đặt đơn này nhé? (gõ "ừ" / "đúng")'
      : 'Anh/chị xác nhận món nhé? (gõ "ừ" / "đúng", sau đó cho em xin địa chỉ giao)';
  return [
    heading,
    "",
    ...lines,
    ...gone,
    ...(details.length ? ["", ...details] : []),
    ...inCart,
    `Tạm tính: ${vnd(candidate.total + extraCartTotal)}`,
    "",
    ask,
  ].join("\n");
}
