import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

// Collector DB (working copy the pipeline writes)  ->  runtime DB (what the platform reads).
// A promotion is an explicit, verified snapshot:
//   1. the source passes PRAGMA integrity_check and has the knowledge schema;
//   2. a consistent copy is taken with SQLite's online backup API (WAL included) into <to>.tmp;
//   3. the copy is checked again (integrity + identical published counts);
//   4. the current runtime DB, if any, is kept as a timestamped backup; then <to>.tmp replaces <to>;
//   5. <to>.manifest.json records source, time, sha256 and counts.
// The source is only read. Nothing is deleted.

const COUNTS = {
  foods: `SELECT COUNT(*) AS n FROM kb_food_entities WHERE status = 'published'`,
  foodNames: `SELECT COUNT(*) AS n FROM kb_food_names WHERE status = 'published'`,
  merchants: `SELECT COUNT(*) AS n FROM kb_merchants WHERE status IN ('candidate', 'verified')`,
  products: `SELECT COUNT(*) AS n FROM kb_merchant_products WHERE status = 'published'`,
  prices: `SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`,
  links: `SELECT COUNT(*) AS n FROM kb_food_product_links WHERE status = 'published'`,
  regions: `SELECT COUNT(*) AS n FROM kb_regions`,
  sources: `SELECT COUNT(*) AS n FROM kb_sources`,
};

export function knowledgeCounts(db) {
  return Object.fromEntries(Object.entries(COUNTS).map(([k, sql]) => [k, db.prepare(sql).get().n]));
}

function check(db, label) {
  const ok = db.pragma("integrity_check", { simple: true });
  if (ok !== "ok") throw new Error(`${label}: integrity_check failed (${ok})`);
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
  for (const t of ["kb_food_entities", "kb_merchants", "kb_merchant_products", "kb_regions"]) {
    if (!tables.has(t)) throw new Error(`${label}: missing table ${t}`);
  }
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * @param {{from: string, to: string, backupDir?: string}} opts
 * @returns {Promise<object>} the manifest
 */
export async function promoteKnowledge({ from, to, backupDir = path.join(path.dirname(to), "backups") }) {
  if (path.resolve(from) === path.resolve(to)) throw new Error("source and runtime DB are the same file");
  if (!fs.existsSync(from)) throw new Error(`source DB not found: ${from}`);
  const src = new Database(from, { readonly: true, fileMustExist: true });
  let counts;
  const tmp = `${to}.tmp`;
  try {
    check(src, "source");
    counts = knowledgeCounts(src);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(tmp, { force: true });
    await src.backup(tmp);
  } finally {
    src.close();
  }
  const rawIngestTables = scrubRuntimeCopy(tmp);
  const copy = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    check(copy, "copy");
    const left = copy.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'kb_ingest%' OR name = 'kb_contribution_visible'`).all();
    if (left.length) throw new Error(`copy still holds raw ingestion data: ${left.map((r) => r.name).join(", ")}`);
    const copied = knowledgeCounts(copy);
    if (JSON.stringify(copied) !== JSON.stringify(counts)) throw new Error(`copy differs from source: ${JSON.stringify({ counts, copied })}`);
  } finally {
    copy.close();
  }
  let previous = null;
  if (fs.existsSync(to)) {
    fs.mkdirSync(backupDir, { recursive: true });
    previous = path.join(backupDir, `knowledge-runtime-${stamp()}.db`);
    fs.copyFileSync(to, previous);
  }
  try {
    fs.renameSync(tmp, to);
  } catch (err) {
    throw new Error(`could not replace ${to} (${err.code ?? err.message}) — is the platform holding it open? Promote before (re)starting it.`);
  }
  const manifest = { promotedAt: new Date().toISOString(), source: path.resolve(from), runtime: path.resolve(to), sha256: sha256(to), bytes: fs.statSync(to).size, counts, previousBackup: previous, rawIngestTables: 0, scrubbedIngestTables: rawIngestTables.dropped, scrubbedContributionSources: rawIngestTables.sources };
  fs.writeFileSync(`${to}.manifest.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * The runtime snapshot carries PUBLISHED knowledge only. Raw ingestion evidence (Knowledge Group messages, customer
 * contributions: senders, hashes, updates, jobs, readings, candidates) stays in the working DB: every kb_ingest_*
 * table and the contribution view are dropped from the COPY, customer source URLs (which hold a chat hash) are
 * replaced by a neutral label, and the copy is VACUUMed so no deleted page keeps the bytes. The source DB is never touched.
 * @returns {{dropped: string[], sources: number}}
 */
export function scrubRuntimeCopy(file) {
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = OFF");
    const names = db.prepare(`SELECT type, name FROM sqlite_master WHERE (type = 'table' AND name LIKE 'kb_ingest%') OR (type = 'view' AND name = 'kb_contribution_visible')`).all();
    let sources = 0;
    db.transaction(() => {
      for (const v of names.filter((n) => n.type === "view")) db.exec(`DROP VIEW "${v.name}"`);
      for (const t of names.filter((n) => n.type === "table")) db.exec(`DROP TABLE "${t.name}"`);
      const hasSources = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kb_sources'`).get();
      if (hasSources) {
        sources = db
          .prepare(`UPDATE kb_sources SET url = 'food://khach-hang-cung-cap/' || id, domain = 'khach-hang-cung-cap', raw_path = '(working-db)' WHERE source_type = 'user_contribution'`)
          .run().changes;
      }
    })();
    db.exec("VACUUM");
    db.pragma("journal_mode = DELETE"); // self-contained file: nothing of the scrub left in a -wal beside it
    return { dropped: names.map((n) => n.name).sort(), sources };
  } finally {
    db.close();
  }
}
