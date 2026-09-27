import { stripAccents } from "../../src/nlp/normalize.js";
import { extractCheckoutDetails } from "./checkoutDetails.js";
import { extractFoodInstructions } from "./foodInstructions.js";

// Deterministic language understanding for the Conversational Ordering
// Engine: one message -> { intent, entities }. No merchant, menu or cart
// knowledge lives here — resolving "tôm" to a product, "cái đó" to a cart
// line or "2" to a choice is the engine's job, using conversation state.
//
// All rules run on accent-free text, so "có sủi cảo không" and "co sui cao
// khong" behave the same. Folding keeps the NFC text's length, so regex
// offsets on the folded text slice the ORIGINAL (accented) text — used for
// addresses, notes and item segments, which must reach the domain verbatim.

const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const QTY = "(\\d{1,3}|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)";
const UNIT = "(?:phan|suat|cai|dia|ly|to|chai|lon|hop|con|mon)";
const ADD_VERB = "(?:cho|them|lay|order|mua|dat|goi|an)";

// "cái đó", "món này", "nó" — refers back to the product/line just discussed.
const BACK_REFERENCE = /^(?:cai|mon|phan)?\s*(?:do|nay|kia|vua roi|vua them|vua dat|vua chon)$|^no$/;

// Trailing politeness that never changes meaning.
const POLITE_TAIL = /(?:\s+(?:nha|nhe|nhen|a|ah|di|voi|giup em|giup toi|giup minh|giup|dum|gium|nhe a|nha em|em oi|shop oi|ad oi))+$/;

const YES = /^(dung|dung roi|dung vay|phai|phai roi|u|uh|um|ok|oke|okay|yes|y|chuan|chuan roi|chinh xac|vang|da|da dung|da vang|co|duoc|mon do|dung mon do)$/;
const NO = /^(khong|ko|k|khong phai|sai|sai roi|khong dung|no|khong phai mon do)$/;

/** Answer to a yes/no question ("ý anh/chị là X phải không?"): true, false or null. */
export function yesNoAnswer(text) {
  const core = stripPolite(toNorm(fold(String(text ?? "").trim()).folded));
  if (YES.test(core)) return true;
  if (NO.test(core)) return false;
  return null;
}

export function parseCount(token) {
  if (token === undefined || token === null) return null;
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

/** NFC text + its accent-free lowercase fold with identical length (for offset slicing). */
export function fold(text) {
  const original = String(text ?? "").normalize("NFC");
  const folded = stripAccents(original);
  // stripAccents is length-preserving for NFC Vietnamese; if some exotic
  // character breaks that, fall back to the folded text on both sides.
  return folded.length === original.length ? { original, folded } : { original: folded, folded };
}

function toNorm(folded) {
  return folded.replace(/[^a-z0-9]+/g, " ").trim();
}

function stripPolite(norm) {
  let out = norm;
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.replace(POLITE_TAIL, "").trim();
  }
  return out;
}

const FILLER = new Set(
  "cho toi tui minh em anh chi ban xin gium giup mon cai phan suat quan nay co khong ko k hong hem chua con gia bao nhieu tien the vay la a nhe nha di nua voi hang muon an uong tim kiem".split(" ")
);

function productWords(norm) {
  return norm
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

function refOrQuery(text) {
  const q = (text || "").trim();
  if (!q || BACK_REFERENCE.test(q)) return { ref: "last", query: null };
  const words = productWords(q);
  return words ? { ref: null, query: words } : { ref: "last", query: null };
}

// Cleans a verbatim slice of customer text (address/note): trims
// punctuation and trailing politeness, keeps accents and casing.
function cleanVerbatim(text) {
  return text
    .replace(/(?:[\s,]+(?:nha|nhé|nhe|nhen|ạ|giúp em|giùm|giùm em|nha em|nhé ạ|em nhé|em nha))+[\s.!?]*$/iu, "")
    .replace(/^[\s,:;.\-–]+|[\s,;.!?]+$/g, "")
    .trim();
}

// Item segments: "Cho 2 tôm, 3 bò viên" -> ["Cho 2 tôm", "3 bò viên"]. A
// separator only splits when the next part starts with a quantity or an
// add verb, so dish names containing commas ("Nước ép Ổi, Chanh dây")
// stay whole.
const SEPARATOR = /\s*(?:,|;|\/|\+|&|\n|\bva\b|\bvoi\b|\bthem\s+(?=\d|mot|hai|ba\b))\s*/g;
const STARTS_ITEM = new RegExp(`^(?:${ADD_VERB}\\s+)?(?:toi\\s+|minh\\s+|em\\s+)?${QTY}\\b`);

// How a number word may be typed. Folded, other words collide with them
// ("hải sản" -> "hai san", "nấm" -> "nam"): typed with other accents, it is not a number.
const NUMBER_SPELLINGS = {
  mot: ["mot", "một"], hai: ["hai"], ba: ["ba"], bon: ["bon", "bốn"], nam: ["nam", "năm"],
  sau: ["sau", "sáu"], bay: ["bay", "bảy"], tam: ["tam", "tám"], chin: ["chin", "chín"], muoi: ["muoi", "mười"],
};

// The folded text after a separator starts an item: [verb] [pronoun] quantity.
function startsItem(nextOriginal, nextFolded) {
  const next = nextFolded.replace(/[^a-z0-9 ]+/g, " ").trim();
  const m = next.match(STARTS_ITEM);
  if (!m) return false;
  const words = m[0].split(/\s+/);
  const qty = words[words.length - 1];
  if (!NUMBER_SPELLINGS[qty]) return true; // digits
  const typed = nextOriginal.split(/[^\p{L}\p{N}]+/u).filter(Boolean)[words.length - 1];
  return NUMBER_SPELLINGS[qty].includes(String(typed).toLowerCase());
}

export function splitItemSegments(original, folded) {
  const cuts = [];
  for (const m of folded.matchAll(SEPARATOR)) {
    // a leading "thêm 2 …" separates nothing: the word stays with its item
    if (!folded.slice(0, m.index).trim()) continue;
    const nextStart = m.index + m[0].length;
    if (startsItem(original.slice(nextStart), folded.slice(nextStart))) cuts.push({ start: m.index, end: nextStart });
  }
  const segments = [];
  let from = 0;
  for (const cut of cuts) {
    segments.push(original.slice(from, cut.start));
    from = cut.end;
  }
  segments.push(original.slice(from));
  return segments.map((s) => s.trim()).filter(Boolean);
}

function hasDiacritics(text) {
  return text.normalize("NFD") !== text.normalize("NFD").replace(/[̀-ͯ]/g, "") || /đ/i.test(text);
}

/**
 * @returns {{intent: string, raw: string, norm: string, [entity: string]: any}}
 */
export function understandMessage(text) {
  const { original, folded } = fold(String(text ?? "").trim());
  const norm = toNorm(folded);
  const core = stripPolite(norm);
  const out = (intent, entities = {}) => ({ intent, raw: original, norm, ...entities });

  if (!core) return out("unknown");

  // --- conversation control -------------------------------------------------
  if (/^(xin chao|chao|chao shop|chao ban|chao em|hi|hello|alo|hey)( .{0,20})?$/.test(core) && core.split(" ").length <= 4) {
    return out("greeting");
  }
  if (/^(help|huong dan|tro giup|lam sao de dat|ban lam duoc gi|dat nhu the nao)$/.test(core)) return out("general_help");
  if (/\b(huy don|khong dat nua|thoi khong dat|huy dat|khong mua nua|thoi khong mua|khong dat don)\b/.test(core)) {
    return out("cancel_order");
  }
  // --- customer memory: addresses by reference, reorders, food instructions ---
  // "giao chỗ cũ", "địa chỉ như lần trước", "giao về nhà" (checked on the
  // un-stripped text: the trailing "nhà" must not be eaten as politeness "nha").
  let refMatch = norm.match(/^(?:(?:giao|ship|chuyen|gui)(?:\s+hang)?(?:\s+(?:ve|toi|den|qua|o))?\s+)(nha|cong ty|van phong|cho lam)(?:\s+(?:cua\s+)?(?:toi|em|anh|minh|tui))?(?:\s+(?:nhe|nha|a))?$/);
  if (refMatch) return out("provide_delivery_address", { address: null, addressRef: { label: refMatch[1] === "nha" ? "nhà" : "công ty" } });
  // "chỗ" (place) folds to "cho" (give): with accents typed it must be "chỗ"
  const placeWord = !/[^\u0000-\u007f]/.test(original) || /chỗ/i.test(original);
  if (/\bdia chi\s+(?:cu|quen|nhu lan truoc|luc truoc|hom truoc|lan truoc|nhu cu|moi lan)\b/.test(core) ||
      (placeWord && /\bcho\s+(?:cu|quen|nhu lan truoc|luc truoc|hom truoc|lan truoc|nhu cu|moi lan)\b/.test(core))) {
    return out("provide_delivery_address", { address: null, addressRef: { label: null } });
  }
  // "nhà tôi ở 76 …", "địa chỉ công ty là 123 …" — an address with a label
  refMatch = folded.match(/(?:^|\s)(?:dia chi\s+)?(nha|cong ty|van phong)\s+(?:(?:cua\s+)?(?:toi|em|anh|minh|tui)\s+)?(?:la|o|tai)\s+(?=\d)/);
  if (refMatch) {
    const address = cleanVerbatim(original.slice(refMatch.index + refMatch[0].length));
    if (address) return out("provide_delivery_address", { address, addressLabel: refMatch[1] === "nha" ? "nhà" : "công ty" });
  }
  // "như cũ", "cho như lần trước", "đặt lại", "như mọi lần"
  if (/\b(nhu cu|nhu lan truoc|mon cu|dat lai|giong lan truoc|nhu moi lan|nhu moi khi|nhu hom truoc|y nhu cu|nhu thuong le|nhu bua truoc|giong moi lan)\b/.test(core)) {
    // "như cũ nhưng hôm nay nhiều tiêu": the override travels with the reorder
    const override = extractFoodInstructions(original);
    const facts = override ? { instructions: override.instructions, temporality: override.temporality, scope: override.scope, correction: override.correction } : {};
    return out("reorder", { preferRecurring: /\b(moi lan|moi khi|thuong le)\b/.test(core), ...facts });
  }
  // food instructions ("không hành, ít tiêu", "em không ăn hành", "hôm nay
  // cho hành"), alone or around an order ("cho 2 thập cẩm, không hành")
  const food = extractFoodInstructions(original);
  if (food) {
    const facts = { instructions: food.instructions, temporality: food.temporality, scope: food.scope, correction: food.correction };
    if (food.pure || !food.remainder) return out("food_instruction", facts);
    const inner = understandMessage(food.remainder);
    return { ...inner, raw: original, norm, ...facts };
  }

  // "Không, pizza bò" / "không phải món đó" / "sai rồi" — the previous
  // resolution was wrong. A bare "không" needs a comma + replacement to count.
  if (/^(khong phai|khong dung|sai roi|sai|nham mon|nham roi)(?: mon do| cai do| mon nay| roi)*$/.test(core)) {
    return out("negation", { replacement: null });
  }
  const negated = folded.match(/^\s*(?:(?:khong phai|khong dung|sai roi|sai|nham mon)(?:\s+(?:mon do|cai do))?[\s,.!:;-]+|khong\s*[,.!:;-]+\s*)(.+)$/);
  if (negated) {
    const replacement = original.slice(negated.index + negated[0].length - negated[1].length).trim();
    return out("negation", { replacement: replacement || null });
  }
  if (/^(thoi|thoi khoi|khoi|bo qua|huy|thoi bo qua|khong can|thoi khong can)$/.test(core)) return out("cancel_pending");
  if (
    /^(xac nhan|dong y|chot|chot don|ok chot|ok|oke|okay|okie|u|uh|um|uhm|duoc|duoc roi|yes|y|dung roi|dung|chuan|chuan roi|chot luon|xac nhan dat|xac nhan don|dong y dat)$/.test(core) ||
    (/\b(xac nhan|chot don)\b/.test(core) && !/\bkhong (xac nhan|chot)\b/.test(core))
  ) {
    return out("confirm_order");
  }

  // "À nhầm, 3" — a correction of the quantity just set.
  let m = core.match(new RegExp(`^(?:a |ah |oi |ay )?(?:nham|lon|sua lai|khong phai|xin loi nham)(?: roi)?(?: la| thanh| lay)?\\s+${QTY}(?:\\s+${UNIT})?$`));
  if (m) return out("correction", { quantity: parseCount(m[1]) });

  // --- merchant / menu questions (before addresses: "có thực đơn ko gửi tui"
  // and "địa chỉ quán" are questions, not delivery details) ------------------
  // "cho xem hủ tiếu", "xem các món cơm", "menu món nước": one part of the
  // menu (a category, else matching dishes) — resolved by the engine.
  m = core.match(/^(?:(?:cho|de)\s+(?:(?:toi|minh|em|tui)\s+)?)?(?:xem|coi)\s+(?:thu\s+)?(.+)$|^(?:menu|thuc don)\s+(.+)$/);
  if (m) {
    const part = (m[1] ?? m[2]).trim();
    const wholeMenu = /^(?:(?:cac\s+)?mon(?:\s+an)?|menu|thuc don|het|tat ca|het mon|tat ca (?:cac )?mon|danh sach mon|quan co gi|co gi)$/.test(part);
    // "xem giỏ", "xem lại", "xem đơn", "xem tổng" belong to the cart rules below
    if (!wholeMenu && !/^(?:gio|lai|don|tong|hoa don|dia chi|quan\s+\S)/.test(part)) return out("browse_category", { query: part });
  }
  if (/\b(menu|thuc don|co mon gi|mon gi|xem mon|danh sach mon|ban gi|ban nhung gi|co nhung gi|quan co gi)\b|^co gi(?: an| ngon)?$/.test(core)) {
    return out("show_menu");
  }
  if (/\b(dia chi quan|(quan|shop|nha hang)( nay| do)? (o|nam o) dau)\b|^(o dau|dia chi)( vay| the)?$/.test(core)) {
    return out("store_location");
  }

  // --- checkout details (verbatim slices of the original text) ---------------
  if (/\b(lay tai quan|den quan lay|toi quan lay|qua quan lay|tu (?:den|toi|qua) lay|den lay|qua lay|khong can giao|an tai quan|mang ve)\b/.test(core)) {
    return out("provide_fulfillment", { fulfillment: "pickup" });
  }
  if (/\b(co giao|giao hang khong|co ship|ship khong|giao khong|giao duoc khong|ship duoc khong|phi giao|phi ship)\b/.test(core)) {
    return out("delivery_question");
  }
  // A delivery address is recognized BEFORE any product parsing, and is
  // never lost when the same message also orders food ("giao 2 phần hủ
  // tiếu đến 76 …", "cho 2 đặc biệt, gửi về 76 …, phone …").
  const details = extractCheckoutDetails(original);
  if (details.addressFound) {
    const extras = { address: details.address, phone: details.phone, invalidPhone: details.invalidPhone, note: details.note };
    if (details.uncertain) extras.addressUncertain = true;
    const rest = details.remainder ? understandMessage(details.remainder) : null;
    if (rest?.intent === "add_to_cart") return out("add_to_cart", { items: rest.items, ...extras });
    return out("provide_delivery_address", extras);
  }
  if (/^(?:giao|ship|gui|chuyen)(?:\s+hang)?(?:\s+(?:den|toi|qua|ve|o))?(?:\s+(?:day|do|nha|nha toi|nha minh|o day|cho nay|tan noi))?$|^(?:giao|ship)\s+di$/.test(core)) {
    return out("provide_delivery_address", { address: null });
  }
  m = folded.match(/(?:^|\s)ghi chu\s*:?\s*(.+)$/);
  if (m) return out("provide_note", { note: cleanVerbatim(original.slice(m.index + m[0].length - m[1].length)) });

  const digitsJoined = core.replace(/(\d)\s+(?=\d)/g, "$1");
  const phone = digitsJoined.match(/\b(0\d{9}|84\d{9})\b/)?.[1] ?? null;
  if (phone && productWords(digitsJoined.replace(phone, "").replace(/\b(sdt|so dien thoai|dien thoai|so|lien he|goi|phone)\b/g, "")) === "") {
    return out("provide_phone", { phone });
  }

  // --- cart / order ----------------------------------------------------------
  if (/\btong\b|^(het |tat ca )?bao nhieu tien( tat ca| het| vay)?$|\b(het bao nhieu|tinh tien|tat ca bao nhieu)\b/.test(core)) {
    return out("ask_total");
  }
  if (/\b(xem gio|gio hang|trong gio|gio cua toi|da chon gi|da dat gi|dat nhung gi|da goi gi)\b/.test(core)) return out("show_cart");
  if (/^(?:cho (?:toi|minh|em) )?(?:xem lai|kiem tra lai|tom tat|coi lai|doc lai)(?: don| don hang| gio| gio hang| mon)?$/.test(core)) {
    return out("review_order");
  }
  if (/\b(xoa (?:het )?gio|huy (?:het )?gio|lam lai gio|xoa het (?:mon|gio)?)\b/.test(core)) return out("clear_cart");
  if (/^(?:toi |minh |em )?(?:muon )?(?:dat|dat mon|dat hang|dat luon|dat don|dat di|len don|chot mon|thanh toan|dat luon di)$/.test(core)) {
    return out("checkout");
  }

  // --- quantity changes -------------------------------------------------------
  m = core.match(new RegExp(`\\b(?:doi|sua|thay|tang|giam|cho)\\s+(.*?)\\s*\\b(?:thanh|len|xuong|con)\\s+${QTY}(?:\\s+${UNIT})?$`));
  if (!m) m = core.match(new RegExp(`^(.+?)\\s+thanh\\s+${QTY}(?:\\s+${UNIT})?$`));
  if (m) return out("change_quantity", { ...refOrQuery(m[1]), quantity: parseCount(m[2]) });
  if (/^(?:doi|sua|thay doi|doi mon|doi so luong)$/.test(core)) return out("change_quantity", { ref: null, query: null, quantity: null });

  // "thêm một phần nữa", "thêm 1", "bớt một phần tôm", "1 phần nữa"
  m = core.replace(/\s+nua$/, "").match(new RegExp(`^(them|bot|giam|tru)\\s+${QTY}(?:\\s+${UNIT})?(?:\\s+(.+))?$`));
  if (m && (m[1] !== "them" || !m[3] || BACK_REFERENCE.test(m[3]))) {
    const sign = m[1] === "them" ? 1 : -1;
    return out("adjust_quantity", { delta: sign * parseCount(m[2]), ...refOrQuery(m[3]) });
  }
  m = core.match(new RegExp(`^${QTY}(?:\\s+${UNIT})?\\s+nua$`));
  if (m) return out("adjust_quantity", { delta: parseCount(m[1]), ref: "last", query: null });

  // Removal: the verb is checked on ACCENTED text when available, because
  // "bỏ" (remove) and "bò" (beef) fold to the same "bo".
  const lowerOriginal = original.toLowerCase();
  const removeAccented = /^(?:thôi\s+)?(?:bỏ|xóa|xoá|hủy|huỷ|không lấy|ko lấy|k lấy|khỏi lấy|đừng lấy|bớt hết|loại)\s+(.+)$/u.exec(lowerOriginal);
  const removePlain = !hasDiacritics(original) && /^(?:thoi\s+)?(?:bo|xoa|huy|khong lay|ko lay|dung lay)\s+(.+)$/.exec(core);
  if (removeAccented || removePlain) {
    const rest = removeAccented ? stripPolite(toNorm(stripAccents(removeAccented[1]))) : removePlain[1];
    // Unaccented "bo vien" is either "bỏ viên" or the dish "bò viên" — the
    // engine checks the menu for `alternativeMention` before removing.
    const alternativeMention = removePlain && /^bo\s/.test(core) ? productWords(core) : null;
    return out("remove_from_cart", { ...refOrQuery(rest.replace(/\s+(?:nua|ra|di)$/, "")), alternativeMention });
  }

  // "Cho 2 cái" — a quantity for the product being discussed, nothing named.
  m = core.match(new RegExp(`^(?:(?:toi|minh|em)\\s+)?${ADD_VERB}(?:\\s+(?:toi|minh|em|tui))?\\s+${QTY}(?:\\s+${UNIT})?(?:\\s+nua)?$`));
  if (m && !/^them\b/.test(core)) return out("quantity_only", { quantity: parseCount(m[1]) });

  // An add verb + quantity ("cho tôi 2 …", "thêm 3 …") is an order even if
  // the text also says "giá …" or "… không".
  if (new RegExp(`^(?:(?:toi|minh|em)\\s+)?${ADD_VERB}(?:\\s+(?:toi|minh|em|tui))?\\s+${QTY}\\s+\\S`).test(core)) {
    return out("add_to_cart", { items: splitItemSegments(original, folded) });
  }

  // --- product questions -------------------------------------------------------
  if (/^(?:co|con)(?: hang)?\s+(?:khong|ko|k|hong|hem)$/.test(core)) return out("ask_product_availability", { ref: "last", query: null });
  m = core.match(/^(?:quan\s+(?:nay\s+)?)?(?:co|con)\s+(?:ban\s+)?(.+?)\s+(?:khong|ko|k|hong|hem|chua)$/);
  if (!m) m = core.match(/^(.+?)\s+(?:co|con)\s+(?:khong|ko|k|hong|hem)$/);
  if (m) return out("ask_product_availability", refOrQuery(m[1]));
  if (/\b(gia|bao nhieu)\b/.test(core)) {
    return out("ask_product_price", refOrQuery(core.replace(/\b(gia|bao nhieu|tien|mot|phan|la)\b/g, " ")));
  }

  // --- adding items ---------------------------------------------------------------
  const startsWithVerb = new RegExp(`^(?:(?:toi|minh|em)\\s+)?${ADD_VERB}\\b`).test(core);
  m = core.match(new RegExp(`^${QTY}(?:\\s+${UNIT})?$`));
  if (m) return out("quantity_only", { quantity: parseCount(m[1]) });
  if (startsWithVerb || new RegExp(`^${QTY}\\b`).test(core)) {
    return out("add_to_cart", { items: splitItemSegments(original, folded) });
  }

  // "số 2", "món thứ 2", "chọn 2"
  m = core.match(/^(?:so|mon|cai|lua chon|chon|quan)\s+(?:thu\s+)?(\d{1,2})$|^thu\s+(\d{1,2})$/);
  if (m) return out("choose_option", { ordinal: Number(m[1] ?? m[2]) });

  // A bare product or choice name ("tôm", "seafood pizza") — resolved by context.
  const words = productWords(core);
  return words ? out("mention", { query: words }) : out("unknown");
}
