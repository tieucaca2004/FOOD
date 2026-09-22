import { config } from "../config.js";
import { NullProvider } from "./NullProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";

export function createAIProvider() {
  if (config.aiProvider === "anthropic" && config.anthropicApiKey) {
    return new AnthropicProvider();
  }
  return new NullProvider();
}
