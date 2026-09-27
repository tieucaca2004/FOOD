// A Tiểu (ATIEU001) served by the GENERIC merchant engine — the same
// GenericMerchantAdapter + ConversationalOrderingEngine as Nôm Nôm, over its
// real catalog (platform/db/catalog/atieu_menu.json, imported by the real
// platform seed with atieuEngine "generic"). Driven through the real
// Telegram webhook path (SIMULATED updates; the bot token is blanked).
// The legacy A Tiểu module is not involved here; its own tests keep
// covering it unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const ATIEU = "ATIEU001";
const NOMNOM = "DEMO_NOMNOM001";

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9700) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "T" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const customerId = (userId = 9700) => platform.repos.customers.findByZaloUserId(`telegram:${userId}`).id;
  const cart = (merchantId = ATIEU, userId = 9700) => platform.services.cart.getOrCreateCart(customerId(userId), merchantId);
  const cartOf = (merchantId = ATIEU, userId = 9700) => cart(merchantId, userId).items.map((i) => [i.product_name, i.quantity]);
  const orders = (merchantId = ATIEU) => platform.db.prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY id`).all(merchantId);
  const aliases = (merchantId) =>
    platform.db
      .prepare(`SELECT a.normalized_alias AS phrase, p.name, a.status, a.confirmed_count FROM merchant_product_aliases a JOIN merchant_products p ON p.id = a.product_id WHERE a.merchant_id = ?`)
      .all(merchantId);
  const productId = (name, merchantId = ATIEU) => platform.db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND name = ?`).get(merchantId, name).id;
  try {
    await fn({ platform, say, customerId, cart, cartOf, orders, aliases, productId });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const openAtieu = async (say, userId) => {
  const reply = await say("Xem quán A Tiểu", userId);
  assert.match(reply, /Đã mở Hủ Tiếu Xào A Tiểu/);
  return reply;
};

// Several phrases, each a fresh customer, each resolved on its own.
async function eachFresh(say, texts, check) {
  let userId = 9800;
  for (const text of texts) {
    userId += 1;
    await openAtieu(say, userId);
    await check(await say(text, userId), text, userId);
  }
}

// --- ROUTING --------------------------------------------------------------------------

test("A Tiểu runs on the generic engine: generic module, generic adapter, same engine as Nôm Nôm", async () => {
  await withChat(async ({ platform }) => {
    assert.equal(platform.repos.merchants.getById(ATIEU).module, "generic");
    const adapter = platform.registry.getAdapter(ATIEU);
    assert.equal(adapter.constructor.name, "GenericMerchantAdapter");
    assert.equal(adapter.supportsConversationalOrdering, true);
    assert.equal(adapter.engine.constructor, platform.registry.getAdapter(NOMNOM).engine.constructor);
    assert.equal(platform.atieuCtx, null); // the legacy module is not even built
  });
});

// --- DISCOVERY + MENU ---------------------------------------------------------------------

test("DISCOVERY: 'tìm hủ tiếu hải sản' finds A Tiểu by its dishes", async () => {
  await withChat(async ({ say }) => {
    const reply = await say("tìm hủ tiếu hải sản");
    assert.match(reply, /HỦ TIẾU XÀO A TIỂU/);
    assert.match(reply, /HỦ TIẾU XÀO HẢI SẢN/);
    assert.doesNotMatch(reply, /NÔM NÔM/);
  });
});

test("MENU: opening A Tiểu and 'menu' / 'thực đơn' / 'có món gì' / 'quán có gì' show the 13 categories, not 76 lines", async () => {
  await withChat(async ({ say }) => {
    const opened = await openAtieu(say);
    assert.match(opened, /76 món, 13 nhóm/);
    assert.match(opened, /• HỦ TIẾU XÀO \(5 món\)/);
    assert.doesNotMatch(opened, /THÊM TÔM/);
    for (const text of ["menu", "thực đơn", "có món gì", "quán có gì"]) {
      const reply = await say(text);
      assert.match(reply, /76 món, 13 nhóm/, text);
      for (const c of ["HỦ TIẾU XÀO", "MÌ XÀO GIÒN", "CƠM CHÁY", "MÓN NƯỚC", "GỌI THÊM", "NƯỚC UỐNG"]) assert.match(reply, new RegExp(`• ${c} \\(`), `${text}: ${c}`);
      assert.ok(reply.split("\n").length < 25, `${text}: compact`);
    }
  });
});

test("MENU: drill down — 'cho xem hủ tiếu' / 'cho xem cơm' / 'cho xem món nước'", async () => {
  await withChat(async ({ say }) => {
    await openAtieu(say);
    const hu = await say("cho xem hủ tiếu");
    assert.match(hu, /HỦ TIẾU XÀO:/);
    assert.match(hu, /HỦ TIẾU XÀO HẢI SẢN: 75\.000đ/);
    assert.match(hu, /HỦ TIẾU XÀO THẬP CẨM ĐẶC BIỆT: 70\.000đ/);
    assert.doesNotMatch(hu, /CƠM/);
    const com = await say("cho xem cơm");
    for (const c of ["CƠM CÁNH GÀ:", "CƠM XÀO:", "CƠM CHIÊN:", "CƠM CHÁY:"]) assert.match(com, new RegExp(c));
    assert.match(com, /CƠM CHIÊN CUA: 80\.000đ/);
    const nuoc = await say("cho xem món nước");
    assert.match(nuoc, /MÓN NƯỚC:/);
    assert.match(nuoc, /SÚP HOÀNH THÁNH: 50\.000đ/);
    assert.doesNotMatch(nuoc, /NƯỚC UỐNG/);
    // after browsing a category, its plain dish is what "2 hải sản" means
    await say("cho xem hủ tiếu");
    assert.match(await say("cho 2 hải sản"), /Đã thêm 2 × HỦ TIẾU XÀO HẢI SẢN \(75\.000đ\)/);
  });
});

// --- SEARCH ------------------------------------------------------------------------------

test("SEARCH: exact, natural, no-accent and quantity phrases add the right dish", async () => {
  await withChat(async ({ say, cartOf }) => {
    const cases = [
      ["cho 1 HỦ TIẾU XÀO HẢI SẢN", "HỦ TIẾU XÀO HẢI SẢN", 1],
      ["cho tôi hủ tiếu hải sản", "HỦ TIẾU XÀO HẢI SẢN", 1],
      ["2 hủ tiếu hải sản", "HỦ TIẾU XÀO HẢI SẢN", 2],
      ["cho 2 phần hủ tiếu hải sản", "HỦ TIẾU XÀO HẢI SẢN", 2],
      ["2 hu tieu hai san", "HỦ TIẾU XÀO HẢI SẢN", 2],
      ["  CHO 2   Hủ Tiếu, hải sản!! ", "HỦ TIẾU XÀO HẢI SẢN", 2],
      ["cho 1 hủ tiếu bò", "HỦ TIẾU XÀO BÒ", 1],
      ["cho 1 hủ tiếu thập cẩm", "HỦ TIẾU XÀO THẬP CẨM", 1],
      ["cho 1 mì giòn hải sản", "MÌ XÀO GIÒN HẢI SẢN", 1],
      ["cho 1 mì mềm bò", "MÌ XÀO MỀM BÒ", 1],
      ["cho 1 phở chiên hải sản", "PHỞ CHIÊN GIÒN HẢI SẢN", 1],
      ["cho 1 cơm chiên cua", "CƠM CHIÊN CUA", 1],
      ["cho 1 hủ tiếu hải sản đặc biệt", "HỦ TIẾU XÀO HẢI SẢN ĐẶC BIỆT", 1],
    ];
    let userId = 9800;
    for (const [text, name, qty] of cases) {
      userId += 1;
      await openAtieu(say, userId);
      assert.match(await say(text, userId), new RegExp(`Đã thêm ${qty} × ${name} \\(`), text);
      assert.deepEqual(cartOf(ATIEU, userId), [[name, qty]], text);
    }
  });
});

test("SEARCH: a bare dish name answers with that dish and its catalog price", async () => {
  await withChat(async ({ say }) => {
    await eachFresh(say, ["hủ tiếu hải sản", "mì giòn hải sản", "phở chiên hải sản"], (reply, text) => {
      assert.match(reply, /Dạ có ạ: (HỦ TIẾU XÀO HẢI SẢN|MÌ XÀO GIÒN HẢI SẢN|PHỞ CHIÊN GIÒN HẢI SẢN) — 75\.000đ/, text);
    });
  });
});

// --- AMBIGUITY ----------------------------------------------------------------------------

test("AMBIGUITY: 'thập cẩm', 'cơm hải sản', 'sủi cảo', 'sting' ask — nothing is added", async () => {
  await withChat(async ({ say, cartOf }) => {
    const expect = {
      "cho 1 thập cẩm": ["HỦ TIẾU XÀO THẬP CẨM", "MÌ XÀO GIÒN THẬP CẨM", "MÌ XÀO MỀM THẬP CẨM", "PHỞ CHIÊN GIÒN THẬP CẨM", "MIẾN THẬP CẨM", "CƠM CHÁY SỐT THẬP CẨM"],
      "cho 1 cơm hải sản": ["CƠM XÀO HẢI SẢN", "CƠM CHIÊN HẢI SẢN", "CƠM CHÁY HẢI SẢN"],
      "cho 1 sủi cảo": ["SỦI CẢO BÒ VIÊN", "SỦI CẢO CHIÊN", "SỦI CẢO CHIÊN TÔM", "SÚP SỦI CẢO"],
      "cho 1 sting": ["REVIVE / FANTA / STING", "STING DÂU"],
      "thập cẩm": ["HỦ TIẾU XÀO THẬP CẨM", "MIẾN THẬP CẨM"],
      sting: ["REVIVE / FANTA / STING", "STING DÂU"],
    };
    let userId = 9800;
    for (const [text, names] of Object.entries(expect)) {
      userId += 1;
      await openAtieu(say, userId);
      const reply = await say(text, userId);
      assert.match(reply, /món phù hợp/, text);
      assert.match(reply, /chọn món nào/, text);
      for (const n of names) assert.ok(reply.includes(n), `${text}: ${n}`);
      assert.deepEqual(cartOf(ATIEU, userId), [], `${text}: nothing guessed`);
    }
  });
});

test("AMBIGUITY: the customer's choice is what gets added", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openAtieu(say);
    const ask = await say("cho 2 cơm hải sản");
    assert.match(ask, /1\. CƠM XÀO HẢI SẢN: 75\.000đ\n2\. CƠM CHIÊN HẢI SẢN: 75\.000đ\n3\. CƠM CHÁY HẢI SẢN: 75\.000đ/);
    assert.match(await say("2"), /Đã thêm 2 × CƠM CHIÊN HẢI SẢN/);
    await say("cho 1 sting");
    assert.match(await say("sting dâu"), /Đã thêm 1 × STING DÂU/);
    assert.deepEqual(cartOf(), [
      ["CƠM CHIÊN HẢI SẢN", 2],
      ["STING DÂU", 1],
    ]);
  });
});

// --- ADD-ONS ----------------------------------------------------------------------------------

test("ADD-ON: 'thêm tôm/bò/mực/cật/cua/trứng' add the GỌI THÊM products at catalog prices", async () => {
  await withChat(async ({ say, cartOf, cart }) => {
    await openAtieu(say);
    const cases = [
      ["thêm tôm", "THÊM TÔM", "50.000đ"],
      ["thêm bò", "THÊM BÒ", "35.000đ"],
      ["thêm mực", "THÊM MỰC", "40.000đ"],
      ["thêm cật", "THÊM CẬT", "30.000đ"],
      ["thêm cua", "THÊM CUA", "60.000đ"],
      ["thêm trứng", "TRỨNG ỐP LA", "9.000đ"],
    ];
    for (const [text, name, price] of cases) {
      assert.match(await say(text), new RegExp(`Đã thêm 1 × ${name} \\(${price.replace(".", "\\.")}\\)`), text);
    }
    assert.deepEqual(cartOf(), cases.map(([, name]) => [name, 1]));
    assert.equal(cart().total, 50000 + 35000 + 40000 + 30000 + 60000 + 9000);
    assert.match(await say("thêm 2 tôm"), /Đã thêm 2 × THÊM TÔM/);
    assert.deepEqual(cartOf()[0], ["THÊM TÔM", 3]);
  });
});

// --- CONTEXT ------------------------------------------------------------------------------------

test("CONTEXT: product → 'thêm 2 phần' → 'tổng bao nhiêu' → 'xem lại'", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openAtieu(say);
    assert.match(await say("cho tôi hủ tiếu hải sản"), /Đã thêm 1 × HỦ TIẾU XÀO HẢI SẢN \(75\.000đ\)/);
    assert.match(await say("thêm 2 phần"), /HỦ TIẾU XÀO HẢI SẢN thành 3/);
    assert.deepEqual(cartOf(), [["HỦ TIẾU XÀO HẢI SẢN", 3]]);
    assert.match(await say("tổng bao nhiêu"), /Tổng tạm tính: 225\.000đ \(3 phần\)/);
    const review = await say("xem lại");
    assert.match(review, /3 × HỦ TIẾU XÀO HẢI SẢN — 75\.000đ = 225\.000đ/);
    assert.match(review, /Tạm tính: 225\.000đ/);
  });
});

test("CONTEXT: a bare quantity after a product question orders that product", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openAtieu(say);
    await say("có mì mềm bò không");
    assert.match(await say("2 phần"), /Đã thêm 2 × MÌ XÀO MỀM BÒ/);
    assert.deepEqual(cartOf(), [["MÌ XÀO MỀM BÒ", 2]]);
  });
});

// --- CART + ORDER -------------------------------------------------------------------------------

test("CART + ORDER: 2 hủ tiếu hải sản + 1 cơm chiên cua → total → address → confirm → order", async () => {
  await withChat(async ({ platform, say, cartOf, orders, customerId }) => {
    await openAtieu(say);
    await say("cho 2 hủ tiếu hải sản");
    await say("thêm 1 cơm chiên cua");
    assert.deepEqual(cartOf(), [
      ["HỦ TIẾU XÀO HẢI SẢN", 2],
      ["CƠM CHIÊN CUA", 1],
    ]);
    assert.match(await say("tổng bao nhiêu"), /Tổng tạm tính: 230\.000đ \(3 phần\)/);
    assert.match(await say("đặt món"), /cho em xin địa chỉ giao hàng/);
    assert.match(await say("giao qua 76 Nguyễn Thị Minh Khai"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai[\s\S]*xác nhận/);
    const done = await say("xác nhận");
    assert.match(done, /Đã tạo đơn TD-/);
    assert.match(done, /Tổng: 230\.000đ/);
    const [order] = orders();
    assert.equal(order.total, 230000);
    assert.equal(order.customer_id, customerId());
    const items = platform.db.prepare(`SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id`).all(order.id);
    assert.deepEqual(items.map((i) => ({ ...i })), [
      { product_name: "HỦ TIẾU XÀO HẢI SẢN", quantity: 2, unit_price: 75000 },
      { product_name: "CƠM CHIÊN CUA", quantity: 1, unit_price: 80000 },
    ]);
    const checkout = platform.repos.cartCheckout.getByCart(order.cart_id);
    assert.equal(checkout.delivery_address, "76 Nguyễn Thị Minh Khai");
    assert.deepEqual(cartOf(), []); // a fresh cart for the next order
  });
});

// --- ADDRESS --------------------------------------------------------------------------------------

test("ADDRESS: address alone ('giao qua …' / 'giao hàng đến …') is stored, never searched as food", async () => {
  await withChat(async ({ say, cart, platform }) => {
    await openAtieu(say);
    assert.match(await say("giao qua 76 Nguyễn Thị Minh Khai"), /Dạ em đã ghi nhận địa chỉ giao hàng:\n📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.equal(platform.repos.cartCheckout.getByCart(cart().id).delivery_address, "76 Nguyễn Thị Minh Khai");
    assert.match(await say("giao hàng đến 12 Trần Phú"), /📍 Giao tới: 12 Trần Phú/);
    assert.equal(platform.repos.cartCheckout.getByCart(cart().id).delivery_address, "12 Trần Phú");
    assert.deepEqual(cart().items, []);
  });
});

test("ADDRESS: order + address in one message keeps both", async () => {
  await withChat(async ({ say, cartOf, cart, platform, orders }) => {
    await openAtieu(say);
    const reply = await say("cho 2 hủ tiếu hải sản giao qua 76 Nguyễn Thị Minh Khai");
    assert.match(reply, /Đã thêm 2 × HỦ TIẾU XÀO HẢI SẢN/);
    assert.match(reply, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.deepEqual(cartOf(), [["HỦ TIẾU XÀO HẢI SẢN", 2]]);
    assert.equal(platform.repos.cartCheckout.getByCart(cart().id).delivery_address, "76 Nguyễn Thị Minh Khai");
    assert.match(await say("đặt món"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai[\s\S]*gõ "xác nhận"/);
    assert.match(await say("xác nhận"), /Đã tạo đơn/);
    assert.equal(orders()[0].total, 150000);
  });
});

// --- LEARNING ---------------------------------------------------------------------------------------

test("LEARNING: A Tiểu phrases feed the existing learning engine, per merchant only", async () => {
  await withChat(async ({ say, aliases }) => {
    await openAtieu(say);
    await say("cho 1 mì giòn hải sản");
    await say("đặt món");
    await say("lấy tại quán");
    assert.match(await say("xác nhận"), /Đã tạo đơn/);
    const learned = aliases(ATIEU).find((a) => a.phrase === "mi gion hai san");
    assert.equal(learned.name, "MÌ XÀO GIÒN HẢI SẢN");
    assert.ok(learned.confirmed_count >= 1);
    assert.deepEqual(aliases(NOMNOM), []);
  });
});

test("LEARNING: a choice among several dishes never becomes an alias ('thập cẩm')", async () => {
  await withChat(async ({ say, aliases }) => {
    await openAtieu(say);
    await say("cho 1 thập cẩm");
    assert.match(await say("1"), /Đã thêm 1 × HỦ TIẾU XÀO THẬP CẨM/);
    await say("đặt món");
    await say("lấy tại quán");
    await say("xác nhận");
    assert.equal(aliases(ATIEU).filter((a) => a.phrase === "thap cam").length, 0);
  });
});

test("LEARNING: learned language never overrides an exact catalog name", async () => {
  await withChat(async ({ platform, say, productId }) => {
    // strongest evidence possible, pointing the wrong way
    const row = platform.repos.productAliases.ensure(ATIEU, productId("CƠM XÀO BÒ"), "hủ tiếu xào bò", "hu tieu xao bo");
    platform.repos.productAliases.saveCounts(row.id, { observed_count: 9, confirmed_count: 9, rejected_count: 0, confidence: 0.9, status: "TRUSTED" });
    await openAtieu(say);
    assert.match(await say("cho 1 hủ tiếu xào bò"), /Đã thêm 1 × HỦ TIẾU XÀO BÒ \(65\.000đ\)/);
  });
});

test("LEARNING: established customer language outranks the plain-dish rule among its variants", async () => {
  await withChat(async ({ platform, say, productId }) => {
    const row = platform.repos.productAliases.ensure(ATIEU, productId("HỦ TIẾU XÀO HẢI SẢN ĐẶC BIỆT"), "hủ tiếu hải sản", "hu tieu hai san");
    platform.repos.productAliases.saveCounts(row.id, { observed_count: 6, confirmed_count: 6, rejected_count: 0, confidence: 0.75, status: "TRUSTED" });
    await openAtieu(say);
    assert.match(await say("cho 1 hủ tiếu hải sản"), /Đã thêm 1 × HỦ TIẾU XÀO HẢI SẢN ĐẶC BIỆT/);
  });
});

// --- ISOLATION ------------------------------------------------------------------------------------

test("ISOLATION: A Tiểu and Nôm Nôm never see each other's products, carts, orders or aliases", async () => {
  await withChat(async ({ say, cartOf, orders, aliases, platform }) => {
    await openAtieu(say);
    assert.match(await say("cho 1 seafood pizza"), /không tìm thấy món/);
    await say("cho 2 hủ tiếu hải sản");
    assert.match(await say("quay lại tổng đài"), /quay lại Tổng Đài/);
    assert.match(await say("Xem quán Nôm Nôm"), /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    assert.match(await say("cho 1 hủ tiếu xào hải sản"), /không tìm thấy món/);
    assert.match(await say("thêm tôm"), /không tìm thấy món|món phù hợp/);
    assert.doesNotMatch(await say("xem giỏ"), /HỦ TIẾU XÀO HẢI SẢN/);
    await say("cho 1 coca");
    assert.deepEqual(cartOf(NOMNOM), [["COCA COLA 320ML", 1]]);
    assert.deepEqual(cartOf(ATIEU), [["HỦ TIẾU XÀO HẢI SẢN", 2]]);
    await say("đặt món");
    await say("lấy tại quán");
    assert.match(await say("xác nhận"), /Đã tạo đơn/);
    assert.equal(orders(NOMNOM).length, 1);
    assert.equal(orders(ATIEU).length, 0);
    const nomnomItems = platform.db.prepare(`SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.merchant_id = ?`).all(NOMNOM);
    const atieuIds = new Set(platform.db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ?`).all(ATIEU).map((r) => r.id));
    assert.ok(nomnomItems.every((i) => !atieuIds.has(i.product_id)));
    assert.ok(aliases(NOMNOM).every((a) => !/hu tieu/.test(a.phrase)));
    assert.ok(aliases(ATIEU).every((a) => !/coca/.test(a.phrase)));
  });
});

test("ISOLATION: discovery keeps each merchant's dishes with that merchant", async () => {
  await withChat(async ({ platform }) => {
    const pizza = await platform.agentSearch.searchProducts("pizza hải sản");
    assert.ok(pizza.length > 0);
    assert.ok(pizza.every((r) => r.merchant_id === NOMNOM));
    const hu = await platform.agentSearch.searchProducts("hủ tiếu hải sản");
    assert.ok(hu.some((r) => r.merchant_id === ATIEU && r.product_name === "HỦ TIẾU XÀO HẢI SẢN"));
    assert.ok(hu.every((r) => r.merchant_id === ATIEU));
    const within = await platform.agentSearch.searchProducts("pizza", { merchantId: ATIEU });
    assert.deepEqual(within, []);
  });
});
