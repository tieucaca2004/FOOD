import path from "node:path";
import { runPilot, openKnowledge, DEFAULTS } from "./pipeline.js";
import { dataQualityReport } from "./lib/report.js";
import { loadRegion, generateQueries } from "./lib/queryGenerator.js";

// Offline knowledge collector. Never touches the platform DB.
//   node tools/knowledge-collector/cli.js pilot   [--db <path>] [--osm 50] [--wiki N]
//        [--osm-file <overpass-export.json> --osm-url <query url> --osm-fetched-at <ISO>]   (OSM data obtained elsewhere)
//        [--no-articles | --articles <article-sources.json> --articles-limit N]
//        [--inventory [--families <source-families.json>]]   walk permitted sites' listing pages for more articles
//        [--reuse-days N]   serve pages stored within N days from data/raw instead of fetching again
//   node tools/knowledge-collector/cli.js report  [--db <path>]
//   node tools/knowledge-collector/cli.js coverage [--db <path>]   (current discovered coverage, JSON)
//   node tools/knowledge-collector/cli.js queries
//   node tools/knowledge-collector/cli.js review  [--db <path>]
//   node tools/knowledge-collector/cli.js promote [--db <collector db>] [--to data/knowledge/knowledge.db]   (verified snapshot for the platform)
//   node tools/knowledge-collector/cli.js bridge <kbMerchantId> <platformMerchantId> --by <person>   (a person's decision)
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repoRoot = process.cwd();
const dbPath = flag("db", process.env.KNOWLEDGE_SQLITE_PATH || "data/normalized/pilot/knowledge.db");
const rawRoot = flag("raw", "data/raw");

switch (args[0]) {
  case "promote": {
    // collector DB -> runtime DB read by the platform (platformConfig.knowledgeDbPath); verified snapshot + manifest
    const { promoteKnowledge } = await import("./lib/promote.js");
    const to = flag("to", "data/knowledge/knowledge.db");
    console.log(JSON.stringify(await promoteKnowledge({ from: dbPath, to }), null, 2));
    break;
  }
  case "pilot": {
    const { summary, report } = await runPilot({
      repoRoot,
      dbPath,
      rawRoot,
      outDir: path.dirname(dbPath),
      osmLimit: Number(flag("osm", 50)),
      osmFile: flag("osm-file"),
      skipOsm: args.includes("--no-osm"),
      osmUrl: flag("osm-url"),
      osmFetchedAt: flag("osm-fetched-at"),
      wikiLimit: flag("wiki") ? Number(flag("wiki")) : undefined,
      articlesFile: args.includes("--no-articles") ? null : flag("articles", DEFAULTS.articles),
      articlesLimit: flag("articles-limit") ? Number(flag("articles-limit")) : undefined,
      familiesFile: args.includes("--inventory") ? flag("families", DEFAULTS.families) : undefined,
      reuseWithinDays: Number(flag("reuse-days", 0)),
      placesFile: args.includes("--places") ? flag("places-config", DEFAULTS.places) : undefined,
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify({ summary: { ...summary, facts: `${Object.keys(summary.facts).length} entities` }, report }, null, 2));
    break;
  }
  case "report": {
    const { db } = openKnowledge({ dbPath, repoRoot });
    console.log(JSON.stringify(dataQualityReport(db), null, 2));
    db.close();
    break;
  }
  case "queries": {
    const queries = generateQueries(loadRegion(DEFAULTS.region));
    for (const q of queries) console.log(`${q.group}\t${q.text}`);
    break;
  }
  case "review": {
    const { db, knowledge } = openKnowledge({ dbPath, repoRoot });
    const r = knowledge.listReview();
    const links = db.prepare(`SELECT COUNT(*) AS n FROM kb_food_product_links WHERE status = 'review'`).get().n;
    console.log(JSON.stringify({ entities: r.entities.length, names: r.names.length, claims: r.claims.length, links, duplicate_candidates: db.prepare(`SELECT COUNT(*) AS n FROM kb_duplicate_candidates WHERE status = 'pending'`).get().n, food_duplicate_candidates: r.foodDuplicates.length }, null, 2));
    db.close();
    break;
  }
  case "bridge": {
    const by = flag("by");
    if (!args[1] || !args[2] || !by) throw new Error("usage: bridge <kbMerchantId> <platformMerchantId> --by <person>");
    const { db, discovery } = openKnowledge({ dbPath, repoRoot });
    console.log(discovery.bridgeMerchant({ kbMerchantId: Number(args[1]), platformMerchantId: args[2], linkedBy: by }));
    db.close();
    break;
  }
  case "coverage": {
    const { coverageReport, crawlLogStats } = await import("./lib/coverage.js");
    const fs = await import("node:fs");
    const { db } = openKnowledge({ dbPath, repoRoot });
    const judgements = path.join(path.dirname(dbPath), "quality-judgements.json");
    const quality = fs.existsSync(judgements) ? JSON.parse(fs.readFileSync(judgements, "utf8")) : null;
    console.log(JSON.stringify(coverageReport(db, { crawl: crawlLogStats(path.join(rawRoot, "_crawl-log.jsonl"), fs), quality }), null, 2));
    db.close();
    break;
  }
  case "matrix": {
    const { coverageMatrix } = await import("./lib/matrix.js");
    const { db } = openKnowledge({ dbPath, repoRoot });
    console.log(JSON.stringify(coverageMatrix(db, { region: loadRegion(DEFAULTS.region) }), null, 2));
    db.close();
    break;
  }
  case "promote-dishes": {
    // a dish entity in review whose ONLY evidence is places naming it is published when at least
    // --min-domains independent sites and --min-places different places name it as their own dish
    // (listing heading / menu line). Dry run unless --apply; recorded as a rule decision, reversible.
    const minDomains = Number(flag("min-domains", 2));
    const minPlaces = Number(flag("min-places", 5));
    const apply = args.includes("--apply");
    const { db, knowledge, discovery } = openKnowledge({ dbPath, repoRoot });
    const rows = db.prepare(`SELECT id, key, canonical_name, normalized_name FROM kb_food_entities WHERE status = 'review'`).all();
    const evidenceOf = db.prepare(
      `SELECT COUNT(DISTINCT s.domain) AS domains, COUNT(DISTINCT p.merchant_id) AS places FROM kb_merchant_products p JOIN kb_evidence e ON e.id = p.evidence_id
       JOIN kb_sources s ON s.id = e.source_id JOIN kb_merchants m ON m.id = p.merchant_id
       WHERE p.status = 'published' AND m.status IN ('candidate', 'verified') AND p.normalized_name = ?`
    );
    const out = [];
    for (const r of rows) {
      const ev = evidenceOf.get(r.normalized_name);
      if (ev.domains < minDomains || ev.places < minPlaces) continue;
      const item = { entity: r.canonical_name, domains: ev.domains, places: ev.places, published: false, links: 0 };
      if (apply) {
        const decidedBy = `rule:dish-named-by-places(>=${minDomains} domains, >=${minPlaces} places)`;
        knowledge.resolveReview({ type: "entity", id: r.id, approve: true, decidedBy, note: `${ev.places} places on ${ev.domains} independent sites name it as their dish` });
        item.published = knowledge.entity(r.key)?.status === "published";
        if (item.published) {
          for (const p of db.prepare(`SELECT id FROM kb_merchant_products WHERE status = 'published' AND normalized_name = ?`).all(r.normalized_name)) {
            const l = discovery.proposeFoodProductLink({ foodKey: r.key, kbProductId: p.id, matchType: "exact" });
            if (l.outcome === "published" && !l.reasons.some((x) => x.code === "ALREADY_EXISTS")) item.links += 1;
          }
        }
      }
      out.push(item);
    }
    console.log(JSON.stringify({ apply, minDomains, minPlaces, promoted: out }, null, 2));
    db.close();
    break;
  }
  case "audit": {
    // data-quality audit; --fix marks what a rule can judge (never deletes) after a timestamped backup
    const { auditKnowledge } = await import("./lib/audit.js");
    const fs = await import("node:fs");
    const fix = args.includes("--fix");
    const { db, knowledge } = openKnowledge({ dbPath, repoRoot });
    if (fix) {
      const dir = path.join(path.dirname(path.dirname(dbPath)), "backups");
      fs.mkdirSync(dir, { recursive: true });
      await db.backup(path.join(dir, `knowledge-pre-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.db`));
    }
    const policy = JSON.parse(fs.readFileSync(DEFAULTS.policy, "utf8"));
    const report = db.transaction(() => auditKnowledge({ db, knowledge, fix, show: Number(flag("show", 8)), policy }))();
    fs.writeFileSync(path.join(path.dirname(dbPath), "audit-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    db.close();
    break;
  }
  case "sample": {
    // random sample of published data, provenance re-verified; written next to the DB for a person to judge
    const { sampleQuality } = await import("./lib/quality.js");
    const fs = await import("node:fs");
    const { db, knowledge } = openKnowledge({ dbPath, repoRoot });
    const s = sampleQuality({ db, knowledge });
    fs.writeFileSync(path.join(path.dirname(dbPath), "quality-sample.json"), JSON.stringify(s, null, 2));
    console.log(JSON.stringify(s.summary, null, 2));
    db.close();
    break;
  }
  default:
    console.log("usage: pilot | report | coverage | matrix | audit [--fix] | sample | queries | review | bridge");
}
