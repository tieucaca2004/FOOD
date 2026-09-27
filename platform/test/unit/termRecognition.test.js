// Vietnamese input normalization + controlled typo recognition of the term matcher. PRECISION > RECALL:
// exact / approved / no-accent names resolve; typos are CANDIDATES only (one -> "did you mean", several -> AMBIGUOUS);
// only a clean Telex / VNI decoding resolves. SYNTHETIC dish list; pure (no DB, nothing stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TermMatcher } from "../../knowledge/terms/termMatcher.js";
import { decodeTyping, toneSig, phoneticKey } from "../../knowledge/terms/termFuzzy.js";

const DISHES = ["Bún cá", "Bánh căn", "Bánh canh", "Bánh canh cá", "Bánh canh chả cá", "Hủ tiếu xào", "Bún chả cá", "Bún bò", "Nem nướng", "Giò", "Bún riêu"];
const matcher = (opts = {}) =>
  new TermMatcher({
    canonicals: DISHES.map((canonicalName, i) => ({ foodEntityId: i + 1, canonicalName })),
    relations: [{ id: 1, status: "APPROVED", relation_type: "EXACT_ALIAS", term: "bún cá sứa", term_key: "bun ca sua", food_entity_id: 1, canonical_name: "Bún cá", confidence: 0.9 }],
    regionNames: ["Nha Trang", "Khánh Hòa"],
    ...opts,
  });
const m = matcher();
const r = (text) => {
  const x = m.match(text);
  return {
    status: x.status,
    matches: x.matches.map((y) => y.canonicalName),
    suggestions: x.suggestions.map((y) => y.canonicalName),
    ambiguous: x.ambiguous.map((a) => a.candidates.map((c) => c.canonicalName).sort()),
    kinds: [...x.matches, ...x.suggestions].map((y) => y.typo?.kind ?? y.relationType),
    places: x.modifiers.map((y) => y.name),
  };
};
const resolved = (text, dish) => {
  const x = r(text);
  assert.equal(x.status, "resolved", text);
  assert.deepEqual(x.matches, [dish], text);
  return x;
};
const suggested = (text, dish, kind = null) => {
  const x = r(text);
  assert.deepEqual([x.status, x.matches, x.suggestions], ["suggested", [], [dish]], text);
  if (kind) assert.deepEqual(x.kinds, [kind], text);
  return x;
};
const nothing = (text) => assert.deepEqual(r(text), { status: "none", matches: [], suggestions: [], ambiguous: [], kinds: [], places: r(text).places }, text);

test("ACCENTED + UNACCENTED + CASE + SPACES + PUNCTUATION resolve exactly", () => {
  for (const t of ["Bún cá", "bun ca", "BÚN CÁ", "BUN CA", "  bún    cá  ", "bún-cá!!", "“bún cá”…", "bún cá" /* decomposed (NFD) input */]) resolved(t, "Bún cá");
  resolved("banh can", "Bánh căn");
  resolved("hu tieu xao", "Hủ tiếu xào");
  resolved("Hủ Tiếu Xào", "Hủ tiếu xào");
  resolved("có bún cá sứa không", "Bún cá"); // approved alias
});

test("TONE PLACEMENT: old / new style marks are the same word (hoà = hòa)", () => {
  assert.equal(toneSig("hoà"), toneSig("hòa"));
  assert.deepEqual(r("khánh hoà có bún cá").places, ["Khánh Hòa"]);
  const m2 = new TermMatcher({ canonicals: [{ foodEntityId: 1, canonicalName: "Chè thuỷ tinh" }], relations: [] });
  assert.equal(m2.match("chè thủy tinh").status, "resolved");
});

test("INPUT METHOD OFF: Telex / VNI spellings decode WITH their marks — and only an exact spelling resolves", () => {
  assert.equal(decodeTyping("cas"), "cá");
  assert.equal(decodeTyping("nuwowngs"), "nướng");
  assert.equal(decodeTyping("bu1n"), "bún");
  assert.equal(decodeTyping("caa"), "câ"); // Telex "aa" is â — so "caa" is NOT "cá"
  assert.deepEqual(resolved("bun cas", "Bún cá").kinds, ["INPUT_METHOD"]);
  assert.deepEqual(resolved("bu1n ca1", "Bún cá").kinds, ["INPUT_METHOD"]);
  assert.deepEqual(resolved("nem nuwowngs", "Nem nướng").kinds, ["INPUT_METHOD"]);
  suggested("nem nuongs", "Nem nướng", "EDIT"); // "nuóng" is not "nướng": only a candidate
});

test("TYPO 1 letter: doubled / extra, missing, swapped — a SUGGESTION, never a match", () => {
  suggested("bun cca", "Bún cá", "DOUBLED");
  suggested("bún cáa", "Bún cá", "DOUBLED");
  suggested("bánh cănn", "Bánh căn", "DOUBLED"); // the typed "ă" rules out Bánh canh
  suggested("nem nuog", "Nem nướng", "EDIT"); // missing letter
  suggested("bahn can", "Bánh căn", "TRANSPOSE"); // swapped neighbours
});

test("TYPO 2 letters only in a long name; never in a short one", () => {
  suggested("banh cahn chaa ca", "Bánh canh chả cá", "MIXED");
  nothing("bunn caa"); // 2 slips in a 5-letter name
});

test("WRONG MARKS / VOWELS / CONSONANTS: common confusions are candidates", () => {
  suggested("bún cà", "Bún cá", "ACCENT");
  suggested("bún chã cá", "Bún chả cá", "ACCENT");
  suggested("hu tiu xao", "Hủ tiếu xào", "PHONETIC"); // iêu / iu
  suggested("bún ká", "Bún cá", "PHONETIC"); // c / k
  suggested("bún riu", "Bún riêu", "PHONETIC");
});

test("TYPO → AMBIGUITY: several dishes one slip away is AMBIGUOUS, never a choice", () => {
  const x = r("banh cann");
  assert.equal(x.status, "ambiguous");
  assert.deepEqual(x.matches, []);
  assert.deepEqual(x.ambiguous, [["Bánh canh", "Bánh căn"]]);
});

test("TYPO → EVERYDAY WORD or ANOTHER DISH: the word is what it says", () => {
  nothing("bún có không"); // "có" is a word, not a slip of "cá"
  nothing("bún còn không");
  nothing("ban can"); // "bạn cần": everyday words
  resolved("banh canh", "Bánh canh"); // another dish typed exactly is that dish
  resolved("bún bò", "Bún bò");
  assert.deepEqual(r("canh chua").matches, []);
});

test("VERY SHORT input and one-word names are never guessed", () => {
  for (const t of ["bu", "ca", "b", "cá", "bún", "giỏ", "gio"]) assert.deepEqual(r(t).matches.concat(r(t).suggestions), [], t);
  resolved("cho tôi giò", "Giò");
});

test("QUANTITY + DISH, PLACE + DISH, LONG QUESTION", () => {
  resolved("cho 2 tô bun ca", "Bún cá");
  suggested("cho 2 tô bun cca", "Bún cá", "DOUBLED");
  const place = resolved("bun ca nha trang", "Bún cá");
  assert.deepEqual(place.places, ["Nha Trang"]); // a place is a modifier, never part of the dish
  const long = resolved("anh ơi cho em hỏi ở nha trang chỗ nào bán bun ca ngon mà rẻ vậy, có ship không", "Bún cá");
  assert.deepEqual([long.suggestions, long.ambiguous, long.places], [[], [], ["Nha Trang"]]);
  nothing("hôm nay trời đẹp quá, đi đâu chơi nhỉ");
});

test("RESOLVE THRESHOLD: typos never resolve by default; nothing is learned from input", () => {
  const before = JSON.stringify([...m.index.keys()]);
  for (let i = 0; i < 5; i++) m.match("bun cca");
  assert.equal(JSON.stringify([...m.index.keys()]), before); // no new term from repeated input
  assert.deepEqual(r("bun cca").matches, []);
  const strict = matcher({ resolveTypoAt: 2 }); // even Telex only suggests
  assert.equal(strict.match("bun cas").status, "suggested");
  assert.equal(phoneticKey("trà"), phoneticKey("chà"));
});
