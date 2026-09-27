// Multimodal V1 — PHASE 9–17 gate: customer contributions through the REAL Telegram and Zalo webhooks of the test
// platform: photo -> server storage -> reading -> pending submission -> merchant / confirmation -> candidates;
// image + caption, catalog conflict, multi-turn, cancel, unsupported media, albums, merchant-context safety,
// failures, privacy. SYNTHETIC fixtures, fake reader / media download / sender — no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { FixtureImageUnderstanding, fixtureFetcher, dumpAll, TEST_HASH_KEY } from "../helpers/contributionKit.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { createContributionIngest } from "../../services/knowledgeIngestAdapter.js";
import { ContributionService } from "../../services/contributionService.js";
import { isAllowedZaloUrl } from "../../channel/zalo/zaloMedia.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const ZALO_HOSTS = ["zdn.vn", "zadn.vn"];

async function withChannels(fn, { reader = new FixtureImageUnderstanding(), fetchFail = null, maxImagesPerDay = 20, genericFixture = true, coalesceMs = 0 } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const runtimeFile = nhaTrangKnowledge(); // what customers read (read-only adapter)
  const workingFile = nhaTrangKnowledge(); // where contributions are written (the collector's working DB)
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-contrib-e2e-"));
  const sent = [];
  const fetchTelegram = fixtureFetcher({ fail: fetchFail });
  const fetchZalo = async (url) => {
    if (!isAllowedZaloUrl(url, ZALO_HOSTS)) throw Object.assign(new Error("zalo media url not allowed"), { permanent: true });
    return fetchTelegram(new URL(url).pathname.slice(1));
  };
  let ingest;
  const platform = buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    withGenericFixture: genericFixture,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: runtimeFile, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    contributions: ({ services, repos, foodKnowledge }) => {
      ingest = createContributionIngest({ dbPath: workingFile, rawRoot, hashKey: TEST_HASH_KEY, ...reader.asReaders(), fetchTelegram, fetchZalo });
      return new ContributionService({ ingest, services, repos, foodKnowledge, send: async (target, text) => sent.push({ ...target, text }), coalesceMs, maxImagesPerDay });
    },
  });
  const server = await startServer(platform.app);
  let seq = 100;
  const post = async (url, body, headers = {}) => {
    const res = await fetch(`${baseUrl(server)}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const tg = {
    text: async (text, userId = 777) => {
      seq += 1;
      return (await post(platformConfig.telegramWebhookPath, { update_id: seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "Khách", last_name: "Thử" }, chat: { id: userId, type: "private" }, date: 1790499540, text } }, { "x-telegram-bot-api-secret-token": TEST_SECRET })).body;
    },
    photo: async (file, { caption = null, userId = 777, mediaGroupId = null, updateId = null, document = false } = {}) => {
      seq += 1;
      const media = document ? { document: { file_id: file, mime_type: file.endsWith(".png") ? "image/png" : "image/jpeg", file_size: 1000 } } : { photo: [{ file_id: `thumb-${file}`, file_size: 10, width: 90, height: 70 }, { file_id: file, file_size: 50000, width: 900, height: 700 }] };
      return (await post(platformConfig.telegramWebhookPath, { update_id: updateId ?? seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "Khách" }, chat: { id: userId, type: "private" }, date: 1790499540, ...(caption && { caption }), ...(mediaGroupId && { media_group_id: mediaGroupId }), ...media } }, { "x-telegram-bot-api-secret-token": TEST_SECRET })).body;
    },
    voice: async (userId = 777) => {
      seq += 1;
      return (await post(platformConfig.telegramWebhookPath, { update_id: seq, message: { message_id: seq, from: { id: userId }, chat: { id: userId, type: "private" }, date: 1, voice: { file_id: "v1", duration: 3 } } }, { "x-telegram-bot-api-secret-token": TEST_SECRET })).body;
    },
  };
  const zalo = {
    image: async (file, { text = null, userId = "zalo-user-1", host = "photo-stal.zdn.vn" } = {}) => {
      seq += 1;
      return (await post(platformConfig.webhookPath, { app_id: "1", event_name: "user_send_image", sender: { id: userId }, recipient: { id: "oa" }, timestamp: "1790499540000", message: { msg_id: `zm${seq}`, ...(text && { text }), attachments: [{ type: "image", payload: { url: `https://${host}/${file}`, thumbnail: `https://${host}/t.jpg` } }] } })).body;
    },
    text: async (text, userId = "zalo-user-1") => {
      seq += 1;
      return (await post(platformConfig.webhookPath, { app_id: "1", event_name: "user_send_text", sender: { id: userId }, recipient: { id: "oa" }, timestamp: "1790499540000", message: { msg_id: `zm${seq}`, text } })).body;
    },
  };
  const idle = () => platform.contributionService.idle();
  const catalog = () => platform.db.prepare(`SELECT merchant_id, name, price FROM merchant_products ORDER BY id`).all();
  const kdb = () => ingest.store.db;
  const lastSent = () => sent.at(-1)?.text ?? null;
  try {
    await fn({ platform, tg, zalo, sent, idle, catalog, kdb, lastSent, rawRoot, ingest, reader, fetchTelegram });
  } finally {
    server.close();
    ingest?.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

test("TELEGRAM photo + caption -> stored on the server -> read -> ask the merchant -> answer -> candidates (unverified); catalog untouched", async () => {
  await withChannels(async ({ tg, idle, sent, catalog, kdb, lastSent, rawRoot }) => {
    const before = catalog();
    const published45 = kdb().prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published' AND price = 45000`).get().n;
    const r = await tg.photo("menu_clean.jpg", { caption: "Đây là menu mới" });
    assert.equal(r.status, "processed");
    assert.match(r.reply_text, /đã nhận ảnh, đang đọc/);
    await idle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "telegram");
    assert.match(lastSent(), /ảnh này có vẻ là menu/);
    assert.match(lastSent(), /Bún bò Huế — 45\.000đ/);
    assert.match(lastSent(), /Bánh hỏi — 40\.000đ/);
    assert.match(lastSent(), /Bạn muốn lưu cho quán nào/);
    // the original is on the server, content-addressed
    const media = kdb().prepare(`SELECT * FROM kb_ingest_media`).all();
    assert.equal(media.length, 1);
    assert.ok(fs.existsSync(path.join(rawRoot, media[0].storage_ref)));
    const s = kdb().prepare(`SELECT * FROM kb_ingest_submissions`).get();
    assert.equal(s.status, "WAITING_FOR_MERCHANT");
    const answer = await tg.text("Quán Bún Mẫu Thử");
    assert.match(answer.reply_text, /đã lưu 4 thông tin cho Bún Mẫu Thử làm nguồn tham khảo \(chưa xác minh\)/);
    assert.match(answer.reply_text, /chưa có trong dữ liệu/);
    const cands = kdb().prepare(`SELECT kind, product_text, normalized_value, status, assertion_kind, place_text FROM kb_ingest_candidates ORDER BY id`).all();
    assert.equal(cands.length, 4);
    assert.ok(cands.every((c) => c.status === "review" && c.assertion_kind === "OBSERVED" && c.place_text === "Bún Mẫu Thử"));
    assert.equal(kdb().prepare(`SELECT status FROM kb_ingest_submissions`).get().status, "CANDIDATE");
    assert.deepEqual(catalog(), before, "the FOOD catalog is never changed");
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published' AND price = 45000`).get().n, published45, "nothing published");
  });
});

test("GPT-off retrieval: 'Giá bún bò bao nhiêu?' — the answer keeps the normal result and adds the own contribution, labelled unverified", async () => {
  await withChannels(async ({ tg, idle }) => {
    await tg.photo("menu_clean.jpg");
    await idle();
    await tg.text("Quán Bún Mẫu Thử");
    const q = await tg.text("Giá bún bò bao nhiêu?");
    assert.match(q.reply_text, /Thông tin khách hàng cung cấp — chưa xác minh/);
    assert.match(q.reply_text, /Ảnh bạn gửi \(\d\d\/\d\d\) có ghi Bún bò Huế 45\.000đ — Bún Mẫu Thử/);
    assert.doesNotMatch(q.reply_text, /Quán hiện bán Bún bò Huế 45/);
    // another customer sees it only as an anonymous, unverified contribution — never who sent it
    const other = await tg.text("Giá bún bò bao nhiêu?", 888);
    assert.doesNotMatch(other.reply_text ?? "", /Ảnh bạn gửi/);
    assert.doesNotMatch(other.reply_text ?? "", /777|Khách/);
  });
});

test("CATALOG CONFLICT (image): the catalog price stays; both are kept; the customer is told both, and that the official price did not change", async () => {
  await withChannels(async ({ tg, idle, lastSent, catalog, kdb }) => {
    const before = catalog();
    await tg.photo("menu_catalog_conflict.jpg");
    await idle();
    assert.match(lastSent(), /menu của Quán Thử Nghiệm B/);
    assert.match(lastSent(), /dữ liệu menu hiện tại của quán đang ghi 70\.000đ, còn ảnh bạn gửi ghi 65\.000đ/);
    assert.match(lastSent(), /Bạn có muốn lưu/);
    const done = await tg.text("có");
    assert.match(done.reply_text, /Dữ liệu menu hiện tại của quán đang ghi 70\.000đ, còn ảnh bạn gửi ghi 65\.000đ\. Mình đã lưu làm nguồn tham khảo nhưng chưa thay đổi giá chính thức\./);
    const c = kdb().prepare(`SELECT change, severity, previous_value, catalog_merchant_id FROM kb_ingest_candidates`).get();
    assert.deepEqual(c, { change: "CONFLICT", severity: "HIGH", previous_value: "70000", catalog_merchant_id: "TESTFIXTURE001" });
    assert.deepEqual(catalog(), before);
    assert.equal(catalog().find((p) => p.merchant_id === "TESTFIXTURE001").price, 70000);
  });
});

test("TEXT contribution vs query: a statement asks for confirmation; a question goes to the normal search; nothing stored for queries", async () => {
  await withChannels(async ({ tg, kdb }) => {
    const q = await tg.text("Quán nào bán bún cá?");
    assert.doesNotMatch(q.reply_text, /lưu làm thông tin tham khảo/);
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_submissions`).get().n, 0);
    const c = await tg.text("Quán Thử Nghiệm B bán Hủ Tiếu Xào Hải Sản 65k");
    assert.match(c.reply_text, /Quán Thử Nghiệm B/);
    assert.match(c.reply_text, /đang ghi 70\.000đ, còn ảnh bạn gửi ghi 65\.000đ|đang ghi 70\.000đ/);
    const ok = await tg.text("lưu");
    assert.match(ok.reply_text, /còn tin nhắn bạn gửi ghi 65\.000đ/);
    assert.equal(kdb().prepare(`SELECT assertion_kind FROM kb_ingest_candidates`).get().assertion_kind, "USER_ASSERTION");
  });
});

test("MULTI-TURN: correction, cancel, an unrelated question while waiting passes to the normal conversation", async () => {
  await withChannels(async ({ tg, idle, lastSent, kdb }) => {
    await tg.photo("merchant_sign.jpg");
    await idle();
    // the sign names an EXISTING knowledge place -> confirmation question
    assert.match(lastSent(), /biển hiệu quán của Bún cá Cô Ba/i);
    assert.match(lastSent(), /Tên quán: BÚN CÁ CÔ BA/);
    const unrelated = await tg.text("tìm bún cá");
    assert.doesNotMatch(unrelated.reply_text, /lưu/);
    assert.equal(kdb().prepare(`SELECT status FROM kb_ingest_submissions`).get().status, "WAITING_FOR_CONFIRMATION", "still waiting");
    const bye = await tg.text("bỏ qua");
    assert.match(bye.reply_text, /không lưu/);
    assert.equal(kdb().prepare(`SELECT status FROM kb_ingest_submissions`).get().status, "CANCELLED");
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates`).get().n, 0);
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 1, "the image stays as evidence");
    // correction
    await tg.photo("menu_small.png", { document: true });
    await idle();
    const fix = await tg.text("không, quán Bún Cá Cô Ba");
    assert.match(fix.reply_text, /đã lưu 1 thông tin cho Bún cá Cô Ba/i);
    const events = kdb().prepare(`SELECT to_status FROM kb_ingest_submission_events WHERE submission_id = 2 ORDER BY id`).all().map((e) => e.to_status);
    assert.deepEqual(events, ["RECEIVED", "EXTRACTING", "WAITING_FOR_MERCHANT", "CANDIDATE"]);
  });
});

test("ALBUM / DUPLICATE / UNSUPPORTED: one ack per album, a redelivered update is deduped, a voice note gets a clear reply", async () => {
  await withChannels(async ({ tg, idle, sent, kdb }) => {
    const a = await tg.photo("menu_clean.jpg", { mediaGroupId: "alb1" });
    const b = await tg.photo("menu_angled.jpg", { mediaGroupId: "alb1" });
    assert.match(a.reply_text, /đang đọc/);
    assert.equal(b.reply_text, null, "the second photo of the album is not acked again");
    await idle();
    assert.equal(sent.length, 1, "one summary for the album");
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_messages`).get().n, 2);
    const dup = await tg.photo("menu_clean.jpg", { updateId: 999 });
    const again = await tg.photo("menu_clean.jpg", { updateId: 999 });
    assert.equal(dup.status, "processed");
    assert.ok(["duplicate", "processed"].includes(again.status));
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 2, "same image -> same stored file");
    const v = await tg.voice();
    assert.match(v.reply_text, /chỉ đọc được ảnh/);
  }, { coalesceMs: 300 });
});

test("MERCHANT CONTEXT: while ordering, 'có' goes to the ordering engine — only 'lưu' / 'bỏ qua' answer a pending contribution", async () => {
  await withChannels(async ({ tg, idle, kdb, platform }) => {
    await tg.photo("merchant_sign.jpg");
    await idle();
    await tg.text("Menu A Tiểu");
    const s = platform.db.prepare(`SELECT context FROM platform_sessions ORDER BY id DESC LIMIT 1`).get();
    assert.equal(s.context, "merchant", "the customer is inside A Tiểu (ordering)");
    {
      await tg.text("có");
      assert.equal(kdb().prepare(`SELECT status FROM kb_ingest_submissions`).get().status, "WAITING_FOR_CONFIRMATION", "'có' was not taken as a contribution answer");
      const saved = await tg.text("lưu");
      assert.match(saved.reply_text, /đã lưu/);
    }
  });
});

test("ZALO image -> the same pipeline: stored, read, asked, confirmed; the reply goes back through the Zalo sender", async () => {
  await withChannels(async ({ zalo, idle, sent, kdb, lastSent }) => {
    const r = await zalo.image("menu_clean.jpg", { text: "menu quán Bún Mẫu Thử" });
    assert.equal(r.status, "processed");
    assert.match(r.reply_text, /đã nhận ảnh/);
    await idle();
    assert.equal(sent[0].channel, "zalo");
    assert.equal(sent[0].userId, "zalo-user-1");
    assert.match(lastSent(), /Bún bò Huế — 45\.000đ/);
    const a = await zalo.text("Quán Bún Mẫu Thử");
    assert.match(a.reply_text, /đã lưu 4 thông tin/);
    assert.equal(kdb().prepare(`SELECT channel FROM kb_ingest_messages LIMIT 1`).get().channel, "zalo");
    // a URL outside the Zalo CDN is never fetched (SSRF guard)
    await zalo.image("menu_clean.jpg", { host: "evil.example.com", userId: "zalo-user-2" });
    await idle();
    assert.match(lastSent(), /không mở được|chưa tải được/);
  });
});

test("FAILURES: corrupt image, download failure, reader failure — safe replies, evidence metadata kept, webhook never 500", async () => {
  await withChannels(
    async ({ tg, idle, lastSent, kdb }) => {
      const r = await tg.photo("corrupt_truncated.jpg");
      assert.equal(r.status, "processed");
      await idle();
      assert.match(lastSent(), /không mở được/);
      await tg.photo("missing.jpg", { userId: 700 });
      await idle();
      assert.match(lastSent(), /chưa tải được ảnh|trục trặc khi đọc ảnh, em sẽ thử lại/, "a failed download is retried, never a crash");
      assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_messages`).get().n, 2);
    },
    {}
  );
  await withChannels(
    async ({ tg, idle, lastSent, kdb }) => {
      await tg.photo("menu_clean.jpg");
      await idle();
      assert.match(lastSent(), /trục trặc khi đọc ảnh/);
      assert.equal(kdb().prepare(`SELECT status FROM kb_ingest_submissions`).get().status, "EXTRACTING");
      assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 1, "the image is stored even though reading failed");
    },
    { reader: new FixtureImageUnderstanding({ fail: () => Object.assign(new Error("image understanding timed out")) }) }
  );
});

test("PRIVACY + RATE LIMIT: no raw Telegram id / name anywhere in the knowledge DB or files; caps per person per day", async () => {
  await withChannels(
    async ({ tg, idle, kdb, rawRoot }) => {
      await tg.photo("menu_clean.jpg", { caption: "menu quán Bún Mẫu Thử", userId: 424242 });
      await idle();
      await tg.text("Quán Bún Mẫu Thử", 424242);
      const dump = dumpAll(kdb(), rawRoot);
      assert.ok(!dump.includes("424242"));
      assert.ok(!dump.includes("Khách"));
      await tg.photo("menu_angled.jpg", { userId: 424242 });
      const limited = await tg.photo("menu_blurry.jpg", { userId: 424242 });
      assert.match(limited.reply_text, /nhiều ảnh/);
    },
    { maxImagesPerDay: 2 }
  );
});

test("ERASE: 'xoá ảnh của tôi' deletes the person's files (hash rows stay) and rejects their open candidates", async () => {
  await withChannels(async ({ tg, idle, kdb, rawRoot }) => {
    await tg.photo("menu_clean.jpg", { caption: "menu quán Bún Mẫu Thử" });
    await idle();
    await tg.text("Quán Bún Mẫu Thử");
    const ref = kdb().prepare(`SELECT storage_ref FROM kb_ingest_media`).get().storage_ref;
    const r = await tg.text("xoá ảnh của tôi");
    assert.match(r.reply_text, /đã xoá/);
    assert.ok(!fs.existsSync(path.join(rawRoot, ref)));
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates WHERE status = 'review'`).get().n, 0);
    assert.ok(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_purges`).get().n >= 2);
    assert.equal(kdb().prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 1, "the hash row stays");
  });
});

test("REGRESSION: with contributions ON, plain text flows (search, A Tiểu menu) answer exactly as without", async () => {
  const replies = [];
  const run = async (on) => {
    const out = [];
    await withChannels(async ({ tg }) => {
      for (const t of ["tìm bún cá", "Menu A Tiểu", "quay lại", "hello"]) out.push((await tg.text(t)).reply_text);
    });
    replies.push(out);
  };
  await run(true);
  // the same platform without the contribution wrapper
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withGenericFixture: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const server = await startServer(platform.app);
  const out = [];
  let seq = 100;
  for (const t of ["tìm bún cá", "Menu A Tiểu", "quay lại", "hello"]) {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET }, body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: 777, first_name: "Khách" }, chat: { id: 777, type: "private" }, date: 1790499540, text: t } }) });
    out.push((await res.json()).reply_text);
  }
  server.close();
  platformConfig.telegramWebhookSecret = originalSecret;
  assert.deepEqual(replies[0], out);
});
