// Deterministic parsers for checkout answers — never guesses; returns null
// when the text doesn't clearly match, so the router can ask again instead
// of silently assuming.

export function parseFulfillmentType(text) {
  const t = text.toLowerCase();
  if (/(mang về|mang di|mang đi|takeaway|take away)/.test(t)) return "takeaway";
  if (/(giao hàng|giao tận nơi|ship|delivery)/.test(t)) return "delivery";
  if (/(tại quán|ăn tại|dine in|dine-in|ngồi lại)/.test(t)) return "dine_in";
  return null;
}

export function parsePhone(text) {
  const match = text.match(/(0\d{9,10}|\+84\d{8,10})/);
  return match ? match[0] : null;
}

export function fulfillmentTypeLabel(type) {
  return { dine_in: "Ăn tại quán", takeaway: "Mang về", delivery: "Giao hàng" }[type] || type;
}
