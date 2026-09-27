// Follow-up FOCUS (GPT-2 evidence, 2026-09-26): after "quán đầu tiên ở đâu?", "quán đó có giá không?" answered
// about the WHOLE list and showed another place's price. The place last answered about is now the conversation's
// focus (stored in the existing knowledge context); "quán đó / quán này / chỗ đó" use it, or the bot asks.
// Over the (simulated) Telegram webhook; SYNTHETIC knowledge fixture ("tìm bún cá" -> 3 places, in this order:
// Bún cá Cam Ranh Hai (no price), Bún cá Cô Ba (no bún cá price; priced bún chả cá / bún riêu), Bún Cá Mẫu 45.000đ).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const ASK = /Dạ anh\/chị hỏi quán nào trong danh sách ạ\?/;

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "K" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    return (await res.json()).reply_text;
  };
  const session = (u) => platform.db.prepare(`SELECT s.* FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id LIKE ? ORDER BY s.id DESC`).get(`%${u}`);
  const ctx = (u) => JSON.parse(session(u)?.knowledge_context_json ?? "null");
  try {
    await fn({ say, session, ctx });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

test("FOCUS: ordinal and demonstrative follow-ups answer about ONE place — never another place's price", async () => {
  await withChat(async ({ say, session, ctx }) => {
    const u = 3001;
    assert.match(await say("tìm bún cá", u), /Em tìm thấy 3 quán/);
    const list = ctx(u);
    // 1. the whole list
    assert.match(await say("sao không có giá?", u), /em mới xác minh được giá của 1 quán/);
    // 2. more of the same list
    assert.match(await say("còn quán nào nữa?", u), /Dạ em đã gửi hết 3 quán/);
    // 3. position -> that place, and it becomes the focus
    assert.equal(await say("quán đầu tiên ở đâu?", u), "• Bún cá Cam Ranh Hai: 12 Nguyễn Trãi, Cam Ranh");
    // 4 / 5. "quán đó" / "quán này" = the focus: no price for it, and NOT Bún Cá Mẫu's 45.000đ
    for (const q of ["quán đó có giá không?", "quán này có giá không?"]) {
      const r = await say(q, u);
      assert.match(r, /Bún cá Cam Ranh Hai[\s\S]*các nguồn hiện có chưa ghi giá cho quán này/, q);
      assert.doesNotMatch(r, /45\.000đ|Bún Cá Mẫu|Cô Ba/, q);
    }
    assert.match(await say("quán này có bán không?", u), /^• Bún cá Cam Ranh Hai — 12 Nguyễn Trãi/);
    assert.equal(await say("chỗ đó ở đâu?", u), "• Bún cá Cam Ranh Hai: 12 Nguyễn Trãi, Cam Ranh");
    // 6. "quán thứ 2": Cô Ba has no bún cá price — its bún chả cá / bún riêu prices are not borrowed
    const second = await say("quán thứ 2 có giá không?", u);
    assert.match(second, /Bún cá Cô Ba[\s\S]*chưa ghi giá cho quán này/);
    assert.doesNotMatch(second, /15\.000đ|25\.000đ|45\.000đ/);
    assert.match(await say("menu quán đó", u), /^• Bún cá Cô Ba — 105 Hoàng Hoa Thám/); // the focus moved to #2
    // 7. the last one shown
    assert.equal(await say("quán cuối cùng ở đâu?", u), "• Bún Cá Mẫu: 170 Bạch Đằng, Tân Lập, Nha Trang");
    assert.match(await say("quán đó có giá không?", u), /Bún Cá Mẫu[\s\S]*Bún cá: giá tham khảo 45\.000đ/);
    // 9. no new search: the query and the list are the same ones
    assert.equal(session(u).last_search_query, "bún cá");
    assert.deepEqual(ctx(u).matchedIds, list.matchedIds);
  });
});

test("FOCUS: an ambiguous reference is asked back; a new search clears the focus; a one-place list is unambiguous", async () => {
  await withChat(async ({ say, ctx }) => {
    const u = 3002;
    await say("tìm bún cá", u);
    // 8. nothing was talked about yet in a 3-place list: ask, do not guess, do not search
    assert.match(await say("quán đó có giá không?", u), ASK);
    assert.match(await say("chỗ đó ở đâu?", u), ASK);
    assert.equal(ctx(u).focusId ?? null, null);
    await say("quán thứ 2 ở đâu?", u);
    assert.ok(ctx(u).focusId);
    // 11. a new discovery starts a new list with no focus
    await say("tìm quán bánh căn ở Nha Trang", u);
    assert.equal(ctx(u).focusId ?? null, null);
    await say("tìm bún cá", u);
    assert.match(await say("quán đó có giá không?", u), ASK);
    // a list of one place: "quán đó" can only be that place
    await say("tìm Bún Cá Mịn", u);
    const one = await say("quán đó có giá không?", u);
    assert.match(one, /Bún Cá Mịn — 12 Lý Tự Trọng[\s\S]*45\.000đ/);
  });
});

test("FOCUS: never shared between customers / sessions", async () => {
  await withChat(async ({ say, ctx }) => {
    const a = 3003;
    const b = 3004;
    await say("tìm bún cá", a);
    await say("quán cuối cùng ở đâu?", a); // A focuses Bún Cá Mẫu
    // 12. B has no list at all: asked back, nothing of A's
    const bFirst = await say("quán đó có giá không?", b);
    assert.match(bFirst, /muốn hỏi giá của món hoặc quán nào/);
    assert.doesNotMatch(bFirst, /Bún Cá Mẫu|45\.000đ/);
    // B's own list has no focus even though A's has one
    await say("tìm bún cá", b);
    assert.match(await say("quán đó có giá không?", b), ASK);
    assert.ok(ctx(a).focusId);
    assert.equal(ctx(b).focusId ?? null, null);
    assert.match(await say("quán đó có giá không?", a), /Bún Cá Mẫu[\s\S]*45\.000đ/); // A's focus is intact
  });
});
