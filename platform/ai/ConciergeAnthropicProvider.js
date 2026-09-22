import { AIProvider } from "../../src/ai/AIProvider.js"; // generic contract — read-only reuse
import { platformConfig } from "../config.js";
import { logger } from "../../src/logger.js";

// Optional fallback for messages the rule-based concierge (platform/nlp/concierge.js)
// classifies as "unknown". Same non-authoritative contract as AIProvider:
// it may only ever suggest search keywords/merchant name hints — the
// DiscoveryEngine's actual DB search and RankingService's scoring are
// unaffected by anything this returns.
export class ConciergeAnthropicProvider extends AIProvider {
  async classify(text) {
    if (!platformConfig.anthropicApiKey) return null;
    const system =
      "Trích xuất ý định tìm quán ăn từ câu khách nói với tổng đài Zalo marketplace. " +
      'Chỉ trả JSON: {"intent": one of [search_food, open_merchant_by_name, unknown], ' +
      '"searchKeywords": string|null, "merchantNameHint": string|null}. ' +
      "Không tự đặt tên merchant hay sản phẩm ngoài nguyên văn câu khách nói.";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": platformConfig.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: platformConfig.anthropicModel,
          max_tokens: 200,
          system,
          messages: [{ role: "user", content: text }],
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.content?.find((c) => c.type === "text")?.text;
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn("AI", "concierge anthropic classify failed", { error: err.message });
      return null;
    }
  }
}
