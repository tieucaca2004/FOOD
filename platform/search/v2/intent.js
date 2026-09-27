// SEARCH INTELLIGENCE V2 — step 2: intent detection (pure). WHAT the customer asks for, never WHICH dish or
// place (that is entity resolution). Word-boundary rules on the accent-free text; accents decide only where the
// folded forms collide ("giá" price vs "gia" family — the bare "gia" counts only in a message typed without accents).
import { classifyKnowledgeFollowUp } from "../../nlp/knowledgeFollowUp.js";
import { hasAccents } from "./normalize.js";

const w = (alts) => new RegExp(`(?:^| )(?:${alts})(?= |$)`);

const ADDRESS = w("o dau|dia chi|cho nao|nam o|duong nao|o cho nao|di the nao|chi duong");
const HOURS = w("may gio|gio mo|mo cua|dong cua|gio giac|mo luc|mo den|gio nao");
const PRICE_ASK = w("bao nhieu tien|may tien|nhieu tien|gia bao nhieu|gia the nao|gia sao|bao nhieu");
const MENU = w("menu|thuc don|co mon gi|mon gi|ban gi|co gi|nhung mon nao|mon nao|full menu");
const MORE = w("con quan nao|quan nao nua|quan khac|them quan|xem them|con nua|nua khong|con gi nua|quan nao khac|cho khac|noi khac");
const ASK_PLACES = w("quan nao|cho nao ban|o dau ban|noi nao|dau ban|ban o dau|tiem nao|nha hang nao|co quan nao|quan nao ban|ai ban");
const AREA = w("xung quanh|quanh day|gan day|gan nhat|khu nay|khu vuc|gan toi|gan minh|quanh|gan|trung tam|khu");
const AREA_ASK = w("co mon gi|mon gi|an gi|co gi an|co gi|mon nao|quan an|do an|cho an|co gi ngon|an uong|ban gi");
const NEAR_ME = w("gan day|quanh day|gan toi|gan minh|gan nhat|gan em|cho toi o");
const PROXIMITY = w("xung quanh|quanh|gan|lan can|ke ben|sat ben");
const UNSUPPORTED_AREA = w("trung tam|gan bien|bai bien|bo bien|ven bien|san bay|nhin ra bien|view bien");
const OTHER_THAN = / ?(?:^| )ngoai (.+?) ra(?= |$)/;
const EXCLUDE_CURRENT = w("ngoai quan nay|ngoai cho nay|quan khac|cho khac|noi khac|ngoai tiem nay|khac quan nay");
// "2 tô", "cho 2", "đặt", "thêm 1": an ORDER — the ordering engines own it, never search
// (a number inside a name or an address — "Bánh Căn 51 Tô Hiến Thành" — is not an order: only a message that
// STARTS with an order verb + a quantity, or with a quantity, is)
const ORDER = /^(?:(?:toi|minh|em|anh|chi)\s+)?(?:cho|them|lay|order|dat|goi|mua|an)\s+(?:\S+\s+){0,2}\d+(?= |$)|^\d+ \S|^(?:dat|dat mon|order|chot don|chot)$/;
const YES = w("dung roi|dung|phai|ok|oke|uh|u|vang|da|co|chuan|chinh xac|yes");
const NO = w("khong phai|sai|khong|ko|k|no");

/**
 * @param {{originalQuery: string, normalizedQuery: string, foldedQuery: string, tokens: object[]}} input
 * @returns {{operation: "address"|"hours"|"price"|"menu"|"more"|"place"|"none", ordinal: number|null,
 *   reference: "focus"|null, askPlaces: boolean, exclusion: {current: boolean, text: string|null},
 *   area: boolean, nearMe: boolean, unsupportedArea: string|null, orderLike: boolean, yes: boolean, no: boolean}}
 */
export function detectIntent(input) {
  const f = input.foldedQuery;
  const plain = !input.tokens.some((t) => t.accented);
  const fu = classifyKnowledgeFollowUp(input.normalizedQuery);
  // "giá": accented, or plain "gia" in a message typed without any accents
  const priceWord = input.tokens.some((t) => t.lower === "giá") || (plain && / (?:gia)(?= |$)/.test(` ${f}`));
  let operation = "none";
  if (priceWord || PRICE_ASK.test(f)) operation = "price";
  else if (HOURS.test(f)) operation = "hours";
  else if (ADDRESS.test(f)) operation = "address";
  else if (MENU.test(f)) operation = "menu";
  else if (MORE.test(f)) operation = "more";
  else if (fu?.kind === "place") operation = "place";
  const other = f.match(OTHER_THAN);
  const exclusion = { current: EXCLUDE_CURRENT.test(f), text: other ? other[1].trim() : null };
  const area = AREA.test(f) && AREA_ASK.test(f);
  return {
    operation,
    ordinal: fu?.ordinal ?? null,
    reference: fu?.ref ?? (/(?:^| )(?:do|nay|kia|ay)$/.test(f) && input.tokens.length <= 3 ? "focus" : null),
    askPlaces: ASK_PLACES.test(f),
    exclusion,
    area,
    nearMe: NEAR_ME.test(f),
    proximity: PROXIMITY.test(f), // any "around / near" wording: distance cannot be computed (no coordinates)
    unsupportedArea: f.match(UNSUPPORTED_AREA)?.[0]?.trim() ?? null,
    orderLike: ORDER.test(f),
    yes: input.tokens.length <= 3 && YES.test(f) && !NO.test(f),
    no: input.tokens.length <= 3 && NO.test(f),
    plain,
  };
}

export { hasAccents };
