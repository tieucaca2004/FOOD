import { stripAccents } from "../../src/nlp/normalize.js"; // generic pure utility — read-only reuse

/**
 * Deterministic parsing — no AI/LLM call, fully testable without any API
 * key. Used directly for TEXT imports, and as the shared normalization
 * step for IMAGE imports (the vision provider's raw OCR output still runs
 * through flagDuplicates() here so both source types converge on the same
 * MenuDraft shape — spec §26).
 *
 * Text format convention (documented, not guessed): a line ending with
 * `:` starts a new category. Any other line is a product; its trailing
 * whitespace-separated token is parsed as a price if it unambiguously
 * matches a known pattern (65000 / 65.000 / 65,000 / 65k). Anything else
 * — no price at all, or an ambiguous token like "65?000" — sets
 * price: null, needs_review: true. This never guesses a price from
 * another product or from context (spec §9).
 */

function parsePriceToken(rawToken) {
  const token = (rawToken || "").trim();
  if (!token) return null;

  const kMatch = token.match(/^(\d{1,3})\s*[kK]$/);
  if (kMatch) return Number(kMatch[1]) * 1000;

  const groupedMatch = token.match(/^\d{1,3}(?:[.,]\d{3})+$/);
  if (groupedMatch) return Number(token.replace(/[.,]/g, ""));

  if (/^\d{4,7}$/.test(token)) return Number(token);

  return null; // ambiguous — never guessed
}

function extractNameAndPrice(line) {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s+/);
  const lastToken = parts[parts.length - 1];
  const price = parsePriceToken(lastToken);
  if (price !== null && parts.length > 1) {
    return { name: parts.slice(0, -1).join(" ").trim(), price };
  }
  return { name: trimmed, price: null };
}

export function parseMenuText(rawText) {
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const categories = [];
  let current = null;

  for (const line of lines) {
    if (line.endsWith(":")) {
      current = { name: line.slice(0, -1).trim(), products: [] };
      categories.push(current);
      continue;
    }
    if (!current) {
      current = { name: null, products: [] };
      categories.push(current);
    }
    const { name, price } = extractNameAndPrice(line);
    current.products.push({
      name,
      price,
      description: null,
      available: true,
      keywords: [],
      confidence: null, // deterministic parsing has no probabilistic confidence — never fabricated
      needs_review: price === null,
      possible_duplicate: false,
    });
  }

  return { categories };
}

// Shared by both TEXT and IMAGE pipelines (spec §26). Flags same-name
// repeats within a category as possible duplicates — never auto-removes;
// the merchant decides during review.
export function flagDuplicates(parsedMenu) {
  for (const category of parsedMenu.categories) {
    const seen = new Set();
    for (const product of category.products) {
      const key = stripAccents(product.name || "").toLowerCase();
      if (!key) continue;
      if (seen.has(key)) product.possible_duplicate = true;
      seen.add(key);
    }
  }
  return parsedMenu;
}
