import { platformConfig } from "../../config.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { ClaudeCliProvider, resolveClaudeCliCommand } from "./ClaudeCliProvider.js";
import { ModelRouter } from "../../router/ModelRouter.js";

export const FOOD_AGENT_ID = "food-agent";
export const CLAUDE_CLI_ID = "claude-cli";
const TELEGRAM_PREFIX = "telegram:"; // the channel's namespaced customer id (telegramWebhookController.js)

/** The Telegram user id of a customer created by the Telegram channel, else null (a Zalo customer never matches). */
export function telegramUserId(customer) {
  const id = customer?.zalo_user_id;
  return typeof id === "string" && id.startsWith(TELEGRAM_PREFIX) ? id.slice(TELEGRAM_PREFIX.length) : null;
}

/**
 * The registry the Telegram Model Router uses:
 *   food-agent  default for everyone — the existing router (Search V2 / Knowledge / Fact Guard / Ordering), unchanged
 *   claude-cli  CLAUDE_CLI_ENABLED=true + an executable found, for CLAUDE_CLI_TELEGRAM_USER_IDS only; text only
 */
export function createModelRegistry({ inner, gptModel = null, config = platformConfig, claude = undefined, logger = null }) {
  const registry = new ModelRegistry({ defaultModelId: FOOD_AGENT_ID });
  registry.register({
    id: FOOD_AGENT_ID,
    displayName: gptModel ? `FOOD Agent — ${gptModel}` : "FOOD Agent",
    type: "channel-router",
    enabled: true,
    aliases: ["food", "gpt", "gpt-4o", ...(gptModel ? [String(gptModel).toLowerCase()] : [])],
    timeoutMs: config.openaiTimeoutMs,
    capabilities: { foodKnowledge: true, ordering: true, images: true },
    invoke: (req) => inner.handle(req),
  });

  if (config.claudeCliEnabled) {
    const allowed = new Set(config.claudeCliTelegramUserIds);
    const provider =
      claude ??
      new ClaudeCliProvider({
        command: resolveClaudeCliCommand({ configured: config.claudeCliPath }),
        model: config.claudeCliModel,
        timeoutMs: config.claudeCliTimeoutMs,
        maxConcurrent: config.claudeCliMaxConcurrent,
      });
    if (!provider.available) logger?.warn("APP", "claude cli backend: executable not found (set CLAUDE_CLI_PATH); it will answer 'unavailable'");
    registry.register({
      id: CLAUDE_CLI_ID,
      displayName: "Claude CLI",
      type: "cli",
      enabled: allowed.size > 0,
      aliases: ["claude"],
      timeoutMs: config.claudeCliTimeoutMs,
      capabilities: { textOnly: true, tools: false, foodKnowledge: false, ordering: false },
      allows: (customer) => allowed.has(telegramUserId(customer) ?? ""),
      invoke: (req) => provider.invoke(req),
    });
  }
  return registry;
}

/** The router the Telegram channel should see: the Model Router when a non-default backend is enabled, else `inner`. */
export function createTelegramModelRouter({ inner, gptModel = null, config = platformConfig, claude = undefined, logger = null }) {
  const registry = createModelRegistry({ inner, gptModel, config, claude, logger });
  if (!registry.get(CLAUDE_CLI_ID)) return { router: inner, registry, modelRouter: null };
  const modelRouter = new ModelRouter({ inner, registry, logger, selectionTtlMs: config.modelSelectionTtlMinutes * 60_000 });
  return { router: modelRouter.wrap(), registry, modelRouter };
}
