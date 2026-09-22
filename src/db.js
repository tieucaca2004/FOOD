import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS support_sessions (
    support_session_id TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    channel_type        TEXT NOT NULL DEFAULT 'zalo',
    status              TEXT NOT NULL DEFAULT 'open',
    current_intent      TEXT,
    opened_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    message_id          TEXT PRIMARY KEY,
    support_session_id  TEXT NOT NULL REFERENCES support_sessions(support_session_id),
    sender_type         TEXT NOT NULL, -- 'user' | 'agent'
    agent_identity      TEXT,          -- 'mary'
    message_status      TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'sent' | 'failed'
    raw_text            TEXT NOT NULL,
    sent_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON support_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON support_messages(support_session_id);
`);

export function getOrCreateOpenSession(userId) {
  const existing = db
    .prepare(
      `SELECT * FROM support_sessions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
    )
    .get(userId);
  if (existing) return existing;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO support_sessions (support_session_id, user_id, channel_type, status) VALUES (?, ?, 'zalo', 'open')`
  ).run(id, userId);
  return db.prepare(`SELECT * FROM support_sessions WHERE support_session_id = ?`).get(id);
}

export function setSessionIntent(supportSessionId, intent) {
  db.prepare(`UPDATE support_sessions SET current_intent = ? WHERE support_session_id = ?`).run(
    intent,
    supportSessionId
  );
}

export function insertMessage({ supportSessionId, senderType, agentIdentity, messageStatus, rawText }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO support_messages (message_id, support_session_id, sender_type, agent_identity, message_status, raw_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, supportSessionId, senderType, agentIdentity || null, messageStatus, rawText);
  return id;
}

export function updateMessageStatus(messageId, status) {
  db.prepare(`UPDATE support_messages SET message_status = ? WHERE message_id = ?`).run(status, messageId);
}
