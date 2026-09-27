import { fold } from "../conversation/understand.js";

// FOOD-ONLY SCOPE GUARD. FOOD Concierge is a food / local-food-discovery assistant, not a general chatbot.
// Deterministic (no model call), decided by intent and entities — never by message length.
//
//   classifyScope(text) -> OUT_OF_SCOPE before anything else runs (0 GPT call, 0 search):
//     generation  image / video creation or editing ("tạo ảnh", "vẽ", "làm video", "generate image")
//     security    secrets, system prompt, env / keys, instruction override, shell / SQL-looking input
//     topic       clearly non-food topics (finance, code, weather, politics, news, essays / emails,
//                 translation, medical, legal, study, psychology, roleplay, general travel) — unless the
//                 message ALSO asks about eating ("trời nóng nên ăn gì" is food)
//   hasFoodSignal(text) -> the words themselves are about food / places / menu / price / address / service;
//     the router asks it (plus conversation state and Food Knowledge) before any GPT call.

export const SCOPE_REPLY = "Em hiện hỗ trợ tìm món ăn, quán ăn, menu, giá, địa chỉ và các dịch vụ liên quan trong hệ thống FOOD. Anh/chị hỏi em về món hoặc quán nhé.";

const w = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu");

// absolute: never food, whatever else the message says
const GENERATION = [
  w("(?:tạo|làm|vẽ|chỉnh|sửa|edit|thiết kế|render|dựng|xuất)\\s+(?:(?:cho\\s+)?(?:tôi|em|mình|anh|chị|tui)\\s+)?(?:(?:một|1|cái|tấm|bức|đoạn|clip)\\s+)?(?:ảnh|hình|hình ảnh|tranh|logo|poster|banner|video|clip|phim|gif|avatar)"),
  w("vẽ"),
  w("generate\\s+(?:an?\\s+)?(?:image|picture|photo|video|art)|image generation|video generation|text[- ]to[- ](?:image|video)|midjourney|dall[- ]?e|stable diffusion|sora"),
];
const SECURITY = [
  w("api[ _-]?key|openai_api_key|secret|credential|password|mật khẩu|token|bearer|khóa api|khoá api|biến môi trường|environment variable|env var"),
  /(?:^|[\s"'`(])\.env(?![\p{L}\p{N}])/iu,
  w("system prompt|prompt hệ thống|internal tools?|developer mode|jailbreak|unrestricted|no restrictions|dan mode"),
  w("ignore (?:all |the )?(?:previous|prior|above) instructions?|disregard (?:all |the )?(?:previous|prior) instructions?|bỏ qua (?:mọi|tất cả|các|toàn bộ)?\\s*(?:luật|quy tắc|hướng dẫn|chỉ dẫn|lệnh)|bỏ qua fact guard|system override"),
  w("key"), // "cho tôi xem key" — asking for a key is never a food question
  /\$\(|`[^`]*`|\brm\s+-rf\b|\/etc\/passwd|<script|;\s*(?:drop|delete|insert|update|select|truncate)\s|\bunion\s+select\b|\bor\s+1\s*=\s*1\b|--\s*$/iu,
  w("chạy lệnh|thực thi lệnh|execute (?:this |the )?command|run (?:this |the )?command|shell command|terminal"),
];
const TOPICS = [
  ["finance", w("bitcoin|btc|ethereum|crypto|tiền ảo|tiền điện tử|chứng khoán|cổ phiếu|stock|forex|tỷ giá|lãi suất|giá vàng|đầu tư")],
  ["code", w("viết code|code python|lập trình|python|javascript|typescript|java|c\\+\\+|html|css|sql|debug|thuật toán|viết hàm|viết chương trình|script")],
  ["weather", w("thời tiết|dự báo|nhiệt độ|weather")],
  ["politics", w("bầu cử|chính trị|tổng thống|chủ tịch nước|thủ tướng|quốc hội|đảng|election|president|politics")],
  ["news", w("tin tức|thời sự|news|báo chí")],
  ["writing", w("(?:viết|soạn|làm)\\s+(?:cho\\s+(?:tôi|em|mình)\\s+)?(?:một\\s+)?(?:bài văn|bài luận|bài thơ|thơ|văn|email|e-mail|thư|truyện|kịch bản|caption|content|bài đăng|luận văn|tiểu luận)|essay")],
  ["translation", w("dịch (?:đoạn|câu|bài|văn bản|giúp|sang|ra)|translate")],
  ["medical", w("tư vấn bệnh|chẩn đoán|triệu chứng|bác sĩ|kê đơn|uống thuốc gì|bệnh gì|khám bệnh")],
  ["legal", w("pháp luật|luật sư|kiện tụng|khởi kiện|tư vấn luật|hợp đồng pháp lý")],
  ["study", w("bài tập|giải toán|giải phương trình|homework|ôn thi|luyện thi")],
  ["psychology", w("tâm lý|trầm cảm|tư vấn tình cảm|thất tình|chia tay")],
  ["roleplay", w("roleplay|đóng vai|nhập vai|kể chuyện cười|kể chuyện|pretend to be|act as")],
  ["travel", w("vé máy bay|visa|hộ chiếu|đặt phòng khách sạn|tour du lịch")],
  ["general", w("thủ đô|ai là người|trái đất|vũ trụ")],
];
// the message asks about eating / places / menu / orders — this keeps a food question food even when it
// mentions weather ("trời nóng nên ăn gì") or health ("đau bụng ăn gì")
const FOOD_ASK = w("ăn gì|uống gì|món|quán|nhà hàng|tiệm|menu|thực đơn|đặt món|giao hàng|ship|đồ ăn|thức ăn|món ăn|đồ uống");

// food / place / menu / price / address / service words, as written. A word typed WITH accents must match
// its accented form ("của" is not "cua"); a word typed without accents matches the unaccented form.
const FOOD_TERMS = (
  "ăn|uống|món|quán|nhà hàng|tiệm|menu|thực đơn|giá|bao nhiêu|tiền|đặt|order|gọi món|giao|giao hàng|ship|địa chỉ|ở đâu|đường|chỗ nào|gần|mở cửa|đóng cửa|" +
  "cơm|bún|phở|bánh|lẩu|chè|cà phê|cafe|coffee|trà sữa|nước|pizza|mì|hủ tiếu|cháo|xôi|nem|chả|gà|vịt|bò|heo|lợn|cá|tôm|cua|mực|ốc|hải sản|" +
  "chay|cay|ngọt|mặn|chua|ngon|rẻ|đặc sản|ăn sáng|ăn trưa|ăn tối|ăn vặt|ăn nhẹ|đồ ăn|thức ăn|đồ uống|combo|khuyến mãi|voucher|mang về|chỗ ngồi|" +
  "dịch vụ|tiện ích|nướng|kem|sinh tố|bia|thịt|rau|trái cây|snack|buffet|đói|khát|thèm|nhậu|bữa|bữa sáng|bữa trưa|bữa tối"
).split("|");
const ACCENTED = new Set(FOOD_TERMS.map((x) => x.normalize("NFC").toLowerCase()));
const PLAIN = new Set(FOOD_TERMS.map((x) => fold(x).folded.toLowerCase()));

/** @returns {{scope: "OUT_OF_SCOPE"|"IN_SCOPE", category: string|null}} */
export function classifyScope(text) {
  const t = String(text ?? "").normalize("NFC");
  if (!t.trim()) return { scope: "IN_SCOPE", category: null };
  if (GENERATION.some((re) => re.test(t))) return { scope: "OUT_OF_SCOPE", category: "generation" };
  if (SECURITY.some((re) => re.test(t))) return { scope: "OUT_OF_SCOPE", category: "security" };
  const topic = TOPICS.find(([, re]) => re.test(t));
  if (topic && !FOOD_ASK.test(t)) return { scope: "OUT_OF_SCOPE", category: topic[0] };
  return { scope: "IN_SCOPE", category: null };
}

/** Do the words themselves talk about food, places, menus, prices, addresses or services? */
export function hasFoodSignal(text) {
  const tokens = String(text ?? "").normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    for (const span of [tokens[i], tokens.slice(i, i + 2).join(" "), tokens.slice(i, i + 3).join(" ")]) {
      const plain = fold(span).folded.toLowerCase();
      if (plain === span ? PLAIN.has(span) : ACCENTED.has(span)) return true;
    }
  }
  return false;
}
