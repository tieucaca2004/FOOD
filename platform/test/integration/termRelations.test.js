// Dish name / keyword relation rule engine: CANONICAL FOOD -> APPROVED TERMS -> DETERMINISTIC MATCHING.
// Temp knowledge DBs from the SYNTHETIC Nha Trang fixture (+ a few test dishes); never the collector / runtime DB.
// Production reaches the module ONLY through the Food Knowledge adapter, read-only (checked below).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { TermRelationService } from "../../knowledge/terms/termRelationService.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA = "a".repeat(64);

function setup() {
  const db = createKnowledgeConnection(nhaTrangKnowledge());
  runKnowledgeMigrations(db);
  const addFood = (key, name) => {
    const id = db.prepare(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, 'published')`).run(key, name, key.replace(/-/g, " ")).lastInsertRowid;
    return id;
  };
  // SYNTHETIC test dishes: a one-word accented name, and a sibling that can share a nickname
  const gio = addFood("gio", "Giò");
  const banhCanhCa = addFood("banh-canh-ca", "Bánh canh cá");
  const food = (key) => db.prepare(`SELECT id FROM kb_food_entities WHERE key = ?`).get(key).id;
  const s = new TermRelationService({ db });
  const ev = [{ sourceKind: "text", sourceRef: SHA, quote: "Khách Nha Trang hay gọi như vậy" }];
  const approved = (p, opts = {}) => {
    const r = s.propose({ createdBy: "founder", evidence: ev, ...p });
    s.submitForReview(r.id, "founder");
    return s.approve(r.id, { by: "founder", ...opts });
  };
  return { db, s, ev, approved, bunCa: food("bun-ca"), banhCan: food("banh-can"), longLon: food("long-lon"), gio, banhCanhCa };
}
const brief = (r) => ({ status: r.status, foods: r.matches.map((m) => m.canonicalName), types: r.matches.map((m) => m.relationType) });

test("CANONICAL: exact name, accents forgiven, accents typed respected, whole words only", () => {
  const { s } = setup();
  const m = s.buildMatcher();
  assert.deepEqual(brief(m.match("Tìm quán bún cá")), { status: "resolved", foods: ["Bún cá"], types: ["CANONICAL"] });
  assert.deepEqual(brief(m.match("cho tôi 2 tô bun ca")), { status: "resolved", foods: ["Bún cá"], types: ["CANONICAL"] }); // no accents typed
  // an accent typed differently is a different word: never a match — at most a "did you mean" (ACCENT candidate)
  const wrongAccent = m.match("bún cà");
  assert.deepEqual([wrongAccent.status, wrongAccent.matches, wrongAccent.suggestions.map((x) => [x.canonicalName, x.typo.kind])], ["suggested", [], [["Bún cá", "ACCENT"]]]);
  assert.equal(m.match("cá").status, "none"); // part of a name is not the name
  assert.equal(m.match("canh chua").status, "none");
  // a one-word accented name is not matched from its unaccented spelling (gio = giờ / gió …)
  assert.deepEqual(brief(m.match("cho tôi giò")), { status: "resolved", foods: ["Giò"], types: ["CANONICAL"] });
  assert.equal(m.match("may gio mo cua").status, "none");
});

test("APPROVED TERMS: alias, abbreviation, common query, diacritic variant — only once approved", () => {
  const { s, approved, bunCa, gio } = setup();
  const proposed = s.propose({ foodEntityId: bunCa, term: "bún cá NT", relationType: "ABBREVIATION", createdBy: "founder", evidence: [{ sourceKind: "text", sourceRef: SHA, quote: "bún cá NT" }] });
  assert.equal(s.buildMatcher().match("có bún cá NT không").matches[0].relationType, "CANONICAL"); // "bún cá" only: the abbreviation is not in force
  s.submitForReview(proposed.id, "founder");
  assert.equal(s.buildMatcher().match("bún cá NT").matches[0].relationType, "CANONICAL"); // REVIEW is not in force either
  s.approve(proposed.id, { by: "founder" });
  const nt = s.buildMatcher().match("có bún cá NT không");
  assert.deepEqual([nt.matches[0].canonicalName, nt.matches[0].relationType, nt.matches[0].text], ["Bún cá", "ABBREVIATION", "bún cá nt"]);
  approved({ foodEntityId: bunCa, term: "tô bún cá dầm", relationType: "COMMON_QUERY" });
  approved({ foodEntityId: bunCa, term: "bún cá dầm", relationType: "EXACT_ALIAS" });
  approved({ foodEntityId: gio, term: "gio", relationType: "DIACRITIC_VARIANT" });
  const m = s.buildMatcher();
  assert.deepEqual(brief(m.match("cho 2 tô bún cá dầm")), { status: "resolved", foods: ["Bún cá"], types: ["COMMON_QUERY"] }); // longest span
  assert.deepEqual(brief(m.match("bun ca dam")), { status: "resolved", foods: ["Bún cá"], types: ["EXACT_ALIAS"] });
  assert.deepEqual(brief(m.match("cho toi gio lua")), { status: "resolved", foods: ["Giò"], types: ["DIACRITIC_VARIANT"] }); // now explicitly approved
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bún cá", relationType: "EXACT_ALIAS", createdBy: "founder" }), /canonical name/);
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bún bò", relationType: "DIACRITIC_VARIANT", createdBy: "founder" }), /without accents/);
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bun bo", relationType: "DIACRITIC_VARIANT", createdBy: "founder" }), /unaccented spelling of the dish/);
});

test("TYPO: one edit on a long name is a SUGGESTION to confirm, never a match; short words never", () => {
  const { s } = setup();
  const m = s.buildMatcher();
  const r = m.match("cho tôi bánh cănn");
  assert.equal(r.status, "suggested");
  assert.deepEqual(r.matches, []);
  assert.deepEqual(r.suggestions.map((x) => [x.canonicalName, x.suggestion]), [["Bánh căn", true]]);
  assert.equal(m.match("cá").status, "none");
  assert.equal(m.match("bún").status, "none");
});

test("AMBIGUITY: a term that names several dishes returns candidates, never a choice; approving it needs an acknowledgement", () => {
  const { s, bunCa, banhCanhCa, ev } = setup();
  const one = s.propose({ foodEntityId: bunCa, term: "cá nước", relationType: "COMMON_QUERY", createdBy: "founder", evidence: ev });
  s.submitForReview(one.id, "founder");
  s.approve(one.id, { by: "founder" });
  const two = s.propose({ foodEntityId: banhCanhCa, term: "cá nước", relationType: "COMMON_QUERY", createdBy: "founder", evidence: ev });
  s.submitForReview(two.id, "founder");
  assert.throws(() => s.approve(two.id, { by: "founder" }), /AMBIGUOUS|already names/);
  s.approve(two.id, { by: "founder", ackAmbiguous: true });
  const r = s.buildMatcher().match("cho tôi tô cá nước");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.matches, []);
  assert.deepEqual(r.ambiguous[0].candidates.map((c) => c.canonicalName).sort(), ["Bánh canh cá", "Bún cá"]);
});

test("FALSE POSITIVES: generic words, places, numbers are never terms; related terms never resolve; disallowed terms block", () => {
  const { s, approved, bunCa, longLon } = setup();
  for (const term of ["còn", "món", "quán", "ngon", "giá", "đâu", "này", "kia", "món ngon", "ăn gì", "còn món", "ngon nhất"]) {
    assert.throws(() => s.propose({ foodEntityId: bunCa, term, relationType: "EXACT_ALIAS", createdBy: "founder" }), /generic words/, term);
  }
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "Nha Trang", relationType: "EXACT_ALIAS", createdBy: "founder" }), /a place/);
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "123", relationType: "EXACT_ALIAS", createdBy: "founder" }), /number/);
  // "cá" related to Bún cá: reported as related, never resolved to the dish
  approved({ foodEntityId: bunCa, term: "cá", relationType: "RELATED_TERM" });
  const related = s.buildMatcher().match("cá");
  assert.equal(related.status, "none");
  assert.deepEqual(related.related.map((x) => [x.canonicalName, x.relationType]), [["Bún cá", "RELATED_TERM"]]);
  // the historical bad alias "tràng" (Lòng lợn) is a Food Knowledge name, not an approved term: not used here
  assert.equal(s.buildMatcher().match("Nha Trang").status, "none");
  assert.equal(s.buildMatcher().match("tràng").status, "none");
  // a DISALLOWED term blocks its dish (and a global one blocks every dish)
  approved({ foodEntityId: longLon, term: "lòng lợn", relationType: "DISALLOWED_TERM" });
  assert.equal(s.buildMatcher().match("lòng lợn").status, "none");
  approved({ foodEntityId: null, term: "bánh căn", relationType: "DISALLOWED_TERM" });
  assert.equal(s.buildMatcher().match("tìm bánh căn").status, "none");
  assert.equal(s.buildMatcher().match("pizza hải sản").status, "none"); // unrelated
});

test("CONTEXT: 'còn món đó không?' is a reference to the conversation, not a dish; 'còn' is never learned", () => {
  const { s, db } = setup();
  const m = s.buildMatcher();
  const r = m.match("còn món đó không?");
  assert.deepEqual([r.status, r.contextReference, r.matches.length], ["none", true, 0]);
  const withDish = m.match("còn món bún cá không?");
  assert.deepEqual(brief(withDish), { status: "resolved", foods: ["Bún cá"], types: ["CANONICAL"] });
  assert.equal(withDish.contextReference, false);
  // matching never writes: no relation is created from customer messages
  for (const t of ["còn món bún cá không?", "bún cá NT ngon", "cho tôi tô bun ca", "quán này có bánh căn không"]) m.match(t);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_term_relations`).get().n, 0);
});

test("LIFECYCLE: draft -> review -> approve (person only) -> retire; RETIRED no longer matches; versions are immutable", () => {
  const { s, db, bunCa, ev } = setup();
  const llm = s.propose({ foodEntityId: bunCa, term: "bún cá sứa", relationType: "EXACT_ALIAS", proposedByKind: "llm", createdBy: "model:gpt-5.6-terra", evidence: ev });
  assert.deepEqual([llm.status, llm.confidence, llm.proposed_by_kind], ["DRAFT", 0.5, "llm"]);
  assert.throws(() => s.approve(llm.id, { by: "founder" }), /submit it for review first/);
  s.submitForReview(llm.id, "founder");
  for (const by of ["ai:gpt", "model", "system", ""]) assert.throws(() => s.approve(llm.id, { by }), /person/, by);
  const ok = s.approve(llm.id, { by: "founder" });
  assert.equal(ok.status, "APPROVED");
  assert.equal(s.buildMatcher().match("bún cá sứa").matches[0].relationType, "EXACT_ALIAS");
  assert.throws(() => db.prepare(`UPDATE kb_term_relations SET term_key = 'x' WHERE id = ?`).run(ok.id), /immutable/);
  assert.throws(() => db.prepare(`DELETE FROM kb_term_relations WHERE id = ?`).run(ok.id), /never deleted/);
  const v2 = s.revise(ok.id, { relationType: "COMMON_QUERY", confidence: 0.8 }, "founder");
  assert.deepEqual([v2.status, v2.version, v2.supersedes_id, v2.evidence.length], ["DRAFT", 2, ok.id, 1]);
  s.submitForReview(v2.id, "founder");
  s.approve(v2.id, { by: "founder" });
  assert.equal(s.get(ok.id).status, "RETIRED");
  assert.equal(s.buildMatcher().match("bún cá sứa").matches[0].relationType, "COMMON_QUERY");
  s.retire(v2.id, { by: "founder", reason: "không dùng nữa" });
  assert.equal(s.buildMatcher().match("bún cá sứa").matches[0].relationType, "CANONICAL"); // only the canonical "bún cá" is left
  assert.throws(() => db.prepare(`UPDATE kb_term_relations SET status = 'APPROVED' WHERE id = ?`).run(v2.id), /immutable/);
  assert.deepEqual(s.get(v2.id).events.map((e) => e.action), ["proposed", "submitted", "approved", "retired"]);
});

test("PROVENANCE: evidence is required and must point at an existing source; evidence is append-only", () => {
  const { s, db, bunCa } = setup();
  const r = s.propose({ foodEntityId: bunCa, term: "bún chả cá dầm", relationType: "COMMON_QUERY", createdBy: "founder" });
  assert.throws(() => s.submitForReview(r.id, "founder"), /needs evidence/);
  assert.throws(() => s.linkEvidence(r.id, { sourceKind: "kb_evidence", sourceRef: "999999", quote: "x" }, "founder"), /no kb_evidence/);
  assert.throws(() => s.linkEvidence(r.id, { sourceKind: "text", sourceRef: "not-a-sha", quote: "x" }, "founder"), /no text/);
  const evId = db.prepare(`SELECT id FROM kb_evidence LIMIT 1`).get().id;
  s.linkEvidence(r.id, { sourceKind: "kb_evidence", sourceRef: String(evId), quote: "Bún cá" }, "founder");
  assert.equal(s.submitForReview(r.id, "founder").status, "REVIEW");
  assert.throws(() => db.prepare(`DELETE FROM kb_term_evidence`).run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE kb_term_events SET actor = 'x'`).run(), /append-only/);
});

test("ISOLATION: Food Knowledge names / entities untouched; only the adapter imports the module; migration 007 present", () => {
  const { s, db, approved, bunCa } = setup();
  const counts = () => ["kb_food_entities", "kb_food_names", "kb_merchant_products", "kb_food_product_links"].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const before = counts();
  approved({ foodEntityId: bunCa, term: "bún cá chả", relationType: "EXACT_ALIAS" });
  s.buildMatcher().match("bún cá chả");
  assert.deepEqual(counts(), before);
  assert.ok(db.prepare(`SELECT 1 FROM kb_schema_migrations WHERE name = '007_term_relations.sql'`).get());
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (["node_modules", "test"].includes(e.name) ? [] : files(path.join(dir, e.name))) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const importers = [...files(path.join(REPO, "platform")), ...files(path.join(REPO, "src"))].filter((f) => !f.includes(`${path.sep}knowledge${path.sep}terms${path.sep}`) && /knowledge\/terms\//.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(importers.map((f) => path.relative(REPO, f).replace(/\\/g, "/")), ["platform/services/foodKnowledgeAdapter.js"]); // only the adapter (read-only matcher)
});

test("REGIONAL NAME: how a region calls a dish names it anywhere, and says whether the conversation is in that region", () => {
  const { s, approved, bunCa, ev } = setup();
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bún cá lá", relationType: "REGIONAL_ALIAS", createdBy: "founder", evidence: ev }), /needs a known region/);
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bún cá lá", relationType: "REGIONAL_ALIAS", regionId: "vn.khong-co", createdBy: "founder" }), /needs a known region/);
  assert.throws(() => s.propose({ foodEntityId: bunCa, term: "bún cá lá", relationType: "EXACT_ALIAS", regionId: "vn.khanh-hoa.nha-trang", createdBy: "founder" }), /only a REGIONAL_ALIAS has a region/);
  // "Khách ở Khánh Hòa thường gọi Bún cá là bún cá lá" (a founder note would be the evidence)
  approved({ foodEntityId: bunCa, term: "bún cá lá", relationType: "REGIONAL_ALIAS", regionId: "vn.khanh-hoa" });
  const m = s.buildMatcher();
  const inside = m.match("cho tôi bún cá lá ở Nha Trang"); // Nha Trang is inside Khánh Hòa
  assert.deepEqual([inside.matches[0].canonicalName, inside.matches[0].relationType, inside.matches[0].regionMatch], ["Bún cá", "REGIONAL_ALIAS", "in"]);
  assert.equal(m.match("bun ca la", { regionId: "vn.khanh-hoa.cam-ranh" }).matches[0].regionMatch, "in");
  assert.equal(m.match("bún cá lá", { regionId: "vn" }).matches[0].regionMatch, "out"); // the whole country is not inside Khánh Hòa
  assert.equal(m.match("bún cá lá").matches[0].regionMatch, "unknown");
  assert.equal(m.match("bún cá lá").status, "resolved"); // it still names the dish, wherever it is said
});
