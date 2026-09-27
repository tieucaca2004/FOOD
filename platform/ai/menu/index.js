import { platformConfig } from "../../config.js";
import { NullMenuVisionProvider } from "./NullMenuVisionProvider.js";
import { AnthropicMenuVisionProvider } from "./AnthropicMenuVisionProvider.js";
import { OpenAIMenuVisionProvider } from "./OpenAIMenuVisionProvider.js";

export function createMenuVisionProvider() {
  if (platformConfig.menuVisionProvider === "anthropic" && platformConfig.anthropicApiKey) {
    return new AnthropicMenuVisionProvider();
  }
  if (platformConfig.menuVisionProvider === "openai" && platformConfig.openaiApiKey) {
    return new OpenAIMenuVisionProvider();
  }
  return new NullMenuVisionProvider();
}
