import { config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const SECRET_KEY_PATTERN = /(token|secret|password|access_token|api_key|apikey|authorization)/i;

// Recursively strips values whose key looks secret-ish, so a stray
// access_token/secret in a logged payload never reaches stdout.
function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level, category, message, meta) {
  if (LEVELS[level] > currentLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    category, // ORDER | ZALO | AI | WEBHOOK | HTTP | DB | APP
    message,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  error: (category, message, meta) => write("error", category, message, meta),
  warn: (category, message, meta) => write("warn", category, message, meta),
  info: (category, message, meta) => write("info", category, message, meta),
  debug: (category, message, meta) => write("debug", category, message, meta),
};
