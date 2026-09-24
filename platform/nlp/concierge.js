// Deterministic, rule-based classification for the Tổng Đài concierge.
// Mirrors A Tiểu's intentEngine.js design (see src/nlp/intentEngine.js):
// no LLM in the decision path by default, fully testable without any API
// key. AI (platform/ai/) may only ever suggest a fallback for `unknown`.

const GREETING = /(xin chào|chào tổng đài|chào shop|^chào$|^hi$|^hello$|^alo$)/;
// Chat-app bot start command, optionally addressed ("/start@SomeBot") or
// carrying a deep-link payload ("/start ref123").
const START_COMMAND = /^\/start(@\w+)?(\s|$)/;
const RETURN_TO_PLATFORM = /(quay lại tổng đài|quay lại|tìm quán khác|đổi quán|thoát quán|thoát ra)/;
const GLOBAL_SEARCH_TRIGGER = /(quán nào khác|chỗ khác|nơi khác).*(bán|có)/;
// Choosing from the search results just shown: a position ("1", "quán số 2",
// "chọn quán 2"), or a confirmation that only makes sense when exactly one
// merchant was listed ("ok", "chọn quán này"). The router decides whether
// there is a list to choose from.
const SELECT_RESULT_NUMBER = /^(?:(?:chọn|vào|xem|mở)\s+)?(?:quán\s+)?(?:số\s+)?(\d{1,3})$/;
const SELECT_THIS_RESULT = /^(?:ok|oke|okay|được|đồng ý|(?:chọn|vào|xem|mở)?\s*quán (?:này|đó))$/;

function extractMerchantNameHint(text) {
  const patterns = [
    /(?:muốn ăn ở|ăn ở|ăn tại|ở quán|tại quán)\s+(.+)/i,
    /(?:xem|chọn|mở)\s+(?:quán\s+)?(.+)/i,
    /^vào\s+(?:quán\s+)?(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const hint = m && m[1] ? cleanNameHint(m[1]) : "";
    if (hint.length > 0) return hint;
  }
  return null;
}

// Drops brackets, quotes and end punctuation around a typed name, e.g. the
// "[ XEM <TÊN QUÁN> ]" call to action copied back from a search reply.
function cleanNameHint(text) {
  return text.replace(/^[\s[\]()"'“”‘’]+/, "").replace(/[\s[\]()"'“”‘’.!?]+$/, "");
}

/**
 * @returns {{intent: string, merchantNameHint: string|null, searchKeywords: string|null}}
 */
export function classifyConciergeIntent(text) {
  // Some keyboards send Vietnamese decomposed (NFD); every pattern here is
  // written precomposed, so compare in NFC.
  const raw = (text || "").normalize("NFC").trim();
  const lower = raw.toLowerCase();

  if (GREETING.test(lower) || START_COMMAND.test(lower)) return { intent: "greeting", merchantNameHint: null, searchKeywords: null };
  if (RETURN_TO_PLATFORM.test(lower)) return { intent: "return_to_platform", merchantNameHint: null, searchKeywords: null };
  if (GLOBAL_SEARCH_TRIGGER.test(lower)) {
    return { intent: "global_search", merchantNameHint: null, searchKeywords: null };
  }

  const selection = cleanNameHint(lower);
  const numbered = selection.match(SELECT_RESULT_NUMBER);
  if (numbered) return { intent: "select_result_number", resultNumber: Number(numbered[1]), merchantNameHint: null, searchKeywords: null };
  if (SELECT_THIS_RESULT.test(selection)) return { intent: "select_this_result", merchantNameHint: null, searchKeywords: null };

  const merchantNameHint = extractMerchantNameHint(raw);
  if (merchantNameHint) {
    return { intent: "open_merchant_by_name", merchantNameHint, searchKeywords: null };
  }

  if (raw.length === 0) return { intent: "unknown", merchantNameHint: null, searchKeywords: null };

  // Fallback: treat the message as a food/category search query. Strip a
  // handful of filler words so "tôi muốn ăn hủ tiếu xào" reduces to
  // "hủ tiếu xào" for keyword matching against merchant catalogs.
  const stripped = stripFillerWords(raw);
  if (stripped.length === 0) return { intent: "unknown", merchantNameHint: null, searchKeywords: null };
  return { intent: "search_food", merchantNameHint: null, searchKeywords: stripped };
}

const FILLER_PATTERNS = [
  // "tìm cho tôi …", "tìm giúp mình …", "kiếm …" — a request to search, not part of the dish name.
  // "tìm quán cà phê" searches for "cà phê": the dish/category follows "quán".
  /^(tìm|kiếm)(\s+(cho|giúp|hộ))?(\s+(tôi|mình|em|anh|chị))?(\s+quán(?=\s+\S))?\s+/i,
  /^tôi muốn ăn\s+/i,
  /^mình muốn ăn\s+/i,
  /^cho (tôi|mình|em)\s+/i,
  /^tôi muốn\s+/i,
  /^mình muốn\s+/i,
  /^muốn ăn\s+/i,
  /\s+(nào ngon|không ạ|không|ạ|nhé|nha)\s*$/i,
];

function stripFillerWords(text) {
  let result = text.trim();
  for (const pattern of FILLER_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }
  return result.replace(/[.!?]+$/, "").trim();
}
