// Deterministic, rule-based intent classifier for Vietnamese chat text.
// This is the sole decision-maker for routing — no LLM call sits in this
// path, so behavior stays reproducible and testable without any API key.
// Entity extraction (which product, which quantity) is intentionally NOT
// done here — it needs the products table, so the business router asks
// menuService for that after this returns a base intent.

const RULES = [
  // Highest priority: short, critical commands that must never be
  // mis-routed into a generic product/menu answer.
  { intent: "cancel_order", test: (t) => /(hủy đơn|không đặt nữa|thôi không đặt|hủy đặt)/.test(t) },
  { intent: "confirm_order", test: (t) => /(xác nhận|đồng ý|^ok chốt$|chốt đơn|đúng rồi|chuẩn rồi|^ok$|^ừ$|^được$)/.test(t) },
  { intent: "checkout", test: (t) => /(^đặt\b|đặt món|đặt hàng|đặt luôn|muốn đặt|cho đặt)/.test(t) },

  { intent: "clear_cart", test: (t) => /(xóa giỏ|hủy hết giỏ|làm lại giỏ|xóa hết giỏ)/.test(t) },
  { intent: "show_cart", test: (t) => /(xem giỏ|giỏ hàng|kiểm tra giỏ)/.test(t) },
  { intent: "update_cart", test: (t) => /(đổi|sửa|thay).*(thành)/.test(t) },
  { intent: "remove_from_cart", test: (t) => /(bỏ|hủy|xóa)\s+(món\s+)?/.test(t) && !/đơn/.test(t) },
  {
    intent: "add_to_cart",
    test: (t) => {
      const hasAddVerb = /\b(thêm|lấy|order|mua)\b/.test(t);
      const hasQuantityWord = /(\d|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)/.test(t);
      const hasChoWithoutXem = /\bcho\b/.test(t) && !/\bxem\b/.test(t);
      return hasAddVerb || (hasChoWithoutXem && hasQuantityWord);
    },
  },

  { intent: "product_price", test: (t) => /(bao nhiêu|nhiêu tiền|giá.*bao nhiêu|giá sao)/.test(t) },
  { intent: "product_availability", test: (t) => /(còn.*không|hết.*chưa|còn hàng không)/.test(t) },
  { intent: "show_menu", test: (t) => /(menu|thực đơn|có món gì|xem món|danh sách món)/.test(t) },

  { intent: "order_status", test: (t) => /(đơn của (tôi|em|anh)|kiểm tra đơn|trạng thái đơn)/.test(t) },
  { intent: "store_location", test: (t) => /(địa chỉ (quán|shop)|quán ở đâu|shop ở đâu)/.test(t) },
  { intent: "opening_hours", test: (t) => /(mấy giờ mở|giờ mở cửa|mở cửa lúc mấy giờ|giờ đóng cửa)/.test(t) },
  {
    intent: "payment_method",
    test: (t) => /(thanh toán (bằng gì|thế nào)|có chuyển khoản|trả bằng gì|hình thức thanh toán)/.test(t),
  },
  { intent: "delivery_question", test: (t) => /(giao hàng không|có ship không|ship không|phí giao hàng|giao tận nơi)/.test(t) },
  { intent: "promotion_question", test: (t) => /(khuyến mãi|giảm giá|có ưu đãi|mã giảm giá)/.test(t) },
  { intent: "human_support", test: (t) => /(gặp nhân viên|cho gặp người|nói chuyện với người|tư vấn viên)/.test(t) },

  { intent: "greeting", test: (t) => /(xin chào|chào shop|chào ad|^chào$|^hi$|^hello$|^alo$)/.test(t) },
];

export function classifyIntent(text) {
  const lower = (text || "").trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.test(lower)) {
      return { intent: rule.intent, confidence: 0.9 };
    }
  }
  return { intent: "unknown", confidence: 0 };
}
