// Regression: a delivery address must never be parsed as food.
// Live bug: inside A Tiểu, "chuyển về / giao qua / giao hàng đến 76 Nguyễn
// Thị Minh Khai" all got "Dạ em chưa rõ ý … (tên món, số lượng)".
// Driven through the real Telegram webhook path (SIMULATED updates; the bot
// token is blanked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { understandMessage } from "../../conversation/understand.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const NOMNOM = "DEMO_NOMNOM001";
const ADDRESS = "76 Nguyễn Thị Minh Khai";

const PHRASES = [
  "giao qua 76 Nguyễn Thị Minh Khai",
  "giao tới 76 Nguyễn Thị Minh Khai",
  "giao đến 76 Nguyễn Thị Minh Khai",
  "giao hàng đến 76 Nguyễn Thị Minh Khai",
  "chuyển về 76 Nguyễn Thị Minh Khai",
  "ship tới 76 Nguyễn Thị Minh Khai",
  "gửi tới 76 Nguyễn Thị Minh Khai",
  "địa chỉ giao là 76 Nguyễn Thị Minh Khai",
  "giao hàng cho tôi tại 76 Nguyễn Thị Minh Khai",
  "địa chỉ của tôi là 76 Nguyễn Thị Minh Khai",
  "A ken chuyển về 76 Nguyễn Thị Minh Khai",
];
const UNACCENTED = PHRASES.map((p) => p.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D"));

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9700) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "D" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const platformCustomer = (userId = 9700) => platform.repos.customers.findByZaloUserId(`telegram:${userId}`);
  const nomnomCheckout = (userId = 9700) => {
    const cart = platform.services.cart.getOrCreateCart(platformCustomer(userId).id, NOMNOM);
    return platform.repos.cartCheckout.getByCart(cart.id);
  };
  const atieuCart = () =>
    platform.atieuCtx.db.prepare(`SELECT p.name, ci.quantity FROM cart_items ci JOIN products p ON p.id = ci.product_id ORDER BY ci.id`).all().map((r) => [r.name, r.quantity]);
  try {
    await fn({ platform, say, nomnomCheckout, atieuCart, platformCustomer });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const NOT_FOOD = /tên món, số lượng|không tìm thấy món|chưa có món|chưa tìm thấy/;

// --- parsing ------------------------------------------------------------------------

test("every delivery phrasing, accented and not, is an address — never a product request", () => {
  for (const phrase of [...PHRASES, ...UNACCENTED]) {
    const msg = understandMessage(phrase);
    assert.equal(msg.intent, "provide_delivery_address", phrase);
    assert.equal(stripped(msg.address), stripped(ADDRESS), phrase);
  }
});

function stripped(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
}

test("an order and an address in one message: neither part is lost", () => {
  const combined = understandMessage("giao 2 phần hủ tiếu đến 76 Nguyễn Thị Minh Khai");
  assert.deepEqual([combined.intent, combined.items, combined.address], ["add_to_cart", ["2 phần hủ tiếu"], ADDRESS]);
  const live = understandMessage("cho 2 đặc biệt + 1 thập cẩm, gửi về 76 Nguyễn thị Minh Khai, phone 98339999, 4h30 chiều nay");
  assert.deepEqual(live.items, ["cho 2 đặc biệt", "1 thập cẩm"]);
  assert.equal(live.address, "76 Nguyễn thị Minh Khai");
  assert.equal(live.invalidPhone, "98339999"); // 8 digits: flagged, never stored as a phone
  assert.equal(live.note, "4h30 chiều nay");
  assert.equal(understandMessage("cho 2 hủ tiếu").intent, "add_to_cart"); // plain orders are untouched
});

// --- A Tiểu (legacy module with its own checkout) -----------------------------------------

test("A Tiểu LIVE SEQUENCE: 'thêm 2 thập cẩm' → 'giao qua 76 …' → 'tổng bao nhiêu' → 'xem lại' keeps cart and address", async () => {
  await withChat(async ({ say, atieuCart }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    assert.match(await say("thêm 2 thập cẩm"), /Hủ Tiếu Xào Thập Cẩm × 2/);

    let reply = await say("giao qua 76 Nguyễn Thị Minh Khai");
    assert.doesNotMatch(reply, NOT_FOOD);
    assert.match(reply, /Dạ em đã ghi nhận địa chỉ giao hàng:\n📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.deepEqual(atieuCart(), [["Hủ Tiếu Xào Thập Cẩm", 2]]); // cart untouched

    reply = await say("tổng bao nhiêu");
    assert.match(reply, /Tạm tính: 120\.000đ/);
    assert.match(reply, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);

    reply = await say("xem lại");
    assert.match(reply, /Hủ Tiếu Xào Thập Cẩm × 2/);
    assert.match(reply, /120\.000đ/);
    assert.match(reply, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
  });
});

test("A Tiểu: the address given early answers A Tiểu's own checkout questions, and lands on its order", async () => {
  await withChat(async ({ platform, say }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    await say("thêm 2 thập cẩm");
    await say("chuyển về 76 Nguyễn Thị Minh Khai");
    const asked = await say("Đặt");
    // fulfillment ("giao hàng") and address were answered from what the customer said; only the phone is asked
    assert.match(asked, /Dạ em dùng thông tin anh\/chị đã cho:\n📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.match(asked, /số điện thoại/);
    assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
    assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
    const order = platform.atieuCtx.db.prepare(`SELECT fulfillment_type, delivery_address, customer_phone, status FROM orders`).get();
    assert.deepEqual(order, { fulfillment_type: "delivery", delivery_address: ADDRESS, customer_phone: "0912345678", status: "CONFIRMED" });
  });
});

test("A Tiểu: while its checkout asks for the address, 'giao hàng đến 76 …' gives just the address", async () => {
  await withChat(async ({ platform, say }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    await say("thêm 1 bò");
    await say("Đặt");
    assert.match(await say("giao hàng"), /địa chỉ giao hàng/); // A Tiểu's own question
    const reply = await say("giao hàng đến 76 Nguyễn Thị Minh Khai");
    assert.doesNotMatch(reply, NOT_FOOD);
    await say("0912345678");
    await say("Xác nhận");
    assert.equal(platform.atieuCtx.db.prepare(`SELECT delivery_address FROM orders`).get().delivery_address, ADDRESS);
  });
});

test("A Tiểu: plain product ordering still goes to its engine unchanged", async () => {
  await withChat(async ({ say, atieuCart }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    assert.match(await say("Cho tôi 2 hủ tiếu xào bò"), /× 2/);
    assert.match(await say("cho 2 đặc biệt + 1 thập cẩm, gửi về 76 Nguyễn thị Minh Khai, phone 98339999, 4h30 chiều nay"), /76 Nguyễn thị Minh Khai[\s\S]*98339999/);
    assert.deepEqual(atieuCart(), [
      ["Hủ Tiếu Xào Bò", 2],
      ["Hủ Tiếu Xào Đặc Biệt", 2],
      ["Hủ Tiếu Xào Thập Cẩm", 1],
    ]);
  });
});

// --- generic engine (Nôm Nôm) ---------------------------------------------------------

test("generic: every phrasing after add_to_cart stores the address on the current cart", async () => {
  for (const phrase of [...PHRASES, ...UNACCENTED]) {
    await withChat(async ({ say, nomnomCheckout }) => {
      await say("Xem quán Nôm Nôm");
      await say("Cho 1 coca");
      const reply = await say(phrase);
      assert.doesNotMatch(reply, NOT_FOOD, phrase);
      assert.match(reply, /Dạ em đã ghi nhận địa chỉ giao hàng:/, phrase);
      const checkout = nomnomCheckout();
      assert.equal(checkout.fulfillment_type, "delivery");
      assert.equal(stripped(checkout.delivery_address), stripped(ADDRESS), phrase);
    });
  }
});

test("generic: order + address in one message adds the item AND stores the address", async () => {
  await withChat(async ({ say, nomnomCheckout, platform, platformCustomer }) => {
    await say("Xem quán Nôm Nôm");
    const reply = await say("giao 2 pizza hải sản đến 76 Nguyễn Thị Minh Khai");
    assert.match(reply, /Đã thêm 2 × Seafood Pizza/);
    assert.match(reply, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.equal(nomnomCheckout().delivery_address, ADDRESS);
    const cart = platform.services.cart.getOrCreateCart(platformCustomer().id, NOMNOM);
    assert.deepEqual(cart.items.map((i) => [i.product_name, i.quantity]), [["Seafood Pizza - Pizza Hải Sản 28cm", 2]]);
  });
});

test("generic: a bare '76 Nguyễn Thị Minh Khai' answering the address question is the address", async () => {
  await withChat(async ({ say, nomnomCheckout }) => {
    await say("Xem quán Nôm Nôm");
    await say("Cho 1 coca");
    assert.match(await say("Đặt món"), /cho em xin địa chỉ giao hàng/);
    const summary = await say("76 Nguyễn Thị Minh Khai");
    assert.match(summary, /kiểm tra lại đơn[\s\S]*📍 Giao tới: 76 Nguyễn Thị Minh Khai[\s\S]*xác nhận đặt đơn này/);
    assert.equal(nomnomCheckout().delivery_address, ADDRESS);
  });
});

test("generic: outside checkout a bare address is asked about, never searched in the menu", async () => {
  await withChat(async ({ say, nomnomCheckout }) => {
    await say("Xem quán Nôm Nôm");
    const ask = await say("76 Nguyễn Thị Minh Khai");
    assert.match(ask, /"76 Nguyễn Thị Minh Khai" là địa chỉ giao hàng phải không/);
    assert.doesNotMatch(ask, NOT_FOOD);
    assert.match(await say("đúng"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.equal(nomnomCheckout().delivery_address, ADDRESS);
    // a quantity + real dish is still an order, not an address
    assert.match(await say("2 pizza hải sản"), /Đã thêm 2 × Seafood Pizza/);
  });
});

test("generic LIVE SEQUENCE equivalent: add → address → total → review shows products, prices and address", async () => {
  await withChat(async ({ say }) => {
    await say("Xem quán Nôm Nôm");
    await say("thêm 2 coca");
    assert.match(await say("giao qua 76 Nguyễn Thị Minh Khai"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    const total = await say("tổng bao nhiêu");
    assert.match(total, /Tổng tạm tính: 44\.000đ \(2 phần\)/);
    assert.match(total, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    const review = await say("xem lại");
    assert.match(review, /2 × COCA COLA 320ML — 22\.000đ = 44\.000đ/);
    assert.match(review, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
  });
});

// --- isolation ------------------------------------------------------------------------------

test("customer isolation: one customer's address never appears for another", async () => {
  await withChat(async ({ say, nomnomCheckout }) => {
    await say("Xem quán Nôm Nôm", 1);
    await say("Cho 1 coca", 1);
    await say("giao qua 76 Nguyễn Thị Minh Khai", 1);
    await say("Xem quán Nôm Nôm", 2);
    await say("Cho 1 coca", 2);
    assert.doesNotMatch(await say("xem lại", 2), /Minh Khai/);
    assert.equal(nomnomCheckout(2), null);
    assert.equal(nomnomCheckout(1).delivery_address, ADDRESS);
  });
});

test("merchant isolation: an address given at A Tiểu is not applied at Nôm Nôm, and vice versa", async () => {
  await withChat(async ({ say, nomnomCheckout }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    await say("thêm 1 bò");
    await say("giao qua 76 Nguyễn Thị Minh Khai");
    await say("Quay lại tổng đài");
    await say("Xem quán Nôm Nôm");
    await say("Cho 1 coca");
    assert.doesNotMatch(await say("xem lại"), /Minh Khai/);
    assert.equal(nomnomCheckout(), null);
  });
});
