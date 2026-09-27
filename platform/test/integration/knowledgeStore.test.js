// Food Intelligence P0 — evidence model + validator + store over a real
// (in-memory) knowledge.db. The raw "sources" below are SYNTHETIC TEST
// FIXTURES written to a temp dir: short made-up texts, not collected data.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { KnowledgeStore } from "../../knowledge/store.js";

const PAD = "Đoạn văn đệm của test fixture, không nói về món nào cụ thể. ".repeat(8); // > 300 chars

const FIXTURES = {
  "pub-a.html": `<html><head><script>var note = "Bún cá cay xé lưỡi";</script></head><body>
    <h1>Bún&nbsp;cá</h1>
    <p>Bún cá là món nước,   thường ăn nóng.
       Nước dùng ngọt thanh, có chả cá và sứa. Ớt để riêng cho khách tự thêm.</p>
    <p>Món này có tính mát theo quan niệm dân gian.</p>
    <p>Bún cá thường dùng để ăn sáng.</p></body></html>`,
  "enc-b.txt": `Bún cá thường ăn nóng. Bún cá và bún sứa là hai món liên quan ở miền Trung.
${PAD}
Bánh căn là món bánh nướng khuôn từ bột gạo, giòn ở đáy.
${PAD}
Bánh bò là món bánh ngọt, mềm.`,
  "blog-c.txt": "Bún cá ở đây hơi cay. Bún cá ở quán kia không cay. bun ca chua chua",
  "osm.json": JSON.stringify({ elements: [{ tags: { name: "Quán Thử Nghiệm", cuisine: "noodle" } }] }),
  "menu.pdf": "%PDF-1.4 binary-ish",
};

function setup() {
  const dir = path.join(os.tmpdir(), `knowledge-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const store = new KnowledgeStore({ db, rawRoot: dir });
  const src = {
    a: store.registerSource({ url: "https://news-a.example/bun-ca", sourceType: "publication", rawPath: "pub-a.html", contentType: "text/html", fetchedAt: "2026-09-25T00:00:00Z" }),
    b: store.registerSource({ url: "https://wiki-b.example/mon-an", sourceType: "encyclopedia", rawPath: "enc-b.txt", contentType: "text/plain", fetchedAt: "2026-09-25T00:00:00Z" }),
    c: store.registerSource({ url: "https://blog-c.example/review", sourceType: "blog", rawPath: "blog-c.txt", contentType: "text/plain", fetchedAt: "2026-09-25T00:00:00Z" }),
  };
  store.registerRegion({ id: "vn", name: "Việt Nam", level: "country" });
  store.registerRegion({ id: "vn.mien-trung", name: "miền Trung", parentId: "vn", level: "province" });
  const ev = (source, quote, extra = {}) => ({ sourceId: source.id, quote, extraction: "explicit", ...extra });
  const entity = (key, name, source, quote) => store.proposeEntity({ key, canonicalName: name, evidence: ev(source, quote) });
  entity("bun-ca", "Bún cá", src.a, "Bún cá là món nước");
  const claim = (p) => store.proposeClaim({ entityKey: "bun-ca", scope: "typical", ...p });
  const codes = (r) => r.reasons.map((x) => x.code);
  const row = (id) => db.prepare(`SELECT * FROM kb_claims WHERE id = ?`).get(id);
  return { dir, db, store, src, ev, entity, claim, codes, row };
}

// --- schema --------------------------------------------------------------------------------

test("SCHEMA: knowledge.db is its own database — knowledge tables only, no platform/ordering tables", () => {
  const { db } = setup();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`).all().map((r) => r.name);
  for (const t of ["kb_sources", "kb_regions", "kb_food_entities", "kb_food_names", "kb_evidence", "kb_claims", "kb_published_claims", "kb_published_names"]) {
    assert.ok(tables.includes(t), t);
  }
  for (const t of ["merchants", "merchant_products", "orders", "merchant_carts"]) assert.ok(!tables.includes(t), t);
  // re-running migrations is a no-op
  runKnowledgeMigrations(db);
  const migrationFiles = fs.readdirSync(new URL("../../knowledge/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n, migrationFiles.length);
});

// --- sources -------------------------------------------------------------------------------

test("SOURCES: the store computes the content hash itself; unknown types and unlicensed OSM are refused", () => {
  const { store, src, dir } = setup();
  assert.match(src.a.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(src.a.domain, "news-a.example");
  assert.throws(() => store.registerSource({ url: "https://x.example", sourceType: "rumor", rawPath: "blog-c.txt", contentType: "text/plain", fetchedAt: "2026-09-25" }), /unknown source type/);
  assert.throws(() => store.registerSource({ url: "https://osm.example", sourceType: "osm", rawPath: "osm.json", contentType: "application/json", fetchedAt: "2026-09-25" }), /ODbL-1.0/);
  const osm = store.registerSource({ url: "https://overpass.example/q", sourceType: "osm", rawPath: "osm.json", contentType: "application/json", fetchedAt: "2026-09-25", license: "ODbL-1.0", attribution: "© OpenStreetMap contributors" });
  assert.equal(osm.license, "ODbL-1.0");
  assert.throws(() => store.registerSource({ url: "https://x.example", sourceType: "blog", rawPath: "missing.txt", contentType: "text/plain", fetchedAt: "2026-09-25" }), /raw file not found/);
  assert.ok(fs.existsSync(path.join(dir, "pub-a.html"))); // raw data is never deleted
});

// --- entities / names ------------------------------------------------------------------------

test("ENTITY: published once a verbatim quote names it; the unaccented form is derived, not sourced", () => {
  const { store } = setup();
  assert.equal(store.entity("bun-ca").status, "published");
  const names = store.publishedNames("bun-ca").map((n) => [n.name, n.kind, n.origin]);
  assert.deepEqual(names, [["Bún cá", "canonical", "sourced"], ["bun ca", "no_accent", "derived"]]);
});

test("ENTITY: a quote that does not name it -> review; a quote not in the source -> rejected", () => {
  const { store, entity, src } = setup();
  const r1 = entity("bun-sua", "Bún sứa", src.a, "Nước dùng ngọt thanh");
  assert.equal(r1.entity.status, "review");
  assert.deepEqual(r1.reasons.map((x) => x.code), ["NOT_SUPPORTED_BY_QUOTE"]);
  const r2 = entity("banh-xeo", "Bánh xèo", src.a, "Bánh xèo giòn rụm");
  assert.equal(r2.entity.status, "rejected");
  assert.deepEqual(r2.reasons.map((x) => x.code), ["QUOTE_NOT_FOUND"]);
  assert.throws(() => entity("bun-ca", "Bún cá", src.a, "Bún cá là món nước"), /already exists/);
});

test("NAMES: aliases need evidence; misspellings go to review; derived forms cannot be proposed", () => {
  const { store, src, ev } = setup();
  assert.equal(store.proposeName({ entityKey: "bun-ca", name: "bún chả cá", kind: "alias", evidence: ev(src.a, "có chả cá và sứa") }).outcome, "review");
  assert.equal(store.proposeName({ entityKey: "bun-ca", name: "bún cá", kind: "alias", evidence: ev(src.b, "Bún cá thường ăn nóng.") }).outcome, "published");
  assert.equal(store.proposeName({ entityKey: "bun-ca", name: "bún kà", kind: "misspelling", evidence: ev(src.b, "Bún cá thường ăn nóng.") }).outcome, "review");
  assert.equal(store.proposeName({ entityKey: "bun-ca", name: "bun ca", kind: "no_accent", evidence: ev(src.b, "Bún cá thường ăn nóng.") }).outcome, "rejected");
});

// --- publish path ------------------------------------------------------------------------------

test("CLAIM: verified, supporting evidence publishes — confidence is computed, never taken from the proposal", () => {
  const { claim, row } = setup();
  const r = claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: 1, quote: "Bún cá là món nước, thường ăn nóng.", extraction: "explicit" }, confidence: 1 });
  assert.equal(r.outcome, "published", JSON.stringify(r.reasons));
  assert.equal(row(r.claimId).confidence, 0.65); // publication tier
  assert.equal(claim({ kind: "facet", key: "dish_form", value: "soup_dish", evidence: { sourceId: 1, quote: "Bún cá là món nước", extraction: "explicit" } }).outcome, "published");
  assert.equal(claim({ kind: "facet", key: "meal_period", value: "breakfast", evidence: { sourceId: 1, quote: "Bún cá thường dùng để ăn sáng.", extraction: "explicit" } }).outcome, "published");
  assert.equal(claim({ kind: "ingredient", key: "protein.seafood.fish_cake", value: "topping", evidence: { sourceId: 1, quote: "có chả cá và sứa", extraction: "explicit" } }).outcome, "published");
  assert.equal(claim({ kind: "ingredient", key: "protein.seafood", value: "topping", evidence: { sourceId: 1, quote: "có chả cá và sứa", extraction: "explicit" } }).outcome, "published"); // chả cá isA seafood
  assert.equal(claim({ kind: "attribute", key: "taste.spicy", level: "adjustable", evidence: { sourceId: 1, quote: "Ớt để riêng cho khách tự thêm.", extraction: "explicit" } }).outcome, "published");
});

test("CORROBORATION: the same fact from another independent domain raises confidence for both", () => {
  const { claim, row, src } = setup();
  const a = claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.a.id, quote: "thường ăn nóng.", extraction: "explicit" } });
  const b = claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.b.id, quote: "Bún cá thường ăn nóng.", extraction: "explicit" } });
  assert.equal(a.outcome, "published");
  assert.equal(b.outcome, "published");
  assert.equal(row(a.claimId).confidence, 0.75); // 0.65 + 0.1
  assert.equal(row(b.claimId).confidence, 0.85); // 0.75 + 0.1
});

// --- hard rejections ----------------------------------------------------------------------------

test("REJECT: traditional-medicine 'tính mát' — neither as a concept nor as evidence for temperature", () => {
  const { claim, codes } = setup();
  assert.deepEqual(codes(claim({ kind: "attribute", key: "tcm_nature", value: "cool", evidence: { sourceId: 1, quote: "Món này có tính mát theo quan niệm dân gian.", extraction: "explicit" } })), ["OUT_OF_SCOPE"]);
  const r = claim({ kind: "attribute", key: "temperature.serving", value: "cool", evidence: { sourceId: 1, quote: "Món này có tính mát theo quan niệm dân gian.", extraction: "explicit" } });
  assert.equal(r.outcome, "rejected");
  assert.deepEqual(codes(r), ["OUT_OF_SCOPE_ONLY"]);
});

test("REJECT: a quote that is not verbatim in the source — including text hidden in <script>", () => {
  const { claim, codes, db } = setup();
  const r = claim({ kind: "attribute", key: "taste.spicy", level: "high", evidence: { sourceId: 1, quote: "Bún cá cay xé lưỡi", extraction: "explicit" } });
  assert.equal(r.outcome, "rejected");
  assert.deepEqual(codes(r), ["QUOTE_NOT_FOUND"]);
  assert.equal(db.prepare(`SELECT verification FROM kb_evidence ORDER BY id DESC LIMIT 1`).get().verification, "failed");
  // whitespace and HTML entities are not "wording": the collapsed quote is found
  assert.equal(claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: 1, quote: "Bún cá là món nước, thường ăn nóng.", extraction: "explicit" } }).outcome, "published");
});

test("REJECT: a raw source that changed or disappeared after registration", () => {
  const { claim, codes, dir, src } = setup();
  fs.appendFileSync(path.join(dir, "blog-c.txt"), " sửa sau khi lưu");
  assert.deepEqual(codes(claim({ kind: "attribute", key: "taste.spicy", level: "low", evidence: { sourceId: src.c.id, quote: "Bún cá ở đây hơi cay.", extraction: "explicit" } })), ["RAW_CHANGED"]);
  fs.rmSync(path.join(dir, "enc-b.txt"));
  assert.deepEqual(codes(claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.b.id, quote: "Bún cá thường ăn nóng.", extraction: "explicit" } })), ["RAW_MISSING"]);
});

test("REJECT: LLM proposals must carry the source URL, and it must be the source's", () => {
  const { claim, codes, row, src } = setup();
  const q = "Bún cá là món nước, thường ăn nóng.";
  assert.deepEqual(codes(claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.a.id, quote: q, extraction: "llm_proposal" } })), ["MISSING_SOURCE_URL"]);
  assert.deepEqual(codes(claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.a.id, quote: q, extraction: "llm_proposal", sourceUrl: "https://elsewhere.example" } })), ["SOURCE_URL_MISMATCH"]);
  const ok = claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.a.id, quote: q, extraction: "llm_proposal", sourceUrl: src.a.url, proposedBy: "model:test" } });
  assert.equal(ok.outcome, "published");
  assert.equal(row(ok.claimId).confidence, 0.6); // 0.65 − 0.05 for an LLM proposal
});

test("REJECT: values outside the taxonomy; a proposal without evidence stores nothing", () => {
  const { claim, codes, db } = setup();
  assert.deepEqual(codes(claim({ kind: "attribute", key: "taste.spicy", level: "extreme", evidence: { sourceId: 1, quote: "Bún cá là món nước", extraction: "explicit" } })), ["INVALID_VALUE"]);
  assert.deepEqual(codes(claim({ kind: "facet", key: "dish_form", value: "pizza", evidence: { sourceId: 1, quote: "Bún cá là món nước", extraction: "explicit" } })), ["INVALID_VALUE"]);
  assert.deepEqual(codes(claim({ kind: "attribute", key: "temperature.actual", value: "hot", evidence: { sourceId: 1, quote: "Bún cá là món nước", extraction: "explicit" } })), ["INVALID_VALUE"]);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM kb_claims`).get().n;
  assert.deepEqual(codes(claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: null })), ["MISSING_EVIDENCE"]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_claims`).get().n, before);
});

// --- review path ---------------------------------------------------------------------------------

test("REVIEW: real evidence that does not support the claim (absent, negated, other level, ambiguous)", () => {
  const { claim, codes, src } = setup();
  const c = (p, quote, source = src.c) => codes(claim({ ...p, evidence: { sourceId: source.id, quote, extraction: "explicit" } }));
  assert.deepEqual(c({ kind: "attribute", key: "taste.spicy", level: "high" }, "có chả cá và sứa", src.a), ["NOT_SUPPORTED_BY_QUOTE"]);
  assert.deepEqual(c({ kind: "attribute", key: "taste.spicy", level: "low" }, "Bún cá ở quán kia không cay."), ["NEGATED_IN_QUOTE"]);
  assert.deepEqual(c({ kind: "attribute", key: "taste.spicy", level: "high" }, "Bún cá ở đây hơi cay."), ["LEVEL_MISMATCH"]);
  assert.deepEqual(c({ kind: "attribute", key: "taste.sour", level: "low" }, "bun ca chua chua"), ["AMBIGUOUS_TERM"]);
  // "không cay" does support spice = none
  assert.equal(claim({ kind: "attribute", key: "taste.spicy", level: "none", evidence: { sourceId: src.c.id, quote: "Bún cá ở quán kia không cay.", extraction: "explicit" } }).outcome, "published");
});

test("REVIEW: a dish name is not evidence — 'bánh bò' does not mean beef", () => {
  const { store, entity, src, ev } = setup();
  entity("banh-bo", "Bánh bò", src.b, "Bánh bò là món bánh ngọt, mềm.");
  const beef = store.proposeClaim({ entityKey: "banh-bo", kind: "ingredient", key: "protein.beef", value: "main", evidence: ev(src.b, "Bánh bò là món bánh ngọt, mềm.") });
  assert.equal(beef.outcome, "review");
  assert.deepEqual(beef.reasons.map((r) => r.code), ["PROTECTED_NAME_ONLY"]);
  assert.equal(store.proposeClaim({ entityKey: "banh-bo", kind: "attribute", key: "texture.soft", level: "medium", evidence: ev(src.b, "Bánh bò là món bánh ngọt, mềm.") }).outcome, "published");
});

test("REVIEW: the entity must be named in the quote or right around it", () => {
  const { store, entity, src, ev, codes } = setup();
  entity("banh-can", "Bánh căn", src.b, "Bánh căn là món bánh nướng khuôn từ bột gạo, giòn ở đáy.");
  // "giòn ở đáy" alone: Bánh căn is named just before it -> fine
  assert.equal(store.proposeClaim({ entityKey: "banh-can", kind: "attribute", key: "texture.crispy", level: "medium", evidence: ev(src.b, "giòn ở đáy") }).outcome, "published");
  assert.equal(store.proposeClaim({ entityKey: "banh-can", kind: "facet", key: "preparation", value: "mold_bake", evidence: ev(src.b, "món bánh nướng khuôn từ bột gạo") }).outcome, "published");
  // the same words attributed to Bún cá, which is far away in the text -> review
  const wrong = store.proposeClaim({ entityKey: "bun-ca", kind: "attribute", key: "texture.crispy", level: "medium", evidence: ev(src.b, "giòn ở đáy") });
  assert.deepEqual(codes(wrong), ["ENTITY_NOT_MENTIONED"]);
});

test("REVIEW: rule-derived values, ingredient-list completeness and 'varies' are founder cases", () => {
  const { claim, codes } = setup();
  assert.ok(codes(claim({ kind: "ingredient", key: "protein.seafood.jellyfish", value: "topping", evidence: { sourceId: 1, quote: "có chả cá và sứa", extraction: "rule" } })).includes("DERIVED_BY_RULE"));
  assert.deepEqual(codes(claim({ kind: "ingredient_completeness", key: "ingredients", value: "complete", evidence: { sourceId: 1, quote: "có chả cá và sứa", extraction: "explicit" } })), ["NEEDS_FOUNDER_RULE"]);
  assert.deepEqual(codes(claim({ kind: "attribute", key: "taste.spicy", level: "varies", evidence: { sourceId: 1, quote: "Ớt để riêng cho khách tự thêm.", extraction: "explicit" } })), ["NEEDS_FOUNDER_RULE"]);
});

test("REVIEW: descriptions must be the source's own words", () => {
  const { claim, codes } = setup();
  const quote = "Nước dùng ngọt thanh, có chả cá và sứa.";
  assert.deepEqual(codes(claim({ kind: "description", key: "description", value: "Một món nước dùng rất ngon và nổi tiếng", evidence: { sourceId: 1, quote, extraction: "llm_proposal", sourceUrl: "https://news-a.example/bun-ca" } })), ["DESCRIPTION_NOT_VERBATIM"]);
  assert.equal(claim({ kind: "description", key: "description", value: "Nước dùng ngọt thanh", evidence: { sourceId: 1, quote, extraction: "explicit" } }).outcome, "published");
});

test("RELATIONS: related dishes must be named in the quote", () => {
  const { store, entity, claim, codes, src } = setup();
  entity("bun-sua", "Bún sứa", src.b, "Bún cá và bún sứa là hai món liên quan ở miền Trung.");
  assert.equal(store.entity("bun-sua").status, "published");
  assert.equal(claim({ kind: "relation", key: "related_to", value: "bun-sua", evidence: { sourceId: src.b.id, quote: "Bún cá và bún sứa là hai món liên quan ở miền Trung.", extraction: "explicit" } }).outcome, "published");
  assert.deepEqual(codes(claim({ kind: "relation", key: "similar_to", value: "bun-sua", evidence: { sourceId: src.b.id, quote: "Bún cá thường ăn nóng.", extraction: "explicit" } })), ["NOT_SUPPORTED_BY_QUOTE"]);
  assert.deepEqual(codes(claim({ kind: "relation", key: "related_to", value: "pho-bo", evidence: { sourceId: src.b.id, quote: "Bún cá thường ăn nóng.", extraction: "explicit" } })), ["INVALID_VALUE"]);
  assert.equal(claim({ kind: "relation", key: "regional_specialty", value: "vn.mien-trung", evidence: { sourceId: src.b.id, quote: "Bún cá và bún sứa là hai món liên quan ở miền Trung.", extraction: "explicit" } }).outcome, "published");
});

// --- conflicts ------------------------------------------------------------------------------------

test("CONFLICT: disagreeing evidence is never settled by picking one — flagged, reviewed, confidence reduced", () => {
  const { claim, codes, row, src } = setup();
  const first = claim({ kind: "attribute", key: "taste.spicy", level: "adjustable", evidence: { sourceId: src.a.id, quote: "Ớt để riêng cho khách tự thêm.", extraction: "explicit" } });
  assert.equal(row(first.claimId).confidence, 0.65);
  const second = claim({ kind: "attribute", key: "taste.spicy", level: "low", evidence: { sourceId: src.c.id, quote: "Bún cá ở đây hơi cay.", extraction: "explicit" } });
  assert.equal(second.outcome, "review");
  assert.deepEqual(codes(second), ["CONFLICT"]);
  assert.equal(row(first.claimId).status, "published"); // not overwritten
  assert.equal(row(first.claimId).conflict, 1);
  assert.equal(row(first.claimId).confidence, 0.45); // 0.65 − 0.2
  assert.equal(row(second.claimId).conflict, 1);
});

test("CONFLICT: a region- or variant-scoped fact is not a conflict with the typical one", () => {
  const { claim, src } = setup();
  claim({ kind: "attribute", key: "taste.spicy", level: "adjustable", evidence: { sourceId: src.a.id, quote: "Ớt để riêng cho khách tự thêm.", extraction: "explicit" } });
  const regional = claim({ kind: "attribute", key: "taste.spicy", level: "low", scope: "region", regionId: "vn.mien-trung", evidence: { sourceId: src.c.id, quote: "Bún cá ở đây hơi cay.", extraction: "explicit" } });
  assert.equal(regional.outcome, "published");
  // multi-valued facets never conflict (breakfast AND another period is fine)
  assert.equal(claim({ kind: "facet", key: "meal_period", value: "breakfast", evidence: { sourceId: src.a.id, quote: "Bún cá thường dùng để ăn sáng.", extraction: "explicit" } }).outcome, "published");
});

// --- idempotency / founder review / reads ------------------------------------------------------------

test("IDEMPOTENT: the same proposal from the same evidence is stored once", () => {
  const { claim, db } = setup();
  const p = { kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: 1, quote: "thường ăn nóng.", extraction: "explicit" } };
  const first = claim(p);
  const again = claim(p);
  assert.equal(again.claimId, first.claimId);
  assert.deepEqual(again.reasons.map((r) => r.code), ["ALREADY_EXISTS"]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_claims WHERE key = 'temperature.serving'`).get().n, 1);
});

test("FOUNDER REVIEW: review cases can be approved or rejected; rejected and unverified evidence can never be approved", () => {
  const { store, claim, row, dir, src } = setup();
  const reviewCase = claim({ kind: "attribute", key: "taste.spicy", level: "high", evidence: { sourceId: src.c.id, quote: "Bún cá ở đây hơi cay.", extraction: "explicit" } });
  assert.equal(store.listReview().claims.length, 1);
  assert.throws(() => store.resolveReview({ type: "claim", id: reviewCase.claimId, approve: true }), /decidedBy/);
  const approved = store.resolveReview({ type: "claim", id: reviewCase.claimId, approve: true, decidedBy: "founder", note: "nguồn nói hơi cay, chấp nhận mức cao cho test" });
  assert.equal(approved.status, "published");
  assert.ok(row(reviewCase.claimId).confidence > 0);
  assert.match(approved.review_reason, /approved by founder/);

  const rejected = claim({ kind: "attribute", key: "taste.spicy", level: "high", evidence: { sourceId: 1, quote: "không có trong nguồn", extraction: "explicit" } });
  assert.throws(() => store.resolveReview({ type: "claim", id: rejected.claimId, approve: true, decidedBy: "founder" }), /not in review/);

  // a source whose content cannot be read -> the quote was never verified -> cannot be approved
  const pdf = store.registerSource({ url: "https://quan.example/menu.pdf", sourceType: "merchant_official", rawPath: "menu.pdf", contentType: "application/pdf", fetchedAt: "2026-09-25" });
  const unread = claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: pdf.id, quote: "Bún cá ăn nóng", extraction: "explicit" } });
  assert.equal(unread.outcome, "review");
  assert.throws(() => store.resolveReview({ type: "claim", id: unread.claimId, approve: true, decidedBy: "founder" }), /no verified evidence/);
  assert.equal(store.resolveReview({ type: "claim", id: unread.claimId, approve: false, decidedBy: "founder" }).status, "rejected");
  assert.ok(fs.existsSync(path.join(dir, "menu.pdf")));
});

test("READS: only published claims of published entities are visible, each with its quote and source", () => {
  const { store, claim, entity, src, ev } = setup();
  claim({ kind: "attribute", key: "temperature.serving", value: "hot", evidence: { sourceId: src.a.id, quote: "thường ăn nóng.", extraction: "explicit" } });
  claim({ kind: "attribute", key: "taste.spicy", level: "high", evidence: { sourceId: src.c.id, quote: "Bún cá ở đây hơi cay.", extraction: "explicit" } }); // review
  const visible = store.publishedClaims("bun-ca");
  assert.deepEqual(visible.map((c) => [c.key, c.value]), [["temperature.serving", "hot"]]);
  assert.equal(visible[0].quote, "thường ăn nóng.");
  assert.equal(visible[0].source_url, "https://news-a.example/bun-ca");
  assert.equal(visible[0].source_type, "publication");
  // an entity still in review exposes nothing
  entity("bun-sua", "Bún sứa", src.a, "Nước dùng ngọt thanh");
  store.proposeClaim({ entityKey: "bun-sua", kind: "attribute", key: "temperature.serving", value: "hot", evidence: ev(src.b, "Bún cá thường ăn nóng.") });
  assert.deepEqual(store.publishedClaims("bun-sua"), []);
});
