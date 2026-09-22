// Idempotency guard for Zalo webhook retries. `reserve` inserts the message
// id and returns true only if this is the first time we've seen it — the
// UNIQUE constraint on message_id makes the check-and-insert atomic even
// under concurrent requests for the same message.
export class WebhookEventRepository {
  constructor(db) {
    this.db = db;
  }

  reserve(messageId, eventName) {
    try {
      this.db
        .prepare(`INSERT INTO webhook_events (message_id, event_name) VALUES (?, ?)`)
        .run(messageId, eventName || null);
      return true;
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return false;
      throw err;
    }
  }

  saveResponse(messageId, responseJson) {
    this.db
      .prepare(`UPDATE webhook_events SET response_json = ? WHERE message_id = ?`)
      .run(JSON.stringify(responseJson), messageId);
  }

  getCachedResponse(messageId) {
    const row = this.db
      .prepare(`SELECT response_json FROM webhook_events WHERE message_id = ?`)
      .get(messageId);
    return row?.response_json ? JSON.parse(row.response_json) : null;
  }
}
