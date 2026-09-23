import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramUpdate } from "../../channel/telegram/normalizeTelegramUpdate.js";

function validUpdate(overrides = {}) {
  return {
    update_id: 100001,
    ...overrides,
    message: {
      message_id: 55,
      from: { id: 12345, is_bot: false, first_name: "Minh", last_name: "Nguyễn", username: "minhnguyen" },
      chat: { id: 12345, type: "private" },
      date: 1700000000,
      text: "Xin chào",
      ...overrides.message,
    },
  };
}

test("B. a valid text message update normalizes correctly", () => {
  const event = normalizeTelegramUpdate(validUpdate());
  assert.deepEqual(event, {
    channel: "telegram",
    updateId: "100001",
    messageId: "55",
    externalChatId: "12345",
    externalUserId: "12345",
    text: "Xin chào",
    timestamp: 1700000000,
    displayName: "Minh Nguyễn",
  });
});

test("displayName falls back to username, then null, when first/last name absent", () => {
  const withUsernameOnly = normalizeTelegramUpdate(validUpdate({ message: { from: { id: 1, username: "onlyuser" } } }));
  assert.equal(withUsernameOnly.displayName, "onlyuser");

  const withNothing = normalizeTelegramUpdate(validUpdate({ message: { from: { id: 1 } } }));
  assert.equal(withNothing.displayName, null);
});

test("C. malformed/garbage bodies normalize to null, never throw", () => {
  for (const bad of [null, undefined, {}, [], "not an object", 12345, { update_id: 1 }, { message: {} }]) {
    assert.equal(normalizeTelegramUpdate(bad), null, `body=${JSON.stringify(bad)}`);
  }
});

test("E. missing sender (from absent — e.g. anonymous channel post) normalizes with externalUserId: null, not rejected outright", () => {
  const body = validUpdate();
  delete body.message.from;
  const event = normalizeTelegramUpdate(body);
  assert.notEqual(event, null);
  assert.equal(event.externalUserId, null);
  assert.equal(event.displayName, null);
});

test("malformed `from` (present but wrong shape) is rejected — never guesses an identity", () => {
  for (const badFrom of ["not-an-object", 123, [], { no_id_field: true }]) {
    const event = normalizeTelegramUpdate(validUpdate({ message: { from: badFrom } }));
    assert.equal(event, null, `from=${JSON.stringify(badFrom)}`);
  }
});

test("F. missing chat is rejected (null)", () => {
  const body = validUpdate();
  delete body.message.chat;
  assert.equal(normalizeTelegramUpdate(body), null);

  for (const badChat of ["not-an-object", 123, [], {}]) {
    assert.equal(normalizeTelegramUpdate(validUpdate({ message: { chat: badChat } })), null, `chat=${JSON.stringify(badChat)}`);
  }
});

test("missing update_id or message_id is rejected", () => {
  const noUpdateId = validUpdate();
  delete noUpdateId.update_id;
  assert.equal(normalizeTelegramUpdate(noUpdateId), null);

  const noMessageId = validUpdate();
  delete noMessageId.message.message_id;
  assert.equal(normalizeTelegramUpdate(noMessageId), null);
});

test("non-text messages (no text field — e.g. photo/sticker) normalize to null", () => {
  const body = validUpdate();
  delete body.message.text;
  assert.equal(normalizeTelegramUpdate(body), null);
});

test("G. empty text is accepted structurally (a valid, if unusual, string) — not crashed", () => {
  const event = normalizeTelegramUpdate(validUpdate({ message: { text: "" } }));
  assert.notEqual(event, null);
  assert.equal(event.text, "");
});

test("G. an oversized text payload is normalized safely without throwing", () => {
  const hugeText = "x".repeat(200000);
  assert.doesNotThrow(() => {
    const event = normalizeTelegramUpdate(validUpdate({ message: { text: hugeText } }));
    assert.equal(event.text.length, 200000);
  });
});

test("K. SQL-injection-shaped text is normalized verbatim, as plain data — the normalizer never interprets it", () => {
  const payload = "'; DROP TABLE platform_messages; --";
  const event = normalizeTelegramUpdate(validUpdate({ message: { text: payload } }));
  assert.equal(event.text, payload);
});

test("Q. the normalized event exposes ONLY documented, minimal fields — no raw Telegram object leaks through", () => {
  const event = normalizeTelegramUpdate(validUpdate());
  assert.deepEqual(Object.keys(event).sort(), [
    "channel", "displayName", "externalChatId", "externalUserId", "messageId", "text", "timestamp", "updateId",
  ].sort());
});
