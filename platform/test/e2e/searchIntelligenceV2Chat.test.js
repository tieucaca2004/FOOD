// SEARCH INTELLIGENCE V2 — the Phase 2 test matrix through the REAL channel routes (Telegram webhook and Zalo
// webhook -> PlatformRouter -> Search Intelligence V2 -> Food Knowledge), GPT off, A Tiểu on its LEGACY engine.
// SYNTHETIC fixture (helpers/searchV2Knowledge.js) reproducing the Phase 1.5 situations; nothing is sent out
// (bot token blanked, no Zalo token) and nothing is written outside the in-memory platform DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { searchV2Knowledge } from "../helpers/searchV2Knowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-value";
const CHANNELS = ["telegram", "zalo"];

async function withChat(fn, { atieuLink = false } = {}) {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = SECRET;
  const file = searchV2Knowledge({ atieuLink });
  const p = buildTestPlatform({ withAtieu: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const server = await startServer(p.app);
  let seq = 0;
  let user = 91000;
  const conversation = (channel = "telegram") => {
    const id = ++user;
    const say = async (text) => {
      seq += 1;
      const req =
        channel === "telegram"
          ? { url: platformConfig.telegramWebhookPath, headers: { "x-telegram-bot-api-secret-token": SECRET }, body: { update_id: seq, message: { message_id: seq, from: { id, is_bot: false, first_name: "S" }, chat: { id, type: "private" }, date: 1, text } } }
          : { url: platformConfig.webhookPath, headers: {}, body: { event_name: "user_send_text", sender: { id: `zalo-si2-${id}` }, message: { text, msg_id: `si2-${seq}` }, timestamp: Date.now() } };
      const body = await fetch(`${baseUrl(server)}${req.url}`, { method: "POST", headers: { "content-type": "application/json", ...req.headers }, body: JSON.stringify(req.body) }).then((r) => r.json());
      assert.equal(body.status, "processed", JSON.stringify(body));
      return body.reply_text;
    };
    const session = () => {
      const key = channel === "telegram" ? `telegram:${id}` : `zalo-si2-${id}`;
      const c = p.db.prepare(`SELECT id FROM platform_customers WHERE zalo_user_id = ?`).get(key);
      return p.db.prepare(`SELECT context, active_merchant_id, knowledge_context_json FROM platform_sessions WHERE customer_id = ? ORDER BY id DESC`).get(c.id);
    };
    return { say, session };
  };
  const counts = () => ["merchants", "merchant_products", "orders"].map((t) => p.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  try {
    await fn({ conversation, counts });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = saved;
  }
}

const NO_PLACE_LIST = /Em tìm thấy \d+ quán/;

test("A/B EXACT + NO-DIACRITIC: the same dish with or without accents, on Telegram and Zalo", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      for (const q of ["bún cá", "bun ca"]) {
        const r = await conversation(ch).say(q);
        assert.match(r, /Bún Cá Mịn/, `${ch} ${q}`);
        assert.match(r, /Bún cá Cô Ba/, `${ch} ${q}`);
        assert.doesNotMatch(r, /Rejected Test/, `${ch} ${q}`); // a rejected record is never an answer
      }
      for (const q of ["bánh căn", "banh can"]) assert.match(await conversation(ch).say(q), /Bánh căn Út Năm Nha Trang/, `${ch} ${q}`);
      for (const q of ["hủ tiếu", "hu tieu"]) assert.match(await conversation(ch).say(q), /Hủ tiếu Cô Năm/, `${ch} ${q}`);
      assert.match(await conversation(ch).say("nem nuong"), /Nem nướng Đặng Văn Quyên/, ch);
      const pho = await conversation(ch).say("pho hong");
      assert.match(pho, /Phở Hồng — số 40 đường Lê Thánh Tôn/, ch);
      assert.doesNotMatch(pho, /Hồng Ngọc/, ch); // shares "Hồng", is another place
    }
  });
});

test("C TYPOS: a candidate is confirmed first, never answered as fact; 'đúng' then searches it", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const cca = await conversation(ch).say("bun cca");
      assert.match(cca, /có thể là nhiều món: .*Bún cá/, ch);
      assert.doesNotMatch(cca, NO_PLACE_LIST, ch);
      assert.match(await conversation(ch).say("banh cann"), /Bánh căn[\s\S]*Bánh canh|Bánh canh[\s\S]*Bánh căn/, ch);
      assert.match(await conversation(ch).say("nem nuongg"), /ý anh\/chị là “Nem nướng”/, ch);
      const c = conversation(ch);
      const tiu = await c.say("hu tiu");
      assert.match(tiu, /ý anh\/chị là “Hủ tiếu”/, ch);
      assert.doesNotMatch(tiu, NO_PLACE_LIST, ch);
      assert.match(await c.say("đúng"), /Hủ tiếu Cô Năm/, ch); // confirmed -> searched
    }
  });
});

test("D SHORTENED: 'bun' / 'banh' / 'pho' / 'bún bò' ask which dish — no guess, no broad list", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      for (const [q, dish] of [["bun", /Bún cá/], ["banh", /Bánh căn/], ["pho", /Phở/], ["bún bò", /Bún bò Huế, Bún bò Nam Bộ/], ["bun bo", /Bún bò Huế, Bún bò Nam Bộ/]]) {
        const r = await conversation(ch).say(q);
        assert.match(r, /có thể là nhiều món/, `${ch} ${q}`);
        assert.match(r, dish, `${ch} ${q}`);
        assert.doesNotMatch(r, NO_PLACE_LIST, `${ch} ${q}`);
      }
    }
  });
});

test("E MERCHANT NAME: found without a dish keyword, with or without 'ở đâu / giá / giờ / món gì'", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const say = (q) => conversation(ch).say(q);
      for (const q of ["Bánh căn Út Năm", "Bánh căn Út Năm ở đâu", "Út Năm"]) {
        const r = await say(q);
        assert.match(r, /16 Phạm Hồng Thái/, `${ch} ${q}`);
        assert.match(r, /127 Nguyễn Bỉnh Khiêm/, `${ch} ${q}`); // two recorded addresses: both said, none chosen
        assert.doesNotMatch(r, /Tô Hiến Thành Nha Trang/, `${ch} ${q}`); // another bánh căn place is not "Út Năm"
      }
      assert.match(await say("Kiwami"), /Nhà hàng Nhật Bản KIWAMI — 136 Bạch Đằng/, ch);
      assert.match(await say("Vfruit"), /Vfruit — 24 Tô Hiến Thành/, ch);
      assert.match(await say("Livin"), /LIVIN Barbecue restaurant in Nha Trang/, ch);
      const pho = await say("Phở Hồng ở đâu");
      assert.match(pho, /Phở Hồng — số 40 đường Lê Thánh Tôn/, ch);
      assert.doesNotMatch(pho, /Hồng Ngọc/, ch);
      const loan = await say("Bún Cá Sứa Nguyên Loan ở đâu");
      assert.match(loan, /123 Ngô Gia Tự/, ch);
      assert.match(loan, /2 nguồn ghi cùng địa chỉ/, ch); // the same place from two sources is one place
      const phan = await say("Bánh Mì Phan ở đâu");
      assert.match(phan, /chưa có dữ liệu về “Bánh Mì Phan”/, ch);
      assert.doesNotMatch(phan, /Phan Bội Châu/, ch); // a street-named bánh bèo place is not "Bánh Mì Phan"
      const union = await say("Union Pizza ở đâu");
      assert.match(union, /chưa có dữ liệu về “Union Pizza”/, ch); // said FIRST …
      assert.match(union, /The Pizza Company/, ch); // … then the pizza places FOOD has
    }
  });
});

test("K RELATIONS: merchant -> price / hours / products / address, recorded data only", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const price = await conversation(ch).say("Bánh căn Út Năm có giá bao nhiêu");
      assert.match(price, /Bánh căn: giá tham khảo 45\.000đ, ghi nhận 26\/09\/2026 \(guide\.example\)/, ch);
      assert.match(price, /chưa ghi giá cho quán này, em không đoán giá/, ch); // the other record has no price
      assert.match(await conversation(ch).say("Bánh căn Út Năm mấy giờ mở cửa"), /06:00–10:00 \(theo nguồn, ghi nhận 26\/09\/2026\)/, ch);
      assert.match(await conversation(ch).say("Bánh căn Út Năm có món gì"), /– Bánh căn: giá tham khảo 45\.000đ/, ch);
      assert.match(await conversation(ch).say("Kiwami ở đâu"), /KIWAMI — 136 Bạch Đằng, Nha Trang/, ch);
    }
  });
});

test("F PRICE: every natural form is applied and echoed — never silently dropped; reference prices only", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const say = (q) => conversation(ch).say(q);
      for (const q of ["bánh căn khoảng 50k", "bánh căn tầm 50k", "bánh căn cỡ 50k", "Có quán bánh căn nào khoảng 50k không?"]) {
        const r = await say(q);
        assert.match(r, /Lọc giá: khoảng 50\.000đ \(em lọc 40\.000đ–60\.000đ\)/, `${ch} ${q}`);
        assert.match(r, /Bánh căn Út Năm Nha Trang/, `${ch} ${q}`); // 45.000đ
        assert.doesNotMatch(r, /Bánh căn Tô Hiến Thành/, `${ch} ${q}`); // 80.000đ
      }
      for (const q of ["bánh căn dưới 50k", "bánh căn không quá 50k"]) {
        const r = await say(q);
        assert.match(r, /Lọc giá: không quá 50\.000đ/, `${ch} ${q}`);
        assert.match(r, /Bánh căn Út Năm Nha Trang/, `${ch} ${q}`);
        assert.doesNotMatch(r, /Bánh căn Tô Hiến Thành/, `${ch} ${q}`);
      }
      const above = await say("bánh căn trên 50k");
      assert.match(above, /Lọc giá: từ 50\.000đ trở lên/, ch);
      assert.match(above, /Bánh căn Tô Hiến Thành/, ch);
      assert.doesNotMatch(above, /Út Năm Nha Trang — 16/, ch);
      for (const q of ["bánh căn 30k đến 50k", "bánh căn từ 30k đến 50k", "bánh căn 30-50k", "bánh căn 30.000 đến 50.000"]) {
        const r = await say(q);
        assert.match(r, /Lọc giá: từ 30\.000đ đến 50\.000đ/, `${ch} ${q}`);
        assert.match(r, /Bánh căn Út Năm Nha Trang/, `${ch} ${q}`);
      }
      const cheap = await say("bún cá dưới 50k");
      assert.match(cheap, /Bún Cá Mịn/, ch);
      assert.doesNotMatch(cheap, /Rejected Test/, ch); // its 10.000đ is not an answer: the record is rejected
      assert.match(cheap, /chưa có giá nên chưa đưa vào/, ch); // unpriced places are counted, not assumed
      const none = await say("bánh xèo dưới 20k");
      assert.match(none, /Lọc giá: không quá 20\.000đ/, ch);
      assert.doesNotMatch(none, /Bánh xèo Chị Bảy —/, ch);
    }
  });
});

test("G FOLLOW-UP: the list stays the subject — 'quán nào bán', first, 'quán đó', more, second", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const c = conversation(ch);
      assert.match(await c.say("Nha Trang có quán bún cá nào?"), NO_PLACE_LIST, ch);
      assert.match(await c.say("Quán nào bán?"), NO_PLACE_LIST, ch); // inherits bún cá — never "chưa tìm thấy"
      const first = await c.say("Quán đầu tiên ở đâu?");
      assert.match(first, /^• .+: .+/, ch);
      assert.equal(first.split("\n").length, 1, ch);
      assert.match(await c.say("Quán đó có giá bao nhiêu?"), /^• /, ch);
      assert.match(await c.say("Còn quán nào nữa?"), /Dạ em đã gửi hết|Thêm \d+ quán/, ch);
      assert.match(await c.say("Quán thứ 2 có món gì?"), /^• /, ch);
      const ctx = JSON.parse(c.session().knowledge_context_json);
      assert.equal(ctx.si.currentFoodEntity.key, "bun-ca", ch);
    }
  });
});

test("I MÓN -> QUÁN: 'Có bún cá không?' -> 'Quán nào bán?' -> 'Ở đâu?' -> 'Giá bao nhiêu?' keep bún cá", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const c = conversation(ch);
      assert.match(await c.say("Có bún cá không?"), NO_PLACE_LIST, ch);
      assert.match(await c.say("Quán nào bán?"), /Bún Cá Mịn/, ch);
      assert.match(await c.say("Ở đâu?"), /^• .+: \d+/m, ch); // the addresses of the places just listed
      assert.match(await c.say("Giá bao nhiêu?"), /em mới xác minh được giá của 1 quán[\s\S]*Bún Cá Mịn/, ch);
    }
  });
});

test("H CONTEXT SWITCH: inside A Tiểu, global questions leave it; its own menu stays with it", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const c = conversation(ch);
      assert.match(await c.say("Menu A Tiểu"), /Hủ Tiếu Xào Bò/, ch);
      assert.match(await c.say("full menu"), /Hủ Tiếu Xào Bò/, ch); // merchant-local
      assert.equal(c.session().context, "merchant", ch);
      const other = await c.say("Ngoài quán này ra còn quán nào bán bún cá?");
      assert.match(other, /Bún Cá Mịn/, ch); // the dish is kept …
      assert.doesNotMatch(other, /HỦ TIẾU XÀO A TIỂU|Anh\/chị muốn tìm món gì/, ch); // … the place left is not an answer
      assert.equal(c.session().context, "platform", ch);

      const d = conversation(ch);
      await d.say("Menu A Tiểu");
      const area = await d.say("Xung quanh Nha Trang có món gì?");
      assert.match(area, /FOOD có dữ liệu tham khảo về các món/, ch);
      assert.match(area, /• Bún cá — \d+ quán có ghi nhận/, ch);
      assert.match(area, /chưa có tọa độ/, ch); // "xung quanh": no distance is claimed
      assert.doesNotMatch(area, /Hủ Tiếu Xào Bò: 65/, ch);

      const e = conversation(ch);
      await e.say("Menu A Tiểu");
      const notHuTieu = await e.say("Ngoài quán hủ tiếu ra còn món gì?");
      assert.match(notHuTieu, /ngoài Hủ tiếu/, ch);
      assert.doesNotMatch(notHuTieu, /• Hủ tiếu —/, ch);
    }
  });
});

test("I/L FALSE POSITIVES: 'bún bò' is never Hủ Tiếu Xào Bò; 'key' / 'đó' / 'quán đó' / 'món đó' are not dishes", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      for (const q of ["bún bò", "Có bún bò không?", "bun bo"]) {
        const r = await conversation(ch).say(q);
        assert.doesNotMatch(r, /Hủ Tiếu Xào Bò|HỦ TIẾU XÀO/, `${ch} ${q}`);
      }
      const hue = await conversation(ch).say("bún bò Huế");
      assert.match(hue, /Bún bò Huế Cố Đô/, ch);
      assert.doesNotMatch(hue, /Hủ Tiếu Xào Bò|Bún cá/, ch);
      // inside A Tiểu (legacy engine): another dish sharing the word "bò" is not its product
      const c = conversation(ch);
      await c.say("Menu A Tiểu");
      for (const q of ["Bún bò huế đó", "Có bún bò ko"]) assert.doesNotMatch(await c.say(q), /Hủ Tiếu Xào Bò: 65|Dạ có ạ: Hủ Tiếu Xào Bò/, `${ch} ${q}`);
      assert.doesNotMatch(await conversation(ch).say("key"), NO_PLACE_LIST, ch);
      for (const q of ["đó", "do", "quán đó", "món đó"]) {
        const r = await conversation(ch).say(q);
        assert.match(r, /muốn hỏi .+ của món hoặc quán nào/, `${ch} ${q}`);
        assert.doesNotMatch(r, NO_PLACE_LIST, `${ch} ${q}`);
      }
    }
  });
});

test("J ORDERING: order messages are never a search — A Tiểu's own engine takes them", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const c = conversation(ch);
      await c.say("Menu A Tiểu");
      const add = await c.say("2 tô hủ tiếu xào bò");
      assert.match(add, /Hủ Tiếu Xào Bò/, ch);
      assert.doesNotMatch(add, /Em tìm thấy \d+ quán có dữ liệu|có thể là nhiều món/, ch);
      assert.doesNotMatch(await c.say("cho 2 tô"), /Em tìm thấy \d+ quán có dữ liệu|có thể là nhiều món/, ch);
      assert.equal(c.session().context, "merchant", ch);
    }
  });
});

test("L DATA STATUS: review dish and rejected place never answer; no coordinates -> no distance; nothing is written", async () => {
  await withChat(async ({ conversation, counts }) => {
    const before = counts();
    for (const ch of CHANNELS) {
      const near = await conversation(ch).say("quán bún cá gần đây");
      assert.match(near, /vị trí|tọa độ/, ch); // asks for a location, never claims a distance
      assert.doesNotMatch(near, /cách khoảng/, ch);
      const unpriced = await conversation(ch).say("Bún cá Cô Ba có giá bao nhiêu");
      assert.match(unpriced, /chưa ghi giá cho quán này, em không đoán giá/, ch);
      assert.doesNotMatch(await conversation(ch).say("bún cá"), /Rejected Test/, ch);
    }
    assert.deepEqual(counts(), before); // search never creates merchants, products or orders
  });
});

test("H MERCHANT-LOCAL MISS: the place answers; FOOD says others have it; 'quán nào khác?' keeps that dish", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const c = conversation(ch);
      await c.say("Menu A Tiểu");
      const miss = await c.say("Có cháo lòng ko");
      assert.match(miss, /quán chưa có món "chao long"/, ch); // merchant-local answer first
      assert.match(miss, /FOOD có dữ liệu tham khảo về “Cháo lòng” ở 2 quán khác/, ch);
      assert.equal(c.session().context, "merchant", ch); // nothing left behind the customer's back
      const others = await c.say("Có quán nào khác ko");
      assert.match(others, /Cháo lòng 148 Võ Trứ/, ch);
      assert.doesNotMatch(others, /Anh\/chị muốn tìm món gì/, ch);
      assert.equal(c.session().context, "platform", ch);
    }
  });
});

test("I IDENTITY: the catalog place and its reference record — one place once a person approved the link", async () => {
  // without the approved link (today's warehouse): the reference record still shows under the catalog place
  await withChat(async ({ conversation }) => {
    const r = await conversation().say("Có quán hủ tiếu nào?");
    assert.match(r, /HỦ TIẾU XÀO A TIỂU/); // the orderable catalog place (the dish words reach the catalog now)
    assert.match(r, /A\. Tiểu — 86 Lạc Long Quân/);
  });
  // with the approved link (kb_merchant_links, data change awaiting Founder approval): shown once, as orderable
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const r = await conversation(ch).say("Có quán hủ tiếu nào?");
      assert.match(r, /HỦ TIẾU XÀO A TIỂU/, ch);
      assert.doesNotMatch(r, /A\. Tiểu — 86 Lạc Long Quân/, ch);
      assert.match(r, /Hủ tiếu Cô Năm/, ch); // other reference places are still listed
    }
  }, { atieuLink: true });
});
