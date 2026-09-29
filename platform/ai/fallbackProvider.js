// FOOD Agent model routing: a PRIMARY provider (DeepSeek) and a FALLBACK provider (OpenAI GPT-4o) behind the one
// provider interface the concierge already uses ({ model, configured, respond() }).
//
// Fallback happens per MODEL CALL, never per turn: when the primary fails, the SAME request (the same transcript,
// with the tool results already in it) goes to the fallback and the concierge carries on from there. This class
// never runs a tool, never re-runs a turn and writes nothing, so a fallback cannot repeat a tool call, an order or a
// learning observation. What the concierge decides itself (the Fact Guard, tool argument validation, the tool-round
// limit) never reaches a provider and never falls back.
//
// - The primary gets a share of the time left; the fallback gets the rest of the same budget.
// - Once a turn has fallen back, its later calls go straight to the fallback (no second wait on a slow primary).
// - 401 / 403 from the primary is a configuration error: logged as an error, and the primary is skipped for a
//   cool-down (one new attempt per window, never a retry loop) while the fallback answers.
// - Items one provider produced are cleaned before the other provider sees them (a copy; the concierge's transcript
//   is never changed): reasoning items and provider item ids are dropped, messages and function calls are kept.
//
// Logs carry provider names, models, error kinds and HTTP statuses only: never the transcript or a key.

const AUTH_STATUSES = new Set([401, 403]);

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("model call exceeded its time share"), { kind: "timeout" })), Math.max(1, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// an item as a provider that did not produce it may receive it; null = leave it out
function portable(item) {
  if (item?.type === "function_call") return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" };
  if (item?.type === "message") {
    const text = (item.content ?? []).filter((c) => c?.type === "output_text").map((c) => c.text).join("");
    return { role: item.role ?? "assistant", content: text };
  }
  return null; // reasoning items and anything provider-specific
}

export class FallbackProvider {
  constructor({ primary = null, fallback = null, logger = null, primaryTimeoutShare = 0.6, minFallbackMs = 1000, authCooldownMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
    this.primaryTimeoutShare = Math.min(1, Math.max(0.1, Number(primaryTimeoutShare) || 0.6));
    this.minFallbackMs = minFallbackMs;
    this.authCooldownMs = authCooldownMs;
    this.now = now;
    this.authFailedAt = null;
    this.origin = new WeakMap(); // output item -> the provider that produced it
    this.fellBack = new WeakSet(); // the first input item of turns that already fell back
    this.stats = { primaryCalls: 0, primaryFailures: 0, fallbackCalls: 0, authFailures: 0 };
  }

  get configured() {
    return Boolean(this.primary?.configured || this.fallback?.configured);
  }

  /** the model the Agent calls first */
  get model() {
    return (this.primary?.configured ? this.primary.model : this.fallback?.model) ?? null;
  }

  describe() {
    return {
      primary: this.primary ? { model: this.primary.model ?? null, configured: Boolean(this.primary.configured) } : null,
      fallback: this.fallback ? { model: this.fallback.model ?? null, configured: Boolean(this.fallback.configured) } : null,
      primaryTimeoutShare: this.primaryTimeoutShare,
    };
  }

  _primaryUsable() {
    if (!this.primary?.configured) return false;
    return this.authFailedAt === null || this.now() - this.authFailedAt >= this.authCooldownMs;
  }

  async respond(req) {
    const started = this.now();
    const hasFallback = Boolean(this.fallback?.configured);
    const turnKey = Array.isArray(req.input) && typeof req.input[0] === "object" && req.input[0] ? req.input[0] : null;
    if (hasFallback && (!this._primaryUsable() || (turnKey && this.fellBack.has(turnKey)))) return this._call(this.fallback, req);
    this.stats.primaryCalls += 1;
    const share = hasFallback ? Math.max(1, Math.floor(req.timeoutMs * this.primaryTimeoutShare)) : req.timeoutMs;
    try {
      return await this._call(this.primary, { ...req, timeoutMs: share }, share);
    } catch (err) {
      this.stats.primaryFailures += 1;
      const status = Number.isInteger(err?.status) ? err.status : null;
      const auth = AUTH_STATUSES.has(status);
      if (auth) {
        this.stats.authFailures += 1;
        this.authFailedAt = this.now();
        this.logger?.error?.("AI", "food agent PRIMARY provider authentication/configuration error: check its API key and base URL", { provider: this.primary.name ?? null, model: this.primary.model ?? null, status, fallback: hasFallback ? this.fallback.model ?? null : null, primarySkippedForMs: hasFallback ? this.authCooldownMs : 0 });
      }
      if (!hasFallback) throw err;
      const remaining = req.timeoutMs - (this.now() - started);
      if (remaining < this.minFallbackMs) {
        this.logger?.warn?.("AI", "food agent primary provider failed, no time left for the fallback", { from: this.primary.model ?? null, reason: err?.kind ?? "provider_error", status, remainingMs: Math.max(0, remaining) });
        throw err;
      }
      if (turnKey) this.fellBack.add(turnKey);
      this.logger?.warn?.("AI", "food agent provider fallback", { from: this.primary.model ?? null, to: this.fallback.model ?? null, reason: err?.kind ?? "provider_error", status });
      return this._call(this.fallback, { ...req, timeoutMs: remaining });
    }
  }

  async _call(provider, req, deadlineMs = null) {
    if (provider === this.fallback) this.stats.fallbackCalls += 1;
    const input = this._inputFor(provider, req.input);
    const pending = provider.respond({ ...req, input });
    const res = await (deadlineMs ? withDeadline(pending, deadlineMs) : pending);
    for (const item of res?.output ?? []) if (item && typeof item === "object") this.origin.set(item, provider);
    return res;
  }

  // the transcript as `provider` may receive it: items another provider produced are made portable (a new array)
  _inputFor(provider, input) {
    if (!Array.isArray(input)) return input;
    const foreign = (item) => item && typeof item === "object" && this.origin.has(item) && this.origin.get(item) !== provider;
    if (!input.some(foreign)) return input;
    return input.flatMap((item) => {
      if (!foreign(item)) return [item];
      const p = portable(item);
      return p ? [p] : [];
    });
  }
}
