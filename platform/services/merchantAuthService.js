import { randomBytes, createHash } from "node:crypto";

const KEY_BYTES = 32; // 256 bits of entropy — a high-entropy random token, not a human password, so a plain SHA-256 hash (no salt/bcrypt) is appropriate, same class of design as GitHub/Stripe API key storage.
const KEY_PREFIX = "mk_"; // cosmetic — lets logs/UIs identify the token type without revealing anything about its value.

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Phase 7 minimum merchant authentication boundary. Deliberately NOT a
 * user-management platform: no passwords, no reset flow, no OAuth/SSO, no
 * RBAC — a single opaque per-merchant-user API key, issued by an admin
 * action (POST /api/platform/merchants/:id/api-keys, behind the platform
 * admin token — platform/api/middleware/adminAuth.js).
 *
 * SECURITY: the plaintext key is returned exactly once, at issuance —
 * only its SHA-256 hash is ever persisted (merchant_users.api_key_hash,
 * migration 008). verifyApiKey() never trusts a caller-supplied
 * merchant_id — the only merchant_id that matters is the one bound to
 * whichever key hash actually matched in the DB.
 */
export class MerchantAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class MerchantAuthService {
  constructor(repos) {
    this.repos = repos;
  }

  // Admin-only action. Mints a brand-new key for the merchant's owner
  // user (creating that user row if it doesn't exist yet), overwriting
  // any previously issued key — rotation, not accumulation; no key
  // history is kept (Phase 7 does not need it).
  issueApiKey(merchantId) {
    if (typeof merchantId !== "string" || merchantId.trim().length === 0) {
      throw new MerchantAuthError("MERCHANT_NOT_FOUND", "merchantId must be a non-empty string", 404);
    }
    const merchant = this.repos.merchants.getById(merchantId);
    if (!merchant) {
      throw new MerchantAuthError("MERCHANT_NOT_FOUND", `Merchant ${merchantId} not found`, 404);
    }

    let user = this.repos.merchantUsers.findOwnerByMerchant(merchantId);
    if (!user) user = this.repos.merchantUsers.create({ merchantId, role: "owner" });

    const plaintextKey = KEY_PREFIX + randomBytes(KEY_BYTES).toString("hex");
    this.repos.merchantUsers.setApiKeyHash(user.id, hashKey(plaintextKey));
    return { merchantUserId: user.id, merchantId, apiKey: plaintextKey };
  }

  // Resolves a presented credential to a merchant identity, or throws a
  // generic UNAUTHENTICATED error — never reveals whether a merchant_id
  // exists, whether a key format was "close", or any other detail an
  // attacker could use to enumerate merchants or keys.
  verifyApiKey(presentedKey) {
    if (typeof presentedKey !== "string" || presentedKey.length === 0) {
      throw new MerchantAuthError("UNAUTHENTICATED", "Missing or malformed credential");
    }
    const user = this.repos.merchantUsers.findByApiKeyHash(hashKey(presentedKey));
    if (!user) {
      throw new MerchantAuthError("UNAUTHENTICATED", "Invalid credential");
    }
    return { merchantUserId: user.id, merchantId: user.merchant_id };
  }
}
