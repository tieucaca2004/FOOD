// The whole pilot pipeline over a FAKE network with made-up fixtures:
// Wikipedia-like articles, an Overpass response and a merchant homepage +
// owner snapshot. Checks provenance end to end and the data-quality report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runPilot, DEFAULTS } from "../pipeline.js";
import { articleUrl } from "../sources/wikipedia.js";
import { OVERPASS_ENDPOINT } from "../sources/osm.js";
import { fakeNetwork, noWait } from "./helpers.js";

const WIKI = "https://vi.wikipedia.org/wiki/";
const article = (title, paragraphs) =>
  `<html><head><title>${title}</title></head><body><h1 id="firstHeading"><span>${title}</span></h1><div id="mw-content-text">${paragraphs.map((p) => `<p>${p}</p>`).join("")}</div></body></html>`;

function fixtureRepo() {
  const repo = path.join(os.tmpdir(), `pilot-${randomUUID()}`);
  fs.mkdirSync(path.join(repo, "cfg"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "cfg/snapshot.json"),
    JSON.stringify({ source: "https://quan-mau.example", extracted: "2026-09-20", currency: "VND", item_count: 3, items: [
      { category: "BÚN", name: "Bún chả cá", description: "", price_vnd: 45000 },
      { category: "BÚN", name: "Bún chả cá đặc biệt", description: "Thêm chả", price_vnd: 55000 },
      { category: "NƯỚC", name: "Trà đá", description: "", price_vnd: 5000 },
    ] })
  );
  fs.writeFileSync(path.join(repo, "cfg/seeds.json"), JSON.stringify({ wikipedia_base: WIKI, license: "CC BY-SA 4.0", attribution: "Wikipedia contributors", titles: ["Bún chả cá", "Bánh căn", "Không có bài"] }));
  fs.writeFileSync(
    path.join(repo, "cfg/official.json"),
    JSON.stringify({ merchants: [{ homepage: "https://quan-mau.example/", merchant_name: "Quán Mẫu", snapshot: "cfg/snapshot.json", address_text: "12 Đường Thử", street: "Đường Thử", hours_text: "06:00–10:00", region_id: "vn.khanh-hoa.nha-trang" }] })
  );
  return repo;
}

function network() {
  return fakeNetwork({
    "https://vi.wikipedia.org/robots.txt": { body: "User-agent: *\nDisallow: /w/\nDisallow: /api/" },
    [articleUrl(WIKI, "Bún chả cá")]: { body: article("Bún chả cá", ["Bún chả cá là món nước được ăn nóng vào buổi sáng.", "Bún chả cá là đặc sản của Nha Trang, có chả cá chiên và sứa."]) },
    [articleUrl(WIKI, "Bánh căn")]: { body: article("Bánh căn", ["Bánh căn, còn gọi là bánh căn Phan Rang, là món bánh làm từ bột gạo.", "Bánh căn được nướng trong khuôn đất và ăn nóng."]) },
    "https://overpass.kumi.systems/robots.txt": { status: 404, body: "" },
    [OVERPASS_ENDPOINT]: { contentType: "application/json", body: JSON.stringify({ elements: [
      { type: "node", id: 1, lat: 12.25, lon: 109.19, tags: { amenity: "restaurant", name: "Quán Một", cuisine: "vietnamese;noodle", opening_hours: "Mo-Su 06:00-10:00", "addr:street": "Trần Phú" } },
      { type: "node", id: 2, lat: 12.2501, lon: 109.1901, tags: { amenity: "restaurant", name: "Quán Một" } },
      { type: "way", id: 3, center: { lat: 12.26, lon: 109.2 }, tags: { amenity: "cafe", name: "Cà Phê Hai", takeaway: "yes" } },
      { type: "node", id: 4, lat: 12.27, lon: 109.21, tags: { amenity: "restaurant" } },
    ] }) },
    "https://quan-mau.example/robots.txt": { status: 404, body: "" },
    "https://quan-mau.example/": { body: "<html><title>Quán Mẫu - Bún chả cá</title><body><p>📍 12 Đường Thử · Nha Trang</p><p>⏰ 06:00–10:00</p></body></html>" },
  });
}

test("PILOT PIPELINE: sources -> raw -> evidence -> proposals -> knowledge.db, with a data-quality report", async () => {
  const repo = fixtureRepo();
  const net = network();
  const dbPath = path.join(repo, "data/normalized/pilot/knowledge.db");
  const { summary, report } = await runPilot({
    repoRoot: repo,
    dbPath,
    rawRoot: path.join(repo, "data/raw"),
    outDir: path.dirname(dbPath),
    fetchImpl: net.fetchImpl,
    wait: noWait,
    minIntervalMs: 0,
    seedsFile: path.join(repo, "cfg/seeds.json"),
    officialFile: path.join(repo, "cfg/official.json"),
    regionFile: DEFAULTS.region,
    search: { configured: false },
    policy: { auto_publish: { attribute: true, facet: true, ingredient: true, relation: true } }, // mechanics under test; the default policy is tested below
  });

  // sources
  assert.equal(summary.wikipedia.fetched, 2);
  assert.deepEqual(summary.wikipedia.skipped.map((s) => s.title), ["Không có bài"]);
  assert.equal(summary.osm.available, 4);
  assert.equal(summary.osm.selected, 3); // the unnamed element is not a merchant
  assert.equal(summary.osm.duplicates_flagged, 1); // "Quán Một" twice, 15 m apart: flagged, not merged
  assert.equal(summary.official[0].products, 3);
  assert.equal(summary.official[0].prices, 3);
  assert.match(summary.queries.search_provider, /not_configured/);
  assert.ok(!net.calls.some((c) => c.url.includes("google.")), "no search engine page was requested");
  assert.ok(!net.calls.some((c) => /\/w\/|\/api\/rest/.test(c.url) && c.url.includes("wikipedia")), "only /wiki/ pages");

  // the data-quality report
  assert.equal(report.merchant_count, 4); // Quán Một ×2 (flagged), Cà Phê Hai, Quán Mẫu
  assert.equal(report.food_entity_count, 2);
  assert.equal(report.product_count, 3);
  assert.equal(report.price_count, 3);
  assert.equal(report.rating_count, 0);
  assert.equal(report.duplicate_candidates, 1);
  assert.equal(report.attributes_without_evidence, 0);
  assert.equal(report.missing_price, 0);
  assert.equal(report.products_without_food_link, 2); // the "đặc biệt" variant waits for review; trà đá is not a known food
  assert.equal(report.links_published, 1);
  assert.equal(report.links_in_review, 1);

  const db = new Database(dbPath, { readonly: true });
  try {
    // provenance: every published fact points at verified evidence in a stored raw file
    const rows = db
      .prepare(
        `SELECT s.raw_path, e.verification FROM kb_evidence e JOIN kb_sources s ON s.id = e.source_id
         WHERE e.id IN (SELECT evidence_id FROM kb_claims WHERE status = 'published' UNION SELECT evidence_id FROM kb_merchant_claims WHERE status = 'published'
                        UNION SELECT evidence_id FROM kb_product_prices WHERE status = 'published' UNION SELECT evidence_id FROM kb_merchant_locations WHERE status = 'published')`
      )
      .all();
    assert.ok(rows.length > 10);
    for (const r of rows) {
      assert.equal(r.verification, "verified");
      assert.ok(fs.existsSync(path.join(repo, r.raw_path)), r.raw_path);
    }
    // food facts came from the text, attributed to the right dish
    const claims = db.prepare(`SELECT entity_key, kind, key, value, level FROM kb_published_claims ORDER BY entity_key, key`).all().map((c) => `${c.entity_key} ${c.kind}:${c.key}=${c.value ?? c.level}`);
    for (const c of ["bun-cha-ca attribute:temperature.serving=hot", "bun-cha-ca facet:dish_form=soup_dish", "bun-cha-ca facet:meal_period=breakfast", "bun-cha-ca relation:regional_specialty=vn.khanh-hoa.nha-trang", "banh-can facet:dough_base=rice_flour", "banh-can attribute:temperature.serving=hot", "banh-can facet:preparation=grill"]) {
      assert.ok(claims.includes(c), `${c}\n${claims.join("\n")}`);
    }
    assert.ok(!claims.some((c) => c.startsWith("bun-cha-ca") && c.includes("dough_base")), "no cross-dish leakage");
    assert.ok(!claims.includes("bun-cha-ca facet:preparation=fry"), "a component's preparation is not the dish's");
    assert.ok(!claims.some((c) => c.includes("texture.thick")), "đặc sản is not a texture");
    // the alias stated in the text
    assert.ok(db.prepare(`SELECT 1 FROM kb_published_names WHERE entity_key = 'banh-can' AND name = 'bánh căn Phan Rang'`).get());
    // merchant facts with provenance; hours without days stay unstructured
    const hours = db.prepare(`SELECT original_text, value_json FROM kb_merchant_claims WHERE field = 'opening_hours' ORDER BY id`).all();
    assert.deepEqual(hours.map((h) => h.original_text), ["Mo-Su 06:00-10:00", "06:00–10:00"]);
    assert.equal(hours[1].value_json, null);
    // OSM rows carry the license
    assert.equal(db.prepare(`SELECT license FROM kb_sources WHERE source_type = 'osm'`).get().license, "ODbL-1.0");
    // discovery never bridges to the ordering platform by itself
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_merchant_links`).get().n, 0);
  } finally {
    db.close();
  }
  for (const f of ["queries.json", "pilot-summary.json", "data-quality.json"]) assert.ok(fs.existsSync(path.join(path.dirname(dbPath), f)), f);
});

test("PILOT PIPELINE: the default extraction policy sends sensory attributes found by scanning prose to review", async () => {
  const repo = fixtureRepo();
  const dbPath = path.join(repo, "data/normalized/pilot/knowledge.db");
  await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), fetchImpl: network().fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), search: { configured: false } });
  const db = new Database(dbPath, { readonly: true });
  try {
    const byKind = db.prepare(`SELECT kind, status, COUNT(*) AS n FROM kb_claims GROUP BY kind, status`).all();
    assert.ok(!byKind.some((r) => r.kind === "attribute" && r.status === "published"), JSON.stringify(byKind));
    assert.ok(byKind.some((r) => r.kind === "attribute" && r.status === "review"));
    // each fixture fact is stated in ONE sentence only: under the default policy that is review, not publish
    assert.ok(!byKind.some((r) => ["facet", "ingredient"].includes(r.kind) && r.status === "published"), JSON.stringify(byKind));
    assert.ok(byKind.some((r) => r.kind === "facet" && r.status === "review"));
    assert.ok(byKind.some((r) => r.kind === "relation" && r.status === "published"));
    const reason = db.prepare(`SELECT review_reason FROM kb_claims WHERE kind = 'attribute' LIMIT 1`).get().review_reason;
    assert.match(reason, /DERIVED_BY_RULE/);
  } finally {
    db.close();
  }
});

test("PILOT PIPELINE: re-running over the same sources duplicates nothing", async () => {
  const repo = fixtureRepo();
  const dbPath = path.join(repo, "data/normalized/pilot/knowledge.db");
  const opts = { repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), outDir: path.dirname(dbPath), wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), search: { configured: false } };
  const first = await runPilot({ ...opts, fetchImpl: network().fetchImpl });
  const second = await runPilot({ ...opts, fetchImpl: network().fetchImpl });
  for (const k of ["merchant_count", "food_entity_count", "product_count", "price_count", "menu_count", "duplicate_candidates", "links_published", "food_claims_published"]) {
    assert.equal(second.report[k], first.report[k], k);
  }
});

test("PILOT PIPELINE: OSM data can come from an operator-supplied Overpass export (stored as raw, ODbL provenance)", async () => {
  const repo = fixtureRepo();
  const exportFile = path.join(repo, "cfg/overpass-export.json");
  fs.writeFileSync(exportFile, JSON.stringify({ elements: [{ type: "node", id: 77, lat: 12.24, lon: 109.19, tags: { amenity: "restaurant", name: "Quán Từ File", cuisine: "seafood" } }] }));
  const net = network();
  const dbPath = path.join(repo, "data/normalized/pilot/knowledge.db");
  const { summary } = await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), fetchImpl: net.fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), search: { configured: false }, osmFile: exportFile, osmUrl: "https://overpass.example/export", osmFetchedAt: "2026-09-25T00:00:00Z" });
  assert.equal(summary.osm.selected, 1);
  assert.ok(!net.calls.some((c) => c.url.includes("overpass")), "no live Overpass call");
  const db = new Database(dbPath, { readonly: true });
  try {
    const src = db.prepare(`SELECT * FROM kb_sources WHERE source_type = 'osm'`).get();
    assert.equal(src.license, "ODbL-1.0");
    assert.ok(fs.existsSync(path.join(repo, src.raw_path)));
    assert.equal(db.prepare(`SELECT name FROM kb_merchants WHERE name = 'Quán Từ File'`).get().name, "Quán Từ File");
  } finally {
    db.close();
  }
});

test("PILOT PIPELINE: a redirect to a non-food article creates no entity; a same-dish redirect adds the alias", async () => {
  const repo = fixtureRepo();
  fs.writeFileSync(path.join(repo, "cfg/seeds.json"), JSON.stringify({ wikipedia_base: WIKI, license: "CC BY-SA 4.0", attribution: "x", titles: ["Sinh tố", "Chả giò"] }));
  const net = fakeNetwork({
    "https://vi.wikipedia.org/robots.txt": { body: "User-agent: *\nDisallow: /w/" },
    [articleUrl(WIKI, "Sinh tố")]: { finalUrl: articleUrl(WIKI, "Vitamin"), body: article("Vitamin", ["Vitamin hay sinh tố là một hợp chất hữu cơ cần cho cơ thể."]) },
    [articleUrl(WIKI, "Chả giò")]: { finalUrl: articleUrl(WIKI, "Nem rán"), body: article("Nem rán", ["Nem rán hay chả giò là một món ăn Việt Nam, được chiên giòn."]) },
    "https://quan-mau.example/robots.txt": { status: 404, body: "" },
    "https://quan-mau.example/": { body: "<p>Quán Mẫu</p>" },
  });
  const dbPath = path.join(repo, "data/normalized/pilot/knowledge.db");
  const { summary } = await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), fetchImpl: net.fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), search: { configured: false }, osmFile: path.join(repo, "cfg/snapshot.json") });
  assert.deepEqual(Object.keys(summary.wikipedia.entities), ["nem-ran"]);
  assert.ok(summary.wikipedia.skipped.some((s) => s.title === "Sinh tố" && s.reason === "NOT_A_FOOD_ARTICLE"));
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.ok(db.prepare(`SELECT 1 FROM kb_published_names WHERE entity_key = 'nem-ran' AND name = 'Chả giò'`).get());
  } finally {
    db.close();
  }
});
