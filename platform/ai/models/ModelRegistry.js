// Model Registry (FORM 11): the backends a channel may route a conversation turn to. Each backend is one object
//   { id, displayName, type, enabled, timeoutMs, capabilities, aliases?, allows?(customer), invoke(request) }
// invoke() resolves to { ok: true, text } or { ok: false, reason, exitCode? } — it never throws for an expected failure.
// The registry knows nothing about Telegram, Claude or GPT; it only validates and looks backends up.

const REQUIRED = ["id", "displayName", "type"];

export class ModelRegistry {
  constructor({ defaultModelId }) {
    this.defaultModelId = defaultModelId;
    this._backends = new Map();
  }

  register(backend) {
    for (const k of REQUIRED) if (typeof backend?.[k] !== "string" || !backend[k]) throw new Error(`model backend missing ${k}`);
    if (typeof backend.invoke !== "function") throw new Error(`model backend ${backend.id} has no invoke()`);
    if (this._backends.has(backend.id)) throw new Error(`model backend ${backend.id} already registered`);
    this._backends.set(backend.id, backend);
    return this;
  }

  /** A backend by id or alias (case-insensitive); disabled ones are invisible. */
  get(idOrAlias) {
    const key = String(idOrAlias ?? "").trim().toLowerCase();
    for (const b of this._backends.values()) {
      if (!b.enabled) continue;
      if (b.id === key || (b.aliases ?? []).includes(key)) return b;
    }
    return null;
  }

  /** Enabled backends this customer may use, default first. */
  listFor(customer) {
    return [...this._backends.values()]
      .filter((b) => b.enabled && (b.id === this.defaultModelId || (b.allows?.(customer) ?? false)))
      .sort((a, b) => (a.id === this.defaultModelId ? -1 : b.id === this.defaultModelId ? 1 : 0));
  }

  default() {
    return this._backends.get(this.defaultModelId) ?? null;
  }
}
