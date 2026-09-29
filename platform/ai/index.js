import { NullProvider } from "../../src/ai/NullProvider.js"; // generic, read-only reuse
import { ConciergeAnthropicProvider } from "./ConciergeAnthropicProvider.js";
import { platformConfig } from "../config.js";

/**
 * GPT FOOD concierge, or null when it is not fully enabled (OPENAI_ENABLED=true + a usable model provider).
 * Built only from the services the router already has; nothing here is imported by the router.
 */
export async function createGptFoodConcierge({ services, repos, agentSearch, merchantRouter, logger, contributions = null }) {
  if (!platformConfig.openaiEnabled) return null;
  const provider = await createFoodAgentProvider({ logger });
  if (!provider) return null;
  const { FoodTools } = await import("./foodConcierge/foodTools.js");
  const { GptFoodConcierge } = await import("./foodConcierge/GptFoodConcierge.js");
  const deps = {
    provider,
    tools: new FoodTools({ services, repos, agentSearch, merchantRouter }),
    logger,
    timeoutMs: platformConfig.openaiTimeoutMs,
    maxToolTurns: platformConfig.openaiMaxToolTurns,
    history: conversationHistory(repos, platformConfig.foodAgentHistoryTurns),
    learning: await agentLearning({ agentSearch, logger }),
    imageMemory: customerImageMemory(repos),
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

/**
 * The model provider of the FOOD Agent, or null when none can be called.
 * - FOOD_AGENT_PRIMARY_MODEL unset: OpenAI alone on FOOD_AGENT_MODEL (the Agent as before).
 * - FOOD_AGENT_PRIMARY_MODEL set: DeepSeek on that model first, OpenAI on FOOD_AGENT_FALLBACK_MODEL when a DeepSeek call
 *   fails (per call, platform/ai/fallbackProvider.js). A missing key on either side is logged, never silent.
 */
export async function createFoodAgentProvider({ logger = null, fetchImpl = globalThis.fetch } = {}) {
  const { OpenAIProvider } = await import("./openai/OpenAIProvider.js");
  if (!platformConfig.foodAgentPrimaryModel) {
    if (!platformConfig.openaiApiKey || !platformConfig.openaiModel) return null;
    return new OpenAIProvider({ model: platformConfig.foodAgentModel, fetchImpl });
  }
  const { DeepSeekProvider } = await import("./deepseek/DeepSeekProvider.js");
  const { FallbackProvider } = await import("./fallbackProvider.js");
  const primary = new DeepSeekProvider({ fetchImpl });
  // GPT-4o is not a reasoning model: no encrypted reasoning is asked of the fallback
  const fallback = new OpenAIProvider({ model: platformConfig.foodAgentFallbackModel, includeReasoning: false, fetchImpl });
  if (!primary.configured) logger?.error?.("APP", "food agent PRIMARY model is set but DEEPSEEK_API_KEY is missing: the Agent runs on the fallback only", { primary: primary.model, fallback: fallback.configured ? fallback.model : null });
  if (!fallback.configured) logger?.warn?.("APP", "food agent has NO fallback model: OPENAI_API_KEY or FOOD_AGENT_FALLBACK_MODEL missing", { primary: primary.model });
  if (!primary.configured && !fallback.configured) return null;
  const provider = new FallbackProvider({ primary, fallback, logger, primaryTimeoutShare: platformConfig.foodAgentPrimaryTimeoutShare });
  logger?.info?.("APP", "food agent model routing", provider.describe());
  return provider;
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
// FORM 15 — the customer's latest photo (the evidence the router stored for THIS customer, 30 minutes): what the Agent
// may still refer to on the next turns ("giá món này?" after a menu photo). Unverified customer data, never a fact.
export const IMAGE_MEMORY_TTL_MS = 30 * 60 * 1000;
export function customerImageMemory(repos, ttlMs = IMAGE_MEMORY_TTL_MS) {
  if (!repos?.conversationStates?.getByCustomer) return null;
  return (customer) => {
    if (!customer?.id) return null;
    const memo = repos.conversationStates.getByCustomer(customer.id)?.lastImage;
    return memo?.evidence && Date.now() - Date.parse(memo.touchedAt) <= ttlMs ? memo.evidence : null;
  };
}

/**
 * The image reader of the FOOD Agent's conversation: the EXISTING OpenAIImageUnderstanding (no second Vision
 * implementation), always on OpenAI, on the Agent's OpenAI model (FOOD_AGENT_FALLBACK_MODEL > FOOD_AGENT_MODEL >
 * OPENAI_MODEL) — never the primary (DeepSeek) model. Only when the Agent itself is enabled; else null.
 */
export async function createConversationImageReader() {
  if (!platformConfig.openaiEnabled || !platformConfig.openaiApiKey) return null;
  const { OpenAIImageUnderstanding } = await import("./ingest/OpenAIImageUnderstanding.js");
  return new OpenAIImageUnderstanding({ model: platformConfig.foodAgentFallbackModel });
}

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
