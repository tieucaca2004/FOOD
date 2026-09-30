import { platformConfig } from "../../config.js";
import { OpenAIProvider, OpenAIProviderError } from "../openai/OpenAIProvider.js";

// DeepSeek through its OpenAI-compatible Responses API: the SAME client as OpenAI
// (OpenAIProvider), pointed at DeepSeek's base URL with DeepSeek's key and model.
//
// Two things differ, and only here:
// - no `include` (reasoning.encrypted_content is an OpenAI parameter);
// - strict json_schema output is not relied on: a json_schema format is sent as
//   json_object, the schema is stated in the instructions, and the answer is
//   checked against the schema here. A tool call without call_id / name / JSON
//   object arguments, or a final answer that does not match the schema, is an
//   `invalid_response` — a provider failure the fallback provider acts on,
//   before anything reaches the Fact Guard.
//
// Every turn is sent whole (stateless), so nothing depends on DeepSeek's `store`.
// Never logs or returns the API key.

const invalid = (message) => new OpenAIProviderError("invalid_response", `DeepSeek ${message}`);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Errors of `value` against the JSON-schema subset FOOD's answer formats use; [] when it matches. */
export function schemaErrors(schema, value, at = "$") {
  if (!schema || typeof schema !== "object") return [];
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return [`${at} must be an object`];
      const props = schema.properties ?? {};
      const errors = [];
      for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key} is required`);
      for (const [key, v] of Object.entries(value)) {
        if (props[key]) errors.push(...schemaErrors(props[key], v, `${at}.${key}`));
        else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
      }
      return errors;
    }
    case "array":
      if (!Array.isArray(value)) return [`${at} must be an array`];
      return value.flatMap((v, i) => schemaErrors(schema.items, v, `${at}[${i}]`));
    case "string":
      return typeof value === "string" ? [] : [`${at} must be a string`];
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${at} must be a number`];
    case "integer":
      return Number.isInteger(value) ? [] : [`${at} must be an integer`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at} must be a boolean`];
    default:
      return [];
  }
}

function checkFunctionCalls(functionCalls) {
  for (const call of functionCalls) {
    if (typeof call.callId !== "string" || !call.callId) throw invalid("function_call without call_id");
    if (typeof call.name !== "string" || !call.name) throw invalid("function_call without name");
    let args;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      throw invalid("function_call arguments are not JSON");
    }
    if (!isObject(args)) throw invalid("function_call arguments are not a JSON object");
  }
}

export class DeepSeekProvider {
  constructor({
    apiKey = platformConfig.deepseekApiKey,
    model = platformConfig.foodAgentPrimaryModel,
    baseUrl = platformConfig.deepseekBaseUrl,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.name = "deepseek";
    this.client = new OpenAIProvider({ apiKey, model, baseUrl, includeReasoning: false, fetchImpl, label: "DeepSeek" });
  }

  get model() {
    return this.client.model;
  }

  get configured() {
    return this.client.configured;
  }

  async respond({ instructions, input, tools = [], format = null, timeoutMs }) {
    const schema = format?.type === "json_schema" ? format.schema : null;
    const res = await this.client.respond({
      instructions: schema ? `${instructions}\n\nReply with one JSON object that matches this JSON Schema exactly (every required key, no other keys):\n${JSON.stringify(schema)}` : instructions,
      input,
      tools,
      format: schema ? { type: "json_object" } : format,
      timeoutMs,
    });
    checkFunctionCalls(res.functionCalls);
    if (schema && !res.functionCalls.length) {
      let answer;
      try {
        answer = JSON.parse(res.text);
      } catch {
        throw invalid("final answer is not JSON");
      }
      const errors = schemaErrors(schema, answer);
      if (errors.length) throw invalid(`final answer does not match the schema (${errors.slice(0, 3).join("; ")})`);
    }
    return res;
  }
}
