import crypto from "node:crypto";

// Pseudonymous reference for a customer who contributes knowledge. A customer's raw platform id never enters the
// knowledge DB: only 'h1:' + HMAC-SHA256(key, "<channel>:<scope>:<id>"). The key lives in the environment
// (KNOWLEDGE_CONTRIBUTOR_HASH_KEY), never beside the hash; without a usable key contribution is OFF (fail-closed,
// like the Telegram webhook secret). Stable per channel + scope, so "this person's open submission" and "your own
// contribution" work without storing who they are. `kid` names the key, so a rotated key is never mixed up.

export const MIN_KEY_BYTES = 32;

export class ContributorHasher {
  /** @param {{key: string, kid?: string}} opts */
  constructor({ key, kid = "k1" }) {
    if (typeof key !== "string" || Buffer.byteLength(key) < MIN_KEY_BYTES) throw new Error(`contributor hash key must be at least ${MIN_KEY_BYTES} bytes`);
    this.kid = kid;
    // the key is kept only inside this closure: never a property, so it cannot be logged or serialised by accident
    this._hmac = (s) => crypto.createHmac("sha256", key).update(s).digest("hex");
  }

  /** @param {"telegram"|"zalo"} channel  @param {"user"|"chat"} scope */
  hash(channel, scope, id) {
    if (!channel || !scope || id === undefined || id === null || String(id) === "") throw new Error("hash needs channel, scope and id");
    return `h1:${this._hmac(`${channel}:${scope}:${id}`)}`;
  }

  user(channel, id) {
    return this.hash(channel, "user", id);
  }

  chat(channel, id) {
    return this.hash(channel, "chat", id);
  }

  toJSON() {
    return { kid: this.kid };
  }
}

/** A hasher, or null when no usable key is configured (contribution stays off). */
export function contributorHasherFromEnv({ key, kid } = {}) {
  try {
    return key ? new ContributorHasher({ key, kid: kid || "k1" }) : null;
  } catch {
    return null;
  }
}
