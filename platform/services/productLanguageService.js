import { stripAccents } from "../../src/nlp/normalize.js";
import { logger } from "../../src/logger.js";

// Merchant Conversational Learning (V1): learns how a merchant's customers
// refer to that merchant's products, from the outcomes of real
// conversations. Learns LANGUAGE -> EXISTING PRODUCT only; never creates or
// edits products, prices or merchants. Deterministic — no model call.
//
// Evidence levels (per merchant + phrase + product):
//   OBSERVED   phrase resolved to the product at least once
//   CONFIRMED  >= 2 positive outcomes and confidence >= 0.5
//   TRUSTED    >= 5 positive outcomes, confidence >= 0.7, from >= 2 distinct
//              customers (one customer alone can never make an alias trusted)
//   SUPPRESSED rejected >= 3 and rejected >= confirmed — never used again
// confidence = confirmed / (confirmed + 2 * rejected + 2): a prior of two
// "doubt" votes, and every rejection weighs twice a confirmation.

export const ALIAS_STATUS = Object.freeze({ OBSERVED: "OBSERVED", CONFIRMED: "CONFIRMED", TRUSTED: "TRUSTED", SUPPRESSED: "SUPPRESSED" });

const TRUSTED_MIN_CONFIRMED = 5;
const TRUSTED_MIN_CONFIDENCE = 0.7;
const TRUSTED_MIN_CUSTOMERS = 2;
const CONFIRMED_MIN_CONFIRMED = 2;
const CONFIRMED_MIN_CONFIDENCE = 0.5;
const SUPPRESS_MIN_REJECTED = 3;
const MAX_PHRASE_WORDS = 6;
export const EVENT_RETENTION_DAYS = 90;

// Words that never identify a product. Two groups: verbs/pronouns/units
// only count as noise in the LEADING run ("cho tui 2 cái …"); the rest are
// noise anywhere. Number WORDS are never stripped here: folded, they
// collide with food words ("hai" = hai/hải, "nam" = năm/nấm), and callers
// already extract quantities before a phrase reaches this function.
const LEADING_NOISE = new Set(
  (
    "cho toi tui minh em anh chi ban xin gium giup them lay order mua dat goi an uong muon can " +
    "cai phan suat dia ly to chai lon hop mon"
  ).split(" ")
);
const NOISE_ANYWHERE = new Set("co khong ko k hong hem chua con gia bao nhieu tien vay a ah nhe nha nhen di nua voi nao quan nay kia".split(" "));

function fold(text) {
  return stripAccents(String(text ?? "").normalize("NFC"))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Cho tui 2 cái PIZZA Tôm nha" -> "pizza tom"; null when nothing product-like remains. */
export function normalizePhrase(text) {
  let words = fold(text).split(" ").filter(Boolean);
  let start = 0;
  while (start < words.length && (LEADING_NOISE.has(words[start]) || /^\d+$/.test(words[start]))) start++;
  words = words.slice(start).filter((w) => !NOISE_ANYWHERE.has(w) && !/^\d+$/.test(w));
  if (words.length === 0 || words.length > MAX_PHRASE_WORDS) return null;
  const phrase = words.join(" ");
  return phrase.replace(/ /g, "").length >= 2 ? phrase : null;
}

// The customer's own wording for the phrase (accents kept, lowercase) when
// it can be located in the original text; otherwise the normalized form.
export function displayPhrase(originalText, normalized) {
  const tokens = String(originalText ?? "").normalize("NFC").split(/\s+/).filter(Boolean);
  const keys = tokens.map((t) => fold(t).replace(/ /g, ""));
  const want = normalized.split(" ");
  for (let i = 0; i + want.length <= keys.length; i++) {
    if (want.every((w, j) => keys[i + j] === w)) {
      return tokens
        .slice(i, i + want.length)
        .join(" ")
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    }
  }
  return normalized;
}

export function computeConfidence({ confirmed, rejected }) {
  return confirmed / (confirmed + 2 * rejected + 2);
}

export function computeStatus({ confirmed, rejected, distinctCustomers }) {
  const confidence = computeConfidence({ confirmed, rejected });
  if (rejected >= SUPPRESS_MIN_REJECTED && rejected >= confirmed) return ALIAS_STATUS.SUPPRESSED;
  if (confirmed >= TRUSTED_MIN_CONFIRMED && confidence >= TRUSTED_MIN_CONFIDENCE && distinctCustomers >= TRUSTED_MIN_CUSTOMERS) {
    return ALIAS_STATUS.TRUSTED;
  }
  if (confirmed >= CONFIRMED_MIN_CONFIRMED && confidence >= CONFIRMED_MIN_CONFIDENCE) return ALIAS_STATUS.CONFIRMED;
  return ALIAS_STATUS.OBSERVED;
}

// A phrase that IS the product's own name teaches nothing.
function isCanonicalFor(phrase, product) {
  return [product.name, ...product.name.split(" - ")].some((part) => fold(part) === phrase);
}

export class ProductLanguageService {
  constructor(repos) {
    this.repos = repos;
  }

  // --- lookup (read side, used by the resolver) ------------------------------

  // Usable evidence for a phrase, restricted to `pool` (this merchant's
  // currently orderable products). An alias of an inactive/deleted product
  // is simply not in the pool — it is ignored, never re-pointed elsewhere.
  _usable(merchantId, phrase, pool) {
    if (!phrase) return [];
    const ids = new Set(pool.map((p) => p.id));
    return this.repos.productAliases
      .listByPhrase(merchantId, phrase)
      .filter((a) => ids.has(a.product_id) && a.status !== ALIAS_STATUS.SUPPRESSED);
  }

  /**
   * Strong learned alias: a single product at the highest evidence level.
   * Two different products at the same level = conflict -> nothing.
   * @returns {{product, alias}|null}
   */
  resolveLearned(merchantId, phrase, pool, { trustedOnly = false } = {}) {
    const usable = this._usable(merchantId, phrase, pool);
    const levels = trustedOnly ? [ALIAS_STATUS.TRUSTED] : [ALIAS_STATUS.TRUSTED, ALIAS_STATUS.CONFIRMED];
    for (const level of levels) {
      const atLevel = usable.filter((a) => a.status === level);
      const productIds = [...new Set(atLevel.map((a) => a.product_id))];
      if (productIds.length > 1) return null; // conflicting evidence: never pick
      if (productIds.length === 1) return { product: pool.find((p) => p.id === productIds[0]), alias: atLevel[0] };
    }
    return null;
  }

  /** Weak alias (OBSERVED, not contradicted) — only ever offered as "did you mean". */
  suggestObserved(merchantId, phrase, pool) {
    const usable = this._usable(merchantId, phrase, pool).filter(
      (a) => a.status === ALIAS_STATUS.OBSERVED && a.rejected_count <= a.confirmed_count
    );
    const productIds = [...new Set(usable.map((a) => a.product_id))];
    return productIds.length === 1 ? pool.find((p) => p.id === productIds[0]) : null;
  }

  // --- learning (write side) ---------------------------------------------------

  isLearnable(phrase, product) {
    return Boolean(phrase) && !isCanonicalFor(phrase, product);
  }

  observe(ctx) {
    return this._signal(ctx, "observed");
  }

  // createIfMissing:false -> only strengthens evidence that already exists
  // (used after a clarification, which must never create an alias).
  confirm(ctx, options) {
    return this._signal(ctx, "confirmed", options);
  }

  reject(ctx, options) {
    return this._signal(ctx, "rejected", options);
  }

  // Rejects every alias of `phrase` that points somewhere other than
  // `productId` (the customer chose another product for that phrase).
  rejectOthers({ merchantId, customerId, phrase, productId, source }) {
    for (const alias of this.repos.productAliases.listByPhrase(merchantId, phrase)) {
      if (alias.product_id !== productId) {
        this._signal({ merchantId, customerId, phrase, productId: alias.product_id, source }, "rejected", { createIfMissing: false });
      }
    }
  }

  /**
   * @param ctx {merchantId, customerId, phrase (normalized), display?, product|productId, source}
   * Never throws: learning must not block ordering.
   */
  _signal({ merchantId, customerId, phrase, display, product, productId, source }, signal, { createIfMissing = true } = {}) {
    try {
      const pid = product?.id ?? productId;
      if (!phrase || !pid) return null;
      if (product && !this.isLearnable(phrase, product)) return null;
      const repo = this.repos.productAliases;
      const row = createIfMissing ? repo.ensure(merchantId, pid, display || phrase, phrase) : repo.get(merchantId, phrase, pid);
      if (!row) return null;

      const counts = {
        observed_count: row.observed_count + (signal === "observed" ? 1 : 0),
        confirmed_count: row.confirmed_count + (signal === "confirmed" ? 1 : 0),
        rejected_count: row.rejected_count + (signal === "rejected" ? 1 : 0),
      };
      // the event goes in first so "distinct customers" includes this one
      const eventId = repo.insertEvent({
        merchant_id: merchantId,
        customer_id: customerId ?? null,
        product_id: pid,
        normalized_phrase: phrase,
        resolution_source: source,
        signal,
        confidence_before: row.confidence,
        confidence_after: null,
      });
      const distinctCustomers = repo.countDistinctConfirmingCustomers(merchantId, phrase, pid);
      const evidence = { confirmed: counts.confirmed_count, rejected: counts.rejected_count, distinctCustomers };
      const updated = { ...counts, confidence: computeConfidence(evidence), status: computeStatus(evidence) };
      repo.saveCounts(row.id, updated);
      repo.setEventConfidenceAfter(eventId, updated.confidence);
      return { ...row, ...updated };
    } catch (err) {
      logger.warn("LEARNING", "alias signal skipped", { signal, source, error: err.message });
      return null;
    }
  }

  // --- observability ----------------------------------------------------------------

  /** Learned language for one merchant, grouped by product (for audit). */
  listForMerchant(merchantId) {
    const byProduct = new Map();
    for (const alias of this.repos.productAliases.listByMerchant(merchantId)) {
      if (!byProduct.has(alias.product_id)) {
        const product = this.repos.merchantProducts.findById(alias.product_id);
        byProduct.set(alias.product_id, { productId: alias.product_id, productName: product?.name ?? "(deleted)", available: Boolean(product?.available), aliases: [] });
      }
      byProduct.get(alias.product_id).aliases.push({
        alias: alias.alias,
        normalized: alias.normalized_alias,
        status: alias.status,
        confidence: Math.round(alias.confidence * 100) / 100,
        observed: alias.observed_count,
        confirmed: alias.confirmed_count,
        rejected: alias.rejected_count,
      });
    }
    return [...byProduct.values()];
  }

  pruneEvents(days = EVENT_RETENTION_DAYS) {
    return this.repos.productAliases.pruneEventsOlderThan(days);
  }
}
