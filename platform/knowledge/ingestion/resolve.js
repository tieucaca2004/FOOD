import { normalizeName, fold } from "../text.js";
import { addressKey } from "../discoveryStore.js";

// Entity resolution for ingested claims: find the EXISTING place / product
// before anything new is proposed. Never assigns at random:
//   resolved         one place (or several records of the SAME place: same name + same address)
//   ambiguous        several different places fit ("Quán A" x3) -> the candidates are listed for a person
//   unknown          nothing fits -> a new-place candidate, never a new published place
//   none             the message names no place at all
// Names are matched on whole words, accent-insensitively; a one-word generic
// name ("Phở") is not a place name to find inside a sentence.

const LIVE = `status IN ('candidate', 'verified')`;

export class PlaceResolver {
  constructor(db) {
    this.db = db;
    this._places = null;
  }

  places() {
    if (!this._places) {
      this._places = this.db
        .prepare(
          `SELECT m.id, m.name, m.normalized_name,
                  (SELECT address_original FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1) AS address,
                  (SELECT COUNT(*) FROM kb_merchant_products p WHERE p.merchant_id = m.id AND p.status = 'published') AS products
           FROM kb_merchants m WHERE ${LIVE}`
        )
        .all()
        .map((p) => ({ ...p, words: p.normalized_name.split(" ").filter(Boolean) }));
    }
    return this._places;
  }

  /** Known place names written inside a text (longest first, at least two words). */
  findInText(text) {
    const words = ` ${normalizeName(text)} `;
    const found = this.places()
      .filter((p) => p.words.length >= 2 && words.includes(` ${p.normalized_name} `))
      .sort((a, b) => b.normalized_name.length - a.normalized_name.length);
    if (!found.length) return null;
    // the text as written, for display and for removing it from product names
    const longest = found[0].normalized_name;
    return { normalized: longest, written: writtenSpan(text, longest) };
  }

  /** @returns {{status: string, kbPlaceId: number|null, candidates: object[]}} */
  resolve(placeText) {
    if (!placeText) return { status: "none", kbPlaceId: null, candidates: [] };
    const key = normalizeName(placeText);
    const words = key.split(" ").filter(Boolean);
    let matches = this.places().filter((p) => p.normalized_name === key);
    if (!matches.length && words.length) {
      // "Quán Mịn" -> every place whose own name contains all its words
      matches = this.places().filter((p) => words.every((w) => p.words.includes(w)));
    }
    const candidates = matches.map((p) => ({ kbPlaceId: p.id, name: p.name, address: p.address }));
    if (!matches.length) return { status: "unknown", kbPlaceId: null, candidates: [] };
    // the same place = same name AND same address (house-number key, else the whole normalized address)
    const identity = (p) => `${p.normalized_name}|${p.address ? addressKey(p.address) ?? normalizeName(p.address) : "?"}`;
    const identities = new Set(matches.map(identity));
    if (matches.length === 1 || (identities.size === 1 && !identity(matches[0]).endsWith("|?"))) {
      // one place (maybe listed several times): its most complete record is the one to compare with
      const best = [...matches].sort((a, b) => b.products - a.products || a.id - b.id)[0];
      return { status: "resolved", kbPlaceId: best.id, candidates };
    }
    return { status: "ambiguous", kbPlaceId: null, candidates };
  }

  /** A product of that place with the same name (normalized), or null. */
  product(kbPlaceId, productText) {
    if (!kbPlaceId || !productText) return null;
    // compared on both sides' normalized form (whatever form a source stored), never by partial match
    const key = normalizeName(productText);
    return this.db.prepare(`SELECT * FROM kb_merchant_products WHERE merchant_id = ? AND status = 'published' ORDER BY id`).all(kbPlaceId).find((p) => normalizeName(p.original_name) === key) ?? null;
  }
}

function writtenSpan(text, normalized) {
  const words = String(text).split(/\s+/);
  const target = normalized.split(" ");
  for (let i = 0; i + target.length <= words.length; i++) {
    const span = words.slice(i, i + target.length);
    if (span.map((w) => normalizeName(w)).join(" ") === normalized) return span.join(" ").replace(/[,.:;!?]+$/u, "");
  }
  return normalized;
}

export const folded = (s) => fold(String(s ?? "")).folded ?? String(s ?? "");
