import crypto from "node:crypto";

// Model Router (FORM 11) — sits IN FRONT of the channel router for Telegram only (same wrapping idea as
// ContributionService.wrapRouter). It adds /models and /model [id] and sends each text turn to the backend the
// customer selected; the default backend is the FOOD Agent, i.e. the existing router's handle(), called unchanged.
//
// A customer who may use no backend besides the default never sees any of this: their commands and messages pass
// straight through, byte-for-byte as before. Selection is kept per customer on THIS instance (idle TTL), never in a
// global; a lost selection falls back to the default, never to another backend. A failed non-default backend answers
// with its own "unavailable" message — it never silently hands the turn to the FOOD Agent.

const COMMAND = /^\/(models|model)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/i;
const MAX_REPLY_CHARS = 3900; // Telegram's sendMessage limit is 4096
const MAX_SELECTIONS = 1000;

const USER_TEXT = {
  failed: (name) => `${name} hiện không khả dụng.`,
  busy: (name) => `${name} đang bận xử lý yêu cầu khác, anh/chị thử lại sau ít phút nhé.`,
  tooLong: (name) => `Tin nhắn quá dài cho ${name}.`,
  textOnly: (name) => `${name} chỉ nhận tin nhắn chữ. Gõ /model food-agent để quay lại FOOD Agent.`,
};

export const hashUser = (id) => crypto.createHash("sha256").update(String(id ?? "")).digest("hex").slice(0, 12);

export class ModelRouter {
  constructor({ inner, registry, logger = null, selectionTtlMs = 12 * 3600_000, now = () => Date.now() }) {
    this.inner = inner;
    this.registry = registry;
    this.logger = logger;
    this.selectionTtlMs = selectionTtlMs;
    this.now = now;
    this._selection = new Map(); // customer.id -> { modelId, touchedAt }
  }

  /** The channel-facing router: handle() goes through the Model Router, everything else to the inner router. */
  wrap() {
    const self = this;
    return new Proxy(this.inner, {
      get(target, prop, receiver) {
        if (prop === "handle") return (req) => self.handle(req);
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** The backend this customer is on now (the default when nothing valid is selected). */
  selected(customer) {
    const key = customer?.id;
    const sel = key != null ? this._selection.get(key) : null;
    if (sel && this.now() - sel.touchedAt > this.selectionTtlMs) this._selection.delete(key);
    else if (sel) {
      const backend = this.registry.get(sel.modelId);
      if (backend && this._usable(backend, customer)) return backend;
      this._selection.delete(key);
    }
    return this.registry.default();
  }

  async handle(req) {
    const { customer, session, text, inbound = null } = req;
    const visible = this.registry.listFor(customer);
    // nobody but the default for this customer: the Model Router does not exist for them
    if (visible.length <= 1) return this.inner.handle(req);

    const m = !inbound && typeof text === "string" ? COMMAND.exec(text.trim()) : null;
    if (m) return { replyText: this._command(customer, visible, m[1].toLowerCase(), m[2]), session, modelCommand: true };

    const backend = this.selected(customer);
    if (!backend || backend.id === this.registry.defaultModelId) return this.inner.handle(req);
    this._touch(customer, backend.id);
    if (inbound) return { replyText: USER_TEXT.textOnly(backend.displayName), session, model: backend.id };
    return this._invoke(backend, customer, session, text);
  }

  _command(customer, visible, name, arg) {
    const current = this.selected(customer);
    if (name === "models") {
      const lines = visible.map((b, i) => `${i + 1}. ${b.displayName} — /model ${b.id}${b.id === current?.id ? " (đang dùng)" : ""}`);
      return `Models:\n${lines.join("\n")}`;
    }
    if (!arg) return `Model: ${current?.displayName ?? "—"}`;
    const target = this.registry.get(arg);
    if (!target || !this._usable(target, customer)) return `Không có model "${arg.slice(0, 40)}". Gõ /models để xem danh sách.`;
    if (target.id === this.registry.defaultModelId) this._selection.delete(customer.id);
    else this._touch(customer, target.id);
    this.logger?.info("MODEL", "model selected", { user: hashUser(customer?.id), model: target.id });
    return `Model: ${target.displayName}`;
  }

  async _invoke(backend, customer, session, text) {
    const turnId = crypto.randomUUID();
    const started = this.now();
    let result;
    try {
      result = await backend.invoke({ text, customer, session, turnId });
    } catch {
      result = { ok: false, reason: "crash" };
    }
    const meta = { turnId, user: hashUser(customer?.id), model: backend.id, durationMs: this.now() - started, ok: Boolean(result?.ok), reason: result?.ok ? undefined : result?.reason ?? "unknown", exitCode: result?.exitCode ?? null };
    if (result?.ok) this.logger?.info("MODEL", "model turn", meta);
    else this.logger?.warn("MODEL", "model turn failed", meta);

    if (!result?.ok) {
      const reply = result?.reason === "busy" ? USER_TEXT.busy : result?.reason === "prompt_too_long" ? USER_TEXT.tooLong : USER_TEXT.failed;
      return { replyText: reply(backend.displayName), session, model: backend.id, modelError: result?.reason ?? "unknown" };
    }
    const header = `[${backend.displayName}]\n`;
    let body = result.text;
    if (header.length + body.length > MAX_REPLY_CHARS) body = `${body.slice(0, MAX_REPLY_CHARS - header.length - 20)}\n…(đã cắt bớt)`;
    return { replyText: header + body, session, model: backend.id };
  }

  _usable(backend, customer) {
    return backend.enabled && (backend.id === this.registry.defaultModelId || Boolean(backend.allows?.(customer)));
  }

  _touch(customer, modelId) {
    if (customer?.id == null) return;
    this._selection.delete(customer.id);
    this._selection.set(customer.id, { modelId, touchedAt: this.now() });
    if (this._selection.size > MAX_SELECTIONS) this._selection.delete(this._selection.keys().next().value);
  }
}
