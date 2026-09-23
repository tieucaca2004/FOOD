// Phase 8: unit tests for the REUSED, frozen src/channel/zalo/
// messageNormalizer.js — read-only reuse (see platform/channel/
// webhookController.js's import). This file is new test coverage for
// already-existing, previously-untested logic; it does not modify
// src/ or test/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeZaloTextEvent } from "../../../src/channel/zalo/messageNormalizer.js";

test("valid user_send_text event normalizes correctly", () => {
  const body = {
    event_name: "user_send_text",
    sender: { id: "u1", display_name: "Anh Ba" },
    message: { text: "Xin chào", msg_id: "m1" },
    timestamp: 1234567890,
  };
  const event = normalizeZaloTextEvent(body);
  assert.deepEqual(event, {
    zaloUserId: "u1",
    text: "Xin chào",
    messageId: "m1",
    displayName: "Anh Ba",
    timestamp: 1234567890,
  });
});

test("non-text events (follow, delivery receipt, sticker, ...) normalize to null", () => {
  for (const eventName of ["follow", "unfollow", "user_seen_message", "oa_send_text", undefined]) {
    assert.equal(normalizeZaloTextEvent({ event_name: eventName }), null, `event_name=${eventName}`);
  }
});

test("missing/malformed body never throws — returns null safely", () => {
  for (const bad of [null, undefined, {}, [], "not an object", 12345]) {
    assert.equal(normalizeZaloTextEvent(bad), null, `body=${JSON.stringify(bad)}`);
  }
});

test("missing sender.id, missing message.text, or missing message id are all rejected (null), never partially normalized", () => {
  assert.equal(normalizeZaloTextEvent({ event_name: "user_send_text", message: { text: "hi", msg_id: "m1" } }), null); // no sender
  assert.equal(normalizeZaloTextEvent({ event_name: "user_send_text", sender: { id: "u1" }, message: { msg_id: "m1" } }), null); // no text
  assert.equal(normalizeZaloTextEvent({ event_name: "user_send_text", sender: { id: "u1" }, message: { text: "hi" } }), null); // no msg id
});

test("non-string text (object, number, array) is rejected, not coerced", () => {
  for (const badText of [123, {}, [], null, true]) {
    const body = { event_name: "user_send_text", sender: { id: "u1" }, message: { text: badText, msg_id: "m1" } };
    assert.equal(normalizeZaloTextEvent(body), null, `text=${JSON.stringify(badText)}`);
  }
});

test("message_id fallback (top-level message_id when message.msg_id is absent) is accepted and always stringified", () => {
  const body = { event_name: "user_send_text", sender: { id: "u1" }, message: { text: "hi" }, message_id: 999 };
  const event = normalizeZaloTextEvent(body);
  assert.equal(event.messageId, "999");
  assert.equal(typeof event.messageId, "string");
});

test("a deliberately huge/deeply-nested payload never throws — malformed payload handled safely", () => {
  const huge = { event_name: "user_send_text", sender: { id: "u1" }, message: { text: "x".repeat(100000), msg_id: "m1" } };
  assert.doesNotThrow(() => normalizeZaloTextEvent(huge));
});
