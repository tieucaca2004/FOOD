// Base interface every provider implements. AI is only ever consulted for
// language understanding/phrasing — see class-level contract below. It must
// never be the source of truth for price, total, product existence, or
// order state; those always come from the deterministic services/DB.
export class AIProvider {
  /**
   * @param {string} text raw user message
   * @returns {Promise<{intent: string, productQuery: string|null, quantity: number|null}|null>}
   *   Only used as a fallback hint when the rule-based intentEngine returns
   *   "unknown" — the returned productQuery still goes through the normal
   *   menuService lookup, so the AI can never assert a product/price itself.
   */
  async classify(_text) {
    return null;
  }

  /**
   * @param {string} baseText the deterministic, already-correct reply
   * @param {object} _context extra context for tone only
   * @returns {Promise<string|null>} a rephrased version, or null to keep baseText
   */
  async polish(baseText, _context) {
    return null;
  }
}
