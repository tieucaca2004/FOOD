// Conversational Ordering Engine — multi-turn behavior over the real
// Telegram webhook path (SIMULATED updates; the bot token is blanked).
//
// The reference dialogue talks about sủi cảo, which no real FOOD merchant
// sells, so a TEST-ONLY generic merchant with such dishes is created here
// (same pattern as the MERCHANT002/003 fixtures) — never seeded anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const FIXTURE = "CONVOFIXTURE01";

function addFixtureMerchant(platform) {
  platform.repos.merchants.create({
    merchantId: FIXTURE,
    name: "Quán Sủi Cảo Mẫu (Test Fixture)",
    slug: "quan-sui-cao-mau-test",
    module: "generic",
    status: "ACTIVE",
    address: "12 Đường Thử Nghiệm, Nha Trang",
  });
  platform.db.prepare(`INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES (?, 'free', 'ACTIVE', datetime('now'))`).run(FIXTURE);
  const products = [
    ["SC-TOM", "Sủi Cảo Chiên Tôm", 45000],
    ["SC-BOVIEN", "Sủi Cảo Xíu Xíu Bò Viên", 50000],
    ["SC-THIT", "Sủi Cảo Hấp Thịt", 40000],
    ["TOM-RANG", "Tôm Rang Me", 80000],
    ["HT-NV", "Hủ Tiếu Nam Vang", 55000],
    ["TRA-DA", "Trà Đá", 5000],
  ];
  products.forEach(([sku, name, price], i) => platform.repos.merchantProducts.create(FIXTURE, { sku, name, price, available: true, sortOrder: i + 1 }));
}

async function withChat(fn, { fixture = true } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  if (fixture) addFixtureMerchant(platform);
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9000) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "K" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const customerId = (userId = 9000) => platform.repos.customers.findByZaloUserId(`telegram:${userId}`).id;
  const cartOf = (merchantId, userId = 9000) =>
    platform.services.cart
      .getOrCreateCart(customerId(userId), merchantId)
      .items.map((i) => [i.product_name, i.quantity]);
  const orderCount = (merchantId) => platform.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ?`).get(merchantId).n;
  try {
    await fn({ platform, say, customerId, cartOf, orderCount });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const openFixture = async (say, userId) => {
  const reply = await say("Cho tôi toàn bộ menu Quán Sủi Cảo Mẫu", userId);
  assert.match(reply, /Đã mở Quán Sủi Cảo Mẫu/);
};

// --- the reference dialogue ------------------------------------------------------

test("REFERENCE FLOW (generic engine): search → product question → menu → sủi cảo → '2 tôm / 3 bò viên' → address → total → order", async () => {
  await withChat(async ({ platform, say, cartOf, orderCount }) => {
    // 1. search: several merchants sell hủ tiếu — listed, none chosen for the customer
    let reply = await say("Tôi muốn ăn hủ tiếu");
    assert.match(reply, /HỦ TIẾU XÀO A TIỂU/);
    assert.match(reply, /QUÁN SỦI CẢO MẪU/);

    // 2. "Có hủ tiếu không?" — answered within the merchants just found, not a blind re-search
    reply = await say("Có hủ tiếu không?");
    assert.match(reply, /trong các quán vừa tìm, món "hu tieu" có ở/);
    assert.match(reply, /Hủ Tiếu Nam Vang: 55\.000đ/);
    assert.match(reply, /chọn quán nào/);

    // 3. full menu by name
    reply = await say("Cho tôi toàn bộ menu Quán Sủi Cảo Mẫu");
    assert.match(reply, /Đã mở Quán Sủi Cảo Mẫu \(Test Fixture\)/);
    assert.match(reply, /Sủi Cảo Chiên Tôm: 45\.000đ/);

    // 4. product question scoped to THIS merchant
    reply = await say("Có sủi cảo không?");
    assert.match(reply, /3 món phù hợp với "sui cao"/);
    assert.doesNotMatch(reply, /Pizza|A Tiểu/);

    // 5. two items in one message; "tôm" is resolved by context (the sủi cảo
    //    just listed) even though "Tôm Rang Me" also exists
    reply = await say("Cho 2 tôm / 3 bò viên");
    assert.match(reply, /Đã thêm 2 × Sủi Cảo Chiên Tôm/);
    assert.match(reply, /Đã thêm 3 × Sủi Cảo Xíu Xíu Bò Viên/);
    assert.deepEqual(cartOf(FIXTURE), [
      ["Sủi Cảo Chiên Tôm", 2],
      ["Sủi Cảo Xíu Xíu Bò Viên", 3],
    ]);

    // 6. address, verbatim
    reply = await say("Giao qua 7 Nguyễn Thiện Thuật");
    assert.match(reply, /📍 Giao tới: 7 Nguyễn Thiện Thuật/);

    // 7. total from the real cart
    reply = await say("Tổng bao nhiêu?");
    assert.match(reply, /Tổng tạm tính: 240\.000đ \(5 phần\)/);

    // 8. summary: merchant, lines with unit price + line total, total, address
    reply = await say("Đặt món");
    assert.match(reply, /Quán Sủi Cảo Mẫu \(Test Fixture\)/);
    assert.match(reply, /2 × Sủi Cảo Chiên Tôm — 45\.000đ = 90\.000đ/);
    assert.match(reply, /3 × Sủi Cảo Xíu Xíu Bò Viên — 50\.000đ = 150\.000đ/);
    assert.match(reply, /Tạm tính: 240\.000đ/);
    assert.match(reply, /📍 Giao tới: 7 Nguyễn Thiện Thuật/);
    assert.match(reply, /xác nhận đặt đơn này/);
    assert.equal(orderCount(FIXTURE), 0);

    // 9. confirm
    reply = await say("Xác nhận");
    assert.match(reply, /✅ Đã tạo đơn TD-/);
    assert.match(reply, /Tổng: 240\.000đ/);
    assert.equal(orderCount(FIXTURE), 1);
    const order = platform.db.prepare(`SELECT * FROM orders WHERE merchant_id = ?`).get(FIXTURE);
    assert.equal(order.total, 240000);
    assert.equal(platform.repos.cartCheckout.getByCart(order.cart_id).delivery_address, "7 Nguyễn Thiện Thuật");
  });
});

test("REFERENCE FLOW on the real A Tiểu data (legacy module): honest answers, its own cart, nothing invented", async () => {
  await withChat(
    async ({ platform, say }) => {
      await say("Tôi muốn ăn hủ tiếu");
      let reply = await say("Có hủ tiếu không?");
      assert.match(reply, /Hủ Tiếu Xào A Tiểu/);
      assert.match(reply, /Hủ Tiếu Xào Bò: 65\.000đ/);

      reply = await say("Cho tôi toàn bộ menu A Tiểu");
      assert.match(reply, /Đã mở Hủ Tiếu Xào A Tiểu/);

      // A Tiểu sells no sủi cảo — said plainly, never another merchant's dish
      reply = await say("Có sủi cảo không?");
      assert.match(reply, /quán chưa có món "sui cao"/);
      assert.doesNotMatch(reply, /Nôm Nôm|Pizza/);

      // two items in one message, handed to A Tiểu's own engine one at a time
      reply = await say("Cho 2 bò / 3 hải sản");
      const items = platform.atieuCtx.db.prepare(`SELECT p.name, ci.quantity FROM cart_items ci JOIN products p ON p.id = ci.product_id ORDER BY ci.id`).all();
      assert.deepEqual(
        items.map((i) => [i.name, i.quantity]),
        [
          ["Hủ Tiếu Xào Bò", 2],
          ["Hủ Tiếu Xào Hải Sản", 3],
        ],
        reply
      );
      // and the generic cart/order tables never see A Tiểu items
      assert.equal(platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_carts WHERE merchant_id = 'ATIEU001'`).get().n, 0);
    },
    { fixture: false }
  );
});

// --- continuation, correction, modification ------------------------------------------

test("contextual continuation: 'thêm một phần nữa', 'à nhầm, 3', 'bớt một phần tôm', 'bỏ cái đó', 'không lấy … nữa'", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    await say("Có sủi cảo không?");
    await say("Cho 2 tôm");
    await say("Thêm 3 bò viên");
    assert.match(await say("Thêm một phần nữa"), /Đã đổi Sủi Cảo Xíu Xíu Bò Viên thành 4/);
    assert.match(await say("À nhầm, 3"), /Đã đổi Sủi Cảo Xíu Xíu Bò Viên thành 3/);
    assert.match(await say("bớt một phần tôm"), /Đã đổi Sủi Cảo Chiên Tôm thành 1/);
    assert.match(await say("cho tôm thành 3"), /Đã đổi Sủi Cảo Chiên Tôm thành 3/);
    assert.deepEqual(cartOf(FIXTURE), [
      ["Sủi Cảo Chiên Tôm", 3],
      ["Sủi Cảo Xíu Xíu Bò Viên", 3],
    ]);
    assert.match(await say("bỏ cái đó"), /Đã bỏ Sủi Cảo Chiên Tôm/);
    assert.match(await say("không lấy bò viên nữa"), /Đã bỏ Sủi Cảo Xíu Xíu Bò Viên/);
    assert.deepEqual(cartOf(FIXTURE), []);
  });
});

test("a correction that could mean two lines is asked about, then applied to the chosen one", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    await say("Cho 2 Sủi Cảo Chiên Tôm, 3 bò viên");
    const ask = await say("À nhầm, 3");
    assert.match(ask, /muốn sửa món nào/);
    assert.match(ask, /1\. Sủi Cảo Chiên Tôm/);
    assert.match(await say("1"), /Đã đổi Sủi Cảo Chiên Tôm thành 3/);
    assert.deepEqual(cartOf(FIXTURE), [
      ["Sủi Cảo Chiên Tôm", 3],
      ["Sủi Cảo Xíu Xíu Bò Viên", 3],
    ]);
  });
});

test("ambiguity: 'Cho 2 pizza' lists the options, '2' picks option 2 with the quantity asked for", async () => {
  await withChat(async ({ say, cartOf }) => {
    await say("Xem quán Nôm Nôm");
    const ask = await say("Cho 2 pizza");
    assert.match(ask, /11 món phù hợp với "pizza"/);
    assert.match(ask, /2\. Pizza Thập Cẩm Thịt 28cm/);
    assert.match(ask, /và 1 món khác/);
    assert.deepEqual(cartOf("DEMO_NOMNOM001"), []); // nothing guessed
    assert.match(await say("2"), /Đã thêm 2 × Pizza Thập Cẩm Thịt 28cm/);
    assert.deepEqual(cartOf("DEMO_NOMNOM001"), [["Pizza Thập Cẩm Thịt 28cm", 2]]);
  });
});

test("'tôm' with no context is ambiguous (two tôm dishes) and is asked about, never guessed", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    const ask = await say("Cho 2 tôm");
    assert.match(ask, /2 món phù hợp với "tom"/);
    assert.deepEqual(cartOf(FIXTURE), []);
    assert.match(await say("Tôm Rang Me"), /Đã thêm 2 × Tôm Rang Me/); // answering by name works too
  });
});

test("a multi-item message queues the rest behind an ambiguous item and finishes them after the choice", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    const ask = await say("Cho 2 tôm, 1 trà đá");
    assert.match(ask, /món phù hợp với "tom"/);
    const done = await say("1");
    assert.match(done, /Đã thêm 2 × Sủi Cảo Chiên Tôm/);
    assert.match(done, /Đã thêm 1 × Trà Đá/);
    assert.deepEqual(cartOf(FIXTURE), [
      ["Sủi Cảo Chiên Tôm", 2],
      ["Trà Đá", 1],
    ]);
  });
});

// --- product questions and short messages ---------------------------------------------

test("product question → '2 cái' adds it; 'giá?' and 'có không?' refer to it", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    assert.match(await say("Có Trà Đá không?"), /Dạ có ạ: Trà Đá — 5\.000đ/);
    assert.match(await say("giá?"), /Trà Đá: 5\.000đ/);
    assert.match(await say("có không?"), /Dạ có ạ: Trà Đá/);
    assert.match(await say("2 cái"), /Đã thêm 2 × Trà Đá/);
    // right after adding, a bare number is asked about instead of guessed
    assert.match(await say("3 cái"), /đổi Trà Đá thành 3 .* hay thêm 3 phần nữa/);
    assert.deepEqual(cartOf(FIXTURE), [["Trà Đá", 2]]);
  });
});

test("short messages resolved by context: menu, ở đâu, xem lại, thôi, đổi, giao đây", async () => {
  await withChat(async ({ say }) => {
    await openFixture(say);
    assert.match(await say("menu"), /Sủi Cảo Chiên Tôm: 45\.000đ/);
    assert.match(await say("ở đâu"), /📍 Quán Sủi Cảo Mẫu \(Test Fixture\): 12 Đường Thử Nghiệm/);
    assert.match(await say("xem lại"), /giỏ hàng đang trống/i);
    await say("Cho 1 trà đá");
    assert.match(await say("đổi"), /đổi món nào thành bao nhiêu/);
    assert.match(await say("giao đây"), /cho em xin địa chỉ cụ thể/);
    assert.match(await say("xem lại"), /kiểm tra lại đơn[\s\S]*1 × Trà Đá/);
    assert.match(await say("thôi"), /em bỏ qua bước đó/);
  });
});

test("unaccented conversation works end to end", async () => {
  await withChat(async ({ say, orderCount }) => {
    await say("xem quan sui cao mau");
    await say("co sui cao khong");
    assert.match(await say("cho 2 tom, 3 bo vien"), /Đã thêm 2 × Sủi Cảo Chiên Tôm[\s\S]*Đã thêm 3 × Sủi Cảo Xíu Xíu Bò Viên/);
    assert.match(await say("giao toi 7 nguyen thien thuat"), /Giao tới: 7 nguyen thien thuat/);
    assert.match(await say("tong bao nhieu"), /240\.000đ/);
    assert.match(await say("dat mon"), /xác nhận đặt đơn này/);
    assert.match(await say("xac nhan"), /Đã tạo đơn/);
    assert.equal(orderCount(FIXTURE), 1);
  });
});

// --- delivery details + confirmation safety ------------------------------------------------

test("address: vague or number-less addresses are asked about, never completed; note and phone join the summary", async () => {
  await withChat(async ({ say }) => {
    await openFixture(say);
    await say("Cho 1 trà đá");
    assert.match(await say("giao tới Nguyễn Thiện Thuật"), /chưa có số nhà\/tên đường/);
    assert.match(await say("Địa chỉ giao là 7 Nguyễn Thiện Thuật nha"), /📍 Giao tới: 7 Nguyễn Thiện Thuật/);
    await say("ghi chú: ít đá");
    await say("0912 345 678");
    const summary = await say("Đặt món");
    assert.match(summary, /📍 Giao tới: 7 Nguyễn Thiện Thuật\n☎️ SĐT: 0912345678\n📝 Ghi chú: ít đá/);
    assert.doesNotMatch(summary, /Phường|Thành phố|Nha Trang/); // nothing added to what the customer said
  });
});

test("confirmation safety: no summary / changed address / cancelled -> no order", async () => {
  await withChat(async ({ say, orderCount }) => {
    await openFixture(say);
    await say("Cho 1 trà đá");
    await say("lấy tại quán");
    assert.match(await say("ok"), /kiểm tra lại đơn/); // no summary was shown yet
    assert.equal(orderCount(FIXTURE), 0);
    // changing the address mid-checkout re-shows the updated summary — never orders
    assert.match(await say("giao tới 7 Nguyễn Thiện Thuật"), /kiểm tra lại đơn[\s\S]*Giao tới: 7 Nguyễn Thiện Thuật[\s\S]*xác nhận đặt đơn này/);
    assert.equal(orderCount(FIXTURE), 0);
    // the cart changes after that summary -> "được" only shows a fresh summary
    await say("Cho 1 Sủi Cảo Hấp Thịt");
    const again = await say("được");
    assert.match(again, /kiểm tra lại đơn[\s\S]*Sủi Cảo Hấp Thịt/);
    assert.equal(orderCount(FIXTURE), 0);
    assert.match(await say("thôi không đặt nữa"), /giỏ hàng vẫn được giữ nguyên/);
    assert.match(await say("xác nhận"), /kiểm tra lại đơn/); // pending was cancelled -> review again
    assert.equal(orderCount(FIXTURE), 0);
    assert.match(await say("xác nhận"), /Đã tạo đơn/);
    assert.equal(orderCount(FIXTURE), 1);
  });
});

// --- memory, isolation, robustness -----------------------------------------------------------

test("conversation memory is persisted: a pending choice survives an adapter reload", async () => {
  await withChat(async ({ platform, say, cartOf }) => {
    await say("Xem quán Nôm Nôm");
    await say("Cho 2 pizza");
    platform.registry.invalidate("DEMO_NOMNOM001"); // fresh adapter + engine instance
    assert.match(await say("3"), /Đã thêm 2 × Capricciosa Pizza/);
    assert.deepEqual(cartOf("DEMO_NOMNOM001"), [["Capricciosa Pizza - Jambon Nấm Trứng 28cm", 2]]);
  });
});

test("customer isolation: B's '2' never answers A's pending question, and carts stay separate", async () => {
  await withChat(async ({ say, cartOf }) => {
    await say("Xem quán Nôm Nôm", 9101);
    await say("Xem quán Nôm Nôm", 9102);
    await say("Cho 2 pizza", 9101); // A has a pending choice
    assert.match(await say("2", 9102), /2 phần món nào/); // B has none
    assert.deepEqual(cartOf("DEMO_NOMNOM001", 9102), []);
    assert.match(await say("2", 9101), /Đã thêm 2 × Pizza Thập Cẩm Thịt 28cm/);
    assert.deepEqual(cartOf("DEMO_NOMNOM001", 9101), [["Pizza Thập Cẩm Thịt 28cm", 2]]);
  });
});

test("merchant isolation: questions and memory are scoped to the current merchant", async () => {
  await withChat(async ({ say }) => {
    await say("Xem quán Nôm Nôm");
    await say("Cho 2 pizza"); // pending choice at Nôm Nôm
    await say("Quay lại tổng đài");
    await openFixture(say);
    assert.match(await say("Có Seafood Pizza không?"), /quán chưa có món "seafood pizza"/);
    assert.match(await say("2"), /2 phần món nào/); // Nôm Nôm's pending choice does not leak here
  });
});

test("a failed search or unknown dish never destroys the cart or conversation context", async () => {
  await withChat(async ({ say, cartOf }) => {
    await openFixture(say);
    await say("Cho 2 Sủi Cảo Chiên Tôm");
    assert.match(await say("Cho 1 phở"), /không tìm thấy món "pho"/);
    assert.match(await say("Thêm một phần nữa"), /Đã đổi Sủi Cảo Chiên Tôm thành 3/);
    assert.deepEqual(cartOf(FIXTURE), [["Sủi Cảo Chiên Tôm", 3]]);
  });
});

test("platform level: a merchant is picked by name from the result list, and by number", async () => {
  await withChat(async ({ say }) => {
    await say("Tôi muốn ăn hủ tiếu");
    assert.match(await say("Quán Sủi Cảo Mẫu"), /Đã mở Quán Sủi Cảo Mẫu/);
    await say("Quay lại tổng đài", 9201);
    await say("Tôi muốn ăn hủ tiếu", 9201);
    const picked = await say("2", 9201);
    assert.match(picked, /Đã mở /);
  });
});
