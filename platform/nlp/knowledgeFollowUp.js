import { fold } from "../conversation/understand.js";

// A question ABOUT a list the customer was just shown — "sao ko có giá?",
// "giá bao nhiêu?", "địa chỉ quán đầu", "mấy giờ mở?", "còn quán nào nữa?".
// Only the question words are read here; which dish, place or region the
// message may name is the FoodSemanticParser's business (the router asks
// Food Knowledge before treating a message as a follow-up), so a message
// naming something new is never taken for a follow-up.
//
// "giá" (price) and "gia" (family, as in "gia đình") fold to the same
// letters, so an accented message needs the accented "giá"; the bare
// "gia" counts only in a message typed without any accents.

// "thứ hai" = 2 … "thứ mười" = 10; any written number 1..99 ("quán thứ 10", "món số 7")
const NUMBER_WORDS = { nhat: 1, hai: 2, ba: 3, tu: 4, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
/** 0-based position after a noun ("quan" / "mon"), -1 = the last one, or null. */
function position(n, noun) {
  if (new RegExp(`\\b${noun} (?:dau tien|dau)\\b`).test(n)) return 0;
  if (new RegExp(`\\b${noun} cuoi(?: cung)?\\b`).test(n)) return -1;
  const m = n.match(new RegExp(`\\b${noun} (?:(?:thu|so) )?(\\d{1,2}|nhat|hai|ba|tu|bon|nam|sau|bay|tam|chin|muoi)\\b`));
  if (!m) return null;
  const k = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  // a bare word after the noun is a number only in the ordinal form ("quán thứ hai", "quán 2"; not "quán ba …" alone)
  if (!/^\d+$/.test(m[1]) && !new RegExp(`\\b${noun} (?:thu|so) `).test(n) && m[1] !== "nhat") return null;
  return k >= 1 ? k - 1 : null;
}
// "quán này / quán đó / chỗ đó / tiệm ấy": the place the conversation is ABOUT (the router resolves it,
// or asks back) — never "the first one" by default
const FOCUS = /\b(?:quan|cho|tiem|nha hang) (?:nay|do|kia|ay)\b/;
// "món đó / món này": the dish last answered about
const PRODUCT_FOCUS = /\bmon (?:nay|do|kia|ay)\b/;
// "còn không?", "còn bán không?", "món đó còn không?", "hết chưa?": is it still available (FOOD has no such data)
const AVAILABILITY = /^(?:(?:quan|mon|cho|tiem) (?:nay|do|kia|ay) )?(?:con (?:ban |mo |mon |hang |phuc vu )?(?:khong|ko|k|hong|khum|hok)|het chua|het (?:mon|hang) chua)$/;

// Question / follow-up words (folded). What remains of a message without them is the part that could
// name something new ("giá BÚN BÒ bao nhiêu" -> "bún bò" -> a new search, not a follow-up).
const QUESTION_WORDS = new Set(
  ("sao ko k khong hong ko co gia bao nhieu tien may gio mo cua dong luc nao dia chi o dau cho duong nam quan con nua them xem " +
    "khac thu nhat hai ba tu so cuoi nay do kia vay the a nhi va cac nhung em anh chi minh toi oi giac den tien vui long cho biet " +
    "hoi la gi ban menu thuc don cung thi tiem ay hang 1 2 3 4 5 mon di nhe nha het phuc vu sau bay tam chin muoi bon").split(" ")
);

function residue(original) {
  return original
    .split(/\s+/)
    .filter((w) => {
      const key = fold(w).folded.replace(/[^a-z0-9]/g, "");
      return key && !QUESTION_WORDS.has(key) && !/^\d{1,2}$/.test(key);
    })
    .join(" ");
}

/**
 * @returns {{kind: "price"|"hours"|"address"|"more"|"place"|"product"|"availability", ordinal: number|null, ref: "focus"|null, productOrdinal?: number|null, productRef?: "focus"|null, residue: string} | null}
 *   productOrdinal / productRef: a dish of the menu shown ("món thứ 2" / "món đó"), never a place
 *   ordinal: 0-based place in the list; -1 = the last one shown; null = no position given
 *   ref: "focus" = "quán này / quán đó …", the place last talked about (ordinal and ref both null = the whole list)
 *   residue: the message without its question words — what the caller checks for a new dish / place
 */
export function classifyKnowledgeFollowUp(text) {
  const { original, folded } = fold(String(text ?? "").trim());
  const lower = original.toLowerCase();
  const n = folded.replace(/[^a-z0-9]+/g, " ").trim();
  if (!n) return null;
  const plain = !/[^\x00-\x7f]/.test(lower);
  // a DISH position / reference ("món thứ 2", "món đầu tiên", "món đó") — never a place position
  const productOrdinal = position(n, "mon");
  const productRef = productOrdinal === null && PRODUCT_FOCUS.test(n) ? "focus" : null;
  const ordinal = position(n, "quan") ?? (productOrdinal === null && !/\bmon\b/.test(n) && /\b(?:dau tien|thu nhat)\b/.test(n) ? 0 : null) ?? (productOrdinal === null && /\bcuoi cung\b/.test(n) ? -1 : null);
  const ref = ordinal === null && FOCUS.test(n) ? "focus" : null;
  if (AVAILABILITY.test(n)) return { kind: "availability", ordinal, ref, productOrdinal, productRef, residue: "" };

  const price =
    /(?:^|[^\p{L}])giá(?:$|[^\p{L}])/u.test(lower) ||
    (plain && /\bgia\b/.test(n)) ||
    /\b(?:bao nhieu tien|may tien|nhieu tien)\b/.test(n) ||
    /\bbao nhieu$/.test(n);
  const rest = residue(original);
  if (price) return { kind: "price", ordinal, ref, productOrdinal, productRef, residue: rest };
  // "món thứ 2", "cho tôi món đó", "món đầu tiên đi": that one dish of the menu shown
  if (productOrdinal !== null || productRef) return { kind: "product", ordinal: null, ref: null, productOrdinal, productRef, residue: rest };
  if (/\b(?:may gio|gio mo|mo cua|dong cua|gio giac|mo luc|mo den)\b/.test(n)) return { kind: "hours", ordinal, ref, residue: rest };
  if (/\b(?:dia chi|o dau|cho nao|duong nao|nam o)\b/.test(n)) return { kind: "address", ordinal, ref, residue: rest };
  if (/\b(?:con quan nao|quan nao nua|quan khac|them quan|xem them|con nua|nua khong|con gi nua)\b/.test(n)) return { kind: "more", ordinal: null, ref: null, residue: rest };
  // "quán thứ 2 thì sao?", "quán này có bán không?", "menu quán đó": that one place
  if (ordinal !== null || ref) return { kind: "place", ordinal, ref, residue: rest };
  return null;
}
