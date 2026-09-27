import { MenuVisionProvider } from "./MenuVisionProvider.js";
import { platformConfig } from "../../config.js";
import { logger } from "../../../src/logger.js";

// Menu image -> structured PROPOSAL through the OpenAI Responses API (MENU_VISION_PROVIDER=openai, the existing
// OPENAI_API_KEY; model OPENAI_VISION_MODEL, default OPENAI_MODEL). Like every provider it only READS the image:
// what it returns goes through MenuImportService's own validation into a DRAFT / REVIEW_REQUIRED import that a
// person approves and publishes — it never writes the catalog. Stateless (store=false). The key is sent only as
// the Authorization header and never logged; an API error keeps only its status (never the response body).

const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories"],
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "confidence", "products"],
        properties: {
          name: { type: ["string", "null"] },
          confidence: { type: ["number", "null"] },
          products: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "price", "description", "confidence"],
              properties: {
                name: { type: "string" },
                price: { type: ["integer", "null"] },
                description: { type: ["string", "null"] },
                confidence: { type: ["number", "null"] },
              },
            },
          },
        },
      },
    },
  },
};

const INSTRUCTIONS =
  "Bạn đọc ảnh chụp/scan menu quán ăn Việt Nam và chỉ chép lại đúng những gì thấy trong ảnh. " +
  "Giá là số nguyên VND (\"65k\" = 65000, \"65.000đ\" = 65000). Giá không đọc rõ (mờ, bị che, không chắc) -> price=null và confidence thấp. " +
  "KHÔNG đoán, KHÔNG bịa tên món, giá, nhóm món hay mô tả không có trong ảnh. confidence 0..1 theo độ rõ của chữ.";

export class OpenAIMenuVisionProvider extends MenuVisionProvider {
  constructor({ fetchImpl = globalThis.fetch, apiKey = platformConfig.openaiApiKey, model = platformConfig.menuVisionOpenAIModel, baseUrl = platformConfig.openaiBaseUrl, timeoutMs = 45000 } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async parseImage(imageBuffer, mimeType) {
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (!this.apiKey || !this.model) throw fail("VISION_PROVIDER_NOT_CONFIGURED", "OPENAI_API_KEY / model not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          store: false,
          instructions: INSTRUCTIONS,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Đọc menu trong ảnh này." },
                { type: "input_image", image_url: `data:${mimeType};base64,${imageBuffer.toString("base64")}` },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "menu_draft", strict: true, schema: MENU_SCHEMA } },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      logger.warn("AI", "menu vision provider call failed", { provider: "openai", error: err.name === "AbortError" ? "timeout" : "network" });
      throw fail("VISION_PROVIDER_ERROR", err.name === "AbortError" ? "Vision provider request timed out" : "Vision provider network error");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw fail("VISION_PROVIDER_ERROR", `OpenAI vision API HTTP ${res.status}`);
    const data = await res.json();
    const raw = data?.output_text ?? (data?.output ?? []).flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
    if (!raw) throw fail("VISION_PROVIDER_ERROR", "OpenAI vision API returned no text");
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      throw fail("OCR_FAILED", `Vision provider returned non-JSON output: ${parseErr.message}`);
    }
  }
}
