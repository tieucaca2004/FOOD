import { stripAccents } from "../../src/nlp/normalize.js"; // generic, read-only reuse (same folding dish search uses)

// Case- and accent-insensitive form of a name or typed fragment, for literal
// substring matching: "HỦ TIẾU", "hủ tiếu" and "hu tieu" all fold alike.
export function foldText(text) {
  return stripAccents(String(text).normalize("NFC")).replace(/\s+/g, " ").trim();
}
