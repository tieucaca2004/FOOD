// Deterministic, rule-based classification for the Tổng Đài concierge.
// Mirrors A Tiểu's intentEngine.js design (see src/nlp/intentEngine.js):
// no LLM in the decision path by default, fully testable without any API
// key. AI (platform/ai/) may only ever suggest a fallback for `unknown`.

import { normalizeSearchQuery } from "./searchQuery.js";

const GREETING = /(xin chào|chào tổng đài|chào shop|^chào$|^hi$|^hello$|^alo$)/;
const RETURN_TO_PLATFORM = /(quay lại tổng đài|quay lại|tìm quán khác|đổi quán|thoát quán|thoát ra)/;
const GLOBAL_SEARCH_TRIGGER = /(quán nào khác|chỗ khác|nơi khác).*(bán|có)/;

function extractMerchantNameHint(text) {
  const patterns = [
    /(?:muốn ăn ở|ăn ở|ăn tại|ở quán|tại quán)\s+(.+)/i,
    /(?:xem|chọn|mở)\s+(?:quán\s+)?(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim().replace(/[.!?]+$/, "");
  }
  return null;
}

/**
 * @returns {{intent: string, merchantNameHint: string|null, searchKeywords: string|null}}
 */
export function classifyConciergeIntent(text) {
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();

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
