import { normalizeName, collapseWhitespace } from "../../../platform/knowledge/text.js";

// Quality sampling of PUBLISHED data: a random sample per kind, each row
// re-verified against its stored evidence (the quote is still verbatim in an
// intact raw snapshot, and the value is in the quote). The automatic check
// catches broken provenance; whether a value is RIGHT is judged by a person
// on the same sample (recorded next to it: quality-judgements.json).

const has = (quote, text) => ` ${normalizeName(quote)} `.includes(` ${normalizeName(text)} `);

export function sampleQuality({ db, knowledge, sizes = { merchants: 50, products: 100, links: 100, prices: 50, facts: 50 }, seed = null }) {
  const order = seed === null ? "random()" : `(id * ${Number(seed) || 1}) % 1000003`;
  const pick = (sql, limit) => db.prepare(`SELECT * FROM (${sql}) ORDER BY ${order} LIMIT ${Number(limit)}`).all();
  const check = (row, valueChecks) => {
    const ev = db.prepare(`SELECT * FROM kb_evidence WHERE id = ?`).get(row.evidence_id);
    if (!ev) return { ok: false, problems: ["NO_EVIDENCE"] };
    const v = knowledge.verifyEvidence({ sourceId: ev.source_id, quote: ev.quote, locator: ev.locator, extraction: "explicit" });
    const problems = v.hard.map((h) => h.code);
    for (const [label, ok] of valueChecks(ev.quote)) if (!ok) problems.push(label);
    return { ok: problems.length === 0, problems, quote: collapseWhitespace(ev.quote).slice(0, 220), source: knowledge._source(ev.source_id)?.url ?? null };
  };
  const out = {};
  out.merchants = pick(
    `SELECT m.id, m.name, c.evidence_id FROM kb_merchants m JOIN kb_merchant_claims c ON c.merchant_id = m.id AND c.field = 'name' AND c.status = 'published' WHERE m.status IN ('candidate', 'verified') GROUP BY m.id`,
    sizes.merchants
  ).map((r) => ({ id: r.id, value: r.name, ...check(r, (q) => [["NAME_NOT_IN_QUOTE", has(q, r.name)]]) }));
  out.products = pick(`SELECT id, original_name, observation, evidence_id FROM kb_merchant_products WHERE status = 'published'`, sizes.products).map((r) => ({
    id: r.id,
    value: `${r.original_name} (${r.observation})`,
    ...check(r, (q) => [["NAME_NOT_IN_QUOTE", has(q, r.original_name)]]),
  }));
  out.links = pick(
    `SELECT l.id, l.evidence_id, f.canonical_name AS food, p.original_name AS product, l.match_type FROM kb_food_product_links l JOIN kb_food_entities f ON f.id = l.food_entity_id JOIN kb_merchant_products p ON p.id = l.kb_product_id WHERE l.status = 'published'`,
    sizes.links
  ).map((r) => {
    const names = db.prepare(`SELECT n.normalized FROM kb_food_names n JOIN kb_food_entities f ON f.id = n.entity_id WHERE f.canonical_name = ? AND n.status = 'published'`).all(r.food).map((x) => x.normalized);
    return { id: r.id, value: `${r.product} -> ${r.food} (${r.match_type})`, ...check(r, () => [["FOOD_NAME_NOT_THE_PRODUCT", names.includes(normalizeName(r.product))]]) };
  });
  out.prices = pick(`SELECT x.id, x.evidence_id, x.price, x.price_text_original, p.original_name FROM kb_product_prices x JOIN kb_merchant_products p ON p.id = x.product_id WHERE x.status = 'published'`, sizes.prices).map((r) => ({
    id: r.id,
    value: `${r.original_name} = ${r.price} (${r.price_text_original})`,
    ...check(r, (q) => [["PRICE_TEXT_NOT_IN_QUOTE", collapseWhitespace(q).includes(collapseWhitespace(r.price_text_original)) || q.includes(r.price_text_original)]]),
  }));
  out.facts = pick(
    `SELECT c.id, c.evidence_id, f.canonical_name AS food, c.kind, c.key, c.value, c.level FROM kb_claims c JOIN kb_food_entities f ON f.id = c.entity_id WHERE c.status = 'published' AND f.status = 'published'`,
    sizes.facts
  ).map((r) => ({ id: r.id, value: `${r.food}: ${r.kind} ${r.key}=${r.value ?? ""}${r.level ? `/${r.level}` : ""}`, ...check(r, () => []) }));
  const summary = Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, { sampled: rows.length, provenance_ok: rows.filter((r) => r.ok).length, provenance_rate: rows.length ? +(rows.filter((r) => r.ok).length / rows.length).toFixed(3) : null }]));
  return { sampled_at: new Date().toISOString(), summary, rows: out };
}
