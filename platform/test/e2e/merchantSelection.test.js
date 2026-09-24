// Choosing a merchant after a search. The search reply tells the customer to
// send "[ XEM <TÊN QUÁN IN HOA> ]"; typing that back (or any case/accent
// variant of the name) must open the merchant. Name matching folds case and
// accents the same way dish search already does (stripAccents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

let messageSeq = 0;

async function withPlatform(fn) {
  const platform = buildTestPlatform({ withAtieu: true });
  const server = await startServer(platform.app);
  const say = async (userId, text) => {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: userId }, message: { text, msg_id: `sel-${++messageSeq}` }, timestamp: Date.now() }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.reply_text;
  };
  try {
    return await fn({ platform, say });
  } finally {
    server.close();
  }
}

const OPENED = /^Đã mở Hủ Tiếu Xào A Tiểu/;

test("the call to action printed in the search reply, typed back verbatim, opens the merchant", async () => {
  await withPlatform(async ({ say }) => {
    const results = await say("sel-cta", "tìm cho tôi hủ tiếu xào bò");
    const cta = results.match(/\[ XEM [^\]]+ \]/)?.[0];
    assert.equal(cta, "[ XEM HỦ TIẾU XÀO A TIỂU ]");
    assert.match(await say("sel-cta", cta), OPENED);
  });
});

test("merchant names match regardless of letter case, including Vietnamese capitals", async () => {
  await withPlatform(async ({ say }) => {
    let n = 0;
    for (const text of ["XEM HỦ TIẾU XÀO A TIỂU", "Xem A TIỂU", "xem hủ tiếu xào a tiểu", "Xem A Tiểu", "mở QUÁN A TIỂU"]) {
      const user = `sel-case-${++n}`;
      await say(user, "hủ tiếu xào");
      assert.match(await say(user, text), OPENED, text);
    }
  });
});

test("merchant names match without diacritics, as dish search already does", async () => {
  await withPlatform(async ({ say }) => {
    let n = 0;
    for (const text of ["Xem A Tieu", "xem hu tieu xao a tieu", "XEM HU TIEU XAO A TIEU"]) {
      const user = `sel-accent-${++n}`;
      await say(user, "hu tieu xao");
      assert.match(await say(user, text), OPENED, text);
    }
  });
});

test("brackets, quotes and trailing punctuation around the name are ignored", async () => {
  await withPlatform(async ({ say }) => {
    let n = 0;
    for (const text of ["[XEM HỦ TIẾU XÀO A TIỂU]", "Xem \"A Tiểu\"", "xem A Tiểu!", "(xem A Tiểu)", "Xem “A Tiểu”"]) {
      const user = `sel-punct-${++n}`;
      assert.match(await say(user, text), OPENED, text);
    }
  });
});

test("a name that matches no merchant still falls back to a dish search, not a wrong merchant", async () => {
  await withPlatform(async ({ say }) => {
    const reply = await say("sel-none", "xem quán phở hà nội");
    assert.doesNotMatch(reply, /Đã mở/);
    assert.match(reply, /chưa tìm thấy quán nào/);
  });
});

test("an unavailable merchant is still reported as unavailable under any case or accents", async () => {
  await withPlatform(async ({ platform, say }) => {
    platform.services.merchants.suspend("ATIEU001");
    platform.registry.invalidate("ATIEU001");
    for (const text of ["Xem A Tiểu", "XEM A TIỂU", "xem a tieu"]) {
      const reply = await say(`sel-susp-${text}`, text);
      assert.match(reply, /hiện không khả dụng/, text);
      assert.doesNotMatch(reply, /Đã mở/);
    }
  });
});
