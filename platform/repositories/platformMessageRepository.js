export class PlatformMessageRepository {
  constructor(db) {
    this.db = db;
  }

  log({ sessionId, direction, intent, rawText }) {
    this.db
      .prepare(`INSERT INTO platform_messages (session_id, direction, intent, raw_text) VALUES (?, ?, ?, ?)`)
      .run(sessionId, direction, intent || null, rawText);
  }
}
