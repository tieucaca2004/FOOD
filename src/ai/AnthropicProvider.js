import { AIProvider } from "./AIProvider.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Only ever asked to (a) guess intent+entities for messages the rule engine
// couldn't classify, and (b) rephrase an already-correct reply. It never
// receives price/total/order-state authority — see AIProvider.js contract.
export class AnthropicProvider extends AIProvider {
  async classify(text) {
    if (!config.anthropicApiKey) return null;
    const system =
      "Trích xuất ý định đặt món từ câu nói của khách quán ăn. " +
      "Chỉ trả JSON: {\"intent\": one of [add_to_cart, remove_from_cart, update_cart, product_question, unknown], " +
      "\"productQuery\": string|null, \"quantity\": number|null}. " +
      "Không suy diễn giá, không đặt tên món ngoài câu khách nói — chỉ trích nguyên văn cụm từ khách dùng để chỉ món.";
    try {
      const res = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: config.anthropicModel,
            max_tokens: 200,
            system,
            messages: [{ role: "user", content: text }],
          }),
        },
        8000
      );
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.content?.find((c) => c.type === "text")?.text;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (err) {
      logger.warn("AI", "anthropic classify failed", { error: err.message });
      return null;
    }
  }

  async polish(baseText, context) {
    if (!config.anthropicApiKey) return null;
    const system =
      "Bạn là Mary, nhân viên CS của quán Hủ Tiếu Xào A Tiểu, trả lời qua Zalo. " +
      "Viết lại câu trả lời sau cho tự nhiên, ngắn gọn, lịch sự (dùng dạ/ạ), " +
      "GIỮ NGUYÊN mọi số liệu, tên món, giá, tổng tiền — không thêm/bớt thông tin nào.";
    try {
      const res = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: config.anthropicModel,
            max_tokens: 400,
            system,
            messages: [{ role: "user", content: `Nội dung cần giữ nguyên số liệu:\n${baseText}` }],
          }),
        },
        8000
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data?.content?.find((c) => c.type === "text")?.text || null;
    } catch (err) {
      logger.warn("AI", "anthropic polish failed", { error: err.message, context });
      return null;
    }
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
