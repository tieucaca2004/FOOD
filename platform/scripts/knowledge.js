import fs from "node:fs";
import { createKnowledgeConnection, runKnowledgeMigrations, DEFAULT_KNOWLEDGE_DB_PATH } from "../knowledge/db.js";
import { FoodTaxonomy, loadTaxonomyJson, validateTaxonomy } from "../knowledge/taxonomy.js";
import { loadVocabularyJson, validateVocabulary } from "../knowledge/vocabulary.js";

// Food Knowledge (P0) local tool — never touches the platform DB:
//   npm run knowledge:check   validate the reviewed taxonomy + vocabulary
//   npm run knowledge:init    create/migrate the LOCAL knowledge.db (KNOWLEDGE_SQLITE_PATH, default data/knowledge/knowledge.db)
const [command] = process.argv.slice(2);

function check() {
  const taxonomyJson = loadTaxonomyJson();
  const problems = validateTaxonomy(taxonomyJson);
  if (!problems.length) problems.push(...validateVocabulary(loadVocabularyJson(), new FoodTaxonomy(taxonomyJson)));
  if (problems.length) {
    console.error(`Lexicon INVALID:\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  const vocab = loadVocabularyJson();
  const facetNodes = Object.values(taxonomyJson.facets).reduce((n, f) => n + f.nodes.length, 0);
  console.log(
    `Lexicon OK: ${Object.keys(taxonomyJson.facets).length} facets (${facetNodes} nodes), ${Object.keys(taxonomyJson.attributes).length} attributes, ` +
      `${taxonomyJson.ingredients.length} ingredients, ${vocab.terms.length} vocabulary terms, ${vocab.protected_names.length} protected names, ` +
      `${vocab.out_of_scope.length} out-of-scope phrases`
  );
}

if (command === "check") check();
else if (command === "init") {
  const existed = fs.existsSync(DEFAULT_KNOWLEDGE_DB_PATH);
  // the RUNTIME snapshot is only ever replaced by a verified promotion: never migrated in place (ingestion /
  // contribution / founder tables must not appear there) unless explicitly forced
  if (existed && !process.argv.includes("--allow-runtime")) {
    const { default: Database } = await import("better-sqlite3");
    const probe = new Database(DEFAULT_KNOWLEDGE_DB_PATH, { readonly: true, fileMustExist: true });
    const has = new Set(probe.prepare(`SELECT name FROM kb_schema_migrations`).all().map((r) => r.name));
    probe.close();
    const pending = fs.readdirSync(new URL("../knowledge/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql") && !has.has(f));
    if (pending.some((f) => f >= "005")) {
      console.error(`Refusing to migrate ${DEFAULT_KNOWLEDGE_DB_PATH} in place (pending: ${pending.join(", ")}): it is the runtime snapshot. Promote from the working DB instead, or pass --allow-runtime.`);
      process.exit(1);
    }
  }
  const db = createKnowledgeConnection(DEFAULT_KNOWLEDGE_DB_PATH);
  runKnowledgeMigrations(db);
  const applied = db.prepare(`SELECT name FROM kb_schema_migrations ORDER BY name`).all().map((r) => r.name);
  db.close();
  console.log(`${existed ? "Migrated" : "Created"} local knowledge DB at ${DEFAULT_KNOWLEDGE_DB_PATH} (migrations: ${applied.join(", ")})`);
} else if (command?.startsWith("contrib-")) {
  await contributionCommand(command, process.argv.slice(3));
} else if (command?.startsWith("ingest-")) {
  await ingestCommand(command, process.argv.slice(3));
} else if (command?.startsWith("founder-")) {
  await founderCommand(command, process.argv.slice(3));
} else {
  console.log("Usage: knowledge.js check | init | ingest-status | ingest-review [--status review] | ingest-decide <id> approve|reject --by <person> [--note …] | ingest-contributor <channel> <userId> <admin|editor|verified|member|blocked> --by <person> | contrib-review [--lifecycle CANDIDATE|CONFLICT_REVIEW|APPROVED|PUBLISHED|REJECTED] | contrib-show <id> | contrib-submissions | contrib-decide <id> approve|reject --by <person> | contrib-link <id> merchant|food <targetId> --by <person> | contrib-conflict <id> --by <person> [--note …] | contrib-apply <id> --by <person> [--allow-conflict] | founder-add --type <POLICY|ADVICE_STYLE|FAQ|FOOD_RECOMMENDATION|INTERNAL_NOTE> --title … (--text … | --file <path>) --author <person> [--scope … --ref … --audience … --priority … --valid-from … --valid-to … --revise <id>] | founder-list [--status … --type … --audience … --id <id> --active] | founder-review <id> --by <person> [--return --note …] | founder-approve <id> --by <person> [--ack-warnings --note …] | founder-retire <id> --by <person> --reason …");
  process.exitCode = command ? 1 : 0;
}

// Knowledge Ingestion review (a person's tool). Works on the WORKING knowledge DB (KNOWLEDGE_INGEST_DB_PATH,
// default the collector's). Approving records the decision; it publishes nothing (V1).
async function ingestCommand(cmd, args) {
  const { platformConfig } = await import("../config.js");
  const { KnowledgeStore } = await import("../knowledge/store.js");
  const { KnowledgeIngestion } = await import("../knowledge/ingestion/ingestion.js");
  const flag = (name, fallback = null) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const db = createKnowledgeConnection(platformConfig.knowledgeIngestDbPath);
  db.pragma("busy_timeout = 5000");
  runKnowledgeMigrations(db);
  const ingestion = new KnowledgeIngestion({ db, knowledge: new KnowledgeStore({ db, rawRoot: platformConfig.knowledgeIngestRawRoot }), rawRoot: platformConfig.knowledgeIngestRawRoot });
  try {
    if (cmd === "ingest-status") {
      const jobs = db.prepare(`SELECT stage, status, COUNT(*) n FROM kb_ingest_jobs GROUP BY stage, status ORDER BY stage, status`).all();
      const candidates = db.prepare(`SELECT status, change, COUNT(*) n FROM kb_ingest_candidates GROUP BY status, change ORDER BY status, change`).all();
      const messages = db.prepare(`SELECT COUNT(*) n FROM kb_ingest_messages`).get().n;
      const media = db.prepare(`SELECT COUNT(*) n FROM kb_ingest_media`).get().n;
      console.log(JSON.stringify({ messages, media, jobs, candidates }, null, 2));
    } else if (cmd === "ingest-review") {
      for (const c of ingestion.listCandidates({ status: flag("status", "review"), limit: Number(flag("limit", 50)) })) {
        console.log(
          `#${c.id} [${c.severity} ${c.change} ${c.confidence}] ${c.kind}: ${c.place_text ?? "(no place)"} (${c.place_resolution.status}) / ${c.product_text ?? "-"} = ${c.raw_value} -> ${c.normalized_value}` +
            `${c.previous_value ? ` (published: ${c.previous_value})` : ""}\n    "${c.evidence_quote}"  — ${c.channel} message ${c.external_message_id}, role ${c.sender_role}`
        );
      }
    } else if (cmd === "ingest-decide") {
      const [id, verdict] = args;
      if (!["approve", "reject"].includes(verdict)) throw new Error("approve | reject");
      console.log(JSON.stringify(ingestion.decide(Number(id), { approve: verdict === "approve", by: flag("by"), note: flag("note") }), null, 2));
    } else if (cmd === "ingest-contributor") {
      const [channel, userId, role] = args;
      ingestion.setContributor({ channel, userId, role, addedBy: flag("by") });
      console.log(`contributor ${channel}:${userId} -> ${role}`);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// Customer contributions review (a person's tool) on the WORKING knowledge DB. Lifecycle:
// CANDIDATE -> (CONFLICT_REVIEW) -> APPROVED -> PUBLISHED (evidence-gated) | REJECTED. Never the FOOD catalog.
async function contributionCommand(cmd, args) {
  const { platformConfig } = await import("../config.js");
  const { KnowledgeStore } = await import("../knowledge/store.js");
  const { ContributionReview } = await import("../knowledge/ingestion/apply.js");
  const flag = (name, fallback = null) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const db = createKnowledgeConnection(platformConfig.knowledgeIngestDbPath);
  db.pragma("busy_timeout = 5000");
  runKnowledgeMigrations(db);
  const review = new ContributionReview({ db, knowledge: new KnowledgeStore({ db, rawRoot: platformConfig.knowledgeIngestRawRoot }) });
  const show = (c) =>
    `#${c.id} [${c.lifecycle} ${c.severity} ${c.change} ${c.confidence}] ${c.kind}/${c.assertion_kind}: ${c.place_text ?? "(no place)"} (${c.place_resolution.class ?? c.place_resolution.status}) / ${c.product_text ?? "-"} = ${c.raw_value} -> ${c.normalized_value}` +
    `${c.previous_value ? ` (published / catalog: ${c.previous_value})` : ""}${c.catalog_merchant_id ? ` [catalog ${c.catalog_merchant_id}]` : ""}
    "${c.evidence_quote}" — ${c.source_type} ${c.channel}, submission ${c.submission_id ?? "-"}`;
  try {
    const [a, b, c] = args;
    if (cmd === "contrib-review") for (const x of review.list({ lifecycle: flag("lifecycle"), limit: Number(flag("limit", 50)) })) console.log(show(x));
    else if (cmd === "contrib-show") console.log(JSON.stringify(review.candidate(Number(a)), null, 2));
    else if (cmd === "contrib-submissions") console.log(JSON.stringify(db.prepare(`SELECT id, channel, status, place_text, questions_asked, created_at, expires_at, closed_at FROM kb_ingest_submissions ORDER BY id DESC LIMIT ?`).all(Number(flag("limit", 30))), null, 2));
    else if (cmd === "contrib-decide") {
      if (!["approve", "reject"].includes(b)) throw new Error("contrib-decide <id> approve|reject --by <person>");
      console.log(show(review.decide(Number(a), { approve: b === "approve", by: flag("by"), note: flag("note") })));
    } else if (cmd === "contrib-link") {
      if (b === "merchant") console.log(show(review.linkMerchant(Number(a), Number(c), { by: flag("by") })));
      else if (b === "food") console.log(show(review.linkFood(Number(a), Number(c), { by: flag("by") })));
      else throw new Error("contrib-link <id> merchant|food <targetId> --by <person>");
    } else if (cmd === "contrib-conflict") console.log(show(review.markConflict(Number(a), { by: flag("by"), note: flag("note") })));
    else if (cmd === "contrib-apply") console.log(JSON.stringify(review.apply(Number(a), { by: flag("by"), allowConflict: args.includes("--allow-conflict") }), null, 2));
    else throw new Error(`unknown command ${cmd}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// Founder / Business Knowledge (FK-1, text only). A person's tool: nothing is published by AI, and nothing
// here is read by the GPT concierge yet. Works on the WORKING knowledge DB (FOUNDER_KNOWLEDGE_DB_PATH, default
// the same as KNOWLEDGE_INGEST_DB_PATH) — the first run applies knowledge migration 006 to it (additive).
async function founderCommand(cmd, args) {
  const { platformConfig } = await import("../config.js");
  const { FounderKnowledgeService } = await import("../knowledge/founder/founderKnowledgeService.js");
  const flag = (name, fallback = null) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const has = (name) => args.includes(`--${name}`);
  const dbPath = process.env.FOUNDER_KNOWLEDGE_DB_PATH || platformConfig.knowledgeIngestDbPath;
  const db = createKnowledgeConnection(dbPath);
  db.pragma("busy_timeout = 5000");
  runKnowledgeMigrations(db);
  const fk = new FounderKnowledgeService({ db, rawRoot: platformConfig.knowledgeIngestRawRoot });
  const show = (i, detail = false) => {
    const lines = [
      `#${i.id} [${i.status}] ${i.type} v${i.version} (lineage #${i.lineageId}${i.supersedesId ? `, supersedes #${i.supersedesId}` : ""}) — ${i.title}`,
      `    scope ${i.scope}${i.scopeRef ? `:${i.scopeRef}` : ""} · audience ${i.audience} · priority ${i.priority}${i.validFrom || i.validTo ? ` · valid ${i.validFrom ?? "…"} → ${i.validTo ?? "…"}` : ""}`,
      `    author ${i.author}${i.approvedBy ? ` · approved by ${i.approvedBy} ${i.approvedAt}` : ""}${i.retiredBy ? ` · retired by ${i.retiredBy} ${i.retiredAt} (${i.retiredReason})` : ""}`,
      ...(i.warnings.length ? [`    ⚠ looks like a fact: ${i.warnings.join(", ")} — never treated as one`] : []),
      `    ${detail ? i.body : i.body.length > 120 ? `${i.body.slice(0, 120)}…` : i.body}`,
    ];
    if (detail) {
      for (const e of i.evidence) lines.push(`    evidence #${e.id}: "${e.quote.length > 100 ? `${e.quote.slice(0, 100)}…` : e.quote}" — source #${e.source_id} ${e.kind} ${e.raw_path ?? `ingest message ${e.ingest_message_id}`} sha ${e.sha256?.slice(0, 12) ?? "-"} by ${e.submitted_by} ${e.received_at}`);
      for (const ev of i.events) lines.push(`    ${ev.at} ${ev.action} by ${ev.actor}${ev.note ? ` — ${ev.note}` : ""}`);
    } else lines.push(`    evidence: ${i.evidenceCount}`);
    console.log(lines.join("\n"));
  };
  try {
    if (cmd === "founder-add") {
      const text = has("file") ? fs.readFileSync(flag("file"), "utf8") : flag("text");
      const fields = { type: flag("type"), title: flag("title"), scope: flag("scope", "global"), scopeRef: flag("ref"), audience: flag("audience"), priority: has("priority") ? Number(flag("priority")) : 50, validFrom: flag("valid-from"), validTo: flag("valid-to") };
      if (has("revise")) {
        const source = fk.addTextSource({ text, submittedBy: flag("author") });
        const draft = fk.revise(Number(flag("revise")), { ...Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== null && v !== undefined && k !== "type")), body: String(text).trim() }, flag("author"));
        show(fk.linkEvidence(draft.id, { sourceId: source.id, quote: String(text).trim(), locator: "whole text" }, flag("author")), true);
      } else show(fk.createFromText({ text, author: flag("author"), ...fields }), true);
    } else if (cmd === "founder-list") {
      if (has("id")) show(fk.get(Number(flag("id"))), true);
      else if (has("active")) for (const i of fk.getActiveApproved({ audience: flag("audience", "customer") })) show({ ...i, evidenceCount: fk.get(i.id).evidence.length });
      else for (const i of fk.list({ status: flag("status"), type: flag("type"), audience: flag("audience") })) show(i);
    } else if (cmd === "founder-review") {
      const id = Number(args[0]);
      show(has("return") ? fk.returnToDraft(id, flag("by"), flag("note")) : fk.submitForReview(id, flag("by")), true);
    } else if (cmd === "founder-approve") {
      show(fk.approve(Number(args[0]), { by: flag("by"), ackWarnings: has("ack-warnings"), note: flag("note") }), true);
    } else if (cmd === "founder-retire") {
      show(fk.retire(Number(args[0]), { by: flag("by"), reason: flag("reason") }), true);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (err) {
    console.error(err.code ? `${err.code}: ${err.message}` : err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
