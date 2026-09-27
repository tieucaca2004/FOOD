// Conversation working memory, stored on the customer's current
// platform_sessions row (migration 009). Reads/writes only its own column,
// so it never races with PlatformSessionRepository.update().
export class ConversationStateRepository {
  constructor(db) {
    this.db = db;
  }

  getByCustomer(customerId) {
    const row = this.db
      .prepare(`SELECT conversation_state_json FROM platform_sessions WHERE customer_id = ? ORDER BY id DESC LIMIT 1`)
      .get(customerId);
    if (!row?.conversation_state_json) return null;
    try {
      return JSON.parse(row.conversation_state_json);
    } catch {
      return null; // a corrupt blob is treated as "no memory", never as a crash
    }
  }

  saveForCustomer(customerId, state) {
    this.db
      .prepare(
        `UPDATE platform_sessions SET conversation_state_json = ?
         WHERE id = (SELECT id FROM platform_sessions WHERE customer_id = ? ORDER BY id DESC LIMIT 1)`
      )
      .run(state ? JSON.stringify(state) : null, customerId);
  }
}
