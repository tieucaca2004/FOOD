function parseSession(row) {
  if (!row) return row;
  return {
    ...row,
    pending_confirmation: Boolean(row.pending_confirmation),
    state: row.state_json ? JSON.parse(row.state_json) : {},
  };
}

export class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  getActiveByCustomer(customerId, channel = "zalo") {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE customer_id = ? AND channel = ? ORDER BY id DESC LIMIT 1`)
      .get(customerId, channel);
    return parseSession(row);
  }

  create(customerId, channel = "zalo") {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO sessions (customer_id, channel) VALUES (?, ?)`)
      .run(customerId, channel);
    return this.getById(lastInsertRowid);
  }

  getById(id) {
    return parseSession(this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id));
  }

  update(id, patch) {
    const current = this.getById(id);
    const merged = {
      current_intent: patch.currentIntent ?? current.current_intent,
      pending_confirmation:
        (patch.pendingConfirmation === undefined ? current.pending_confirmation : patch.pendingConfirmation) ? 1 : 0,
      pending_order_id: patch.pendingOrderId === undefined ? current.pending_order_id : patch.pendingOrderId,
      pending_checkout_field:
        patch.pendingCheckoutField === undefined ? current.pending_checkout_field : patch.pendingCheckoutField,
      state_json: patch.state === undefined ? current.state_json : JSON.stringify(patch.state),
    };
    this.db
      .prepare(
        `UPDATE sessions SET
           current_intent = ?,
           pending_confirmation = ?,
           pending_order_id = ?,
           pending_checkout_field = ?,
           state_json = ?,
           last_interaction_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        merged.current_intent,
        merged.pending_confirmation,
        merged.pending_order_id,
        merged.pending_checkout_field,
        merged.state_json,
        id
      );
    return this.getById(id);
  }
}
