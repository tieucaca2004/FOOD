import { MenuVisionProvider } from "./MenuVisionProvider.js";
import { platformConfig } from "../../config.js";
import { logger } from "../../../src/logger.js";

// Real provider adapter. UNVERIFIED against a live key in this
// environment (no credential available) — same honesty posture as
// platform/ai/ConciergeAnthropicProvider.js. Never called unless
// MENU_VISION_PROVIDER=anthropic AND ANTHROPIC_API_KEY is set; automated
// tests never depend on this class (they use a deterministic fake — see
// platform/test/helpers/fakeMenuVisionProvider.js).
export class AnthropicMenuVisionProvider extends MenuVisionProvider {
  async parseImage(imageBuffer, mimeType) {
    if (!platformConfig.anthropicApiKey) {
      const err = new Error("ANTHROPIC_API_KEY not configured");
      err.code = "VISION_PROVIDER_NOT_CONFIGURED";
      throw err;
    }

    const system =
      "Bạn đọc ảnh chụp/scan menu quán ăn. Chỉ trả JSON đúng schema: " +
      '{"categories":[{"name":string,"confidence":number|null,' +
      '"products":[{"name":string,"price":number|null,"description":string|null,"confidence":number|null}]}]}. ' +
      "CHỈ đọc đúng những gì thấy trong ảnh. Nếu giá không đọc rõ (mờ, bị che, không chắc chắn): " +
      "price=null, confidence thấp hoặc null. KHÔNG được tự đoán hay bịa giá, tên món, hay category " +
      "không có trong ảnh. KHÔNG thêm bất kỳ text nào ngoài JSON.";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": platformConfig.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: platformConfig.menuVisionModel,
          max_tokens: 2000,
          system,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
                { type: "text", text: "Đọc menu trong ảnh này." },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`Anthropic vision API ${res.status}: ${body}`);
        err.code = "VISION_PROVIDER_ERROR";
        throw err;
      }
      const data = await res.json();
      const raw = data?.content?.find((c) => c.type === "text")?.text;
      if (!raw) {
        const err = new Error("Anthropic vision API returned no text content");
        err.code = "VISION_PROVIDER_ERROR";
        throw err;
      }
      try {
        return JSON.parse(raw);
      } catch (parseErr) {
        const err = new Error(`Vision provider returned non-JSON output: ${parseErr.message}`);
        err.code = "OCR_FAILED";
        throw err;
      }
    } catch (err) {
      if (err.code) throw err; // already classified above
      logger.warn("AI", "menu vision provider call failed", { error: err.message });
      const wrapped = new Error(err.name === "AbortError" ? "Vision provider request timed out" : err.message);
      wrapped.code = "VISION_PROVIDER_ERROR";
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }
}
