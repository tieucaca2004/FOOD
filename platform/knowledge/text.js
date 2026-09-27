import { stripAccents } from "../../src/nlp/normalize.js"; // generic pure utility — read-only reuse

// Text handling shared by the knowledge layer. Evidence is compared on the
// ORIGINAL (accented) text: only Unicode NFC and whitespace are normalized,
// never accents, case or wording — a quote either appears in its source or
// it does not.

export function nfc(text) {
  return String(text ?? "").normalize("NFC");
}

export function collapseWhitespace(text) {
  return nfc(text).replace(/\s+/g, " ").trim();
}

/** Accent-free lowercase form, same length as the NFC input (for offset-safe matching). */
export function fold(text) {
  const original = nfc(text).toLowerCase();
  const folded = stripAccents(original);
  return folded.length === original.length ? { original, folded } : { original: folded, folded };
}

/** "Bún Cá!" -> "bun ca" — the search/dedup key; never replaces the original name. */
export function normalizeName(text) {
  return stripAccents(nfc(text))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function hasDiacritics(text) {
  const t = nfc(text);
  return t.normalize("NFD") !== t.normalize("NFD").replace(/[̀-ͯ]/g, "") || /đ/i.test(t);
}

// HTML named entities: the basics, typographic marks, and every Latin-1 letter
// (some sites write "Nh&agrave; h&agrave;ng" for "Nhà hàng"). Lookup is case-sensitive
// (&Agrave; ≠ &agrave;), with a lowercase fallback for the basic ones.
const LATIN1_LETTERS = "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•", middot: "·",
  laquo: "«", raquo: "»", deg: "°", copy: "©", reg: "®", trade: "™", euro: "€",
  ...Object.fromEntries(LATIN1_LETTERS.map((name, i) => [name, String.fromCharCode(0xc0 + i)])),
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);
}

function jsonStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => jsonStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => jsonStrings(v, out));
  return out;
}

// Block-level tags separate words; inline tags (<a>, <b>, <span>…) do not —
// "của <a>Nha Trang</a>." reads "của Nha Trang." as a browser shows it.
const BLOCK_TAGS =
  "p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|figure|figcaption|title|head|body|html|option|pre";
// a tag's attributes may contain ">" inside quotes (data-mw='…>…')
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const BLOCK_TAG_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})(?:\\s${ATTRS})?\\/?>`, "gi");
const ANY_TAG_RE = new RegExp(`<\\/?[a-zA-Z][\\w:-]*${ATTRS}>`, "g");

/** Visible text of an HTML document (scripts, styles and comments removed). */
export function htmlToText(html) {
  const body = String(html)
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BLOCK_TAG_RE, " ")
    .replace(ANY_TAG_RE, "");
  return collapseWhitespace(decodeEntities(body));
}

/**
 * The visible text of an HTML document as blocks, in order: [{heading: 1-6|null, text}].
 * Same tag handling as htmlToText, so every block's text is a verbatim
 * substring of htmlToText(html) — a block can be used as an evidence quote.
 */
export function htmlBlocks(html) {
  const marked = String(html)
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(`<h([1-6])(?:\\s${ATTRS})?>`, "gi"), "\u0000\u0001$1")
    .replace(BLOCK_TAG_RE, "\u0000")
    .replace(ANY_TAG_RE, "");
  const blocks = [];
  for (const part of decodeEntities(marked).split("\u0000")) {
    const heading = part.startsWith("\u0001") ? Number(part[1]) : null;
    const text = collapseWhitespace(heading ? part.slice(2) : part);
    if (text) blocks.push({ heading, text });
  }
  return blocks;
}

/** RFC 6901 JSON pointer ("/elements/3/tags/name"); undefined when absent. */
export function jsonPointer(doc, pointer) {
  if (pointer === "") return doc;
  if (!String(pointer).startsWith("/")) return undefined;
  let cur = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The exact quote a JSON value is evidenced by: a string as-is, anything else as compact JSON. */
export function jsonQuote(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The readable text of a stored raw source, which evidence quotes are
 * checked against. Unsupported content types return null (-> review).
 */
export function rawToText(raw, contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type === "text/plain") return collapseWhitespace(raw);
  if (type === "text/html") return htmlToText(raw);
  if (type === "application/json") {
    try {
      return collapseWhitespace(jsonStrings(JSON.parse(raw), []).join("\n"));
    } catch {
      return null;
    }
  }
  return null;
}
