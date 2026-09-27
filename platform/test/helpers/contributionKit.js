// Test kit for customer contributions: a SYNTHETIC knowledge DB (nhaTrangKnowledge) in a temp file, a temp raw root,
// the fixture images of platform/test/fixtures/multimodal and a FAKE image reader that answers with the scripted
// readings.json (by the file's sha256) — no network, no model, never the real collector or runtime DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { nhaTrangKnowledge } from "./nhaTrangKnowledge.js";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { KnowledgeStore } from "../../knowledge/store.js";
import { KnowledgeIngestion } from "../../knowledge/ingestion/ingestion.js";
import { ContributionStore } from "../../knowledge/ingestion/contributions.js";
import { ContributorHasher } from "../../knowledge/ingestion/contributorHash.js";
import { ImageUnderstandingProvider } from "../../ai/ingest/ImageUnderstandingProvider.js";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/multimodal");
export const READINGS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "readings.json"), "utf8"));
export const TEST_HASH_KEY = "test-only-contributor-hash-key-0123456789abcdef";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

/** Scripted reader: the reading of a fixture image, found by the image's sha256. Records every call. */
export class FixtureImageUnderstanding extends ImageUnderstandingProvider {
  constructor({ fail = null, delayMs = 0 } = {}) {
    super({ name: "fixture", model: "readings.json" });
    this.bySha = new Map(Object.entries(READINGS).filter(([k]) => !k.startsWith("_")).map(([file, r]) => [sha(fixture(file)), r]));
    this.calls = 0;
    this.fail = fail; // (count) => Error | null
    this.delayMs = delayMs;
  }

  async _analyze({ buffer }) {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const err = this.fail?.(this.calls);
    if (err) throw err;
    return this.bySha.get(sha(buffer)) ?? { document_type: "UNKNOWN", text: "", items: [], observations: [], food_guess: [] };
  }
}

/** fileId = a fixture file name; the claimed MIME is what a chat platform would say. */
export function fixtureFetcher({ fail = null } = {}) {
  const calls = [];
  const fetchMedia = async (fileId) => {
    calls.push(fileId);
    const err = fail?.(fileId);
    if (err) throw err;
    const file = path.join(FIXTURES, fileId);
    if (!fs.existsSync(file)) throw new Error("download failed (HTTP 404)");
    return { buffer: fs.readFileSync(file), mimeType: fileId.endsWith(".png") ? "image/png" : "image/jpeg", filename: fileId };
  };
  fetchMedia.calls = calls;
  return fetchMedia;
}

export function contributionKit({ reader = new FixtureImageUnderstanding(), fetchMedia = fixtureFetcher(), now = () => new Date("2026-09-27T09:00:00Z"), imageLimits, extra = null } = {}) {
  const file = nhaTrangKnowledge();
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  extra?.(db);
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-contrib-raw-"));
  const readers = reader ? reader.asReaders() : { ocr: null, vision: null };
  const logs = [];
  const ingestion = new KnowledgeIngestion({ db, knowledge: new KnowledgeStore({ db, rawRoot }), rawRoot, ocr: readers.ocr, vision: readers.vision, fetchMedia, now, logger: { info: (c, s, m) => logs.push({ c, s, m }) }, ...(imageLimits && { imageLimits }) });
  const store = new ContributionStore({ db, ingestion, now });
  const hasher = new ContributorHasher({ key: TEST_HASH_KEY, kid: "k1" });
  return { db, file, rawRoot, ingestion, store, hasher, reader, fetchMedia, logs };
}

/** Everything in the knowledge DB and under the raw root, as text (to prove an id / name appears nowhere). */
export function dumpAll(db, rawRoot) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
  const rows = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(rawRoot);
  return `${rows}\n${files.join("\n")}\n${files.filter((f) => f.endsWith(".txt")).map((f) => fs.readFileSync(f, "utf8")).join("\n")}`;
}
