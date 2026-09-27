import { DishFamilies, nameOverlapCandidates } from "../../../platform/knowledge/dishFamily.js";

// Name-level structure of the food entities (computed from names only):
//   - regional style: a registered region written in a dish's own name
//     ("Bún bò Huế" -> Huế). Proposed as relation regional_style with the
//     naming sentence as evidence; a rule-derived proposal (-> review) unless
//     policy.auto_publish.regional_style_from_name is true. Never a merchant
//     location; the "vn" country itself is not a style.
//   - duplicate / variant candidates between entities whose names overlap —
//     recorded for a person, NEVER merged.
//   - lexical families, counted for the coverage report (not stored: a
//     family is a way to browse names, not a food entity).

export function proposeNameStructure({ knowledge, regions, policy = {} }) {
  const db = knowledge.db;
  const families = new DishFamilies(knowledge.taxonomy);
  const stats = { families: {}, no_family: [], style: { proposed: 0, published: 0, review: 0, rejected: 0 }, duplicates: { created: 0, existing: 0, by_kind: {} } };
  const entities = db.prepare(`SELECT id, key, canonical_name, status FROM kb_food_entities WHERE status IN ('published', 'review') ORDER BY id`).all();
  const namesOf = db.prepare(`SELECT name FROM kb_food_names WHERE entity_id = ? AND status IN ('published', 'review') AND kind != 'no_accent' ORDER BY kind != 'canonical', id`);
  const namingEvidence = db.prepare(`SELECT e.source_id, e.quote FROM kb_food_names n JOIN kb_evidence e ON e.id = n.evidence_id WHERE n.entity_id = ? AND n.kind = 'canonical' AND e.verification = 'verified'`);
  const styleRegions = regions.filter((r) => r.id !== "vn");
  const extraction = policy.auto_publish?.regional_style_from_name === true ? "explicit" : "rule";

  for (const e of entities) {
    const family = families.familyOf(e.canonical_name);
    if (family) stats.families[family] = (stats.families[family] ?? 0) + 1;
    else stats.no_family.push(e.canonical_name);
    if (e.status !== "published") continue;
    const evidence = namingEvidence.get(e.id);
    if (!evidence) continue;
    for (const r of families.regionsInName(e.canonical_name, styleRegions)) {
      const res = knowledge.proposeClaim({ entityKey: e.key, kind: "relation", key: "regional_style", value: r.regionId, scope: "typical", evidence: { sourceId: evidence.source_id, quote: evidence.quote, extraction, proposedBy: "collector:name-structure" } });
      stats.style.proposed += 1;
      stats.style[res.outcome] = (stats.style[res.outcome] ?? 0) + 1;
    }
  }

  const withNames = entities.map((e) => ({ id: e.id, key: e.key, names: namesOf.all(e.id).map((n) => n.name) }));
  for (const c of nameOverlapCandidates(withNames, regions)) {
    const r = knowledge.proposeFoodDuplicate({ entityA: c.a, entityB: c.b, kind: c.kind, signals: c.signals, score: c.score });
    stats.duplicates[r.created ? "created" : "existing"] += 1;
    stats.duplicates.by_kind[c.kind] = (stats.duplicates.by_kind[c.kind] ?? 0) + 1;
  }
  return stats;
}
