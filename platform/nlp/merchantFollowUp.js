import { classifyIntent } from "../../src/nlp/intentEngine.js"; // pure, read-only reuse
import { normalizeForMatch } from "./searchQuery.js";

// Detects a message that only makes sense about ONE merchant ("có menu quán
// ko", "quán ở đâu", "có Seafood Pizza không", "cho tôi 2 …"), so the
// platform router can answer it with the merchant the customer just found
// instead of running a new marketplace-wide search. Deterministic, generic:
// nothing here knows any merchant.
//
// Phrases are matched on accent-free text too, because customers type
// "co thuc don ko" / "quan o dau" as often as the accented form.

const MENU = /\b(menu|thuc don|co mon gi|mon gi|xem mon|danh sach mon|ban gi|ban nhung gi|co nhung gi)\b/;
// Phrases that qualify a menu request without naming anything.
const MENU_QUALIFIERS = /\b(toan bo|tat ca|day du|full|het|ban gi|ban nhung gi|co nhung gi)\b/g;
const LOCATION = /\b(dia chi|(quan|shop|nha hang)( nay| do)? (o|nam o) dau)\b|^(o dau|dia chi)( vay| the| a)?$/;
const LEADING_QUANTITY_ITEM = /^(?:\d{1,3}|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s+(?:(?:phan|suat|cai|dia|ly|to|chai|lon)\s+)?[a-z]{2,}/;
const ASKS_WHICH_MERCHANT =/\b(quan nao|nha hang nao|shop nao|noi nao|cho nao)\b/;
const PRODUCT_QUESTION =/^(?:quan\s+(?:nay\s+)?)?(?:co|con)\s+(.+?)\s+(?:khong|ko|k|hong|hem|chua)$/;

// A Tiểu's classifyIntent labels that always target a single merchant.
const MERCHANT_SCOPED_INTENTS = new Set([
  "product_price",
  "product_availability",
  "add_to_cart",
  "show_cart",
  "update_cart",
  "remove_from_cart",
  "clear_cart",
  "checkout",
  "opening_hours",
]);

// Words that carry the follow-up itself, not a merchant name.
const FOLLOW_UP_WORDS = new Set(
  "co menu thuc don mon gi xem danh sach quan nay do o nam dau dia chi shop nha hang khong ko k hong hem chua gui tui toi minh em cho di vay the a nhe nha voi"
    .split(" ")
);

/**
 * @returns {null | {kind: "menu"|"location"|"merchant_message", rest: string}}
 *   rest: accent-free leftover words (maybe a merchant name, e.g. "menu nom nom").
 */
export function classifyMerchantFollowUp(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;
  // "có quán nào bán pizza không" asks WHICH merchant — a marketplace search.
  if (ASKS_WHICH_MERCHANT.test(normalized)) return null;
  const rest = normalized
    .replace(MENU_QUALIFIERS, " ")
    .split(" ")
    .filter((w) => !FOLLOW_UP_WORDS.has(w))
    .join(" ");

  if (MENU.test(normalized)) return { kind: "menu", rest };
  if (LOCATION.test(normalized)) return { kind: "location", rest };
  if (PRODUCT_QUESTION.test(normalized)) return { kind: "merchant_message", rest: "" };
  if (MERCHANT_SCOPED_INTENTS.has(classifyIntent(text).intent)) return { kind: "merchant_message", rest: "" };
  // "2 pizza tôm" — items with a quantity but no verb are still an order.
  if (LEADING_QUANTITY_ITEM.test(normalized)) return { kind: "merchant_message", rest: "" };
  return null;
}

/** "có Seafood Pizza không" -> "seafood pizza"; null when it isn't a "có … không" question. */
export function parseProductQuestion(text) {
  const m = normalizeForMatch(text).match(PRODUCT_QUESTION);
  return m ? m[1] : null;
}
