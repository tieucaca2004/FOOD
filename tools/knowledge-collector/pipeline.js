import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../platform/knowledge/db.js";
import { KnowledgeStore } from "../../platform/knowledge/store.js";
import { MerchantDiscoveryStore } from "../../platform/knowledge/discoveryStore.js";
import { RawFetcher } from "./lib/fetcher.js";
import { loadRegion, generateQueries } from "./lib/queryGenerator.js";
import { GoogleProgrammableSearch } from "./lib/searchProviders.js";
import { dataQualityReport } from "./lib/report.js";
import { buildOverpassQuery, selectPilot, importOsm, OVERPASS_ENDPOINT, OSM_LICENSE, OSM_ATTRIBUTION } from "./sources/osm.js";
import { articleUrl, parseArticle, proposeEntityFromArticle, proposeFactsFromSentences, entityKeyFor, categoryTitles } from "./sources/wikipedia.js";
import { importListicle } from "./sources/listicle.js";
import { discoverFamily } from "./sources/inventory.js";
import { GooglePlacesSearch, importPlaces, placesQueries, PLACES_ENDPOINT, PLACES_ATTRIBUTION } from "./sources/googlePlaces.js";
import { proposeNameStructure } from "./extract/foodStructure.js";
import { importOfficialMerchant } from "./sources/officialMenu.js";
import { linkAll } from "./extract/foodLinker.js";
import { normalizeName } from "../../platform/knowledge/text.js";

// Search Query -> Source Discovery -> Fetch -> Raw Snapshot -> Extract ->
// Normalize -> Evidence -> Proposal -> (validator) Review/Publish -> knowledge.db
// Offline. Writes ONLY to the given knowledge.db, data/raw and the output dir.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = {
  region: path.join(HERE, "config/regions/nha-trang.json"),
  seeds: path.join(HERE, "config/food-seeds.vi.json"),
  official: path.join(HERE, "config/official-merchants.json"),
  policy: path.join(HERE, "config/extraction-policy.json"),
  culinaryRegions: path.join(HERE, "config/regions/culinary-regions.json"),
  articles: path.join(HERE, "config/article-sources.json"),
  families: path.join(HERE, "config/source-families.json"),
  places: path.join(HERE, "config/places-categories.json"),
};

/** Seed titles: a flat "titles" list, or every name of every group (in order, once). */
export function seedTitles(seeds) {
  return [...new Set(seeds.titles ?? Object.values(seeds.groups ?? {}).flat())];
}

const MAX_SOURCE_ATTEMPTS = 3;

/** Sources that failed (network / extraction errors), retried on later runs up to MAX_SOURCE_ATTEMPTS. */
export function failedQueue(outDir) {
  const file = outDir ? path.join(outDir, "failed-sources.json") : null;
  const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return {
    state,
    exhausted: (url) => (state[url]?.attempts ?? 0) >= MAX_SOURCE_ATTEMPTS,
    record: (url, reason) => {
      state[url] = { attempts: (state[url]?.attempts ?? 0) + 1, last_reason: String(reason).slice(0, 300), last_at: new Date().toISOString() };
    },
    clear: (url) => delete state[url],
    save: () => {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    },
  };
}

/** Walks every family's listing pages; merges with the persisted inventory (nothing is forgotten). */
export async function runInventory({ fetcher, familiesFile, outDir, log = () => {} }) {
  const cfg = JSON.parse(fs.readFileSync(familiesFile, "utf8"));
  const file = outDir ? path.join(outDir, "source-inventory.json") : null;
  const known = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { articles: [] };
  const byUrl = new Map(known.articles.map((a) => [a.url, a]));
  const summary = {};
  for (const family of cfg.families) {
    const r = await discoverFamily({ fetcher, family, log });
    let added = 0;
    for (const a of r.articles) {
      if (!byUrl.has(a.url)) {
        byUrl.set(a.url, { ...a, discovered_at: new Date().toISOString() });
        added += 1;
      }
    }
    summary[family.id] = { listed: r.articles.length, new: added, food: r.articles.filter((a) => a.food).length, listing_failures: r.failures.length };
  }
  const articles = [...byUrl.values()];
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ updated_at: new Date().toISOString(), articles }, null, 2));
  }
  return { articles, summary };
}

function addCounts(into, stats) {
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
    else if (Array.isArray(v)) into[k] = (into[k] ?? 0) + v.length;
    else if (v && typeof v === "object") addCounts((into[k] ??= {}), v);
  }
}

/** Which seed dishes have an entity now (published / review) and which are unresolved. */
export function seedResolution(db, seeds) {
  const groups = seeds.groups ?? { all: seeds.titles ?? [] };
  const byName = db.prepare(`SELECT e.key, e.status FROM kb_food_names n JOIN kb_food_entities e ON e.id = n.entity_id WHERE n.normalized = ? AND n.status != 'rejected' AND e.status IN ('published', 'review') ORDER BY e.status = 'published' DESC LIMIT 1`);
  const byKey = db.prepare(`SELECT key, status FROM kb_food_entities WHERE key = ? AND status IN ('published', 'review')`);
  const out = {};
  for (const [group, names] of Object.entries(groups)) {
    const g = (out[group] = { published: [], review: [], unresolved: [] });
    for (const n of names) {
      const hit = byName.get(normalizeName(n)) ?? byKey.get(entityKeyFor(n));
      (hit ? g[hit.status] : g.unresolved).push(hit && hit.key !== entityKeyFor(n) ? `${n} -> ${hit.key}` : n);
    }
  }
  return out;
}

export function openKnowledge({ dbPath, repoRoot }) {
  const db = createKnowledgeConnection(dbPath);
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot: repoRoot });
  return { db, knowledge, discovery: new MerchantDiscoveryStore({ knowledge }) };
}

/**
 * @param {object} o {repoRoot, dbPath, rawRoot, outDir, fetchImpl?, osmLimit?, wikiLimit?, log?, search?}
 */
export async function runPilot(o) {
  const log = o.log ?? (() => {});
  const region = loadRegion(o.regionFile ?? DEFAULTS.region);
  const seeds = JSON.parse(fs.readFileSync(o.seedsFile ?? DEFAULTS.seeds, "utf8"));
  const official = JSON.parse(fs.readFileSync(o.officialFile ?? DEFAULTS.official, "utf8"));
  const policy = o.policy ?? JSON.parse(fs.readFileSync(o.policyFile ?? DEFAULTS.policy, "utf8"));
  const { db, knowledge, discovery } = openKnowledge(o);
  const fetcher = new RawFetcher({ rawRoot: o.rawRoot, repoRoot: o.repoRoot, fetchImpl: o.fetchImpl, minIntervalMs: o.minIntervalMs ?? 2000, wait: o.wait, reuseWithinDays: o.reuseWithinDays ?? 0 });
  const culinary = JSON.parse(fs.readFileSync(o.culinaryRegionsFile ?? DEFAULTS.culinaryRegions, "utf8")).regions;
  const summary = { wikipedia: { fetched: 0, skipped: [], entities: {} }, facts: {}, structure: null, osm: null, official: [], articles: null, links: null, seeds: null, queries: null };
  for (const r of region.regions) knowledge.registerRegion(r);
  // regions a DISH can be named after / come from (never a merchant location)
  for (const r of culinary) if (!region.regions.some((x) => x.id === r.id)) knowledge.registerRegion(r);
  for (const r of culinary) if (r.names?.length) knowledge.registerRegion({ ...(region.regions.find((x) => x.id === r.id) ?? r), names: r.names });
  const namedRegions = db.prepare(`SELECT id FROM kb_regions ORDER BY id`).all().map((r) => ({ id: r.id, names: knowledge.regionNames(r.id), level: db.prepare(`SELECT level FROM kb_regions WHERE id = ?`).get(r.id).level, name: knowledge.regionNames(r.id)[0] }));

  // --- A. food entities (encyclopedia) -------------------------------------------
  const articles = [];
  const titles = seedTitles(seeds);
  // titles from Wikipedia CATEGORY pages ("Thể loại:Món ăn Việt Nam"…) join the seeds — each is
  // still only a candidate: the article itself must be about a food and name it
  if (seeds.categories?.length && !(o.wikiLimit === 0)) {
    const fromCategories = await categoryTitles({ fetcher, base: seeds.wikipedia_base, categories: seeds.categories, exclude: seeds.exclude_categories ?? [], log });
    summary.wikipedia.from_categories = fromCategories.length;
    for (const t of fromCategories) if (!titles.includes(t)) titles.push(t);
  }
  const wikiList = titles.slice(0, o.wikiLimit ?? titles.length);
  for (const [i, title] of wikiList.entries()) {
    try {
      const page = await fetcher.fetch(articleUrl(seeds.wikipedia_base, title), { sourceType: "encyclopedia" });
      if (!page.ok) {
        summary.wikipedia.skipped.push({ title, reason: page.blocked, status: page.status });
        continue;
      }
      const article = parseArticle(page.content);
      if (!article) {
        summary.wikipedia.skipped.push({ title, reason: "not_an_article" });
        continue;
      }
      summary.wikipedia.fetched += 1;
      const source = knowledge.registerSource({ url: page.finalUrl, sourceType: "encyclopedia", rawPath: page.rawPath, contentType: page.contentType, fetchedAt: page.fetchedAt, license: seeds.license, attribution: seeds.attribution, robotsAllowed: true });
      const r = proposeEntityFromArticle({ knowledge, source, article, requestedTitle: title });
      if (r.outcome === "skipped") {
        summary.wikipedia.skipped.push({ title, reason: r.reasons[0].code, article: article.title });
        continue;
      }
      summary.wikipedia.entities[r.key] = r.outcome;
      articles.push({ source, key: r.key, sentences: r.sentences });
      log(`wikipedia ${i + 1}/${wikiList.length} ${title}: ${r.outcome}${page.cached ? " (stored snapshot)" : ""}`);
    } catch (err) {
      // one bad article never stops the collection
      summary.wikipedia.skipped.push({ title, reason: "error", error: err.message });
      log(`wikipedia ${title}: FAILED ${err.message}`);
    }
  }
  const namesByEntity = new Map();
  for (const row of db.prepare(`SELECT e.key, n.name FROM kb_food_entities e JOIN kb_food_names n ON n.entity_id = e.id AND n.status = 'published' WHERE e.status = 'published'`).all()) {
    (namesByEntity.get(row.key) ?? namesByEntity.set(row.key, []).get(row.key)).push(row.name);
  }
  for (const a of articles) {
    try {
      summary.facts[a.key] = proposeFactsFromSentences({ knowledge, source: a.source, entityKey: a.key, sentences: a.sentences, namesByEntity, regions: namedRegions.filter((r) => r.level !== "country"), originRegions: namedRegions, policy });
    } catch (err) {
      summary.facts[a.key] = { error: err.message };
    }
  }

  // --- B. merchants (OpenStreetMap) ------------------------------------------------
  // Live Overpass query, or an Overpass JSON export supplied by the operator
  // (o.osmFile) — stored byte-for-byte as raw data, same ODbL provenance.
  let osmPage;
  if (o.skipOsm) {
    osmPage = { ok: false, blocked: "disabled_by_operator" };
  } else if (o.osmFile) {
    const bytes = fs.readFileSync(o.osmFile);
    const fetchedAt = o.osmFetchedAt ?? new Date().toISOString();
    const stored = fetcher.store({ content: bytes, sourceType: "osm", url: o.osmUrl ?? OVERPASS_ENDPOINT, contentType: "application/json", fetchedAt, note: `Overpass export supplied by the operator: ${path.basename(o.osmFile)}` });
    osmPage = { ok: true, content: bytes.toString("utf8"), fetchedAt, ...stored };
  } else {
    osmPage = await fetcher.fetch(OVERPASS_ENDPOINT, { sourceType: "osm", method: "POST", body: `data=${encodeURIComponent(buildOverpassQuery(region.bbox))}`, contentType: "application/x-www-form-urlencoded", accept: "application/json", timeoutMs: 180000 });
  }
  if (osmPage.ok) {
    const osmSource = knowledge.registerSource({ url: `${o.osmUrl ?? OVERPASS_ENDPOINT}#bbox=${Object.values(region.bbox).join(",")}`, sourceType: "osm", rawPath: osmPage.rawPath, contentType: "application/json", fetchedAt: osmPage.fetchedAt, license: OSM_LICENSE, attribution: OSM_ATTRIBUTION, robotsAllowed: o.osmFile ? null : true });
    const elements = JSON.parse(osmPage.content).elements ?? [];
    const selection = selectPilot(elements, o.osmLimit ?? 50);
    const stats = importOsm({ discovery, source: osmSource, elements, selection, regionId: region.id });
    summary.osm = { available: elements.length, selected: selection.length, merchants_created: stats.merchants, locations: stats.locations, claims: stats.claims, duplicates_flagged: stats.results.filter((r) => r.action === "created_with_duplicate_candidate").length };
  } else {
    summary.osm = { skipped: osmPage.blocked, status: osmPage.status };
  }

  // --- C. official merchant sites + menus ---------------------------------------------
  for (const cfg of official.merchants) {
    const r = await importOfficialMerchant({ knowledge, discovery, fetcher, config: cfg, repoRoot: o.repoRoot });
    summary.official.push({ homepage: cfg.homepage, merchant: r.merchant?.merchantId ?? null, action: r.merchant?.action ?? null, products: r.products, prices: r.prices, skipped: r.skipped });
  }

  // --- C2. "top quán" articles on permitted sites -> places, addresses, hours, dish mentions
  if (o.articlesFile) {
    const cfg = JSON.parse(fs.readFileSync(o.articlesFile, "utf8"));
    const accented = db
      .prepare(`SELECT e.key AS entityKey, n.name FROM kb_food_entities e JOIN kb_food_names n ON n.entity_id = e.id AND n.status = 'published' AND n.kind != 'no_accent' WHERE e.status = 'published'`)
      .all();
    // seed dishes still without an entity: a mention may be their first evidence (-> review)
    const known = new Set(db.prepare(`SELECT normalized FROM kb_food_names WHERE status != 'rejected'`).all().map((r) => r.normalized));
    const seedOnly = titles.filter((t) => !known.has(normalizeName(t)) && !db.prepare(`SELECT 1 FROM kb_food_entities WHERE key = ?`).get(entityKeyFor(t))).map((t) => ({ entityKey: entityKeyFor(t), name: t, seed: true }));
    // configured articles + food articles found by walking the permitted families' listing pages
    const inventory = o.familiesFile ? await runInventory({ fetcher, familiesFile: o.familiesFile, outDir: o.outDir, log }) : { articles: [] };
    const seen = new Set();
    const articles = [...cfg.articles, ...inventory.articles.filter((a) => a.food)].filter((a) => !seen.has(a.url) && seen.add(a.url));
    const failed = failedQueue(o.outDir);
    summary.articles = { pages: 0, blocked: [], failed: [], skipped_after_retries: 0, inventory: inventory.summary ?? null, totals: {} };
    const list = articles.slice(0, o.articlesLimit ?? articles.length);
    for (const [i, a] of list.entries()) {
      if (failed.exhausted(a.url)) {
        summary.articles.skipped_after_retries += 1;
        continue;
      }
      // one bad page never stops the collection: it is recorded and retried (bounded) next run
      try {
        const page = await fetcher.fetch(a.url, { sourceType: cfg.source_type });
        if (!page.ok) {
          summary.articles.blocked.push({ url: a.url, reason: page.blocked, status: page.status });
          if (page.blocked === "network") failed.record(a.url, page.reason ?? page.blocked);
          continue;
        }
        const source = knowledge.registerSource({ url: page.finalUrl, sourceType: cfg.source_type, rawPath: page.rawPath, contentType: page.contentType, fetchedAt: page.fetchedAt, robotsAllowed: true });
        const stats = importListicle({ knowledge, discovery, source, html: page.content, foodNames: [...accented, ...seedOnly], regionId: cfg.region_id, seenAt: page.fetchedAt, localities: cfg.other_localities ?? [] });
        summary.articles.pages += 1;
        failed.clear(a.url);
        log(`article ${i + 1}/${list.length} ${a.url}: ${stats.merchants} places${page.cached ? " (stored snapshot)" : ""}`);
        addCounts(summary.articles.totals, stats);
      } catch (err) {
        failed.record(a.url, err.message);
        summary.articles.failed.push({ url: a.url, error: err.message });
        log(`article ${a.url}: FAILED ${err.message}`);
      }
    }
    failed.save();
  }

  // --- C2b. Google Maps discovery via the OFFICIAL Places API (only with a key and --places)
  if (o.placesFile) {
    const cfg = JSON.parse(fs.readFileSync(o.placesFile, "utf8"));
    const places = o.places ?? new GooglePlacesSearch({ fetcher });
    summary.places = { provider: places.configured ? "google_places_api" : "not_configured (no GOOGLE_PLACES_API_KEY)", queries: 0, failed: [], totals: {} };
    if (places.configured) {
      for (const q of placesQueries(region, cfg.categories).slice(0, o.placesLimit ?? cfg.max_queries ?? 400)) {
        try {
          const page = await places.search(q);
          summary.places.queries += 1;
          if (!page.ok) {
            summary.places.failed.push({ query: q, reason: page.blocked, status: page.status });
            continue;
          }
          const source = knowledge.registerSource({ url: `${PLACES_ENDPOINT}#q=${encodeURIComponent(q)}`, sourceType: "maps_business", rawPath: page.rawPath, contentType: "application/json", fetchedAt: page.fetchedAt, attribution: PLACES_ATTRIBUTION, license: "Google Maps Platform Terms of Service", robotsAllowed: true });
          addCounts(summary.places.totals, importPlaces({ discovery, source, response: JSON.parse(page.content), capturedAt: page.fetchedAt, regionId: region.id, localities: region.nearby ?? [] }));
        } catch (err) {
          summary.places.failed.push({ query: q, error: err.message });
        }
      }
    }
  }

  // --- C3. name structure: regional style (review), food duplicate/variant candidates (never merged)
  summary.structure = proposeNameStructure({ knowledge, regions: namedRegions, policy });

  // --- D. food ↔ product links ---------------------------------------------------------
  summary.links = linkAll({ knowledge, discovery });

  // --- E. search-result discovery (official API only) --------------------------------------
  const merchantNames = db.prepare(`SELECT name FROM kb_merchants WHERE status IN ('candidate','verified') ORDER BY id`).all().map((r) => r.name);
  // per-dish queries for the seed dishes; "site:" queries only for the permitted article/listing domains
  const permittedSites = [...new Set([
    ...(o.articlesFile ? JSON.parse(fs.readFileSync(o.articlesFile, "utf8")).articles.map((a) => new URL(a.url).hostname.replace(/^www\./, "")) : []),
    ...(o.familiesFile ? JSON.parse(fs.readFileSync(o.familiesFile, "utf8")).families.map((f) => new URL(f.listing.url_template.replace("{n}", "1")).hostname.replace(/^www\./, "")) : []),
  ])];
  const queries = generateQueries(region, { merchantNames, dishes: seedTitles(seeds).slice(0, 250), sites: permittedSites });
  const search = o.search ?? new GoogleProgrammableSearch({ fetchImpl: o.fetchImpl });
  const searchResults = [];
  if (search.configured) {
    for (const q of queries.slice(0, o.searchLimit ?? 20)) searchResults.push({ ...q, ...(await search.search(q.text)) });
  }
  summary.queries = { generated: queries.length, by_group: queries.reduce((a, q) => ({ ...a, [q.group]: (a[q.group] ?? 0) + 1 }), {}), searched: searchResults.length, search_provider: search.configured ? "google_cse_api" : "not_configured (no GOOGLE_CSE_KEY/GOOGLE_CSE_CX)" };

  summary.seeds = seedResolution(db, seeds);
  const report = dataQualityReport(db);
  if (o.outDir) {
    fs.mkdirSync(o.outDir, { recursive: true });
    fs.writeFileSync(path.join(o.outDir, "queries.json"), JSON.stringify({ queries, searchResults }, null, 2));
    fs.writeFileSync(path.join(o.outDir, "pilot-summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(o.outDir, "data-quality.json"), JSON.stringify(report, null, 2));
  }
  db.close();
  return { summary, report };
}
