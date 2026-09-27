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

export function runKnowledgeMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kb_schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(db.prepare(`SELECT name FROM kb_schema_migrations`).all().map((r) => r.name));
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO kb_schema_migrations (name) VALUES (?)`).run(file);
    })();
  }
}
