import { normalizePhrase } from "./productLanguageService.js";
import { collapseWhitespace, fold } from "../knowledge/text.js";

// Customer Language Learning for SEMANTIC requests ("cho tôi món giòn giòn"
// -> the customer picks "Bánh căn"). Reuses the existing merchant-isolated
// ProductLanguageService: the phrase becomes, at most, an OBSERVED alias of
// that product AT THAT MERCHANT — a suggestion there, nothing more. The
// usual rules apply (TRUSTED needs several different customers; an alias of
// an inactive product is ignored; ambiguous phrases never act silently).
//
// It NEVER touches Food Knowledge: one customer's choice or opinion is not
// a fact about a dish. There is deliberately no dependency on the knowledge
// store here.

export const SEMANTIC_SOURCE = "semantic_choice";

// First-person judgements are opinions, never facts ("tôi thấy bún cá hơi mặn", "ngon quá").
const OPINION = /(?:^|\s)(?:tôi|em|mình|tui|anh|chị)\s+(?:thấy|nghĩ|cảm thấy|thích|không thích|ghét)|(?:ngon|dở|tệ|chán)\s+(?:quá|lắm|thật|ghê)|(?:hơi|quá|rất)\s+(?:mặn|ngọt|chua|cay|nhạt|béo|dai|cứng)(?:\s+(?:quá|nhỉ|ghê))?\s*[.!?]*$/iu;

export function isOpinion(text) {
  return OPINION.test(collapseWhitespace(String(text ?? "")));
}

export class SemanticLearningService {
  /** @param {{productLanguage: import("./productLanguageService.js").ProductLanguageService}} deps */
  constructor({ productLanguage }) {
    this.productLanguage = productLanguage;
  }

  /**
   * The customer asked with a semantic phrase and then chose `product` at
   * `merchantId`. Records a weak, merchant-scoped signal; returns what was
   * recorded (or why nothing was).
   * @param {object} p {merchantId, customerId, message, product: {id, name, available}}
   */
  recordChoice({ merchantId, customerId, message, product }) {
    if (!merchantId || !customerId || !product?.id) return { recorded: false, reason: "MISSING_CONTEXT" };
    if (isOpinion(message)) return { recorded: false, reason: "OPINION_NOT_LEARNED" };
    const phrase = normalizePhrase(message);
    if (!phrase) return { recorded: false, reason: "NO_PHRASE" };
    // the product's own name teaches nothing (and would be a canonical match anyway)
    if (fold(product.name).folded.replace(/[^a-z0-9]+/g, " ").trim() === phrase) return { recorded: false, reason: "CANONICAL_NAME" };
    const row = this.productLanguage.observe({ merchantId, customerId, phrase, display: phrase, product, source: SEMANTIC_SOURCE });
    return row ? { recorded: true, phrase, status: row.status } : { recorded: false, reason: "NOT_LEARNABLE" };
  }

  /** What this merchant's customers have established for the phrase (never another merchant's). */
  suggestionFor({ merchantId, message, products }) {
    const phrase = normalizePhrase(message);
    if (!phrase) return null;
    const strong = this.productLanguage.resolveLearned(merchantId, phrase, products);
    if (strong) return { product: strong.product, level: strong.alias.status };
    const weak = this.productLanguage.suggestObserved(merchantId, phrase, products);
    return weak ? { product: weak, level: "OBSERVED" } : null;
  }
}
