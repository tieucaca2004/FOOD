import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Connection + migrations for the Food Knowledge DB (knowledge.db). Its own
// migrations directory and bookkeeping table: never the platform DB, never
// the platform's migration runner — a knowledge problem can never touch
// ordering data.

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export const DEFAULT_KNOWLEDGE_DB_PATH = process.env.KNOWLEDGE_SQLITE_PATH || "./data/knowledge/knowledge.db";

export function createKnowledgeConnection(dbPath = DEFAULT_KNOWLEDGE_DB_PATH) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Applies pending migrations. Guards (every CLI, the collector and the server go through here):
 *   - the RUNTIME snapshot (DEFAULT_KNOWLEDGE_DB_PATH) is replaced only by a verified promotion: migrations >= 005
 *     (ingestion / founder / contributions) are refused there unless allowRuntime or KNOWLEDGE_ALLOW_RUNTIME_MIGRATION=true;
 *   - an EXISTING file DB is backed up (VACUUM INTO, integrity-checked) before any pending migration is applied.
 * @param {import("better-sqlite3").Database} db
 * @param {{allowRuntime?: boolean, backupDir?: string|null}} [opts]
 * @returns {{applied: string[], backup: string|null}}
 */
export function runKnowledgeMigrations(db, { allowRuntime = false, backupDir = null } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS kb_schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(db.prepare(`SELECT name FROM kb_schema_migrations`).all().map((r) => r.name));
  const pending = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();
  const file = db.name && db.name !== ":memory:" && !db.memory ? path.resolve(db.name) : null;
  if (!pending.length) return { applied: [], backup: null };
  if (file && file === path.resolve(DEFAULT_KNOWLEDGE_DB_PATH) && pending.some((f) => f >= "005") && !allowRuntime && process.env.KNOWLEDGE_ALLOW_RUNTIME_MIGRATION !== "true") {
    throw new Error(`refusing to migrate the runtime knowledge DB ${file} in place (pending: ${pending.join(", ")}); promote from the working DB instead`);
  }
  let backup = null;
  if (file && applied.size) {
    const dir = backupDir ?? path.join(path.dirname(file), "backups");
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, `${path.basename(file, path.extname(file))}.pre-${pending[0].replace(/\.sql$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    const check = new Database(backup, { readonly: true });
    try {
      if (check.pragma("integrity_check", { simple: true }) !== "ok") throw new Error(`pre-migration backup ${backup} failed integrity_check`);
    } finally {
      check.close();
    }
  }
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO kb_schema_migrations (name) VALUES (?)`).run(file);
    })();
  }
  return { applied: pending, backup };
}
