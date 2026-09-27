// Multimodal V1 — service-level failure / edge flows: ambiguous merchant, unknown dish, missing price, expiry,
// a finished reading delivered on the next message (e.g. after a restart). SYNTHETIC data, fake reader / sender.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contributionKit } from "../helpers/contributionKit.js";
import { ContributionService } from "../../services/contributionService.js";
import { classifyContributionText, classifyReply } from "../../knowledge/ingestion/contributionIntent.js";

function service(kit, { now } = {}) {
  const sent = [];
  const ingest = { store: kit.store, ingestion: kit.ingestion, hasher: kit.hasher, readers: { ocr: true, vision: true }, classifyText: classifyContributionText, classifyReply, drain: () => kit.ingestion.drain() };
  const services = { merchantData: { listDiscoverable: () => [] }, menu: { listProducts: () => [] } };
  const svc = new ContributionService({ ingest, services, repos: null, send: async (t, text) => sent.push(text), coalesceMs: 0, ...(now && { now }) });
  const router = { handle: async ({ text }) => ({ replyText: `ROUTER:${text}`, session: { id: 1, context: "platform" } }) };
  const customer = { zalo_user_id: "telegram:555" };
  const session = { id: 1, context: "platform" };
  // 555 is an authorised contributor; a contribution image is "# <caption>"
  kit.ingestion.setContributor({ channel: "telegram", userId: kit.hasher.user("telegram", "555"), role: "editor", addedBy: "test" });
  const photo = (file, caption = null, id = String(Math.random())) =>
    svc.handle({ customer, session, text: caption ?? "", inbound: { channel: "telegram", updateId: id, messageId: id, externalUserId: "555", externalChatId: "555", timestamp: 1790499540, text: `# ${caption ?? ""}`.trim(), attachments: [{ type: "image", ref: file, mimeType: "image/jpeg" }], mediaGroupId: null, unsupported: null } }, router);
  const say = (text) => svc.handle({ customer, session, text }, router);
  return { svc, sent, photo, say };
}

const twoQuanA = (db) => {
  for (const [i, addr] of [["1", "1 Trần Phú, Nha Trang"], ["2", "9 Lê Lợi, Nha Trang"]]) {
    db.prepare(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, 'Quán Mẫu A', 'quan mau a', 'candidate', '2026-09-26', '2026-09-26')`).run(`quan-mau-a-${i}`);
    const m = db.prepare(`SELECT id FROM kb_merchants WHERE key = ?`).get(`quan-mau-a-${i}`).id;
    const src = db.prepare(`INSERT INTO kb_sources (url, source_type, fetched_at, content_type, content_hash, raw_path) VALUES (?, 'blog', '2026-09-01', 'text/html', ?, 'raw/x')`).run(`https://blog.example/${i}`, `h${i}`).lastInsertRowid;
    const ev = db.prepare(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, 'q', 'explicit', 'verified')`).run(src).lastInsertRowid;
    db.prepare(`INSERT INTO kb_merchant_locations (merchant_id, address_original, region_id, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, 'vn.khanh-hoa.nha-trang', ?, '2026-09-26', '2026-09-26', 'published')`).run(m, addr, ev);
  }
};

test("AMBIGUOUS MERCHANT: never merged silently — options listed, asked again, then saved unresolved for the reviewer", async () => {
  const kit = contributionKit({ extra: twoQuanA });
  const { svc, sent, photo, say } = service(kit);
  await photo("menu_small.png", "menu Quán Mẫu A");
  await svc.idle();
  assert.match(sent.at(-1), /mấy quán tên “Quán Mẫu A”: 1\) Quán Mẫu A — 1 Trần Phú, Nha Trang; 2\) Quán Mẫu A — 9 Lê Lợi, Nha Trang/);
  const again = await say("Quán Mẫu A");
  assert.match(again.replyText, /mấy quán tên/);
  const saved = await say("Quán Mẫu A");
  assert.match(saved.replyText, /đã lưu 1 thông tin/);
  const c = kit.store.candidates(1)[0];
  assert.equal(c.place_resolution.status, "ambiguous");
  assert.equal(c.resolved_kb_merchant_id, null, "not attached to either place");
  assert.equal(c.change, "UNCERTAIN");
  assert.equal(c.severity, "HIGH");
});

test("UNKNOWN DISH + MISSING PRICE: the name as written is kept, no canonical food invented, no price invented", async () => {
  const kit = contributionKit();
  const { svc, photo, say } = service(kit);
  await photo("menu_blurry.jpg", "menu quán Bún Mẫu Thử");
  await svc.idle();
  await say("Quán Bún Mẫu Thử");
  const cands = kit.store.candidates(1);
  const bun = cands.find((c) => c.product_text === "Bún bò Huế");
  assert.equal(bun.kind, "product");
  assert.equal(bun.normalized_value, "bun bo hue");
  assert.equal(bun.food_entity_id, null, "no resolver given -> no canonical dish guessed");
  assert.ok(!cands.some((c) => c.kind === "price" && c.product_text === "Bún bò Huế"));
});

test("EXPIRY: a question left unanswered expires; a later 'có' is a normal message again", async () => {
  let now = new Date("2026-09-27T09:00:00Z");
  const kit = contributionKit({ now: () => now });
  const { svc, photo, say } = service(kit, { now: () => now });
  await photo("merchant_sign.jpg");
  await svc.idle();
  assert.equal(kit.store.get(1).status, "WAITING_FOR_CONFIRMATION");
  now = new Date("2026-09-27T10:00:00Z");
  const r = await say("có");
  assert.equal(r.replyText, "ROUTER:có");
  assert.equal(kit.store.get(1).status, "EXPIRED");
  assert.equal(kit.store.candidates(1).length, 0);
  assert.ok(kit.store.events(1).some((e) => e.to_status === "EXPIRED" && e.reason === "pending_ttl"));
});

test("RESTART: a reading finished but never delivered is delivered with the customer's next message", async () => {
  const kit = contributionKit();
  const { svc, photo, say } = service(kit);
  await photo("menu_clean.jpg", "menu quán Bún Mẫu Thử");
  // simulate a restart: the scheduled reading is lost before it ran
  for (const [, t] of svc._timers) clearTimeout(t.timer);
  svc._timers.clear();
  await kit.ingestion.drain();
  assert.equal(kit.store.get(1).status, "EXTRACTING");
  const r = await say("Quán Bún Mẫu Thử");
  assert.match(r.replyText, /đã lưu 4 thông tin/);
});

test("LIMIT: at most 5 images of one album are stored; the rest are dropped without a reply", async () => {
  const kit = contributionKit();
  const { svc } = service(kit);
  const router = { handle: async () => ({ replyText: "ROUTER", session: {} }) };
  const send = (i) =>
    svc.handle({ customer: { zalo_user_id: "telegram:555" }, session: { id: 1, context: "platform" }, text: "", inbound: { channel: "telegram", updateId: `u${i}`, messageId: `m${i}`, externalUserId: "555", externalChatId: "555", timestamp: 1790499540, text: i === 1 ? "#" : null, attachments: [{ type: "image", ref: "menu_clean.jpg", mimeType: "image/jpeg" }], mediaGroupId: "album-1", unsupported: null } }, router);
  const replies = [];
  for (let i = 1; i <= 7; i++) replies.push(await send(i));
  assert.equal(kit.store.messages(1).length, 5);
  assert.deepEqual(replies.slice(5).map((r) => r.contribution.status), ["album_limit", "album_limit"]);
  assert.ok(replies.slice(1).every((r) => r.replyText === null), "one ack per album");
  await svc.idle();
});
