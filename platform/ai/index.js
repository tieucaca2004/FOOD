import { NullProvider } from "../../src/ai/NullProvider.js"; // generic, read-only reuse
import { ConciergeAnthropicProvider } from "./ConciergeAnthropicProvider.js";
import { platformConfig } from "../config.js";

export function createConciergeAIProvider() {
  if (platformConfig.aiProvider === "anthropic" && platformConfig.anthropicApiKey) {
    return new ConciergeAnthropicProvider();
  }
  return new NullProvider();
}
