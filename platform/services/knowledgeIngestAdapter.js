import path from "node:path";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../knowledge/db.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { KnowledgeIngestion } from "../knowledge/ingestion/ingestion.js";
import { ContributionStore } from "../knowledge/ingestion/contributions.js";
import { contributorHasherFromEnv } from "../knowledge/ingestion/contributorHash.js";
import { classifyContributionText, classifyReply } from "../knowledge/ingestion/contributionIntent.js";
import { IMAGE_LIMITS } from "../knowledge/ingestion/imageCheck.js";
import { normalizeName } from "../knowledge/text.js";

// The ONLY bridge from a chat channel into Knowledge Ingestion (loaded by
// server.js only when KNOWLEDGE_INGEST_ENABLED=true, and only for the chat ids
// listed in KNOWLEDGE_GROUP_CHAT_IDS). It writes the WORKING knowledge DB
// (the collector's, not the runtime snapshot customers read): nothing reaches
// customers until a person approves it and the DB is promoted.
//
// The webhook stays fast: receive() stores the evidence and queues work; the
// slow part (media fetch, OCR, vision) runs in the background, single-flight.
// The bot token is used to fetch files and never appears in a log or an error.

const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

/** Telegram group update -> ingestion envelope (null if it is not a group message). */
export function telegramGroupEnvelope(update) {
  const edited = Boolean(update?.edited_message);
  const m = update?.message ?? update?.edited_message;
  if (!m || typeof m !== "object" || !m.chat || !["group", "supergroup"].includes(m.chat.type) || m.message_id === undefined) return null;
  const media = [];
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = [...m.photo].sort((a, b) => (b.file_size ?? b.width * b.height ?? 0) - (a.file_size ?? a.width * a.height ?? 0))[0];
    if (largest?.file_id) media.push({ type: "photo", fileId: largest.file_id, mimeType: "image/jpeg" });
  }
  if (m.document?.file_id && /^(image\/|application\/pdf$)/.test(m.document.mime_type ?? "")) {
    media.push({ type: "document", fileId: m.document.file_id, mimeType: m.document.mime_type, filename: m.document.file_name ?? null });
  }
  if (typeof m.text !== "string" && typeof m.caption !== "string" && !media.length) return null;
  return {
    channel: "telegram",
    chatId: String(m.chat.id),
    // an edit is new evidence next to the original, never a rewrite of it
    messageId: edited ? `${m.message_id}:edit:${m.edit_date ?? "?"}` : String(m.message_id),
    updateId: update.update_id !== undefined ? String(update.update_id) : null,
    senderId: m.from?.id !== undefined ? String(m.from.id) : null,
    senderName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || null,
    sentAt: typeof m.date === "number" ? new Date(m.date * 1000).toISOString() : null,
    text: typeof m.text === "string" ? m.text : null,
    caption: typeof m.caption === "string" ? m.caption : null,
    replyTo: m.reply_to_message?.message_id !== undefined ? String(m.reply_to_message.message_id) : null,
    mediaGroupId: m.media_group_id ?? null,
    media,
    raw: update,
  };
}

function telegramFileFetcher({ botToken, fetchImpl }) {
  const scrub = (s) => String(s).split(botToken).join("<token>");
  return async function fetchTelegramFile(fileId) {
    try {
      const meta = await fetchImpl(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const body = await meta.json();
      if (!meta.ok || !body?.ok || !body.result?.file_path) throw new Error(`telegram getFile failed (HTTP ${meta.status})`);
      const res = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${body.result.file_path}`);
      if (!res.ok) throw new Error(`telegram file download failed (HTTP ${res.status})`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(body.result.file_path).slice(1).toLowerCase();
      return { buffer, mimeType: MIME_BY_EXT[ext] ?? null, filename: path.basename(body.result.file_path) };
    } catch (err) {
      throw new Error(scrub(err?.message ?? err));
    }
  };
}

/**
 * @param {{dbPath: string, rawRoot: string, groupChatIds: string[], botToken?: string, logger?: object, fetchImpl?: Function, ocr?: object, vision?: object}} opts
 */
export function createKnowledgeIngest({ dbPath, rawRoot, groupChatIds, botToken = "", logger = null, fetchImpl = globalThis.fetch, ocr = null, vision = null }) {
  const db = createKnowledgeConnection(dbPath);
  db.pragma("busy_timeout = 5000"); // the collector may be writing the same DB
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot });
  const ingestion = new KnowledgeIngestion({ db, knowledge, rawRoot, ocr, vision, fetchMedia: botToken ? telegramFileFetcher({ botToken, fetchImpl }) : null, logger });
  const allowed = new Set(groupChatIds.map(String).filter(Boolean));
  let running = null;
  let again = false;
  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await ingestion.processPending({ limit: 20 });
        } while (again);
      } catch (err) {
        logger?.warn?.("KNOWLEDGE_INGEST", "background processing failed", { error: String(err?.message ?? err).slice(0, 200) });
      } finally {
        running = null;
      }
    })();
  };
  return {
    /** Only the configured Knowledge Group(s): every other chat keeps the customer flow. */
    accepts(update) {
      const m = update?.message ?? update?.edited_message;
      return Boolean(m?.chat && allowed.has(String(m.chat.id)));
    },
    /** Stores the evidence and queues the work; returns at once. */
    receive(update) {
      const envelope = telegramGroupEnvelope(update);
      if (!envelope) return { status: "ignored" };
      const result = ingestion.receive(envelope);
      if (result.jobs) setImmediate(kick);
      return result;
    },
    /** Resolves when the queued background work has run (the kick is scheduled with setImmediate). */
    whenIdle: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      while (running) await running;
    },
    ingestion,
    close: () => db.close(),
  };
}

/**
 * Customer contributions (USER_CONTRIBUTIONS_ENABLED): the knowledge side of the contribution service — the
 * ingestion pipeline + the submission store on the WORKING knowledge DB, the keyed hasher and the deterministic
 * text rules. Returns null (feature off) when no usable hash key is configured: fail-closed.
 * @param {{dbPath: string, rawRoot: string, hashKey: string, hashKid?: string, ocr?: object|null, vision?: object|null,
 *          fetchTelegram?: Function|null, fetchZalo?: Function|null, logger?: object, pendingTtlMs?: number, maxImageBytes?: number}} opts
 */
export function createContributionIngest({ dbPath, rawRoot, hashKey, hashKid = "k1", ocr = null, vision = null, fetchTelegram = null, fetchZalo = null, logger = null, pendingTtlMs, maxImageBytes, now } = {}) {
  const hasher = contributorHasherFromEnv({ key: hashKey, kid: hashKid });
  if (!hasher) return null;
  const db = createKnowledgeConnection(dbPath);
  db.pragma("busy_timeout = 5000");
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot });
  // one fetcher for both channels: a Telegram file id or a Zalo https URL (each with its own safety rules)
  const fetchMedia = async (ref, { channel } = {}) => {
    const f = channel === "zalo" ? fetchZalo : fetchTelegram;
    if (!f) throw new Error(`no media fetcher for ${channel}`);
    return f(ref);
  };
  const imageLimits = { ...IMAGE_LIMITS, ...(maxImageBytes ? { maxBytes: maxImageBytes } : {}) };
  const ingestion = new KnowledgeIngestion({ db, knowledge, rawRoot, ocr, vision, fetchMedia, logger, imageLimits, ...(now && { now }) });
  const store = new ContributionStore({ db, ingestion, ...(pendingTtlMs && { pendingTtlMs }), ...(now && { now }) });
  // background work is single-flight per process (like the Knowledge Group bridge)
  let running = Promise.resolve();
  const drain = () => {
    running = running.then(() => ingestion.drain()).catch((err) => {
      logger?.warn?.("CONTRIBUTION", "background processing failed", { error: String(err?.message ?? err).slice(0, 200) });
      return [];
    });
    return running;
  };
  return {
    store,
    ingestion,
    hasher,
    readers: { ocr: Boolean(ocr), vision: Boolean(vision) },
    classifyText: classifyContributionText,
    classifyReply,
    normalizeName,
    drain,
    close: () => db.close(),
  };
}

export { telegramFileFetcher };
