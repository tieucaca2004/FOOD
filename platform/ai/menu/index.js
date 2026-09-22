import { platformConfig } from "../../config.js";
import { NullMenuVisionProvider } from "./NullMenuVisionProvider.js";
import { AnthropicMenuVisionProvider } from "./AnthropicMenuVisionProvider.js";

export function createMenuVisionProvider() {
  if (platformConfig.menuVisionProvider === "anthropic" && platformConfig.anthropicApiKey) {
    return new AnthropicMenuVisionProvider();
  }
  return new NullMenuVisionProvider();
}
