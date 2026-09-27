import { extractClaims, explicitPlace } from "./textClaims.js";
import { nfc, collapseWhitespace } from "../text.js";

// Deterministic: is a customer's TEXT a knowledge contribution, a normal query, or (while a submission waits for
// them) an answer? Rules only — no model. Anything unclear is NOT a contribution: a normal conversation never
// becomes knowledge.
//   "Quán ABC bán bánh hỏi 40k"         -> CONTRIBUTION (a statement with a claim and a place)
//   "Quán nào bán bánh hỏi?"            -> QUERY (a question)
//   "tìm bún bò dưới 40k"               -> QUERY (a request / budget)

const QUESTION = /\?|(?:^|[\s,])(?:nào|nao|bao nhiêu|bao nhieu|bn|ở đâu|o dau|đâu|mấy giờ|may gio|gì|gi|sao|hả|ha|nhỉ|nhi|chưa|chua|không|khong|ko|hông|hok|có không|có ko)\s*[?!.]*$|(?:^|\s)(?:có|co)\s+.+\s+(?:không|khong|ko|hông|k)(?:\s|$)|^(?:ai|nào|sao|bao nhiêu|mấy|có ai|cho hỏi|hỏi|xin hỏi)(?:\s|$)/iu;
const QUESTION_WORDS = /(?:^|\s)(?:bao nhiêu|bao nhieu|ở đâu|o dau|chỗ nào|cho nao|quán nào|quan nao|món nào|mon nao|mấy giờ|may gio)(?:\s|$|\?)/iu;
const REQUEST = /^(?:em\s+|anh\s+|chị\s+|mình\s+|tôi\s+|t\s+|cho\s+(?:em|anh|chị|mình|tôi|t)\s+)?(?:tìm|tim|kiếm|kiem|muốn|muon|thèm|them|gợi ý|goi y|đặt|dat|order|ship|giao|mua|xem|cho xem|chỉ|chi|giới thiệu|gioi thieu|ăn gì|an gi)(?:\s|$)/iu;
const CONTRIBUTE_CUE = /(?:^|\s)(?:bán|ban|giá|gia|menu|thực đơn|thuc don|cập nhật|cap nhat|mới|moi|đổi|doi|tăng|giảm|chuyển|dời|địa chỉ|dia chi|mở cửa|mo cua|nghỉ|nghi|hết|bỏ món|ngưng|đóng góp|dong gop|báo|bao)(?:\s|$)/iu;

const clean = (s) => collapseWhitespace(nfc(String(s ?? ""))).trim();

export function isQuestion(text) {
  const t = clean(text);
  return QUESTION.test(t) || QUESTION_WORDS.test(t);
}

/**
 * @param {string} text
 * @returns {{kind: "CONTRIBUTION"|"QUERY"|"NONE", place: string|null, findings: object[]}}
 */
export function classifyContributionText(text) {
  const t = clean(text);
  if (!t) return { kind: "NONE", place: null, findings: [] };
  if (isQuestion(t) || REQUEST.test(t)) return { kind: "QUERY", place: null, findings: [] };
  const place = explicitPlace(t);
  const findings = extractClaims(t, { placeTexts: place ? [place] : [] }).filter((f) => !f.implausible);
  // a statement that says something checkable about a named place, with a contribution cue
  if (findings.length && place && CONTRIBUTE_CUE.test(t)) return { kind: "CONTRIBUTION", place, findings };
  return { kind: "NONE", place, findings: [] };
}

const YES_WORD = "(?:có|co|ok|oke|okay|okie|đúng|dung|đúng rồi|dung roi|ừ|uh|ừm|um|vâng|vang|dạ|da|lưu|luu|lưu giúp|luu giup|yes|y|được|duoc|dc|đc|chính xác|chuẩn)";
const YES = new RegExp(`^${YES_WORD}(?:[\\s,]+${YES_WORD})*(?:\\s+(?:ạ|a|nhé|nhe|nha|đi|di|luôn|luon|rồi|roi|em|nhen))*\\s*[.!]*$`, "iu");
const NO = /^(?:dạ\s+|da\s+)?(?:không|khong|ko|k|thôi|thoi|bỏ qua|bo qua|hủy|huỷ|huy|no|đừng|khỏi|khoi|không lưu|ko lưu|không cần|ko can|sai|sai rồi|sai roi)(?:\s+(?:ạ|a|nhé|nhe|nha|đi|di|luôn|luon|rồi|roi|em|nhen|lưu|luu))*\s*[.!]*$/iu;
const CORRECTION = /^(?:không|khong|ko|k|sai|sai rồi|sai roi|nhầm|nham|nhầm rồi)[\s,.:;!-]+(?:(?:là|phải là|của)\s+)?(.+)$/iu;
const SAVE_FOR = /^(?:lưu|luu)\s+(?:cho|vào|vao)\s+(.+)$/iu;
const ERASE = /(?:xoá|xóa|xoa)\s+(?:hết\s+)?(?:ảnh|anh|đóng góp|dong gop|dữ liệu|du lieu|thông tin|thong tin)\s+(?:của\s+)?(?:tôi|toi|em|mình|minh)/iu;

/**
 * An answer while a submission waits for the customer.
 * @param {string} text
 * @param {{strict?: boolean, expecting?: "merchant"|"confirmation"}} [opts] strict (merchant context): only unmistakable answers —
 *   "lưu" / "bỏ qua" / "quán X"; expecting: what the bot asked (a bare name is a place only after "quán nào?")
 * @returns {{kind: "YES"|"NO"|"PLACE"|"ERASE"|"OTHER", place?: string}}
 */
export function classifyReply(text, { strict = false, expecting = "merchant" } = {}) {
  const t = clean(text);
  if (!t) return { kind: "OTHER" };
  if (ERASE.test(t)) return { kind: "ERASE" };
  const saveFor = t.match(SAVE_FOR);
  if (saveFor) return { kind: "PLACE", place: stripPlaceWord(clean(saveFor[1]).replace(/[.!]+$/u, "")) };
  if (strict) {
    if (/^(?:lưu|luu)(?:\s+(?:đi|di|nhé|nha|ạ|a))*\s*[.!]*$/iu.test(t)) return { kind: "YES" };
    if (/^(?:bỏ qua|bo qua|không lưu|ko lưu|khong luu)(?:\s+(?:đi|di|nhé|nha|ạ|a))*\s*[.!]*$/iu.test(t)) return { kind: "NO" };
    const p = explicitPlace(t);
    return p && !isQuestion(t) && t.split(/\s+/).length <= 8 ? { kind: "PLACE", place: p } : { kind: "OTHER" };
  }
  if (YES.test(t)) return { kind: "YES" };
  if (NO.test(t)) return { kind: "NO" };
  const correction = t.match(CORRECTION);
  if (correction && !isQuestion(t)) return { kind: "PLACE", place: stripPlaceWord(clean(correction[1])) };
  if (isQuestion(t) || REQUEST.test(t)) return { kind: "OTHER" };
  if (COMMAND.test(t)) return { kind: "OTHER" };
  const explicit = explicitPlace(t);
  if (explicit) return { kind: "PLACE", place: explicit };
  // a short name, no digits, right after "quán nào?": the place they mean ("Bún Cá Cô Ba")
  if (expecting === "merchant" && t.split(/\s+/).length <= 8 && !/\d/.test(t) && /\p{L}/u.test(t)) return { kind: "PLACE", place: stripPlaceWord(t.replace(/[.!]+$/u, "")) };
  return { kind: "OTHER" };
}

// a navigation / ordering command is never a place name ("Menu A Tiểu", "quay lại", "xem giỏ")
const COMMAND = /^(?:menu|thực đơn|thuc don|quay lại|quay lai|về|ve|trở lại|tro lai|giỏ|gio|xem|đặt|dat|order|thêm|them|bớt|bot|huỷ đơn|hủy đơn|huy don|thanh toán|thanh toan|checkout|địa chỉ giao|dia chi giao|ship|giao|chào|chao|hello|hi|alo|cảm ơn|cam on|thanks)(?:\s|$)/iu;

function stripPlaceWord(s) {
  return s.replace(/^(?:của\s+)?(?:quán|quan|tiệm|tiem|nhà hàng|nha hang|hàng|hang)\s+/iu, "").trim() || s;
}
