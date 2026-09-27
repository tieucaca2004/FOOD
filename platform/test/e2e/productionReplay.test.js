// REPLAY of the real Telegram conversation (2026-09-26, platform_messages #307-#394) that exposed the bugs:
// "bún bò" answered with Hủ Tiếu Xào Bò (substring "bo"), "khủng bố bot" / "bánh bò" / "hủ tiếu xào bơ" too, and
// "Xung quanh đây có món gì" answered with A Tiểu's menu. Run on BOTH A Tiểu engines: "legacy" (production today)
// and "generic". A Tiểu is one merchant among others: it answers only when it is asked, by name or in its context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";

const HU_TIEU_BO = /Hủ Tiếu Xào Bò|HỦ TIẾU XÀO BÒ/i;
const ATIEU_MENU = /Đã mở Hủ Tiếu Xào A Tiểu|Dạ đây là menu hiện có|Thực đơn \d+ món/;

for (const engine of ["legacy", "generic"]) {
  const setup = () => {
    const kb = nhaTrangKnowledge();
    const p = buildTestPlatform({ withAtieu: true, atieuEngine: engine, withNomNomDemo: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: kb, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
    const customer = p.services.customers.getOrCreateByZaloUserId(`replay-${engine}-${Math.random()}`, "R");
    const say = (text) => p.router.handle({ customer, session: p.services.sessions.getOrCreate(customer.id), text }).then((r) => r.replyText);
    return { p, customer, say };
  };

  test(`[${engine}] at the platform, other dishes are never "Hủ Tiếu Xào Bò" and A Tiểu is never the default`, async () => {
    const { say } = setup();
    for (const text of ["tòm bún bò cho tui", "bún bò huế", "Có bún bò ko", "Bún bò huế đó", "lâu lâu ông này lại vào khủng bố bot", "Còn bánh bò thì sao?", "2 tô hủ tiếu xào bơ", "hỏi Bún Bò"]) {
      assert.doesNotMatch(await say(text), HU_TIEU_BO, text);
    }
    for (const text of ["Xung quanh đây có món gì", "Ngoài quan hủ tiếu ra có bán gì gần dây ?"]) assert.doesNotMatch(await say(text), ATIEU_MENU, text);
  });

  test(`[${engine}] after opening A Tiểu, an area question leaves it (and does not reopen it); ordering A Tiểu still works`, async () => {
    const { p, customer, say } = setup();
    assert.match(await say("Menu A Tiểu"), ATIEU_MENU);
    for (const text of ["Xung quanh đây có món gì", "Có quán nào bán bún cá?", "Còn quán nào khác?"]) {
      await say("Menu A Tiểu");
      assert.doesNotMatch(await say(text), ATIEU_MENU, text);
      assert.equal(p.services.sessions.getOrCreate(customer.id).context, "platform", text);
    }
    await say("Menu A Tiểu");
    assert.match(await say("cho 2 hủ tiếu xào bò"), /Đã thêm|thêm 2/i);
  });

  test(`[${engine}] real hủ tiếu xào bò questions still find A Tiểu`, async () => {
    const { say } = setup();
    assert.match(await say("hủ tiếu xào bò"), /A TIỂU|A Tiểu/i);
    assert.match(await say("tìm hủ tiếu xào"), /A TIỂU|A Tiểu/i);
  });
}

test("the welcome message names no merchant's dish (FOOD is the switchboard, not A Tiểu)", async () => {
  const p = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true });
  const customer = p.services.customers.getOrCreateByZaloUserId("welcome", "W");
  const reply = (await p.router.handle({ customer, session: p.services.sessions.getOrCreate(customer.id), text: "xin chào" })).replyText;
  assert.doesNotMatch(reply, /hủ tiếu/i);
  assert.match(reply, /Anh\/chị muốn ăn gì/);
});
