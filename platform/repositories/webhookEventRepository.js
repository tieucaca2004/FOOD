// Same idempotency pattern as A Tiểu's own webhookEventRepository, but a
// fully separate table (platform_webhook_events) since the platform has its
// own OA and its own webhook deliveries to de-duplicate.
export class PlatformWebhookEventRepository {
  constructor(db) {
    this.db = db;
  }

  reserve(messageId, eventName) {
    try {
      this.db
        .prepare(`INSERT INTO platform_webhook_events (message_id, event_name) VALUES (?, ?)`)
        .run(messageId, eventName || null);
      return true;
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return false;
      throw err;
    }
  }

  saveResponse(messageId, responseJson) {
    this.db
      .prepare(`UPDATE platform_webhook_events SET response_json = ? WHERE message_id = ?`)
      .run(JSON.stringify(responseJson), messageId);
  }

  getCachedResponse(messageId) {
    const row = this.db.prepare(`SELECT response_json FROM platform_webhook_events WHERE message_id = ?`).get(messageId);
    return row?.response_json ? JSON.parse(row.response_json) : null;
  }
}
