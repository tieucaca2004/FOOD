import { stripAccents } from "../../src/nlp/normalize.js";

// Food/order instructions ("không hành, ít tiêu", "nước sốt nhiều", "em
// không ăn hành", "lần nào cũng ít cay") — a small GENERIC lexicon of
// cooking modifiers, never a merchant's dish list. Only food preferences
// are understood; nothing about health, religion or any other personal
// attribute is inferred (an allergy statement is just "avoid X").
//
// Folding accents makes some words collide ("bỏ"/"bơ", "đá"/"da",
// "tỏi"/"tôi"), so those tokens must carry the right accents whenever the
// customer typed accents at all.

const MODIFIERS = [
  { key: "msg", label: "bột ngọt", words: ["bot ngot"] },
  { key: "cilantro", label: "ngò", words: ["rau mui", "rau ngo", "ngo ri", "ngo"] },
  { key: "peanut", label: "đậu phộng", words: ["dau phong", "lac"] },
  { key: "sauce", label: "sốt", words: ["nuoc sot", "sot"] },
  { key: "onion", label: "hành", words: ["hanh la", "hanh phi", "hanh"] },
  { key: "pepper", label: "tiêu", words: ["tieu"] },
  { key: "chili", label: "ớt", words: ["ot"] },
  { key: "spicy", label: "cay", words: ["cay"] },
  { key: "sugar", label: "đường", words: ["duong"] },
  { key: "sweet", label: "ngọt", words: ["ngot"] },
  { key: "ice", label: "đá", words: ["da"], accented: ["đá"] },
  { key: "vegetables", label: "rau", words: ["rau"] },
  { key: "garlic", label: "tỏi", words: ["toi"], accented: ["tỏi"] },
  { key: "fat", label: "mỡ", words: ["mo"], accented: ["mỡ"] },
  { key: "salt", label: "muối", words: ["muoi"], accented: ["muối"] },
  { key: "cheese", label: "phô mai", words: ["pho mai"] },
];

// value words BEFORE the modifier ("không hành", "ít tiêu", "thêm sốt")
const PRE_VALUES = [
  { value: "avoid", words: ["khong cho", "dung cho", "khong bo", "khong an", "khong lay", "khong", "dung", "khoi", "kieng", "bo"], accented: { bo: ["bỏ"] } },
  { value: "low", words: ["it it", "it", "bot", "nhe"], accented: { bot: ["bớt"] } },
  { value: "extra", words: ["cho them", "cho nhieu", "nhieu", "them", "dam"] },
  { value: "normal", words: ["an binh thuong", "binh thuong", "cho", "co"] },
];
// value words AFTER the modifier ("nước sốt nhiều", "hành bình thường")
const POST_VALUES = [
  { value: "low", words: ["it thoi", "it"] },
  { value: "extra", words: ["nhieu", "nhieu nhieu"] },
  { value: "normal", words: ["binh thuong"] },
];

const VALUE_LABEL = { avoid: "không", low: "ít", extra: "nhiều", normal: "bình thường" };

// Words around instructions that carry no instruction themselves.
const NOISE = new Set("em anh chi toi tui minh ban nhe nha nhen a ah di vay the la voi giup gium an muon".split(" "));
// A leading "Không," / "Không phải," before instructions marks a correction.
const CORRECTION_PART = /^(khong|ko|khong phai|sai roi|sai|nham roi|nham)$/;

const CURRENT_ONLY = /\b(hom nay|lan nay|bua nay|don nay|rieng lan nay|lan nay thoi|hom nay thoi|chuyen nay)\b/;
const STRONG_PERSISTENT = /\b(lan nao cung|moi lan|luon luon|luon|tu gio|tu nay|lan sau|ve sau|tu gio tro di|bao gio cung)\b/;
const SELF_HABIT = /\b(khong an|khong thich|khong uong|thich an|thich it|thich nhieu|hay an|an .{1,20} binh thuong|khong bao gio an|di ung)\b/;
const GLOBAL_SCOPE = /\b(o dau cung|quan nao cung|moi quan|tat ca cac quan|bat ky quan nao|di dau cung)\b/;
const PRODUCT_SCOPE = /\b(mon nay|mon do|cho mon nay|rieng mon nay)\b|^\s*(?:cho\s+)?mon\s+[a-z0-9 ]{1,30}\s+(?:nay|do)\b/;
const QUALIFIER_WORDS =
  /\b(hom nay|lan nay|bua nay|don nay|rieng lan nay|lan nay thoi|hom nay thoi|chuyen nay|lan nao cung|moi lan|luon luon|luon|tu gio tro di|tu gio|tu nay|lan sau|ve sau|bao gio cung|o dau cung vay|o dau cung|quan nao cung|moi quan|tat ca cac quan|bat ky quan nao|di dau cung|o quan nay|rieng mon nay|cho mon nay|mon nay|mon do|khong bao gio|di ung|thich|hay|cung vay|that ra|thuc ra|ghi chu|vay|cung)\b/g;
// "Món pizza này …": a product reference that belongs to the scope, not to the order.
const PRODUCT_REFERENCE_REMAINDER = /^(?:cho\s+)?mon\s+.{1,30}\s+(?:nay|do)$/;

function fold(text) {
  const original = String(text ?? "").normalize("NFC");
  const folded = stripAccents(original);
  return folded.length === original.length ? { original, folded } : { original: folded, folded };
}

function hasDiacritics(text) {
  return /[^\u0000-\u007f]/.test(text.normalize("NFC"));
}

/** Tokens of a clause: [{ word (folded), raw (original lowercase) }]. */
function tokenize(original, folded) {
  const out = [];
  for (const m of folded.matchAll(/[a-z0-9]+/g)) {
    out.push({ word: m[0], raw: original.slice(m.index, m.index + m[0].length).toLowerCase() });
  }
  return out;
}

// Longest phrase from `phrases` starting at tokens[i]; accent-guarded words
// must match their accented spelling when the message has accents.
function matchPhrase(tokens, i, phrases, accented, strictAccents) {
  let best = null;
  for (const phrase of phrases) {
    const parts = phrase.split(" ");
    if (i + parts.length > tokens.length) continue;
    if (!parts.every((p, j) => tokens[i + j].word === p)) continue;
    if (strictAccents && parts.length === 1 && accented?.[phrase] && !accented[phrase].includes(tokens[i].raw)) continue;
    if (!best || parts.length > best.length) best = { phrase, length: parts.length };
  }
  return best;
}

function matchModifier(tokens, i, strictAccents) {
  let best = null;
  for (const mod of MODIFIERS) {
    const guard = mod.accented ? Object.fromEntries(mod.words.map((w) => [w, mod.accented])) : null;
    const hit = matchPhrase(tokens, i, mod.words, guard, strictAccents);
    if (hit && (!best || hit.length > best.length)) best = { mod, length: hit.length };
  }
  return best;
}

function matchValue(tokens, i, table, strictAccents) {
  let best = null;
  for (const entry of table) {
    const hit = matchPhrase(tokens, i, entry.words, entry.accented, strictAccents);
    if (hit && (!best || hit.length > best.length)) best = { value: entry.value, length: hit.length };
  }
  return best;
}

// Parses a whole clause as instructions only ("không hành ít tiêu"); null
// as soon as a word is neither an instruction nor noise.
function parseClause(tokens, strictAccents) {
  const found = [];
  let i = 0;
  while (i < tokens.length) {
    if (NOISE.has(tokens[i].word)) {
      i += 1;
      continue;
    }
    const pre = matchValue(tokens, i, PRE_VALUES, strictAccents);
    if (pre) {
      const mod = matchModifier(tokens, i + pre.length, strictAccents);
      if (mod) {
        found.push({ attribute: mod.mod.key, value: pre.value });
        i += pre.length + mod.length;
        continue;
      }
    }
    const mod = matchModifier(tokens, i, strictAccents);
    if (mod) {
      const post = matchValue(tokens, i + mod.length, POST_VALUES, strictAccents);
      if (post) {
        found.push({ attribute: mod.mod.key, value: post.value });
        i += mod.length + post.length;
        continue;
      }
    }
    return null;
  }
  return found.length ? found : null;
}

export function instructionLabel({ attribute, value }) {
  const mod = MODIFIERS.find((m) => m.key === attribute);
  const name = mod ? mod.label : attribute;
  return value === "normal" ? `${name} bình thường` : `${VALUE_LABEL[value]} ${name}`;
}

function withLabels(list) {
  // the last word on an attribute wins inside one message
  const byAttr = new Map();
  for (const i of list) byAttr.set(i.attribute, i);
  return [...byAttr.values()].map((i) => ({ ...i, label: instructionLabel(i) }));
}

/**
 * @returns {null | {
 *   instructions: [{attribute, value, label}],
 *   temporality: "current_only" | "order" | "persistent" | "strong",
 *   scope: "merchant" | "global" | "product",
 *   pure: boolean,       // the whole message is instructions
 *   remainder: string,   // the message without its instruction parts
 * }}
 */
export function extractFoodInstructions(text) {
  const { original, folded } = fold(text);
  const strictAccents = hasDiacritics(original);
  const qualifiers = folded.replace(/[^a-z0-9]+/g, " ");

  // clauses separated by , ; . / + "và"
  const parts = [];
  let last = 0;
  for (const m of folded.matchAll(/\s*(?:[,;./+\n]|\bva\b)\s*/g)) {
    parts.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  parts.push({ start: last, end: folded.length });

  const instructions = [];
  const removed = [];
  const correctionParts = [];
  for (const part of parts) {
    const partOriginal = original.slice(part.start, part.end);
    const partFolded = folded.slice(part.start, part.end).replace(QUALIFIER_WORDS, (w) => " ".repeat(w.length));
    const tokens = tokenize(partOriginal, partFolded);
    if (tokens.length === 0) continue;
    if (CORRECTION_PART.test(tokens.map((t) => t.word).join(" "))) {
      correctionParts.push([part.start, part.end]);
      continue;
    }
    const whole = parseClause(tokens, strictAccents);
    if (whole) {
      instructions.push(...whole);
      removed.push([part.start, part.end]);
      continue;
    }
    // "2 thập cẩm không hành" — an instruction trailing an order part
    for (let k = 1; k < tokens.length; k++) {
      const tail = parseClause(tokens.slice(k), strictAccents);
      if (tail && !NOISE.has(tokens[k].word)) {
        instructions.push(...tail);
        const cut = partFolded.search(new RegExp(`\\b${tokens[k].word}\\b`));
        if (cut >= 0) removed.push([part.start + cut, part.end]);
        break;
      }
    }
  }
  if (instructions.length === 0) return null;
  const correction = correctionParts.length > 0 && correctionParts[0][0] === 0;
  if (correction) removed.push(...correctionParts);

  let remainder = original;
  for (const [a, b] of removed.sort((x, y) => y[0] - x[0])) remainder = `${remainder.slice(0, a)} ${remainder.slice(b)}`;
  remainder = remainder.replace(/(?:\s*[,;]\s*)+/g, ", ").replace(/^[\s,;.+]+|[\s,;.+]+$/g, "").trim();
  const remainderFolded = fold(remainder).folded.replace(/[^a-z0-9]+/g, " ").trim();
  if (PRODUCT_REFERENCE_REMAINDER.test(remainderFolded) || /^(?:cho\s*)?(?:em|anh|chi|toi|minh|tui)?\s*(?:muon|thich|lay)?$/.test(remainderFolded)) remainder = "";

  const temporality = CURRENT_ONLY.test(qualifiers)
    ? "current_only"
    : STRONG_PERSISTENT.test(qualifiers)
    ? "strong"
    : SELF_HABIT.test(qualifiers) || /\b(that ra|thuc ra)\b/.test(qualifiers)
    ? "persistent"
    : "order";
  const scope = GLOBAL_SCOPE.test(qualifiers) ? "global" : PRODUCT_SCOPE.test(qualifiers) ? "product" : "merchant";
  const pure = !/[\p{L}\p{N}]/u.test(remainder.replace(/\b(nhé|nha|ạ|nhen|em|anh|chị|nhe|nha|a|vay|vậy)\b/giu, ""));
  return { instructions: withLabels(instructions), temporality, scope, correction, pure, remainder: pure ? "" : remainder };
}
