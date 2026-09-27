// Food Knowledge in the customer conversation (founder-approved integration),
// over the REAL Telegram webhook path with SIMULATED inbound updates (the bot
// token is blanked: nothing reaches the real Bot API). The knowledge rows are
// SYNTHETIC TEST FIXTURES shaped like the Nha Trang collector data.
//
// Boundary under test: knowledge is REFERENCE only — never pickable by number,
// never a cart, an order or a price for ordering; the platform catalog stays
// the only source of what can be ordered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";


async function withChat(fn, { knowledge = true, nomNom = false } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const file = knowledge ? nhaTrangKnowledge() : null;
  const platform = buildTestPlatform({
    withAtieu: true,
    withNomNomDemo: nomNom,
    atieuEngine: "generic",
    foodKnowledge: file ? ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) : null,
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const telegram = async (text, userId = 777) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "K" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const counts = () => ["merchants", "merchant_products", "merchant_carts", "orders"].map((t) => platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  try {
    await fn({ platform, telegram, counts });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

test("TELEGRAM: 'Tìm quán bún cá ở Nha Trang' answers from Food Knowledge — Nha Trang places only, as reference", async () => {
  await withChat(async ({ telegram, counts }) => {
    const before = counts();
    const reply = await telegram("Tìm quán bún cá ở Nha Trang");
    assert.match(reply, /chưa có quán nào đặt được qua FOOD/);
    assert.match(reply, /Bún Cá Mẫu — 170 Bạch Đằng/);
    assert.match(reply, /Bún cá Cô Ba/);
    assert.doesNotMatch(reply, /Cam Ranh/); // recorded in Cam Ranh, not Nha Trang
    assert.doesNotMatch(reply, /Lòng lợn/); // "Nha Trang" is the place, not a dish
    assert.match(reply, /giá tham khảo 45\.000đ/);
    assert.match(reply, /Thông tin tham khảo — chưa đặt qua FOOD được/);
    assert.deepEqual(counts(), before); // nothing created in the platform
  });
});

test("TELEGRAM: bánh căn / hải sản / a named place", async () => {
  await withChat(async ({ telegram }) => {
    assert.match(await telegram("Tìm quán bánh căn ở Nha Trang"), /Bánh căn Cô Tư/);
    const seafood = await telegram("Tìm quán hải sản ở Nha Trang", 778);
    assert.match(seafood, /Quán hải sản Sóng Biển/); // a place whose own name says so
    const named = await telegram("Tìm Bún Cá Mẫu", 779);
    assert.match(named, /Bún Cá Mẫu — 170 Bạch Đằng/);
    assert.doesNotMatch(named, /Bún cá Cô Ba/); // the NAMED place, not every bún cá place
  });
});

test("ORDERING BOUNDARY: a knowledge-only place is not openable or orderable; the catalog stays the only orderable source", async () => {
  await withChat(async ({ platform, telegram, counts }) => {
    const before = counts();
    await telegram("Tìm quán bún cá ở Nha Trang", 800);
    // a knowledge-only place cannot be opened or ordered from
    assert.doesNotMatch(await telegram("Xem Bún Cá Mẫu", 800), /Đã mở/);
    assert.doesNotMatch(await telegram("Cho tôi 2 bún cá", 800), /2 × /);
    assert.deepEqual(counts(), before);
    // the catalog flow is unchanged: open the orderable merchant, the cart uses CATALOG prices
    await telegram("Tìm hủ tiếu xào", 801);
    assert.match(await telegram("Xem A Tiểu", 801), /Đã mở/);
    const cart = await telegram("Cho tôi 2 hủ tiếu xào bò", 801);
    assert.match(cart, /2 × /);
    assert.doesNotMatch(cart, /tham khảo/i);
    const live = platform.services.menu.listProducts("ATIEU001").find((x) => x.name === "HỦ TIẾU XÀO BÒ");
    assert.ok(cart.includes(Number(live.price * 2).toLocaleString("vi-VN")) || cart.includes(String(live.price * 2)), "cart total from the catalog price");
  });
});

test("NO DUPLICATE: a catalog merchant shown above is not repeated below as 'chưa đặt qua FOOD'", async () => {
  await withChat(async ({ telegram }) => {
    const reply = await telegram("tìm hủ tiếu", 900);
    const [catalog, reference] = reply.split("📚 Tham khảo thêm (chưa đặt qua FOOD được):");
    assert.match(catalog, /HỦ TIẾU XÀO A TIỂU/);
    assert.ok(reference, "a reference section is appended");
    assert.match(reference, /Hủ tiếu Cô Năm/); // one shared dish name is not the same place
    assert.doesNotMatch(reference, /A. Tiểu/);
    assert.doesNotMatch(reference, /em chưa có thông tin mô tả/);
  });
});

// Live evidence 2026-09-26 (#277): a customer still inside a merchant sent "tìm quán bún cá ở Nha Trang"
// and got "quán chưa có món 'bun ca o trang'". An explicit place search now leaves the merchant.
test("INSIDE A MERCHANT: 'tìm quán …' leaves the merchant (cart kept); other messages stay scoped", async () => {
  await withChat(async ({ platform, telegram }) => {
    const u = 950;
    await telegram("Tìm hủ tiếu xào", u);
    assert.match(await telegram("Xem A Tiểu", u), /Đã mở/);
    assert.match(await telegram("Cho tôi 2 hủ tiếu xào bò", u), /2 × /);
    const cartItems = () => platform.db.prepare(`SELECT COUNT(*) AS n FROM merchant_cart_items`).get().n;
    const items = cartItems();
    // a dish question inside the merchant is still answered by the merchant
    assert.doesNotMatch(await telegram("có bún cá không", u), /Tham khảo/i);
    const reply = await telegram("tìm quán bún cá ở Nha Trang", u);
    assert.match(reply, /Bún Cá Mẫu — 170 Bạch Đằng/);
    assert.match(reply, /Thông tin tham khảo — chưa đặt qua FOOD được/);
    assert.doesNotMatch(reply, /bun ca o trang/);
    assert.equal(cartItems(), items); // leaving is not emptying the cart
    // now at the platform: a merchant name reaches the knowledge name search
    assert.match(await telegram("tìm Bún Cá Mẫu", u), /Bún Cá Mẫu — 170 Bạch Đằng/);
    // and the orderable merchant can be reopened with its cart
    assert.match(await telegram("Xem A Tiểu", u), /Đã mở/);
  });
});

test("NO FALLBACK: place searches, accented or not, fresh or inside a merchant, reach the search flow", async () => {
  await withChat(async ({ telegram }) => {
    const cases = [
      ["tìm quán bún cá ở Nha Trang", /Bún Cá Mẫu/],
      ["tim quan bun ca o Nha Trang", /Bún Cá Mẫu/],
      ["tìm quán bánh căn ở Nha Trang", /Bánh căn Cô Tư/],
      ["tìm quán hải sản ở Nha Trang", /Quán hải sản Sóng Biển/],
    ];
    let u = 960;
    for (const inside of [false, true]) {
      for (const [text, expected] of cases) {
        u += 1;
        if (inside) assert.match(await telegram("Xem A Tiểu", u), /Đã mở/);
        const reply = await telegram(text, u);
        assert.doesNotMatch(reply, /chưa hiểu ý|quán chưa có món/, `${inside ? "inside" : "fresh"}: ${text}`);
        assert.match(reply, expected, `${inside ? "inside" : "fresh"}: ${text}`);
        assert.doesNotMatch(reply, /Cam Ranh|Lòng lợn/);
      }
    }
  });
});

// EXACT live bug #279 (2026-09-26 02:22 UTC, after the "tìm quán" fix): inside [DEMO] Nôm Nôm, "tìm Bún Cá Mịn"
// got "quán chưa có món 'bun ca min'". Routing now follows the concierge's `discovery` flag, not a phrase.
test("LIVE #279: inside Nôm Nôm with a cart — 'tìm Bún Cá Mịn' is a global search; 'có bún cá không' stays", async () => {
  await withChat(
    async ({ platform, telegram }) => {
      const u = 990;
      const cart = () => platform.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM merchant_cart_items`).get();
      const orders = () => platform.db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n;
      assert.match(await telegram("Xem quán Nôm Nôm", u), /Đã mở \[DEMO\] Nôm Nôm/);
      assert.match(await telegram("cho tôi 1 Seafood Pizza", u), /Đã thêm/);
      const before = { cart: cart(), orders: orders() };
      const customer = () => platform.db.prepare(`SELECT s.context FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id LIKE ?`).get(`%${u}`);
      assert.equal(customer()?.context, "merchant");

      const named = await telegram("tìm Bún Cá Mịn", u);
      assert.doesNotMatch(named, /quán chưa có món|chưa hiểu ý/);
      assert.match(named, /Bún Cá Mịn — 12 Lý Tự Trọng/);
      assert.match(named, /Thông tin tham khảo — chưa đặt qua FOOD được/);
      assert.equal(customer()?.context, "platform");

      const place = await telegram("tìm quán bún cá ở Nha Trang", u);
      assert.doesNotMatch(place, /bun ca o trang|chưa hiểu ý/);
      assert.match(place, /Bún Cá Mẫu — 170 Bạch Đằng/);

      // back in the merchant: its cart is intact, and a dish question is the merchant's again
      assert.match(await telegram("Xem quán Nôm Nôm", u), /Đã mở/);
      assert.deepEqual({ cart: cart(), orders: orders() }, before);
      const scoped = await telegram("có bún cá không", u);
      assert.doesNotMatch(scoped, /Tham khảo|Em tìm thấy/i);
      assert.equal(customer()?.context, "merchant");
    },
    { nomNom: true }
  );
});

test("ROUTING MATRIX: discovery leaves the merchant (fresh / inside / inside + cart); merchant messages stay", async () => {
  await withChat(
    async ({ platform, telegram }) => {
      const globals = [
        ["tìm quán bún cá ở Nha Trang", /Bún Cá Mẫu/],
        ["tìm Bún Cá Mịn", /Bún Cá Mịn — 12 Lý Tự Trọng/],
        ["tìm quán bánh căn ở Nha Trang", /Bánh căn Cô Tư/],
        ["tìm hải sản ở Nha Trang", /Quán hải sản Sóng Biển/],
        ["tim quan bun ca o Nha Trang", /Bún Cá Mẫu/],
      ];
      const items = () => platform.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM merchant_cart_items`).get();
      let u = 1000;
      for (const setup of ["fresh", "inside", "inside+cart"]) {
        for (const [text, expected] of globals) {
          u += 1;
          if (setup !== "fresh") assert.match(await telegram("Xem quán Nôm Nôm", u), /Đã mở/);
          if (setup === "inside+cart") assert.match(await telegram("cho tôi 1 Seafood Pizza", u), /Đã thêm/);
          const before = items();
          const reply = await telegram(text, u);
          assert.doesNotMatch(reply, /quán chưa có món|chưa hiểu ý/, `${setup}: ${text}`);
          assert.match(reply, expected, `${setup}: ${text}`);
          assert.deepEqual(items(), before, `${setup}: ${text}`);
        }
      }
      // merchant-scoped messages inside the merchant keep being the merchant's
      u += 1;
      await telegram("Xem quán Nôm Nôm", u);
      assert.match(await telegram("menu", u), /Nôm Nôm/);
      assert.match(await telegram("cho tôi 2 pizza", u), /quán có \d+ món phù hợp với "pizza"/); // the merchant asks which pizza
      assert.doesNotMatch(await telegram("giá món này", u), /Tham khảo|Em tìm thấy/i);
      const q = await telegram("có bún cá không", u);
      assert.match(q, /quán chưa có món/); // answered BY THE MERCHANT, not a global search
      assert.doesNotMatch(q, /Tham khảo|Em tìm thấy/i);
    },
    { nomNom: true }
  );
});

// ---- Follow-up on a reference list (live Telegram #281-#284: "tìm bún cá" -> 23 places -> "sao ko có giá?"
// -> "chưa tìm thấy quán nào phù hợp"). Migration 013 keeps the list; the question is answered about it.
const sessionOf = (platform, u) =>
  platform.db.prepare(`SELECT s.* FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id LIKE ? ORDER BY s.id DESC`).get(`%${u}`);
const knowledgeCtx = (platform, u) => JSON.parse(sessionOf(platform, u)?.knowledge_context_json ?? "null");

test("FOLLOW-UP (exact live bug): 'tìm bún cá' then 'sao ko có giá?' answers about THAT list, with recorded prices only", async () => {
  await withChat(async ({ platform, telegram, counts }) => {
    const u = 1100;
    const before = counts();
    assert.match(await telegram("tìm bún cá", u), /Em tìm thấy \d+ quán có dữ liệu phù hợp/);
    const ctx = knowledgeCtx(platform, u);
    assert.equal(ctx.type, "food_knowledge_results");
    assert.equal(ctx.rawQuery, "tìm bún cá");
    assert.equal(ctx.query, "Bún cá");
    assert.deepEqual(ctx.foodKeys, ["bun-ca"]);
    assert.equal(ctx.matchedIds.length, ctx.total);

    const reply = await telegram("sao ko có giá?", u);
    assert.doesNotMatch(reply, /chưa tìm thấy quán/);
    assert.match(reply, new RegExp(`Trong ${ctx.total} quán em tìm được cho “Bún cá”, em mới xác minh được giá của 1 quán`));
    assert.match(reply, /Bún Cá Mẫu — 170 Bạch Đằng[\s\S]*Bún cá: giá tham khảo 45\.000đ, ghi nhận \d\d\/\d\d\/\d{4} \(buncamau\.example\)/);
    assert.match(reply, /Các quán còn lại hiện chưa có nguồn giá được xác minh/);
    assert.doesNotMatch(reply, /15\.000đ|25\.000đ|Bún chả cá|Bún riêu/); // similar dishes are not bún cá
    assert.match(reply, /chưa đặt qua FOOD được/);
    // the follow-up is not a search: the original query and the list stay
    assert.equal(sessionOf(platform, u).last_search_query, "bún cá");
    assert.deepEqual(knowledgeCtx(platform, u).matchedIds, ctx.matchedIds);
    assert.deepEqual(counts(), before); // no merchant / product / cart / order
  });
});

test("FOLLOW-UP variants, address, hours, more — and new searches replace the list", async () => {
  await withChat(async ({ platform, telegram }) => {
    const u = 1110;
    await telegram("tìm bún cá", u);
    for (const q of ["giá bao nhiêu?", "sao không có giá?", "có giá không?", "bao nhiêu tiền?", "sao ko co gia"]) {
      assert.match(await telegram(q, u), /em mới xác minh được giá của 1 quán/, q);
    }
    const first = knowledgeCtx(platform, u);
    const address = await telegram("địa chỉ quán đầu", u);
    assert.match(address, /^• .+: .+/);
    assert.equal(address.split("\n").length, 1);
    assert.match(await telegram("mấy giờ mở?", u), /các nguồn hiện có chưa ghi giờ mở cửa/);
    assert.match(await telegram("còn quán nào nữa?", u), /Dạ em đã gửi hết|Thêm \d+ quán/);
    // a message that names something new is a new search, never a follow-up
    assert.match(await telegram("giá bánh căn bao nhiêu", u), /Bánh căn Cô Tư/);
    assert.equal(knowledgeCtx(platform, u).query, "Bánh căn");
    assert.match(await telegram("tìm bún cá", u), /Bún Cá Mẫu/);
    assert.deepEqual(knowledgeCtx(platform, u).matchedIds, first.matchedIds);
    const named = await telegram("tìm Bún Cá Mịn", u);
    assert.match(named, /Bún Cá Mịn — 12 Lý Tự Trọng/);
    assert.equal(knowledgeCtx(platform, u).query, "Bún Cá Mịn");
    const price = await telegram("sao ko có giá?", u);
    assert.match(price, /Bún Cá Mịn — 12 Lý Tự Trọng[\s\S]*Bún cá dầm – chả cá: giá tham khảo 45\.000đ/);
    assert.doesNotMatch(price, /Bún Cá Mẫu/);
  });
});

test("FOLLOW-UP without a list: no context, or a stale one, is asked back — never guessed, never searched", async () => {
  await withChat(async ({ platform, telegram }) => {
    const fresh = await telegram("sao ko có giá?", 1120);
    assert.match(fresh, /muốn hỏi giá của món hoặc quán nào/);
    assert.doesNotMatch(fresh, /bún cá|Bún cá/);
    assert.equal(sessionOf(platform, 1120).last_search_query, null);

    await telegram("tìm bún cá", 1121);
    const session = sessionOf(platform, 1121);
    const old = { ...knowledgeCtx(platform, 1121), touchedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    platform.services.sessions.setKnowledgeContext(session.id, old);
    const stale = await telegram("sao ko có giá?", 1121);
    assert.match(stale, /muốn hỏi giá của món hoặc quán nào/);
    assert.doesNotMatch(stale, /45\.000đ/);
  });
});

test("FOLLOW-UP vs MERCHANT: inside a merchant the merchant answers; opening one ends the reference list", async () => {
  await withChat(
    async ({ platform, telegram, counts }) => {
      const u = 1130;
      await telegram("tìm bún cá", u);
      assert.ok(knowledgeCtx(platform, u));
      assert.match(await telegram("Xem quán Nôm Nôm", u), /Đã mở/);
      assert.equal(knowledgeCtx(platform, u), null);
      const before = counts();
      for (const q of ["giá món này", "menu", "có bún cá không"]) {
        assert.doesNotMatch(await telegram(q, u), /em mới xác minh được giá|Tham khảo/i, q);
      }
      assert.match(await telegram("cho tôi 2 pizza", u), /quán có \d+ món phù hợp với "pizza"/);
      assert.match(await telegram("sao ko có giá?", u), /./); // the merchant's own reply, whatever it is
      assert.equal(sessionOf(platform, u).context, "merchant");
      assert.deepEqual(counts(), before);
    },
    { nomNom: true }
  );
});

test("FLAG OFF: without Food Knowledge the conversation is the catalog-only one", async () => {
  await withChat(
    async ({ telegram }) => {
      const reply = await telegram("Tìm quán bún cá ở Nha Trang");
      assert.doesNotMatch(reply, /tham khảo/i);
      assert.match(reply, /chưa tìm thấy quán nào phù hợp/);
    },
    { knowledge: false }
  );
});
