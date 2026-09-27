import { MerchantDiscoveryStore } from "../discoveryStore.js";

// Reviewer actions + APPLY: an APPROVED candidate enters the published Food Knowledge layer through the SAME
// evidence gate as every other source (MerchantDiscoveryStore: the quote is verified against the stored raw file
// and its hash). Never the FOOD catalog / platform DB — the knowledge layer cannot even reach it.
//
//   CANDIDATE --approve (a person)--> APPROVED --apply (a person)--> VALIDATED by the evidence gate --> PUBLISHED
//   CANDIDATE --reject--> REJECTED        CANDIDATE --mark conflict--> CONFLICT_REVIEW (a flag; still a decision to make)
//
// The candidate row keeps everything it had (its evidence is immutable); kb_ingest_applications links it to the
// published row it became (source_submission_id is reachable through its message). A failed gate publishes NOTHING
// (the whole apply rolls back) and says why.

const PERSONAL = /(?:\+?84|\b0)\d[\d .-]{7,11}\d\b|https?:\/\/|www\.|@[A-Za-z0-9_.]{3,}|\b\d{9,12}\b/;

/** The review lifecycle as one label (derived; see migration 008). */
export function lifecycleOf(c) {
  if (c.status === "applied") return "PUBLISHED";
  if (c.status === "approved") return "APPROVED";
  if (c.status === "rejected") return "REJECTED";
  if (c.change === "CONFLICT" || c.review_flag === "CONFLICT") return "CONFLICT_REVIEW";
  return "CANDIDATE";
}

export class ContributionReview {
  /** @param {{db: import("better-sqlite3").Database, knowledge: import("../store.js").KnowledgeStore}} deps */
  constructor({ db, knowledge }) {
    this.db = db;
    this.knowledge = knowledge;
    this.discovery = new MerchantDiscoveryStore({ knowledge });
  }

  candidate(id) {
    const c = this.db
      .prepare(`SELECT c.*, m.channel, m.sent_at, m.received_at, m.submission_id, m.source_type, m.sender_id, m.sender_hash FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id WHERE c.id = ?`)
      .get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    return { ...c, place_resolution: JSON.parse(c.place_resolution), lifecycle: lifecycleOf(c) };
  }

  list({ lifecycle = null, limit = 50 } = {}) {
    return this.db
      .prepare(`SELECT c.*, m.channel, m.sent_at, m.submission_id, m.source_type FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id ORDER BY CASE c.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, c.id LIMIT ?`)
      .all(limit * 4)
      .map((c) => ({ ...c, place_resolution: JSON.parse(c.place_resolution), lifecycle: lifecycleOf(c) }))
      .filter((c) => !lifecycle || c.lifecycle === lifecycle)
      .slice(0, limit);
  }

  _person(by) {
    if (!by || /^system/i.test(by)) throw new Error("a review action needs the deciding person (--by)");
    return by;
  }

  linkMerchant(id, kbMerchantId, { by }) {
    this._person(by);
    if (!this.db.prepare(`SELECT 1 FROM kb_merchants WHERE id = ?`).get(kbMerchantId)) throw new Error(`unknown kb merchant ${kbMerchantId}`);
    this.db.prepare(`UPDATE kb_ingest_candidates SET review_kb_merchant_id = ?, decision_note = COALESCE(decision_note, '') || ? WHERE id = ?`).run(kbMerchantId, `[link merchant ${kbMerchantId} by ${by}]`, id);
    return this.candidate(id);
  }

  linkFood(id, foodEntityId, { by }) {
    this._person(by);
    if (!this.db.prepare(`SELECT 1 FROM kb_food_entities WHERE id = ?`).get(foodEntityId)) throw new Error(`unknown food entity ${foodEntityId}`);
    this.db.prepare(`UPDATE kb_ingest_candidates SET review_food_entity_id = ?, decision_note = COALESCE(decision_note, '') || ? WHERE id = ?`).run(foodEntityId, `[link food ${foodEntityId} by ${by}]`, id);
    return this.candidate(id);
  }

  markConflict(id, { by, note = null }) {
    this._person(by);
    this.db.prepare(`UPDATE kb_ingest_candidates SET review_flag = 'CONFLICT', decision_note = COALESCE(decision_note, '') || ? WHERE id = ?`).run(`[conflict by ${by}${note ? `: ${note}` : ""}]`, id);
    return this.candidate(id);
  }

  /** A person's decision; nobody decides on their own contribution. Approval does not publish. */
  decide(id, { approve, by, note = null, reviewerHash = null }) {
    this._person(by);
    const c = this.candidate(id);
    if (c.status !== "review") throw new Error(`candidate ${id} is already ${c.status}`);
    if ((c.sender_id && by === `${c.channel}:${c.sender_id}`) || (reviewerHash && c.sender_hash === reviewerHash)) throw new Error("a contributor cannot decide on their own contribution");
    this.db.prepare(`UPDATE kb_ingest_candidates SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = COALESCE(decision_note || ' ', '') || COALESCE(?, '') WHERE id = ?`).run(approve ? "approved" : "rejected", by, note, id);
    this._closeSubmission(c.submission_id);
    return this.candidate(id);
  }

  /**
   * APPROVED -> PUBLISHED knowledge (evidence-gated). Returns what was written; throws (nothing written) if the
   * gate does not publish it.
   */
  apply(id, { by, allowConflict = false }) {
    this._person(by);
    return this.db.transaction(() => {
      const c = this.candidate(id);
      if (c.status !== "approved") throw new Error(`candidate ${id} is ${c.status}: only an approved candidate is applied`);
      if (c.assertion_kind === "INFERRED") throw new Error("an inferred (vision guess) candidate is never published");
      if ((c.change === "CONFLICT" || c.review_flag === "CONFLICT") && !allowConflict) throw new Error("a CONFLICT candidate needs --allow-conflict (the catalog is never changed either way)");
      if (!c.source_id) throw new Error("no source to verify the quote against");
      if (this.db.prepare(`SELECT 1 FROM kb_ingest_purges WHERE target_kind = 'source' AND target_id = ?`).get(c.source_id)) throw new Error("the evidence file was purged");
      if (PERSONAL.test(c.evidence_quote)) throw new Error("the quote contains personal / contact data: it cannot be published as evidence");
      const merchantId = c.review_kb_merchant_id ?? c.resolved_kb_merchant_id ?? null;
      const evidence = { sourceId: c.source_id, quote: c.evidence_quote, extraction: "explicit", proposedBy: `contribution:${c.id}` };
      const at = c.sent_at ?? c.received_at;
      const need = () => {
        if (!merchantId) throw new Error("link the candidate to a knowledge merchant first (ingest-link <id> merchant <kbId>)");
        return merchantId;
      };
      let target;
      let r;
      if (c.kind === "place") {
        r = this.discovery.upsertMerchant({ name: c.place_text, evidence, seenAt: at });
        target = { table: "kb_merchants", id: r.merchantId };
      } else if (c.kind === "product") {
        r = this.discovery.proposeProduct({ merchantId: need(), originalName: c.product_text, observation: "menu", evidence, seenAt: at });
        target = { table: "kb_merchant_products", id: r.productId };
      } else if (c.kind === "price") {
        const p = this.discovery.proposeProduct({ merchantId: need(), originalName: c.product_text, observation: "menu", evidence, seenAt: at });
        if (p.outcome !== "published") throw new Error(`product not published by the evidence gate: ${JSON.stringify(p.reasons)}`);
        r = this.discovery.proposePrice({ productId: p.productId, variant: c.variant ?? null, priceTextOriginal: c.raw_value, evidence, capturedAt: at });
        target = { table: "kb_product_prices", id: r.priceId };
      } else if (c.kind === "address") {
        r = this.discovery.proposeLocation({ merchantId: need(), addressOriginal: c.raw_value, evidence, capturedAt: at });
        target = { table: "kb_merchant_locations", id: r.locationId ?? r.id };
      } else if (c.kind === "opening_hours") {
        r = this.discovery.proposeMerchantClaim({ merchantId: need(), field: "opening_hours", value: c.normalized_value, originalText: c.raw_value, evidence, capturedAt: at });
        target = { table: "kb_merchant_claims", id: r.claimId ?? r.id };
      } else throw new Error(`kind ${c.kind} is not applied in V1`);
      if (r.outcome !== "published" || !target.id) throw new Error(`the evidence gate did not publish it (${r.outcome}): ${JSON.stringify(r.reasons)}`);
      const evidenceId = this.db.prepare(`SELECT evidence_id FROM ${target.table} WHERE id = ?`).get(target.id)?.evidence_id ?? this.db.prepare(`SELECT id FROM kb_evidence WHERE proposed_by = ? ORDER BY id DESC LIMIT 1`).get(`contribution:${c.id}`).id;
      this.db.prepare(`INSERT INTO kb_ingest_applications (candidate_id, target_table, target_id, evidence_id, applied_by) VALUES (?, ?, ?, ?, ?)`).run(c.id, target.table, target.id, evidenceId, by);
      this.db.prepare(`UPDATE kb_ingest_candidates SET status = 'applied' WHERE id = ?`).run(c.id);
      this._closeSubmission(c.submission_id);
      return { candidateId: c.id, lifecycle: "PUBLISHED", target, evidenceId, submissionId: c.submission_id, approvedBy: c.decided_by, approvedAt: c.decided_at, appliedBy: by };
    })();
  }

  _closeSubmission(submissionId) {
    if (!submissionId) return;
    const s = this.db.prepare(`SELECT status FROM kb_ingest_submissions WHERE id = ?`).get(submissionId);
    if (s?.status !== "CANDIDATE") return;
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id WHERE m.submission_id = ? AND c.status = 'review'`).get(submissionId).n;
    if (open) return;
    this.db.prepare(`UPDATE kb_ingest_submissions SET status = 'CLOSED', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(submissionId);
    this.db.prepare(`INSERT INTO kb_ingest_submission_events (submission_id, from_status, to_status, actor, reason) VALUES (?, 'CANDIDATE', 'CLOSED', 'system', 'all_candidates_decided')`).run(submissionId);
  }
}
