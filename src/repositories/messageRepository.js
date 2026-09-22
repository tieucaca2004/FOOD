export class MessageRepository {
  constructor(db) {
    this.db = db;
  }

  log({ sessionId, direction, intent, rawText }) {
    this.db
      .prepare(`INSERT INTO messages (session_id, direction, intent, raw_text) VALUES (?, ?, ?, ?)`)
      .run(sessionId, direction, intent || null, rawText);
  }

  listBySession(sessionId, limit = 20) {
    return this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, limit);
  }
}
