// Multimodal V1 — PHASE 18–21 gate: approval / publish lifecycle (reviewer actions, evidence-gated apply, provenance
// kept), published knowledge retrievable after promotion, and GPT retrieval of candidates as
// USER_CONTRIBUTED_UNVERIFIED_EVIDENCE with the additive Fact Guard rule. SYNTHETIC fixtures, scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contributionKit } from "../helpers/contributionKit.js";
import { ContributionReview, lifecycleOf } from "../../knowledge/ingestion/apply.js";
import { KnowledgeStore } from "../../knowledge/store.js";
import { Ledger, checkAnswer, renderAnswer } from "../../ai/foodConcierge/factGuard.js";
import { createKnowledgeAwareRegistry, createKnowledgeLayers, KNOWLEDGE_KINDS, CONTRIBUTION_KIND } from "../../ai/foodConcierge/knowledgeLayers.js";
import { ContributionService } from "../../services/contributionService.js";

async function submitted(kit, files, placeText, { text = null } = {}) {
  const senderHash = kit.hasher.user("telegram", "111");
  const s = kit.store.create({ channel: "telegram", senderHash, kid: "k1", sessionRef: 1 });
  let n = 0;
  for (const f of files.length ? files : [null]) {
    kit.store.addMessage(kit.store.get(s.id), { chatId: kit.hasher.chat("telegram", "111"), messageId: String(++n), sentAt: "2026-09-27T08:59:00Z", text: f ? null : text, media: f ? [{ type: "photo", fileId: f, mimeType: "image/jpeg" }] : [], raw: { message: { message_id: n } } });
  }
  kit.store.transition(s.id, "EXTRACTING");
  await kit.ingestion.drain();
  kit.store.transition(s.id, "CANDIDATE", { patch: { place_text: placeText, place_resolution: kit.store.resolvePlace(placeText), place_message_id: kit.store.messages(s.id)[0].id } });
  kit.store.materialize(s.id);
  return { s, senderHash, cands: kit.store.candidates(s.id) };
}

const review = (kit) => new ContributionReview({ db: kit.db, knowledge: new KnowledgeStore({ db: kit.db, rawRoot: kit.rawRoot }) });

test("APPROVAL: approve -> apply publishes through the evidence gate; provenance, approver and submission are kept; the candidate history stays", async () => {
  const kit = contributionKit();
  const { s, cands } = await submitted(kit, [], "Bún Cá Cô Ba", { text: "Quán Bún Cá Cô Ba bún cá 35k" });
  const r = review(kit);
  const c = cands[0];
  assert.equal(lifecycleOf(c), "CANDIDATE");
  assert.throws(() => r.apply(c.id, { by: "founder" }), /only an approved candidate/);
  assert.throws(() => r.decide(c.id, { approve: true, by: "system" }), /deciding person/);
  const approved = r.decide(c.id, { approve: true, by: "founder", note: "checked the menu" });
  assert.equal(approved.lifecycle, "APPROVED");
  const before = kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`).get().n;
  const applied = r.apply(c.id, { by: "founder" });
  assert.equal(applied.lifecycle, "PUBLISHED");
  assert.equal(applied.target.table, "kb_product_prices");
  assert.equal(applied.submissionId, s.id);
  assert.equal(applied.approvedBy, "founder");
  assert.ok(applied.approvedAt);
  const price = kit.db.prepare(`SELECT p.*, e.verification, e.proposed_by, src.source_type FROM kb_product_prices p JOIN kb_evidence e ON e.id = p.evidence_id JOIN kb_sources src ON src.id = e.source_id WHERE p.id = ?`).get(applied.target.id);
  assert.deepEqual([price.price, price.status, price.verification, price.source_type, price.proposed_by], [35000, "published", "verified", "user_contribution", `contribution:${c.id}`]);
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`).get().n, before + 1);
  assert.equal(r.candidate(c.id).lifecycle, "PUBLISHED");
  assert.equal(kit.db.prepare(`SELECT target_id FROM kb_ingest_applications WHERE candidate_id = ?`).get(c.id).target_id, applied.target.id);
  assert.equal(kit.store.get(s.id).status, "CLOSED", "every candidate decided -> the submission closes");
  assert.throws(() => kit.db.prepare(`DELETE FROM kb_ingest_applications`).run(), /append-only/);
  // the original evidence is never destroyed
  assert.equal(kit.store.messages(s.id).length, 1);
  assert.ok(fs.existsSync(path.join(kit.rawRoot, kit.db.prepare(`SELECT raw_path FROM kb_sources WHERE id = ?`).get(c.source_id).raw_path)));
});

test("REVIEWER ACTIONS: link merchant / food, mark conflict (needs --allow-conflict to publish), reject; guards", async () => {
  const kit = contributionKit();
  const { cands } = await submitted(kit, ["menu_clean.jpg"], "Quán Bún Mẫu Thử");
  const r = review(kit);
  const bun = cands.find((c) => c.product_text === "Bún bò Huế");
  // no knowledge merchant for this new place: publishing needs a link first
  r.decide(bun.id, { approve: true, by: "founder" });
  assert.throws(() => r.apply(bun.id, { by: "founder" }), /link the candidate to a knowledge merchant first/);
  const coBa = kit.db.prepare(`SELECT id FROM kb_merchants WHERE key = 'bun-ca-co-ba'`).get().id;
  assert.throws(() => r.linkMerchant(bun.id, coBa, { by: "founder" }), /review links change only in review/, "links are made before the decision");
  const cha = cands.find((c) => c.product_text === "Bún chả");
  r.linkMerchant(cha.id, coBa, { by: "founder" });
  const food = kit.db.prepare(`SELECT id FROM kb_food_entities ORDER BY id LIMIT 1`).get().id;
  r.linkFood(cha.id, food, { by: "founder" });
  r.markConflict(cha.id, { by: "founder", note: "blog says 45k" });
  assert.equal(r.candidate(cha.id).lifecycle, "CONFLICT_REVIEW");
  r.decide(cha.id, { approve: true, by: "founder" });
  assert.throws(() => r.apply(cha.id, { by: "founder" }), /allow-conflict/);
  const ok = r.apply(cha.id, { by: "founder", allowConflict: true });
  assert.equal(kit.db.prepare(`SELECT merchant_id FROM kb_merchant_products WHERE id = (SELECT product_id FROM kb_product_prices WHERE id = ?)`).get(ok.target.id).merchant_id, coBa);
  const tra = cands.find((c) => c.product_text === "Trà đá");
  assert.equal(r.decide(tra.id, { approve: false, by: "founder" }).lifecycle, "REJECTED");
  assert.throws(() => r.decide(tra.id, { approve: true, by: "founder" }), /already rejected/);
});

test("APPLY GUARDS: an inferred dish, a purged file, a quote with contact data are never published", async () => {
  const kit = contributionKit();
  const { cands } = await submitted(kit, ["food_photo.jpg"], "Bún Cá Cô Ba");
  const r = review(kit);
  const dish = cands.find((c) => c.assertion_kind === "INFERRED");
  r.decide(dish.id, { approve: true, by: "founder" });
  assert.throws(() => r.apply(dish.id, { by: "founder" }), /never published/);
  const kit2 = contributionKit();
  const t = await submitted(kit2, [], "Bún Cá Cô Ba", { text: "Quán Bún Cá Cô Ba bún cá 35k gọi 0905123456" });
  const r2 = review(kit2);
  assert.ok(!t.cands.some((c) => c.raw_value === "0905123456"), "a phone number is never a price candidate");
  assert.equal(kit2.store.visible({ names: ["gọi"] }).length, 0);
  const c2 = t.cands.find((c) => c.kind === "price");
  assert.ok(c2, "the real price claim is there");
  r2.decide(c2.id, { approve: true, by: "founder" });
  assert.throws(() => r2.apply(c2.id, { by: "founder" }), /personal \/ contact data/, "its quote carries the phone number: not publishable as evidence");
});

test("PUBLISHED knowledge is retrievable: promoted copy -> the read-only adapter serves the approved price (as reference, never orderable)", async () => {
  const kit = contributionKit();
  const { cands } = await submitted(kit, [], "Bún Cá Cô Ba", { text: "Quán Bún Cá Cô Ba bún cá 35k" });
  const r = review(kit);
  r.decide(cands[0].id, { approve: true, by: "founder" });
  r.apply(cands[0].id, { by: "founder" });
  const { promoteKnowledge } = await import("../../../tools/knowledge-collector/lib/promote.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-promote-"));
  const to = path.join(dir, "knowledge.db");
  kit.db.pragma("wal_checkpoint(TRUNCATE)");
  const manifest = await promoteKnowledge({ from: kit.file, to });
  assert.equal(manifest.rawIngestTables, 0, "no customer evidence table reaches the runtime");
  const Database = (await import("better-sqlite3")).default;
  const rt = new Database(to, { readonly: true });
  const tables = rt.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'kb_ingest%' OR name = 'kb_contribution_visible'`).all();
  assert.deepEqual(tables, []);
  const row = rt.prepare(`SELECT p.price FROM kb_product_prices p JOIN kb_merchant_products mp ON mp.id = p.product_id JOIN kb_merchants m ON m.id = mp.merchant_id WHERE m.key = 'bun-ca-co-ba' AND p.status = 'published' ORDER BY p.id DESC LIMIT 1`).get();
  assert.equal(row.price, 35000);
  const bytes = fs.readFileSync(to);
  assert.ok(!bytes.includes(Buffer.from(kit.hasher.user("telegram", "111"))), "no contributor hash in the runtime file");
  rt.close();
});

test("GPT RETRIEVAL: get_user_contributions returns labelled, identity-free candidates; Fact Guard allows attributed wording only", async () => {
  const kit = contributionKit();
  const { senderHash } = await submitted(kit, ["menu_clean.jpg"], "Quán Bún Mẫu Thử");
  const svc = new ContributionService({ ingest: { store: kit.store, hasher: kit.hasher, readers: { ocr: true }, classifyText: () => ({ kind: "NONE" }), classifyReply: () => ({ kind: "OTHER" }), drain: async () => [] }, services: { merchantData: { listDiscoverable: () => [] }, menu: { listProducts: () => [] } }, repos: null });
  assert.ok(CONTRIBUTION_KIND.USER_CONTRIBUTED_UNVERIFIED_EVIDENCE);
  assert.equal(Object.keys(KNOWLEDGE_KINDS).length, 6, "the frozen legend is unchanged");
  const layers = createKnowledgeLayers({ tools: { knowledge: null }, contributions: svc });
  const registry = createKnowledgeAwareRegistry({ run: async () => ({ data: {}, facts: [] }) }, layers);
  const own = { zalo_user_id: "telegram:111" };
  const res = await registry.execute("get_user_contributions", { food: "bún bò" }, { customer: own, session: null });
  const data = res.data ?? res.output ?? res;
  const payload = data.data ?? data;
  assert.equal(payload.kind, "USER_CONTRIBUTED_UNVERIFIED_EVIDENCE");
  assert.equal(payload.verified, false);
  const item = payload.items.find((i) => /Bún bò Huế/.test(i.entity.name_as_written));
  assert.equal(item.status, "CANDIDATE");
  assert.equal(item.value, 45000);
  assert.equal(item.own_contribution, true);
  assert.equal(item.provenance.source_type, "USER_CONTRIBUTION");
  assert.equal(item.provenance.media_type, "IMAGE");
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(senderHash) && !json.includes("111") && !/evidence_quote|raw_update|sender/.test(json), "no identity, no raw evidence");
  // another customer: the same candidate, not "own"
  const other = await registry.execute("get_user_contributions", { food: "bún bò" }, { customer: { zalo_user_id: "telegram:222" }, session: null });
  const otherItems = (other.data?.data ?? other.data ?? other).items;
  assert.ok(otherItems.every((i) => i.own_contribution === false));

  const ledger = new Ledger();
  ledger.add(res.facts ?? data.facts ?? []);
  const ok = checkAnswer({ reply: "Ảnh menu bạn gửi có ghi Bún bò Huế 45.000đ (chưa xác minh).", items: [] }, ledger, { userText: "giá bún bò?" });
  assert.deepEqual(ok, []);
  const bad = checkAnswer({ reply: "Quán hiện bán Bún bò Huế 45.000đ.", items: [] }, ledger, { userText: "giá bún bò?" });
  assert.ok(bad.some((v) => v.startsWith("UNATTRIBUTED_CANDIDATE")), JSON.stringify(bad));
  const bare = checkAnswer({ reply: "Bún bò Huế giá 45.000đ nhé.", items: [] }, ledger, { userText: "giá bún bò?" });
  assert.ok(bare.some((v) => v.startsWith("UNATTRIBUTED_CANDIDATE")));
  const invented = checkAnswer({ reply: "Ảnh bạn gửi ghi 99.000đ.", items: [] }, ledger, { userText: "giá bún bò?" });
  assert.ok(invented.some((v) => v.startsWith("UNSUPPORTED_PRICE")), "an amount that is not even a candidate is still unsupported");
  const text = renderAnswer({ reply: "Ảnh menu bạn gửi có ghi Bún bò Huế 45.000đ (chưa xác minh).", items: [] }, ledger);
  assert.match(text, /ℹ️ Thông tin khách hàng cung cấp — chưa xác minh:\n• Ảnh bạn gửi \(27\/09\) có ghi Bún bò Huế 45\.000đ/);
});

test("PRECEDENCE: a candidate for a catalog product with a catalog price is hidden from other customers; the contributor still sees their own", async () => {
  const kit = contributionKit();
  const s = kit.store.create({ channel: "telegram", senderHash: kit.hasher.user("telegram", "111"), kid: "k1" });
  kit.store.addMessage(kit.store.get(s.id), { chatId: kit.hasher.chat("telegram", "111"), messageId: "1", media: [{ type: "photo", fileId: "menu_catalog_conflict.jpg" }], raw: { message: { message_id: 1 } } });
  kit.store.transition(s.id, "EXTRACTING");
  await kit.ingestion.drain();
  kit.store.transition(s.id, "CANDIDATE", { patch: { place_text: "Quán Thử Nghiệm B", place_resolution: { status: "unknown", class: "EXACT_EXISTING_MERCHANT", kbPlaceId: null, catalogMerchantId: "TESTFIXTURE001", candidates: [] }, place_message_id: kit.store.messages(s.id)[0].id } });
  kit.store.materialize(s.id, { catalogPrice: () => 70000 });
  const services = { merchantData: { listDiscoverable: () => [] }, menu: { listProducts: (m) => (m === "TESTFIXTURE001" ? [{ name: "Hủ Tiếu Xào Hải Sản", price: 70000 }] : []) } };
  const svc = new ContributionService({ ingest: { store: kit.store, hasher: kit.hasher, readers: { ocr: true } }, services, repos: null });
  const mine = svc.contributionsFor({ text: "giá hủ tiếu xào hải sản", senderHash: kit.hasher.user("telegram", "111"), merchantIds: ["cat:TESTFIXTURE001"] });
  const theirs = svc.contributionsFor({ text: "giá hủ tiếu xào hải sản", senderHash: kit.hasher.user("telegram", "222"), merchantIds: ["cat:TESTFIXTURE001"] });
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 0, "the catalog (authoritative) price wins for everyone else");
});
