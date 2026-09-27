// Minimal robots.txt (RFC 9309) evaluator: user-agent groups, Allow/Disallow
// with longest-match precedence, "*" and "$" wildcards. Conservative on
// failure: robots.txt missing (4xx) = allowed; unreachable / 5xx = NOT allowed.

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current) continue;
      if (field === "disallow" && value === "") continue; // "Disallow:" = allow all
      current.rules.push({ allow: field === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(path) {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Is `pathWithQuery` allowed for `agentToken` under these robots groups? */
export function isAllowed(groups, agentToken, pathWithQuery) {
  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const group = specific.length ? { rules: specific.flatMap((g) => g.rules) } : { rules: groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules) };
  let best = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(pathWithQuery)) continue;
    const len = rule.path.replace(/[*$]/g, "").length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}

/** Fetches and caches robots.txt per origin. */
export class RobotsCache {
  constructor({ fetchImpl, userAgent, agentToken }) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.agentToken = agentToken;
    this.cache = new Map();
  }

  async allowed(url) {
    const u = new URL(url);
    if (!this.cache.has(u.origin)) {
      let entry;
      try {
        const res = await this.fetchImpl(`${u.origin}/robots.txt`, { headers: { "user-agent": this.userAgent }, redirect: "follow" });
        if (res.status >= 400 && res.status < 500) entry = { groups: [], reason: `robots ${res.status}: allowed` };
        else if (res.ok) entry = { groups: parseRobots(await res.text()), reason: "robots.txt" };
        else entry = { denyAll: true, reason: `robots ${res.status}: unavailable` };
      } catch (err) {
        entry = { denyAll: true, reason: `robots unreachable: ${err.message}` };
      }
      this.cache.set(u.origin, entry);
    }
    const entry = this.cache.get(u.origin);
    if (entry.denyAll) return { allowed: false, reason: entry.reason };
    return { allowed: isAllowed(entry.groups, this.agentToken, u.pathname + u.search), reason: entry.reason };
  }
}
