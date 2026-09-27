import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RobotsCache } from "./robots.js";

// Polite fetcher that stores every successful response as an immutable raw
// snapshot (data/raw/<source_type>/<host>/<date>/<sha256>.<ext> + .meta.json)
// and logs every attempt (data/raw/_crawl-log.jsonl).
//
// It REFUSES — and stores nothing for — any URL that robots.txt disallows,
// any response that is a login wall / CAPTCHA / access denial, and search
// engine result pages (google.com/search is disallowed by Google's
// robots.txt; discovery goes through an official API instead).

export const USER_AGENT = "FOOD-KnowledgeCollector/0.1 (research pilot; respects robots.txt)";
export const AGENT_TOKEN = "food-knowledgecollector";

const BLOCKED_HOST_PATHS = [/^https?:\/\/(www\.)?google\.[a-z.]+\/search/i, /^https?:\/\/(www\.)?bing\.com\/search/i];
const WALL_URL = /\/(login|signin|sign-in|checkpoint|captcha|challenge)\b/i;
// An actual challenge or login wall ON the page — widget markup, challenge
// scripts, login forms. Not the mere word "captcha": wikis carry config such
// as "…CaptchaNeededForGenericEdit":"hcaptcha" (for editing) on every article.
// Nor reCAPTCHA v3 loaded with a site key ("api.js?render=6L…"): that is the
// invisible score check of the site's own forms, served next to the full,
// public article — not a challenge in front of the content.
const WALL_BODY =
  /class="[^"]*\b(?:g-recaptcha|h-captcha)\b|google\.com\/recaptcha\/api\.js(?!\?render=(?!explicit)[\w-]{20,})|hcaptcha\.com\/1\/api\.js|id="cf-challenge|cf_chl_opt|captcha-delivery\.com|Please enable JS and disable any ad blocker|id="login_form"|data-testid="royal_login_form"/i;
const EXT = { "text/html": "html", "application/json": "json", "text/plain": "txt", "application/pdf": "pdf" };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class RawFetcher {
  /**
   * @param {object} o
   * @param {string} o.rawRoot directory for raw snapshots (e.g. "data/raw")
   * @param {string} o.repoRoot the directory raw paths are recorded relative to
   */
  constructor({ rawRoot, repoRoot = process.cwd(), fetchImpl = globalThis.fetch, minIntervalMs = 2000, maxBytes = 8 * 1024 * 1024, timeoutMs = 30000, now = () => new Date(), wait = sleep, reuseWithinDays = 0 }) {
    this.rawRoot = rawRoot;
    // > 0: a GET already stored (or known missing: 404/410) within this many days is served from the
    // raw store — no request; the stored snapshot stays the evidence. 0: always fetch.
    this.reuseWithinDays = reuseWithinDays;
    this._snapshots = null;
    this.repoRoot = repoRoot;
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.wait = wait;
    this.lastByHost = new Map();
    this.robots = new RobotsCache({ fetchImpl, userAgent: USER_AGENT, agentToken: AGENT_TOKEN });
  }

  _log(entry) {
    fs.mkdirSync(this.rawRoot, { recursive: true });
    fs.appendFileSync(path.join(this.rawRoot, "_crawl-log.jsonl"), `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`);
  }

  // url -> newest stored GET snapshot {meta, file} / newest "gone" answer, from the raw store on disk
  _snapshotIndex() {
    if (this._snapshots) return this._snapshots;
    const stored = new Map();
    const gone = new Map();
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".meta.json")) {
          try {
            const meta = JSON.parse(fs.readFileSync(p, "utf8"));
            if ((meta.method ?? "GET") !== "GET" || meta.status !== 200) continue;
            const prev = stored.get(meta.url);
            if (!prev || prev.meta.fetchedAt < meta.fetchedAt) stored.set(meta.url, { meta, file: p.slice(0, -".meta.json".length) });
          } catch {
            // an unreadable meta file is simply not reusable
          }
        }
      }
    };
    walk(this.rawRoot);
    const log = path.join(this.rawRoot, "_crawl-log.jsonl");
    if (fs.existsSync(log)) {
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.blocked === "http" && [404, 410].includes(e.status)) gone.set(e.url, e);
          else if (e.stored) gone.delete(e.url);
        } catch {
          // skip a torn line
        }
      }
    }
    this._snapshots = { stored, gone };
    return this._snapshots;
  }

  _fresh(at) {
    return this.now().getTime() - Date.parse(at) <= this.reuseWithinDays * 86_400_000;
  }

  _reused(url) {
    if (!(this.reuseWithinDays > 0)) return null;
    const { stored, gone } = this._snapshotIndex();
    const hit = stored.get(url);
    if (hit && this._fresh(hit.meta.fetchedAt) && fs.existsSync(hit.file)) {
      const buf = fs.readFileSync(hit.file);
      const { meta } = hit;
      return { ok: true, cached: true, status: meta.status, url, finalUrl: meta.finalUrl, contentType: meta.contentType, fetchedAt: meta.fetchedAt, content: buf.toString("utf8"), rawPath: path.relative(this.repoRoot, hit.file).split(path.sep).join("/"), sha256: meta.sha256 };
    }
    const g = gone.get(url);
    if (g && this._fresh(g.at)) return { ok: false, cached: true, blocked: "http", status: g.status, url };
    return null;
  }

  async _polite(host) {
    const last = this.lastByHost.get(host);
    const elapsed = last === undefined ? Infinity : this.now().getTime() - last;
    if (elapsed < this.minIntervalMs) await this.wait(this.minIntervalMs - elapsed);
    this.lastByHost.set(host, this.now().getTime());
  }

  /**
   * @returns {Promise<{ok: boolean, blocked?: string, status?: number, url, finalUrl?, rawPath?, contentType?, fetchedAt?, sha256?, content?: string}>}
   */
  // extraHeaders: request headers an OFFICIAL API needs (an API key, a field mask); never stored in the snapshot
  async fetch(url, { sourceType, method = "GET", body = null, contentType = null, accept = "text/html,application/json;q=0.9,*/*;q=0.5", timeoutMs = this.timeoutMs, extraHeaders = {} } = {}) {
    if (!sourceType) throw new Error("sourceType is required");
    if (BLOCKED_HOST_PATHS.some((re) => re.test(url))) {
      this._log({ url, blocked: "search_engine_results", sourceType });
      return { ok: false, blocked: "search_engine_results", url };
    }
    if (method === "GET") {
      const reused = this._reused(url);
      if (reused) return reused;
    }
    const robots = await this.robots.allowed(url);
    if (!robots.allowed) {
      this._log({ url, blocked: "robots", reason: robots.reason, sourceType });
      return { ok: false, blocked: "robots", url, reason: robots.reason };
    }
    const host = new URL(url).host;
    await this._polite(host);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        body,
        redirect: "follow",
        headers: { ...extraHeaders, "user-agent": USER_AGENT, accept, ...(contentType ? { "content-type": contentType } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this._log({ url, blocked: "network", reason: err.cause?.code || err.message, sourceType });
      return { ok: false, blocked: "network", url, reason: err.message };
    }
    const finalUrl = res.url || url;
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if ([401, 403, 407, 429].includes(res.status) || WALL_URL.test(new URL(finalUrl).pathname)) {
      this._log({ url, finalUrl, status: res.status, blocked: "access_control", sourceType });
      return { ok: false, blocked: "access_control", status: res.status, url, finalUrl };
    }
    if (!res.ok) {
      this._log({ url, finalUrl, status: res.status, blocked: "http", sourceType });
      return { ok: false, blocked: "http", status: res.status, url, finalUrl };
    }
    // the body can still time out / break after the headers arrived: that is a failed fetch, not a crash
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      this._log({ url, finalUrl, status: res.status, blocked: "network", reason: err.name === "TimeoutError" ? "body_timeout" : err.message, sourceType });
      return { ok: false, blocked: "network", url, finalUrl, reason: err.message };
    }
    if (buf.length > this.maxBytes) {
      this._log({ url, finalUrl, status: res.status, blocked: "too_large", bytes: buf.length, sourceType });
      return { ok: false, blocked: "too_large", url, finalUrl };
    }
    const content = buf.toString("utf8");
    if (WALL_BODY.test(content)) {
      this._log({ url, finalUrl, status: res.status, blocked: "captcha_or_login", sourceType });
      return { ok: false, blocked: "captcha_or_login", url, finalUrl };
    }
    const fetchedAt = this.now().toISOString();
    const stored = this.store({ content: buf, sourceType, url, finalUrl, status: res.status, contentType: type || "application/octet-stream", fetchedAt, robots: robots.reason, method, requestBody: body });
    this._log({ url, finalUrl, status: res.status, stored: stored.rawPath, sourceType });
    return { ok: true, status: res.status, url, finalUrl, contentType: type, fetchedAt, content, ...stored };
  }

  /** Stores bytes as an immutable raw snapshot with its metadata; returns its repo-relative path. */
  store({ content, sourceType, url, finalUrl = url, status = null, contentType, fetchedAt, robots = null, method = "GET", requestBody = null, note = null }) {
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const host = new URL(finalUrl).host.replace(/[^a-z0-9.-]/gi, "_");
    const dir = path.join(this.rawRoot, sourceType, host, fetchedAt.slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sha256}.${EXT[contentType] || "bin"}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content);
    const meta = { url, finalUrl, status, contentType, fetchedAt, sha256, sourceType, robots, method, requestBody, note };
    fs.writeFileSync(`${file}.meta.json`, JSON.stringify(meta, null, 2));
    if (this._snapshots && method === "GET" && status === 200) {
      this._snapshots.stored.set(url, { meta, file });
      this._snapshots.gone.delete(url);
    }
    return { rawPath: path.relative(this.repoRoot, file).split(path.sep).join("/"), sha256 };
  }
}
