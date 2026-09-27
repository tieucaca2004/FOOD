// A value from DATA (a product / merchant / dish name, an address) as it may be shown to a customer or handed to the
// model: one line of text. Structural only — it never judges what the words say and never changes the stored record:
//   - NFC (the same letters, composed);
//   - C0 / C1 control characters, zero-width characters and bidirectional overrides are removed;
//   - every line break / tab / run of whitespace becomes one space — a name can never start a new line of its own,
//     so it cannot pose as a price, source or orderability line of FOOD's reply;
//   - at most MAX_DISPLAY characters.
// A clean name comes back unchanged.
const MAX_DISPLAY = 200;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/** @param {unknown} value @returns {string} */
export function displayText(value) {
  if (value === null || value === undefined) return "";
  const s = String(value).normalize("NFC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  return s.length > MAX_DISPLAY ? `${s.slice(0, MAX_DISPLAY).trimEnd()}…` : s;
}
