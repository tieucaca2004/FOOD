import { TOOL_DEFINITIONS } from "./foodTools.js";

// FoodAIToolRegistry — the ONLY way the model reaches FOOD data.
// A tool = { name, description, inputSchema, handler }. The model sees name + description + schema;
// the handler runs in the backend over existing services (never SQL, shell, filesystem, HTTP or eval).
// execute() rejects a tool that is not registered and arguments that do not match the schema, before
// any handler runs; a handler failure is returned as a structured error, never thrown at the model.

export class ToolRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // UNKNOWN_TOOL | INVALID_ARGUMENTS | TOOL_FAILED
  }
}

/** Minimal JSON-schema check for tool arguments: object, required, types, enums, bounds, no extra keys. */
export function validateArgs(schema, args) {
  const errors = [];
  if (!args || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) if (args[key] === undefined || args[key] === null || args[key] === "") errors.push(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p) {
      if (schema.additionalProperties === false) errors.push(`${key} is not allowed`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (p.type === "string") {
      if (typeof value !== "string") errors.push(`${key} must be a string`);
      else if (value.length > (p.maxLength ?? 500)) errors.push(`${key} is too long`);
    } else if (p.type === "number" || p.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || (p.type === "integer" && !Number.isInteger(value))) errors.push(`${key} must be a${p.type === "integer" ? "n integer" : " number"}`);
      else {
        if (p.minimum !== undefined && value < p.minimum) errors.push(`${key} must be >= ${p.minimum}`);
        if (p.maximum !== undefined && value > p.maximum) errors.push(`${key} must be <= ${p.maximum}`);
      }
    } else if (p.type === "boolean" && typeof value !== "boolean") errors.push(`${key} must be a boolean`);
    if (p.enum && !p.enum.includes(value)) errors.push(`${key} must be one of ${p.enum.join(", ")}`);
  }
  return errors;
}

export class FoodAIToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register({ name, description, inputSchema, handler }) {
    if (!/^[a-z_]{3,64}$/.test(name)) throw new Error(`invalid tool name ${name}`);
    if (this.tools.has(name)) throw new Error(`tool ${name} already registered`);
    if (typeof handler !== "function") throw new Error(`tool ${name} has no handler`);
    this.tools.set(name, { name, description, inputSchema, handler });
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  /** What the model sees (OpenAI function-tool shape): no handler, no implementation detail. */
  definitions() {
    return [...this.tools.values()].map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
  }

  /**
   * @returns {Promise<{ok: true, data: object, facts: object[]} | {ok: false, error: {code: string, message: string}, data: object, facts: []}>}
   */
  async execute(name, args, ctx) {
    const fail = (code, message) => ({ ok: false, error: { code, message }, data: { error: code, message }, facts: [] });
    const tool = this.tools.get(name);
    if (!tool) return fail("UNKNOWN_TOOL", `tool ${String(name).slice(0, 64)} is not available`);
    const errors = validateArgs(tool.inputSchema, args);
    if (errors.length) return fail("INVALID_ARGUMENTS", errors.join("; "));
    try {
      const { data, facts = [] } = await tool.handler(args, ctx);
      return { ok: true, data, facts };
    } catch {
      return fail("TOOL_FAILED", "the tool could not complete"); // detail stays in the backend
    }
  }
}

/** The FOOD registry: the tool contracts of foodTools.js bound to a FoodTools instance (read-only). */
export function createFoodToolRegistry(foodTools) {
  const registry = new FoodAIToolRegistry();
  for (const def of TOOL_DEFINITIONS) {
    registry.register({ name: def.name, description: def.description, inputSchema: def.parameters, handler: (args, ctx) => foodTools.run(def.name, args, ctx) });
  }
  return registry;
}
