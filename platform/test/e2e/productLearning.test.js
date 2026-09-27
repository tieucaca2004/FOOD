// Merchant Conversational Learning — learning from real conversation
// outcomes, over the real Telegram webhook path (SIMULATED updates; the bot
// token is blanked). Menu data is the Nôm Nôm demo; nothing here creates
// products, prices or merchants except one test-only isolation fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const NOMNOM = "DEMO_NOMNOM001";
const SEAFOOD = "Seafood Pizza - Pizza Hải Sản 28cm";

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9500) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "L" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const productId = (name) => platform.db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND name = ?`).get(NOMNOM, name).id;
  // The alias row for (phrase -> product), or null.
  const alias = (phrase, productName, merchantId = NOMNOM) =>
    platform.db
      .prepare(
        `SELECT a.* FROM merchant_product_aliases a JOIN merchant_products p ON p.id = a.product_id
         WHERE a.merchant_id = ? AND a.normalized_alias = ? AND p.name = ?`
      )
      .get(merchantId, phrase, productName) || null;
  const aliasCount = (merchantId = NOMNOM) => platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_product_aliases WHERE merchant_id = ?`).get(merchantId).n;
  const cartOf = (userId = 9500) => {
    const c = platform.repos.customers.findByZaloUserId(`telegram:${userId}`);
    return platform.services.cart.getOrCreateCart(c.id, NOMNOM).items.map((i) => [i.product_name, i.quantity]);
  };
  try {
    await fn({ platform, say, alias, aliasCount, cartOf, productId });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const open = (say, userId) => say("Xem quán Nôm Nôm", userId);
const orderPickup = async (say, userId) => {
  await say("Đặt hàng", userId);
  await say("Lấy tại quán", userId);
  const done = await say("Xác nhận", userId);
  assert.match(done, /Đã tạo đơn/);
};

// --- what is (and is not) learned -----------------------------------------------------

test("an exact product name teaches nothing — the menu already knows it", async () => {
  await withChat(async ({ say, aliasCount }) => {
    await open(say);
    await say("Thêm 1 Greek Salad - Salad Hy Lạp");
    await say("Thêm 1 Greek Salad"); // one half of the canonical name
    await say("Xem giỏ");
    assert.equal(aliasCount(), 0);
  });
});

test("a customer's own wording is recorded as OBSERVED evidence, without the quantity", async () => {
  await withChat(async ({ say, alias, platform }) => {
    await open(say);
    assert.match(await say("Cho 2 pizza hải sản"), /Đã thêm 2 × Seafood Pizza/);
    const a = alias("pizza hai san", SEAFOOD);
    assert.equal(a.alias, "pizza hải sản"); // customer's accents kept for display, no "2"/"cho"
    assert.equal(a.observed_count, 1);
    assert.equal(a.status, "OBSERVED");
    assert.equal(platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_product_aliases WHERE normalized_alias LIKE '%2%' OR normalized_alias LIKE 'cho %'`).get().n, 0);
  });
});

test("accented and unaccented wording is the same evidence (one row, no duplicates)", async () => {
  await withChat(async ({ say, alias, platform }) => {
    await open(say, 1);
    await say("Cho 1 PIZZA HẢI SẢN", 1);
    await open(say, 2);
    await say("cho 1 pizza hai san", 2);
    await open(say, 3);
    await say("thêm 1 Pizza Hải Sản nha", 3);
    assert.equal(alias("pizza hai san", SEAFOOD).observed_count, 3);
    assert.equal(platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_product_aliases WHERE normalized_alias = 'pizza hai san'`).get().n, 1);
  });
});

test("an ambiguous phrase is never learned, whatever the customer picks", async () => {
  await withChat(async ({ say, platform }) => {
    await open(say);
    assert.match(await say("Cho 2 pizza"), /món phù hợp/);
    assert.match(await say("5"), /Đã thêm 2 × Seafood Pizza/);
    await say("Xem giỏ");
    assert.equal(platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_product_aliases WHERE normalized_alias = 'pizza'`).get().n, 0);
  });
});

// --- positive and negative learning ----------------------------------------------------

test("positive outcomes: the next message not correcting it, and a placed order, confirm the phrase", async () => {
  await withChat(async ({ say, alias }) => {
    await open(say);
    await say("Cho 1 pizza hải sản");
    assert.equal(alias("pizza hai san", SEAFOOD).confirmed_count, 0);
    await say("Xem giỏ"); // carried on -> accepted
    assert.equal(alias("pizza hai san", SEAFOOD).confirmed_count, 1);
    await orderPickup(say);
    const a = alias("pizza hai san", SEAFOOD);
    assert.equal(a.confirmed_count, 2); // + order confirmed
    assert.equal(a.status, "CONFIRMED");
  });
});

test("correction: 'Không, pizza bò' undoes the wrong line, orders the right one, and rejects the phrase", async () => {
  await withChat(async ({ say, alias, cartOf }) => {
    await open(say);
    await say("Cho 2 pizza hải sản");
    const reply = await say("Không, pizza bò");
    assert.match(reply, /Dạ em đã bỏ 2 × Seafood Pizza/);
    assert.match(reply, /Đã thêm 2 × Bolognese Pizza - Bò bằm 28cm/);
    assert.deepEqual(cartOf(), [["Bolognese Pizza - Bò bằm 28cm", 2]]);
    const wrong = alias("pizza hai san", SEAFOOD);
    assert.equal(wrong.confirmed_count, 0);
    assert.equal(wrong.rejected_count, 1);
  });
});

test("choosing another product for a phrase in a clarification weakens the phrase's other mapping", async () => {
  await withChat(async ({ say, alias }) => {
    // customer 1 teaches "hải sản" -> Seafood Pizza through context (a pizza list was on screen)
    await open(say, 1);
    await say("Có pizza không?", 1);
    assert.match(await say("cho 2 cái hải sản", 1), /Đã thêm 2 × Seafood Pizza/);
    const learned = alias("hai san", SEAFOOD);
    assert.equal(learned.status, "OBSERVED");
    assert.equal(learned.rejected_count, 0);

    // customer 2, no context: "hải sản" is ambiguous -> asked, never guessed
    await open(say, 2);
    const ask = await say("cho 1 hải sản", 2);
    assert.match(ask, /món phù hợp với "hai san"/);
    const lines = ask.split("\n").filter((l) => /^\d+\. /.test(l));
    const other = lines.findIndex((l) => l.includes("Spaghetti Marirana"));
    await say(String(other + 1), 2);
    assert.equal(alias("hai san", SEAFOOD).rejected_count, 1);
    assert.equal(alias("hai san", "Spaghetti Marirana - Mì Ý hải sản"), null); // a choice never creates an alias
  });
});

test("'did you mean': a new wording is offered, not acted on; 'đúng' teaches it, 'không' blocks it", async () => {
  await withChat(async ({ say, alias, cartOf }) => {
    await open(say, 1);
    await say("Có pizza hải sản không?", 1);
    const ask = await say("Thêm 1 pizza tôm", 1); // no dish is named "pizza tôm"
    assert.match(ask, /ý anh\/chị là "Seafood Pizza - Pizza Hải Sản 28cm"/);
    assert.deepEqual(cartOf(1), []); // nothing added on a guess
    assert.match(await say("đúng", 1), /Đã thêm 1 × Seafood Pizza/);
    const taught = alias("pizza tom", SEAFOOD);
    assert.equal(taught.alias, "pizza tôm");
    assert.equal(taught.confirmed_count, 1);

    await open(say, 2);
    await say("Có pizza hải sản không?", 2);
    await say("Thêm 1 pizza mực", 2);
    assert.match(await say("không", 2), /anh\/chị muốn món nào/);
    assert.equal(alias("pizza muc", SEAFOOD).rejected_count, 1);
    assert.deepEqual(cartOf(2), []);
  });
});

test("typo: 'piza hai san' / 'coka' are suggested (never auto-added), confirmed by the customer", async () => {
  await withChat(async ({ say, cartOf }) => {
    await open(say);
    assert.match(await say("cho 1 piza hai san"), /ý anh\/chị là "Seafood Pizza - Pizza Hải Sản 28cm"/);
    assert.match(await say("đúng rồi"), /Đã thêm 1 × Seafood Pizza/);
    assert.match(await say("thêm 2 coka"), /ý anh\/chị là "COCA COLA 320ML"/);
    assert.match(await say("ok"), /Đã thêm 2 × COCA COLA 320ML/);
    assert.deepEqual(cartOf(), [
      [SEAFOOD, 1],
      ["COCA COLA 320ML", 2],
    ]);
  });
});

test("repeated rejections suppress a mapping: it is never offered again", async () => {
  await withChat(async ({ platform, say, alias, productId }) => {
    const ctx = { merchantId: NOMNOM, customerId: null, phrase: "pizza muc", productId: productId(SEAFOOD), source: "correction" };
    platform.services.productLanguage.observe(ctx);
    for (let i = 0; i < 3; i++) platform.services.productLanguage.reject(ctx);
    assert.equal(alias("pizza muc", SEAFOOD).status, "SUPPRESSED");
    await open(say);
    assert.match(await say("Cho 1 pizza mực"), /không tìm thấy món/); // no suggestion from the suppressed alias
  });
});

// --- the self-learning loop (phase 5 simulation) --------------------------------------------

test("SIMULATION: the same conversation with different wording, by different customers, strengthens 'pizza tôm' to TRUSTED", async () => {
  await withChat(async ({ platform, say, alias, cartOf }) => {
    // before any learning, the marketplace doesn't know "pizza tôm"
    assert.match(await say("Tìm pizza tôm", 1), /chưa tìm thấy quán/);

    // conversation 1 — taught through context + explicit confirmation
    assert.match(await say("Tôi muốn ăn pizza", 11), /\[DEMO\] NÔM NÔM RESTAURANT/);
    assert.match(await say("Có pizza hải sản không?", 11), /Dạ có ạ: Seafood Pizza/);
    assert.match(await say("Cho 2 cái", 11), /Đã thêm 2 × Seafood Pizza/);
    assert.match(await say("Thêm 1 pizza tôm", 11), /ý anh\/chị là "Seafood Pizza/);
    assert.match(await say("đúng", 11), /Đã thêm 1 × Seafood Pizza/);
    assert.deepEqual(cartOf(11), [[SEAFOOD, 3]]);
    await orderPickup(say, 11);
    let a = alias("pizza tom", SEAFOOD);
    assert.equal(a.status, "CONFIRMED"); // "đúng" + order placed

    // conversation 2 — another customer, other wording: understood immediately now
    await say("Tìm pizza", 12);
    assert.match(await say("cho tui 1 cái pizza tôm", 12), /Đã thêm 1 × Seafood Pizza/);
    await orderPickup(say, 12);

    // conversation 3 — a third customer, no accents
    await say("tim pizza", 13);
    assert.match(await say("2 pizza tom", 13), /Đã thêm 2 × Seafood Pizza/);
    await orderPickup(say, 13);

    a = alias("pizza tom", SEAFOOD);
    assert.equal(a.status, "TRUSTED");
    assert.ok(a.confidence >= 0.7, String(a.confidence));
    assert.equal(a.rejected_count, 0);

    // TRUSTED language this merchant's customers use now also finds it in discovery
    assert.match(await say("Tìm pizza tôm", 14), /\[DEMO\] NÔM NÔM RESTAURANT/);

    // observability: grouped by product
    const learned = platform.services.productLanguage.listForMerchant(NOMNOM);
    const seafood = learned.find((p) => p.productName === SEAFOOD);
    assert.ok(seafood.aliases.some((x) => x.alias === "pizza tôm" && x.status === "TRUSTED"));
    assert.ok(seafood.aliases.some((x) => x.alias === "pizza hải sản"));
  });
});

test("even a TRUSTED alias for a phrase that names several dishes is only suggested, never applied silently", async () => {
  await withChat(async ({ platform, say, productId, cartOf }) => {
    // "hải sản" names several Nôm Nôm dishes; evidence says customers mean Seafood Pizza
    const pid = productId(SEAFOOD);
    for (const customerId of [null, null, null]) {
      platform.services.productLanguage.confirm({ merchantId: NOMNOM, customerId, phrase: "hai san", productId: pid, source: "manual" });
    }
    await open(say);
    const ask = await say("cho 1 hải sản");
    assert.match(ask, /ý anh\/chị là "Seafood Pizza/); // the learned answer is offered first…
    assert.deepEqual(cartOf(), []); // …but nothing is added on it
    assert.match(await say("đúng"), /Đã thêm 1 × Seafood Pizza/);
  });
});

test("a single customer repeating a phrase can make it CONFIRMED but never TRUSTED", async () => {
  await withChat(async ({ say, alias }) => {
    for (let i = 0; i < 4; i++) {
      await open(say);
      await say("Cho 1 pizza hải sản");
      await orderPickup(say);
    }
    const a = alias("pizza hai san", SEAFOOD);
    assert.ok(a.confirmed_count >= 5);
    assert.equal(a.status, "CONFIRMED");
  });
});

// --- priority, safety, isolation -------------------------------------------------------------

test("a learned alias never overrides an exact product name", async () => {
  await withChat(async ({ platform, say, productId }) => {
    // evidence (forced for the test) claiming "carbonara" means Seafood Pizza
    const ctx = { merchantId: NOMNOM, customerId: null, phrase: "carbonara", productId: productId(SEAFOOD), source: "manual" };
    for (let i = 0; i < 3; i++) platform.services.productLanguage.confirm(ctx);
    await open(say);
    assert.match(await say("Cho 1 Carbonara"), /Đã thêm 1 × Carbonara - Mì sốt kem trứng/);
  });
});

test("inactive product: its alias is ignored and never re-pointed to another product", async () => {
  await withChat(async ({ platform, say, productId, cartOf }) => {
    const ctx = { merchantId: NOMNOM, customerId: null, phrase: "pizza tom", productId: productId(SEAFOOD), source: "manual" };
    for (let i = 0; i < 3; i++) platform.services.productLanguage.confirm(ctx);
    platform.services.menu.setProductAvailability(NOMNOM, productId(SEAFOOD), false);
    await open(say);
    const reply = await say("Cho 1 pizza tôm");
    assert.doesNotMatch(reply, /Đã thêm/);
    assert.deepEqual(cartOf(), []);
    platform.services.menu.setProductAvailability(NOMNOM, productId(SEAFOOD), true);
    assert.match(await say("Cho 1 pizza tôm"), /Đã thêm 1 × Seafood Pizza/); // same product again, nothing re-pointed
  });
});

test("merchant isolation: one merchant's learned language never applies to another", async () => {
  await withChat(async ({ platform, say, productId, aliasCount }) => {
    platform.repos.merchants.create({ merchantId: "LEARNFIXTURE01", name: "Quán Học Thử (Test Fixture)", slug: "quan-hoc-thu", module: "generic", status: "ACTIVE", address: "1 Đường Thử" });
    platform.db.prepare(`INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES ('LEARNFIXTURE01','free','ACTIVE',datetime('now'))`).run();
    platform.repos.merchantProducts.create("LEARNFIXTURE01", { sku: "PZ-BO", name: "Pizza Bò", price: 90000, available: true });
    platform.repos.merchantProducts.create("LEARNFIXTURE01", { sku: "PZ-GA", name: "Pizza Gà", price: 90000, available: true });

    const ctx = { merchantId: NOMNOM, customerId: null, phrase: "pizza tom", productId: productId(SEAFOOD), source: "manual" };
    for (let i = 0; i < 3; i++) platform.services.productLanguage.confirm(ctx);

    await say("Xem quán Học Thử");
    const reply = await say("Cho 1 pizza tôm");
    assert.doesNotMatch(reply, /Seafood|Đã thêm/);
    assert.equal(aliasCount("LEARNFIXTURE01"), 0);
    assert.equal(platform.services.productLanguage.listForMerchant("LEARNFIXTURE01").length, 0);
  });
});

test("customer isolation: B's 'đúng' never answers A's 'did you mean'", async () => {
  await withChat(async ({ say, alias, cartOf }) => {
    await open(say, 1);
    await say("Có pizza hải sản không?", 1);
    await say("Thêm 1 pizza tôm", 1); // A is asked
    await open(say, 2);
    await say("đúng", 2);
    assert.deepEqual(cartOf(2), []);
    assert.equal(alias("pizza tom", SEAFOOD), null); // nothing learned from B's message
    assert.match(await say("đúng", 1), /Đã thêm 1 × Seafood Pizza/);
  });
});

test("A Tiểu (legacy module) is untouched: no language is learned or used there", async () => {
  await withChat(async ({ say, aliasCount }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    assert.match(await say("Cho tôi 2 hủ tiếu xào bò"), /× 2/);
    assert.equal(aliasCount("ATIEU001"), 0);
  });
});

test("learning events keep only the normalized phrase — never the customer's message", async () => {
  await withChat(async ({ platform, say }) => {
    await open(say);
    await say("Cho tui 2 cái pizza hải sản nha em");
    const events = platform.db.prepare(`SELECT * FROM product_alias_events`).all();
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.equal(e.normalized_phrase, "pizza hai san");
      assert.ok(!Object.values(e).some((v) => typeof v === "string" && /cho tui|nha em/.test(v)));
    }
    // retention: nothing recent is pruned; events past the 90-day window are
    assert.equal(platform.services.productLanguage.pruneEvents(), 0);
    platform.db.prepare(`UPDATE product_alias_events SET created_at = datetime('now', '-91 days')`).run();
    assert.equal(platform.services.productLanguage.pruneEvents(), events.length);
    // the learned evidence itself (the alias row) is kept
    assert.equal(platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_product_aliases`).get().n > 0, true);
  });
});
