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

const ORDINALS = [
  [/\bquan (?:dau tien|dau|thu nhat|so 1|1)\b|\bdau tien\b/, 0],
  [/\bquan (?:thu hai|thu 2|so 2|2)\b/, 1],
  [/\bquan (?:thu ba|thu 3|so 3|3)\b/, 2],
  [/\bquan (?:thu tu|thu 4|so 4|4)\b/, 3],
  [/\bquan (?:thu nam|thu 5|so 5|5)\b/, 4],
  [/\bquan cuoi\b|\bcuoi cung\b/, -1],
];
// "quán này / quán đó / chỗ đó / tiệm ấy": the place the conversation is ABOUT (the router resolves it,
// or asks back) — never "the first one" by default
const FOCUS = /\b(?:quan|cho|tiem|nha hang) (?:nay|do|kia|ay)\b/;

// Question / follow-up words (folded). What remains of a message without them is the part that could
// name something new ("giá BÚN BÒ bao nhiêu" -> "bún bò" -> a new search, not a follow-up).
const QUESTION_WORDS = new Set(
  ("sao ko k khong hong ko co gia bao nhieu tien may gio mo cua dong luc nao dia chi o dau cho duong nam quan con nua them xem " +
    "khac thu nhat hai ba tu so cuoi nay do kia vay the a nhi va cac nhung em anh chi minh toi oi giac den tien vui long cho biet " +
    "hoi la gi ban menu thuc don cung thi tiem ay hang 1 2 3 4 5").split(" ")
);

function residue(original) {
  return original
    .split(/\s+/)
    .filter((w) => {
      const key = fold(w).folded.replace(/[^a-z0-9]/g, "");
      return key && !QUESTION_WORDS.has(key);
    })
    .join(" ");
}

/**
 * @returns {{kind: "price"|"hours"|"address"|"more"|"place", ordinal: number|null, ref: "focus"|null, residue: string} | null}
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
  const ordinal = ORDINALS.find(([re]) => re.test(n))?.[1] ?? null;
  const ref = ordinal === null && FOCUS.test(n) ? "focus" : null;

  const price =
    /(?:^|[^\p{L}])giá(?:$|[^\p{L}])/u.test(lower) ||
    (plain && /\bgia\b/.test(n)) ||
    /\b(?:bao nhieu tien|may tien|nhieu tien)\b/.test(n) ||
    /\bbao nhieu$/.test(n);
  const rest = residue(original);
  if (price) return { kind: "price", ordinal, ref, residue: rest };
  if (/\b(?:may gio|gio mo|mo cua|dong cua|gio giac|mo luc|mo den)\b/.test(n)) return { kind: "hours", ordinal, ref, residue: rest };
  if (/\b(?:dia chi|o dau|cho nao|duong nao|nam o)\b/.test(n)) return { kind: "address", ordinal, ref, residue: rest };
  if (/\b(?:con quan nao|quan nao nua|quan khac|them quan|xem them|con nua|nua khong|con gi nua)\b/.test(n)) return { kind: "more", ordinal: null, ref: null, residue: rest };
  // "quán thứ 2 thì sao?", "quán này có bán không?", "menu quán đó": that one place
  if (ordinal !== null || ref) return { kind: "place", ordinal, ref, residue: rest };
  return null;
}
