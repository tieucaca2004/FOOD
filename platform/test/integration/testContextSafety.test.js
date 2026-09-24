// Guards the test infrastructure itself: no automated test may reach the real
// Telegram or Zalo APIs, even when a developer's .env provides real credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { buildTestContext } from "../../../test/helpers/testApp.js";
import { config as atieuConfig } from "../../../src/config.js";

async function withConfiguredNotifierAndFetchSpy(fn) {
  const saved = { fetch: globalThis.fetch, token: atieuConfig.telegramBotToken, chat: atieuConfig.telegramChatId };
  const telegramCalls = [];
  atieuConfig.telegramBotToken = "000000:test-only-token";
  atieuConfig.telegramChatId = "test-only-chat";
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.telegram.org")) telegramCalls.push(String(url));
    return saved.fetch(url, options);
  };
  try {
    return await fn(telegramCalls);
  } finally {
    globalThis.fetch = saved.fetch;
    atieuConfig.telegramBotToken = saved.token;
    atieuConfig.telegramChatId = saved.chat;
  }
}

async function confirmOrder(ctx) {
  const customer = ctx.repos.customers.create({ zaloUserId: `safety-${Math.random()}`, phone: "0912345678" });
  const product = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, product.id, 1);
  const { cart, items } = ctx.services.cart.getCart(customer.id);
  let order = ctx.services.orders.startCheckout(customer, cart, items);
  order = ctx.services.orders.applyCheckoutField(order, "fulfillment_type", "takeaway", 0);
  order = ctx.services.orders.moveToPendingConfirmation(order);
  return ctx.services.orders.confirm(order, cart);
}

test("the A Tiểu test context captures order notifications instead of calling the Bot API", async () => {
  await withConfiguredNotifierAndFetchSpy(async (telegramCalls) => {
    const ctx = buildTestContext();
    const confirmed = await confirmOrder(ctx);

    assert.equal(telegramCalls.length, 0);
    assert.equal(ctx.sentNotifications.length, 1);
    assert.equal(ctx.sentNotifications[0].chatId, "test-only-chat");
    assert.ok(ctx.sentNotifications[0].text.includes(confirmed.order_code));
  });
});

test("the platform test harness (buildTestPlatform) inherits the same fake notifier", async () => {
  await withConfiguredNotifierAndFetchSpy(async (telegramCalls) => {
    const platform = buildTestPlatform({ withAtieu: true });
    await confirmOrder(platform.atieuCtx);

    assert.equal(telegramCalls.length, 0);
    assert.equal(platform.atieuCtx.sentNotifications.length, 1);
  });
});

test("with real-looking credentials in the environment, the test harness clears them and blocks the messaging APIs", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const url = (relative) => JSON.stringify(pathToFileURL(path.resolve(here, relative)).href);
  const script = `
    await import(${url("../helpers/testPlatform.js")});
    const { platformConfig } = await import(${url("../../config.js")});
    const { config } = await import(${url("../../../src/config.js")});
    const blocked = (target) => fetch(target, { method: "POST" }).then(() => false, (e) => /blocked in tests/.test(e.message));
    process.stdout.write(JSON.stringify({
      platformZalo: platformConfig.zaloAccessToken,
      platformTelegram: platformConfig.telegramBotToken,
      atieuZalo: config.zaloAccessToken,
      telegramBlocked: await blocked("https://api.telegram.org/botX/sendMessage"),
      zaloBlocked: await blocked("https://openapi.zalo.me/v3.0/oa/message/cs"),
    }));
  `;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-safety-"));
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PLATFORM_ZALO_OA_ACCESS_TOKEN: "fake-platform-zalo",
        PLATFORM_TELEGRAM_BOT_TOKEN: "111:fake-platform-telegram",
        ZALO_OA_ACCESS_TOKEN: "fake-atieu-zalo",
      },
    });
    assert.deepEqual(JSON.parse(out), { platformZalo: "", platformTelegram: "", atieuZalo: "", telegramBlocked: true, zaloBlocked: true });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
