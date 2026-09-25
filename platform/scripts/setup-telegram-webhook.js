// One-time (or on-change) registration of the platform's Telegram webhook at
// a FIXED public hostname (a Cloudflare Named Tunnel), so a Windows reboot
// never requires touching the webhook again. Not part of the running server:
// the server never calls setWebhook.
//
//   npm run platform:telegram:webhook            register + verify
//   npm run platform:telegram:webhook -- --check verify only (no change)
//   npm run platform:telegram:webhook -- --dry-run validate config only (no network)
//
// Reads from .env: PLATFORM_TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
// TELEGRAM_WEBHOOK_BASE_URL (and TELEGRAM_WEBHOOK_PATH, same default as the
// server). Never prints the token or the secret.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const DEFAULT_WEBHOOK_PATH = "/api/platform/webhook/telegram"; // same default as platform/config.js
const TELEGRAM_API = "https://api.telegram.org";

export class SetupError extends Error {}

export function validateBotToken(token) {
  if (!token) throw new SetupError("PLATFORM_TELEGRAM_BOT_TOKEN is not set in .env");
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new SetupError("PLATFORM_TELEGRAM_BOT_TOKEN does not look like a Bot API token (<digits>:<key>)");
  return token;
}

// Telegram's own rule for secret_token: 1-256 characters, A-Z a-z 0-9 _ -.
export function validateWebhookSecret(secret) {
  if (!secret) throw new SetupError("TELEGRAM_WEBHOOK_SECRET is not set in .env (the server rejects every webhook without it)");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new SetupError("TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ or -");
  return secret;
}

// The fixed public base URL of the Named Tunnel, e.g. https://telegram.example.com
export function buildWebhookUrl(baseUrl, webhookPath = DEFAULT_WEBHOOK_PATH) {
  if (!baseUrl) throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL is not set in .env (e.g. https://telegram.<your-domain>)");
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must use https://");
  if (url.username || url.password) throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must not contain credentials");
  if (url.search || url.hash) throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must not contain a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must be the hostname only; the path comes from TELEGRAM_WEBHOOK_PATH");
  if (url.port && url.port !== "443") throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must use the default HTTPS port");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL must be a public hostname, not localhost or an IP address");
  if (host === "trycloudflare.com" || host.endsWith(".trycloudflare.com")) {
    throw new SetupError("TELEGRAM_WEBHOOK_BASE_URL is a Cloudflare Quick Tunnel URL, which changes on every restart; use the Named Tunnel hostname");
  }
  if (!webhookPath.startsWith("/")) throw new SetupError("TELEGRAM_WEBHOOK_PATH must start with /");
  return `https://${host}${webhookPath}`;
}

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
}

async function callTelegram(fetchImpl, token, method, payload, secrets) {
  let res;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new SetupError(`Telegram ${method} request failed: ${redact(err.message, secrets)}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new SetupError(`Telegram ${method} returned HTTP ${res.status} with a non-JSON body`);
  }
  if (!body || body.ok !== true) {
    throw new SetupError(`Telegram ${method} failed (HTTP ${res.status}): ${redact(body?.description ?? "no description", secrets)}`);
  }
  return body.result;
}

/**
 * @returns {Promise<number>} process exit code
 */
export async function run({ argv = [], env = process.env, fetchImpl = globalThis.fetch, out = console.log } = {}) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--dry-run") ? "dry-run" : "set";
  const secrets = [env.PLATFORM_TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET];
  try {
    const token = validateBotToken(env.PLATFORM_TELEGRAM_BOT_TOKEN);
    const secret = validateWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
    const webhookUrl = buildWebhookUrl(env.TELEGRAM_WEBHOOK_BASE_URL, env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH);
    out(`Webhook URL: ${webhookUrl}`);
    out("Bot token: PRESENT | Webhook secret: PRESENT");
    if (mode === "dry-run") {
      out("Dry run: configuration is valid; nothing was sent to Telegram.");
      return 0;
    }

    if (mode === "set") {
      // drop_pending_updates stays false: messages queued while the webhook
      // was unreachable are still delivered.
      await callTelegram(fetchImpl, token, "setWebhook", { url: webhookUrl, secret_token: secret, drop_pending_updates: false }, secrets);
      out("setWebhook: OK");
    }

    const info = await callTelegram(fetchImpl, token, "getWebhookInfo", {}, secrets);
    const matches = info.url === webhookUrl;
    out(`getWebhookInfo url: ${info.url || "(none)"} ${matches ? "(matches)" : "(DOES NOT MATCH)"}`);
    out(`Pending updates: ${info.pending_update_count ?? 0}`);
    if (info.last_error_message) {
      const when = info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : "unknown time";
      out(`Last delivery error (${when}): ${redact(info.last_error_message, secrets)}`);
    } else {
      out("Last delivery error: none");
    }
    // Telegram never returns the secret, so it can only be proven by a real
    // delivery: a wrong secret shows up here as a 401 delivery error.
    out("Note: Telegram does not report the secret back; send a test message and re-run with --check (a wrong secret appears as a 401 error above).");
    return matches ? 0 : 1;
  } catch (err) {
    if (err instanceof SetupError) {
      out(`ERROR: ${err.message}`);
      return 1;
    }
    out(`ERROR: ${redact(err.message, secrets)}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  process.exitCode = await run({ argv: process.argv.slice(2) });
}
