import { platformConfig } from "../../config.js";

// Thin OpenAI Responses API client — the only place that talks to OpenAI.
// Same style as ConciergeAnthropicProvider: plain fetch, no SDK dependency.
//
// Stateless (store=false): every call sends the whole turn. Between tool
// rounds the caller appends `output` (function calls and, for reasoning
// models, their encrypted reasoning items) plus the tool results, so no
// customer conversation is kept on OpenAI's side.
//
// Never logs or returns the API key; errors carry a `kind` the caller maps
// to a fallback reason.

export class OpenAIProviderError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind; // timeout | rate_limit | http | network | invalid_response | not_configured
    this.status = status;
  }
}

export class OpenAIProvider {
  /**
   * @param {object} [opts] defaults from platformConfig; fetchImpl is injectable for tests
   */
  constructor({
    apiKey = platformConfig.openaiApiKey,
    model = platformConfig.openaiModel,
    baseUrl = platformConfig.openaiBaseUrl,
    includeReasoning = platformConfig.openaiIncludeReasoning,
    fetchImpl = globalThis.fetch,
    label = "OpenAI", // names the service in error messages (another Responses-compatible API reuses this client)
  } = {}) {
    this.apiKey = apiKey;
    this.label = label;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.includeReasoning = includeReasoning;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.apiKey && this.model);
  }

  /**
   * @param {{instructions: string, input: object[], tools?: object[], format?: object, timeoutMs: number}} req
   * @returns {Promise<{id: string|null, output: object[], functionCalls: {callId: string, name: string, arguments: string}[], text: string, usage: object|null}>}
   */
  async respond({ instructions, input, tools = [], format = null, timeoutMs }) {
    if (!this.configured) throw new OpenAIProviderError("not_configured", `${this.label} is not configured`);
    const body = {
      model: this.model,
      instructions,
      input,
      store: false,
      ...(tools.length && { tools, tool_choice: "auto" }),
      ...(format && { text: { format } }),
      ...(this.includeReasoning && { include: ["reasoning.encrypted_content"] }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw err?.name === "AbortError" ? new OpenAIProviderError("timeout", `${this.label} request timed out`) : new OpenAIProviderError("network", `${this.label} request failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new OpenAIProviderError("rate_limit", `${this.label} rate limit`, 429);
    if (!res.ok) throw new OpenAIProviderError("http", `${this.label} HTTP ${res.status}`, res.status);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new OpenAIProviderError("invalid_response", `${this.label} response is not JSON`);
    }
    if (!Array.isArray(data?.output)) throw new OpenAIProviderError("invalid_response", `${this.label} response has no output`);
    const functionCalls = data.output
      .filter((item) => item.type === "function_call")
      .map((item) => ({ callId: item.call_id, name: item.name, arguments: item.arguments ?? "{}" }));
    const text = data.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
    return { id: data.id ?? null, output: data.output, functionCalls, text, usage: data.usage ?? null };
  }
}
