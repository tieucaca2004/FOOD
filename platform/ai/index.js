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
    provider: new OpenAIProvider({ model: platformConfig.foodAgentModel }),
    tools: new FoodTools({ services, repos, agentSearch, merchantRouter }),
    logger,
    timeoutMs: platformConfig.openaiTimeoutMs,
    maxToolTurns: platformConfig.openaiMaxToolTurns,
    history: conversationHistory(repos, platformConfig.foodAgentHistoryTurns),
    learning: await agentLearning({ agentSearch, logger }),
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

/** Controlled learning for the Agent (FOOD_AGENT_LEARNING_ENABLED): DRAFT candidates only, read-only APPROVED matcher. */
async function agentLearning({ agentSearch, logger }) {
  if (!platformConfig.foodAgentLearningEnabled) return null;
  try {
    const { createTermLearning } = await import("../services/knowledgeIngestAdapter.js");
    const { createAgentLearning } = await import("./foodConcierge/learning.js");
    const sink = createTermLearning({ dbPath: platformConfig.knowledgeIngestDbPath, rawRoot: platformConfig.knowledgeIngestRawRoot, hashKey: platformConfig.contributorHashKey, hashKid: platformConfig.contributorHashKid });
    logger?.info?.("APP", "food agent learning enabled (candidates only)", { dbPath: platformConfig.knowledgeIngestDbPath });
    return createAgentLearning({ sink, matcher: () => agentSearch?.foodKnowledge?.termMatcher?.() ?? null, logger });
  } catch (err) {
    logger?.warn?.("APP", "food agent learning NOT enabled", { error: String(err?.message ?? err).slice(0, 160) });
    return null;
  }
}

/**
 * The Agent's view of the conversation: the last turns of this session from platform_messages (the log the channels
 * already write), oldest first, without the message being answered now. Read-only; no new state.
 */
export function conversationHistory(repos, turns) {
  if (!turns || !repos?.messages?.recentForSession) return null;
  return (session, text) => {
    if (!session?.id) return [];
    const rows = repos.messages.recentForSession(session.id, turns * 2 + 1);
    // the channel logged the current message before the router ran: it is the question, not history
    if (rows.length && rows.at(-1).direction === "in" && rows.at(-1).rawText === text) rows.pop();
    return rows.slice(-turns * 2).map((r) => ({ role: r.direction === "in" ? "customer" : "food", text: r.rawText }));
  };
}

export function createConciergeAIProvider() {
  if (platformConfig.aiProvider === "anthropic" && platformConfig.anthropicApiKey) {
    return new ConciergeAnthropicProvider();
  }
  return new NullProvider();
}
