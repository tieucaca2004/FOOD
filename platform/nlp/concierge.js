// Deterministic, rule-based classification for the Tổng Đài concierge.
// Mirrors A Tiểu's intentEngine.js design (see src/nlp/intentEngine.js):
// no LLM in the decision path by default, fully testable without any API
// key. AI (platform/ai/) may only ever suggest a fallback for `unknown`.

import { normalizeSearchQuery } from "./searchQuery.js";

const GREETING = /(xin chào|chào tổng đài|chào shop|^chào$|^hi$|^hello$|^alo$)/;
const RETURN_TO_PLATFORM = /(quay lại tổng đài|quay lại|tìm quán khác|đổi quán|thoát quán|thoát ra)/;
const GLOBAL_SEARCH_TRIGGER = /(quán nào khác|chỗ khác|nơi khác).*(bán|có)/;

// `discovery`: the customer ASKS TO FIND something — a place or a dish — as opposed to text that is only
// "search_food" because nothing else matched ("menu", "cho tôi 2 pizza", "có bún cá không" are search_food
// too). Decided from how the request is phrased, never from which food or place it names (that is the
// FoodSemanticParser's job): a leading request verb ("tìm …", "cho tôi kiếm …"), or "muốn ăn … ở/tại
// <somewhere>" that is not the current place ("ở quán", "ở đây"). Unaccented "tim" alone is ambiguous
// ("tim heo" is a dish), so without accents it needs a place/help word after it ("tim quan …").
const ASKER = "(?:(?:cho|giúp|giùm|làm ơn|nhờ|xin|em|anh|chị|mình|tôi|tui|bạn|ơi|shop|bot|muốn|cần)[\\s,]+)*";
const SEEK = new RegExp(`^${ASKER}(?:tìm kiếm|tìm|kiếm)\\s+\\S`, "u");
const SEEK_PLAIN = /^(?:(?:cho|giup|gium|lam on|nho|xin|em|anh|chi|minh|toi|tui|ban|oi|shop|bot|muon|can)[\s,]+)*(?:tim kiem|tim|kiem)\s+(?:quan|nha hang|tiem|cho|giup|gium|mon|do an|dia chi|xem)\b/;
const WANT_ELSEWHERE = /^(?:(?:tôi|mình|em|anh|chị|tui)\s+)?(?:muốn ăn|thèm ăn|thèm)\s+.+?\s(?:ở|tại)\s+(?!(?:quán|đây|nhà|bàn|chỗ này|tiệm này)(?:\s|$))\S/u;

// `global`: the customer asks about OTHER places or the AREA — "có quán nào bán bún cá", "còn quán nào khác",
// "xung quanh đây có món gì", "ngoài quán hủ tiếu ra có bán gì". Such a question is never about the place the
// customer is in, so it leaves a merchant context. It is NOT `discovery` (a new request): "còn quán nào nữa"
// after a list is still a follow-up on that list.
const OTHER_PLACES = /(?:^|[^\p{L}])(?:quán|chỗ|nơi|tiệm|nhà hàng|quan|cho|noi|tiem|nha hang)\s+(?:nào|khác|nao|khac)(?:$|[^\p{L}])/u;
const AREA = /(?:xung quanh|quanh đây|gần đây|gần nhất|khu này|khu vực này|xung quanh day|quanh day|gan day|gan nhat)/u;
const AREA_ASK = /(?:có|bán|co|ban)\s+(?:gì|món|quán|đồ ăn|chỗ|gi|mon|quan|do an)(?![\p{L}])|(?:món|quán|đồ ăn|mon|quan|do an)\s+(?:gì|nào|gi|nao)(?![\p{L}])/u;
const OTHER_THAN = /(?:^|[^\p{L}])(?:ngoài|ngoai)\s+.+?\s+ra(?:$|[^\p{L}])/u;

function isGlobal(lower) {
  const text = lower.normalize("NFC");
  if (OTHER_PLACES.test(text) || OTHER_THAN.test(text)) return true;
  return AREA.test(text) && AREA_ASK.test(text);
}

function isDiscovery(lower) {
  const text = lower.normalize("NFC").replace(/^[^\p{L}]+/u, "");
  if (SEEK.test(text) || WANT_ELSEWHERE.test(text)) return true;
  return /^[\x00-\x7f]*$/.test(text) && SEEK_PLAIN.test(text);
}

function extractMerchantNameHint(text) {
  const patterns = [
    // "(cho tôi) (xem / mở) menu (của) (quán) <name>": the menu OF a named place (FORM 13) — "Cho tôi menu của A Tiểu"
    /^(?:cho(?:\s+(?:tôi|mình|em|tui|anh|chị))?\s+)?(?:(?:xem|mở|coi)\s+)?(?:menu|thực đơn)\s+(?:của\s+)?(?:quán\s+)?(.+)$/i,
    /(?:muốn ăn ở|ăn ở|ăn tại|ở quán|tại quán)\s+(.+)/i,
    /(?:xem|chọn|mở)\s+(?:quán\s+)?(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1] || m[1].trim().length === 0) continue;
    const hint = m[1].trim().replace(/[.!?]+$/, "");
    // "menu quán này / đó": a reference to the place being talked about, never a name
    if (/^(?:quán\s+|tiệm\s+|chỗ\s+)?(?:này|đó|kia|ấy|nay|do|kia|ay)$/iu.test(hint)) return null;
    return hint;
  }
  return null;
}

/**
 * @returns {{intent: string, merchantNameHint: string|null, searchKeywords: string|null, discovery: boolean, global: boolean}}
 */
export function classifyConciergeIntent(text) {
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();
  const discovery = isDiscovery(lower);
  return { ...classify(raw, lower), discovery, global: discovery || isGlobal(lower) };
}

function classify(raw, lower) {

  if (GREETING.test(lower)) return { intent: "greeting", merchantNameHint: null, searchKeywords: null };
  if (RETURN_TO_PLATFORM.test(lower)) return { intent: "return_to_platform", merchantNameHint: null, searchKeywords: null };
  if (GLOBAL_SEARCH_TRIGGER.test(lower)) {
    return { intent: "global_search", merchantNameHint: null, searchKeywords: null };
  }

  const merchantNameHint = extractMerchantNameHint(raw);
  if (merchantNameHint) {
    return { intent: "open_merchant_by_name", merchantNameHint, searchKeywords: null };
  }

  if (raw.length === 0) return { intent: "unknown", merchantNameHint: null, searchKeywords: null };

  // Fallback: treat the message as a food/merchant search query. Leading/
  // trailing conversational words are stripped (accent-insensitively) so
  // "tôi muốn ăn hủ tiếu xào" / "tim quan nom nom" reduce to the keywords.
  const { text: keywords } = normalizeSearchQuery(raw);
  if (keywords.length === 0) return { intent: "unknown", merchantNameHint: null, searchKeywords: null };
  return { intent: "search_food", merchantNameHint: null, searchKeywords: keywords };
}
