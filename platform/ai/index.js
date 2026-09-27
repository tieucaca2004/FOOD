import { NullProvider } from "../../src/ai/NullProvider.js"; // generic, read-only reuse
import { ConciergeAnthropicProvider } from "./ConciergeAnthropicProvider.js";
import { platformConfig } from "../config.js";

/**
 * GPT FOOD concierge, or null when it is not fully enabled (OPENAI_ENABLED=true + key + model).
 * Built only from the services the router already has; nothing here is imported by the router.
 */
export async function createGptFoodConcierge({ services, repos, agentSearch, merchantRouter, logger, contributions = null }) {
  if (!platformConfig.openaiEnabled || !platformConfig.openaiApiKey || !platformConfig.openaiModel) return null;
  const { OpenAIProvider } = await import("./openai/OpenAIProvider.js");
  const { FoodTools } = await import("./foodConcierge/foodTools.js");
  const { GptFoodConcierge } = await import("./foodConcierge/GptFoodConcierge.js");
  const deps = {
    provider: new OpenAIProvider(),
    tools: new FoodTools({ services, repos, agentSearch, merchantRouter }),
    logger,
    timeoutMs: platformConfig.openaiTimeoutMs,
    maxToolTurns: platformConfig.openaiMaxToolTurns,
  };
  // knowledge layers only when a flag asks for them — with both flags OFF this is exactly the GPT-2 concierge
  if (platformConfig.founderKnowledgeEnabled || platformConfig.foodAliasKnowledgeEnabled || platformConfig.searchIntelligenceEnabled || contributions) {
    const { createKnowledgeLayers, KnowledgeAwareConcierge } = await import("./foodConcierge/knowledgeLayers.js");
    const layers = createKnowledgeLayers({ tools: deps.tools, founder: platformConfig.founderKnowledgeEnabled, alias: platformConfig.foodAliasKnowledgeEnabled, search: platformConfig.searchIntelligenceEnabled, contributions });
    if (layers.unavailable.length) logger?.warn("APP", "gpt knowledge layers NOT available (knowledge DB without them)", { layers: layers.unavailable });
    if (layers.founder || layers.matcher || layers.search || layers.contributions) {
      logger?.info("APP", "gpt knowledge layers enabled (read-only)", { founderKnowledge: Boolean(layers.founder), foodAliasKnowledge: Boolean(layers.matcher), searchIntelligence: Boolean(layers.search), userContributions: Boolean(layers.contributions) });
      return new KnowledgeAwareConcierge({ ...deps, layers });
    }
  }
  return new GptFoodConcierge(deps);
}

export function createConciergeAIProvider() {
  if (platformConfig.aiProvider === "anthropic" && platformConfig.anthropicApiKey) {
    return new ConciergeAnthropicProvider();
  }
  return new NullProvider();
}
