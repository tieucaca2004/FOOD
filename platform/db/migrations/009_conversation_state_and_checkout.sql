-- Conversational Ordering Engine V1 — additive only.
--
-- 1. platform_sessions.conversation_state_json: the engine's working
--    memory for the current conversation (which products were just
--    mentioned, the cart line just touched, a pending clarification or
--    pending order confirmation). Everything derivable from domain state
--    (cart contents, totals, active merchant) is NOT duplicated here.
--    NULL = no memory yet. Plain ADD COLUMN: no rebuild needed.
--
-- 2. cart_checkout: how the customer wants a cart fulfilled (delivery
--    address or pickup, optional phone/note), captured during the chat
--    BEFORE the order exists. orders.cart_id already links an order to its
--    cart, so these details belong to the order without changing
--    OrderService or the orders table. One row per cart.

ALTER TABLE platform_sessions ADD COLUMN conversation_state_json TEXT;

CREATE TABLE IF NOT EXISTS cart_checkout (
  cart_id           INTEGER PRIMARY KEY REFERENCES merchant_carts(id),
  fulfillment_type  TEXT CHECK (fulfillment_type IN ('delivery', 'pickup')),
  delivery_address  TEXT,
  customer_phone    TEXT,
  note              TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
