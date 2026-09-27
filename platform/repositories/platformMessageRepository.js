export class PlatformMessageRepository {
  constructor(db) {
    this.db = db;
  }

  lastOutboundAt(sessionId) {
    return this.db.prepare(`SELECT MAX(created_at) AS at FROM platform_messages WHERE session_id = ? AND direction = 'out'`).get(sessionId)?.at ?? null;
  }

  log({ sessionId, direction, intent, rawText }) {
    this.db
      .prepare(`INSERT INTO platform_messages (session_id, direction, intent, raw_text) VALUES (?, ?, ?, ?)`)
      .run(sessionId, direction, intent || null, rawText);
  }
}
