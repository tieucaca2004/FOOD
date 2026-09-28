import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude CLI as a TEXT-GENERATION backend of the Model Router (FORM 11). Audited on the runtime (Claude Code 2.1.x):
//   claude -p                        headless: the prompt is read from STDIN, never from an argument or a shell string
//   --tools ""                       every built-in tool removed (no Bash / PowerShell / Read / Edit / Write / Web*)
//   --strict-mcp-config              no MCP server at all (none is passed)
//   --restricted                     ignores user / project / local settings files; no code-running tools
//   --no-session-persistence         nothing is saved or resumable; every turn is stateless
//   --permission-prompts none        anything that would ask for a permission is denied
//   --output-format stream-json      lets us READ the tool list the CLI actually loaded (init event) and fail closed
//                                    if it is not empty, then take the single `result` event as the answer
// It runs with shell:false, an empty working directory outside the repository, and an environment reduced to the
// few non-secret variables the CLI needs to find its own login — no platform token, key or secret is inherited.
// Every failure (missing, non-zero exit, timeout, crash, oversized or invalid output, tools exposed) is { ok: false }.

const BASE_ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--restricted", "--no-session-persistence", "--permission-prompts", "none"];
const SYSTEM_NOTE =
  "You are answering the founder of FOOD through a Telegram chat. You have no tools and no access to files, shells, " +
  "git, databases, the repository or production systems. Answer in plain text only; never claim to have run a command, " +
  "read a file or changed anything.";
const ENV_KEEP = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP", "TMPDIR", "HOMEDRIVE", "HOMEPATH", "HOME", "USER", "USERNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]);
const SHIM = /\.(cmd|bat|ps1)$/i;
const MODEL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|HASH_KEY|PRIVATE)/i;

/** The env the child gets: only non-secret variables the CLI needs to find its login and temp dirs. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => ENV_KEEP.has(k.toUpperCase()) && typeof v === "string"));
}

/** Secret VALUES that must never reach a reply: every env value under a secret-looking key, plus extras. */
export function secretValues(env = process.env, extra = []) {
  const fromEnv = Object.entries(env).filter(([k]) => SECRET_ENV_KEY.test(k)).map(([, v]) => v);
  return [...new Set([...fromEnv, ...extra].filter((v) => typeof v === "string" && v.length >= 8))];
}

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

/**
 * The claude executable to spawn without a shell, or null. A configured path wins (a .cmd/.bat/.ps1 shim is refused:
 * it needs a shell). Otherwise: `claude` / `claude.exe` on PATH, then the npm global install's bundled binary.
 */
export function resolveClaudeCliCommand({ configured = "", env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (configured) return SHIM.test(configured) || !exists(configured) ? null : configured;
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) if (exists(path.join(d, n))) return path.join(d, n);
  if (platform === "win32" && env.APPDATA) {
    const npm = path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(npm)) return npm;
  }
  return null;
}

function killTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false }).on("error", () => {});
    } catch {
      /* fall through to kill() */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export class ClaudeCliProvider {
  constructor({
    command,
    prefixArgs = [],
    model = "",
    timeoutMs = 60000,
    maxOutputBytes = 2 * 1024 * 1024,
    maxPromptChars = 8000,
    maxConcurrent = 2,
    cwd = path.join(os.tmpdir(), "food-claude-cli"),
    env = process.env,
    secrets = [],
    spawnImpl = spawn,
    kill = killTree,
  } = {}) {
    this.command = command || null;
    this.prefixArgs = prefixArgs;
    this.model = MODEL_NAME.test(model) ? model : "";
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxPromptChars = maxPromptChars;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.cwd = cwd;
    this.env = childEnv(env);
    this.secrets = secretValues(env, secrets);
    this.spawnImpl = spawnImpl;
    this.kill = kill;
    this.running = 0;
  }

  get available() {
    return Boolean(this.command);
  }

  /** The fixed argument vector; user text is never part of it. */
  args() {
    return [...this.prefixArgs, ...BASE_ARGS, ...(this.model ? ["--model", this.model] : []), "--append-system-prompt", SYSTEM_NOTE];
  }

  async invoke({ text }) {
    if (!this.command) return { ok: false, reason: "unavailable" };
    const prompt = String(text ?? "").trim();
    if (!prompt) return { ok: false, reason: "empty_prompt" };
    if (prompt.length > this.maxPromptChars) return { ok: false, reason: "prompt_too_long" };
    if (this.running >= this.maxConcurrent) return { ok: false, reason: "busy" };
    try {
      fs.mkdirSync(this.cwd, { recursive: true });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    this.running++;
    try {
      return await this._run(prompt);
    } finally {
      this.running--;
    }
  }

  _run(prompt) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(this.command, this.args(), { cwd: this.cwd, env: this.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return resolve({ ok: false, reason: "unavailable" });
      }
      let settled = false;
      let failure = null;
      const chunks = [];
      let bytes = 0;
      let stderrBytes = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const abort = (reason) => {
        if (!failure) failure = reason;
        this.kill(child);
      };
      const timer = setTimeout(() => abort("timeout"), this.timeoutMs);

      child.on("error", (err) => {
        this.kill(child);
        finish({ ok: false, reason: err?.code === "ENOENT" || err?.code === "EACCES" ? "unavailable" : "spawn_failed" });
      });
      child.stdout.on("data", (d) => {
        bytes += d.length;
        if (bytes > this.maxOutputBytes) return abort("output_too_large");
        chunks.push(d);
      });
      // stderr is drained (so the child never blocks) and only its size is kept — never shown, never logged raw
      child.stderr.on("data", (d) => (stderrBytes += d.length));
      child.stdin.on("error", () => {}); // EPIPE when the CLI exits before reading
      child.on("close", (code, signal) => {
        if (failure) return finish({ ok: false, reason: failure, exitCode: code, signal: signal ?? null });
        if (code !== 0) return finish({ ok: false, reason: "exit", exitCode: code, signal: signal ?? null, stderrBytes });
        finish(this._parse(Buffer.concat(chunks).toString("utf8")));
      });
      child.stdin.end(prompt, "utf8");
    });
  }

  /** stream-json -> the answer, only when the CLI reported an empty tool list and a successful result. */
  _parse(stdout) {
    let init = null;
    let result = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.type === "system" && ev.subtype === "init") init = ev;
      else if (ev?.type === "result") result = ev;
    }
    if (!init || !Array.isArray(init.tools)) return { ok: false, reason: "invalid_output", exitCode: 0 };
    if (init.tools.length || (Array.isArray(init.mcp_servers) && init.mcp_servers.length)) return { ok: false, reason: "tools_exposed", exitCode: 0 };
    if (!result || result.is_error || result.subtype !== "success" || typeof result.result !== "string" || !result.result.trim()) {
      return { ok: false, reason: "invalid_output", exitCode: 0 };
    }
    return { ok: true, text: redactSecrets(result.result.trim(), this.secrets), exitCode: 0 };
  }
}
