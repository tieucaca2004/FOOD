import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext } from "../helpers/testApp.js";

function customerCtx(ctx) {
  const customer = ctx.services.customers.getOrCreateByZaloUserId(`e2e-${Date.now()}-${Math.random()}`, "Nguyễn Văn A");
  const session = ctx.services.sessions.getOrCreate(customer.id);
  return { customer, session };
}

async function say(ctx, state, text) {
  const result = await ctx.router.handle({ customer: state.customer, session: state.session, text });
  state.session = result.session;
  return result.replyText;
}

test("full spec §25 scenario: greeting -> menu -> add -> add more -> cart -> checkout -> confirm -> notified order, no duplicate", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);

  let reply = await say(ctx, state, "Xin chào");
  assert.match(reply, /Mary/);

  reply = await say(ctx, state, "Cho tôi xem menu");
  assert.match(reply, /Hủ Tiếu Xào Bò/);
  assert.match(reply, /65\.000đ/);

  reply = await say(ctx, state, "Cho 2 hủ tiếu xào bò");
  assert.match(reply, /Hủ Tiếu Xào Bò × 2/);
  assert.match(reply, /130\.000đ/);

  reply = await say(ctx, state, "Thêm 1 hải sản");
  assert.match(reply, /Hủ Tiếu Xào Hải Sản × 1/);
  assert.match(reply, /205\.000đ/); // cumulative total, computed in code

  reply = await say(ctx, state, "Xem giỏ");
  assert.match(reply, /Hủ Tiếu Xào Bò × 2/);
  assert.match(reply, /Hủ Tiếu Xào Hải Sản × 1/);
  assert.match(reply, /Tạm tính: 205\.000đ/);

  reply = await say(ctx, state, "Đặt mang về");
  // fulfillment answered inline ("mang về") is not parsed out of the
  // checkout trigger itself — router asks for it explicitly next.
  assert.match(reply, /ăn tại quán, mang về, hay giao hàng/);

  reply = await say(ctx, state, "Mang về");
  assert.match(reply, /để em liên hệ|số điện thoại/);

  reply = await say(ctx, state, "0912345678");
  assert.match(reply, /ĐƠN HÀNG #AT-/);
  assert.match(reply, /205\.000đ/);
  assert.match(reply, /Xác nhận đặt món/);

  const beforeConfirmCount = ctx.repos.orders.listByCustomer(state.customer.id, 10).length;

  reply = await say(ctx, state, "Xác nhận");
  assert.match(reply, /Đã xác nhận đơn hàng #AT-/);

  const orders = ctx.repos.orders.listByCustomer(state.customer.id, 10);
  assert.equal(orders.length, beforeConfirmCount); // confirm didn't create a second order
  assert.equal(orders[0].status, "CONFIRMED");
  assert.equal(orders[0].total, 205000);
  assert.equal(orders[0].customer_id, state.customer.id);

  const items = ctx.repos.orders.listItems(orders[0].id);
  assert.equal(items.length, 2);
  const boItem = items.find((i) => i.product_name.includes("Bò"));
  const haiSanItem = items.find((i) => i.product_name.includes("Hải Sản"));
  assert.equal(boItem.quantity, 2);
  assert.equal(haiSanItem.quantity, 1);

  const notifications = ctx.repos.notifications.listByOrder(orders[0].id);
  assert.equal(notifications.length, 1); // exactly one notification, not zero, not duplicated
});

test("checkout asks for missing info instead of guessing, and doesn't confirm until explicitly asked", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);
  await say(ctx, state, "Cho 1 bò");
  const reply = await say(ctx, state, "Đặt");
  assert.match(reply, /ăn tại quán, mang về, hay giao hàng/);

  const orders = ctx.repos.orders.listByCustomer(state.customer.id, 10);
  assert.equal(orders[0].status, "DRAFT"); // not confirmed just by starting checkout
});

test("cancellation before confirmation cancels the draft order and clears pending state", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);
  await say(ctx, state, "Cho 1 bò");
  await say(ctx, state, "Đặt");
  await say(ctx, state, "Mang về");
  await say(ctx, state, "0912345678");
  const reply = await say(ctx, state, "Thôi không đặt nữa");
  assert.match(reply, /Đã hủy đơn/);

  const orders = ctx.repos.orders.listByCustomer(state.customer.id, 10);
  assert.equal(orders[0].status, "CANCELLED");
});

test("unavailable product is refused with a clear message, never silently added", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);
  ctx.db.prepare(`UPDATE products SET available = 0 WHERE sku = 'HTX-BO'`).run();

  const reply = await say(ctx, state, "Cho 1 bò");
  assert.match(reply, /tạm hết/);

  const { items } = ctx.services.cart.getCart(state.customer.id);
  assert.equal(items.length, 0);
});

test("unknown/nonexistent product asks a clarifying question, never invents an item", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);
  const reply = await say(ctx, state, "Cho 1 bánh mì thịt nướng");
  assert.match(reply, /chưa tìm thấy món này|chưa rõ ý/);
});

test("unknown free text is met with a clarifying question, not a guess", async () => {
  const ctx = buildTestContext();
  const state = customerCtx(ctx);
  const reply = await say(ctx, state, "asdkjaskdj random text");
  assert.match(reply, /chưa rõ ý/);
});
