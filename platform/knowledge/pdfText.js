import zlib from "node:zlib";

// Minimal, dependency-free text reader for text-based PDFs (menus). Reads
// indirect objects, inflates FlateDecode streams, maps glyph codes to Unicode
// through each font's /ToUnicode CMap and walks the page content streams'
// text operators (Tj, TJ, ', ") — one output line per text line (y position).
// Image-only / scanned PDFs yield no text (OCR is NOT done here). Returns null
// when the file cannot be read as a PDF.

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;

function parseObjects(buf) {
  const s = buf.toString("latin1");
  const objects = new Map();
  for (const m of s.matchAll(OBJ_RE)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) continue;
    const body = s.slice(start, end);
    const at = body.search(/\bstream\r?\n/);
    let dict = body;
    let stream = null;
    if (at >= 0) {
      dict = body.slice(0, at);
      const dataStart = start + at + body.slice(at).match(/^stream\r?\n/)[0].length;
      const lenRef = dict.match(/\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/);
      let dataEnd = s.indexOf("endstream", dataStart);
      if (lenRef && !lenRef[2]) dataEnd = Math.min(dataEnd, dataStart + Number(lenRef[1]));
      stream = buf.subarray(dataStart, dataEnd);
    }
    objects.set(Number(m[1]), { dict, stream });
  }
  return objects;
}

function streamData(obj) {
  if (!obj?.stream) return null;
  if (/\/FlateDecode/.test(obj.dict)) {
    try {
      return zlib.inflateSync(obj.stream);
    } catch {
      try {
        return zlib.inflateSync(obj.stream, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
    }
  }
  if (/\/Filter/.test(obj.dict)) return null; // other filters (DCT images…) are not text
  return obj.stream;
}

const ref = (dict, key) => {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
};

function hexToString(hex) {
  const h = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 3 < h.length + 1; i += 4) {
    const code = parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16);
    out += String.fromCodePoint(code);
  }
  // UTF-16 surrogate pairs come out as two code units: join them
  return out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, (p) => String.fromCodePoint(p.codePointAt(0)));
}

/** ToUnicode CMap -> {width: bytes per code, map: Map<code, string>} */
export function parseCMap(text) {
  const map = new Map();
  let width = 1;
  // bytes per code: from the declared codespace range (else the widest source code seen)
  const space = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (space) width = space[1].length / 2;
  else for (const r of text.matchAll(/<([0-9A-Fa-f]+)>\s*<[0-9A-Fa-f\s]+>/g)) width = Math.max(width, r[1].length / 2);
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]*)>/g)) map.set(parseInt(m[1], 16), hexToString(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3].startsWith("[")) {
        const dsts = [...m[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((d) => hexToString(d[1]));
        for (let c = lo; c <= hi && c - lo < dsts.length; c++) map.set(c, dsts[c - lo]);
      } else {
        const base = m[3].slice(1, -1);
        const start = parseInt(base, 16);
        for (let c = lo; c <= hi; c++) {
          const v = (start + (c - lo)).toString(16).padStart(base.length, "0");
          map.set(c, hexToString(v));
        }
      }
    }
  }
  return { width, map };
}

function decodeLiteral(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      bytes.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const n = raw[++i];
    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (n in esc) bytes.push(esc[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1])) oct += raw[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (n === "\r" || n === "\n") {
      if (n === "\r" && raw[i + 1] === "\n") i++;
    } else bytes.push(n.charCodeAt(0) & 0xff);
  }
  return bytes;
}

function showText(bytes, font) {
  if (!font) return bytes.map((b) => String.fromCharCode(b)).join("");
  let out = "";
  for (let i = 0; i + font.width <= bytes.length; i += font.width) {
    let code = 0;
    for (let k = 0; k < font.width; k++) code = (code << 8) | bytes[i + k];
    out += font.map.get(code) ?? (font.width === 1 ? String.fromCharCode(code) : "");
  }
  return out;
}

// tokenizer over a content stream (latin1 string)
function* tokens(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth > 0; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
      }
      yield { t: "str", bytes: decodeLiteral(s.slice(i + 1, j - 1)) };
      i = j;
    } else if (c === "<" && s[i + 1] !== "<") {
      const j = s.indexOf(">", i);
      const hex = s.slice(i + 1, j).replace(/\s+/g, "");
      const bytes = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
      yield { t: "str", bytes };
      i = j + 1;
    } else if (c === "[" || c === "]") {
      yield { t: c };
      i++;
    } else if (c === "<" || c === ">") {
      i += 2;
    } else if (c === "/") {
      let j = i + 1;
      while (j < s.length && !/[\s/[\]()<>%]/.test(s[j])) j++;
      yield { t: "name", v: s.slice(i + 1, j) };
      i = j;
    } else {
      let j = i;
      while (j < s.length && !/[\s/[\]()<>%]/.test(s[j])) j++;
      const w = s.slice(i, j) || s[i];
      yield /^[-+.\d]+$/.test(w) ? { t: "num", v: Number(w) } : { t: "op", v: w };
      i = j === i ? i + 1 : j;
    }
  }
}

/** The inline dictionary value of /key (balanced << >>), or null when it is not inline. */
function subDict(dict, key) {
  const m = new RegExp(`/${key}\\s*<<`).exec(dict);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 2; i < dict.length - 1; i++) {
    if (dict[i] === "<" && dict[i + 1] === "<") {
      depth++;
      i++;
    } else if (dict[i] === ">" && dict[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return dict.slice(m.index + m[0].length, i - 1);
    }
  }
  return null;
}

function pageFonts(objects, pageDict) {
  const fonts = new Map();
  // a value is either an inline << … >> dictionary (nested ones included) or a "N 0 R" reference
  const resolve = (dict, key) => {
    const inline = subDict(dict, key);
    if (inline !== null) return inline;
    const r = ref(dict, key);
    return r !== null ? objects.get(r)?.dict ?? "" : "";
  };
  const res = resolve(pageDict, "Resources");
  const fontDict = resolve(res, "Font");
  for (const m of (fontDict ?? "").matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objects.get(Number(m[2]));
    const tu = font ? ref(font.dict, "ToUnicode") : null;
    const data = tu !== null ? streamData(objects.get(tu)) : null;
    fonts.set(m[1], data ? parseCMap(data.toString("latin1")) : null);
  }
  return fonts;
}

/** Text lines of a PDF (null when unreadable). */
export function pdfToLines(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  const objects = parseObjects(buf);
  const pages = [...objects.values()].filter((o) => /\/Type\s*\/Page(?!s)\b/.test(o.dict));
  const lines = [];
  for (const page of pages) {
    const fonts = pageFonts(objects, page.dict);
    const contentRefs = [];
    const arr = page.dict.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) for (const m of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentRefs.push(Number(m[1]));
    else if (ref(page.dict, "Contents") !== null) contentRefs.push(ref(page.dict, "Contents"));
    const content = contentRefs.map((r) => streamData(objects.get(r))?.toString("latin1") ?? "").join("\n");
    let font = null;
    let line = "";
    let y = null;
    const stack = [];
    const flush = () => {
      if (line.trim()) lines.push(line.replace(/\s+/g, " ").trim());
      line = "";
    };
    const moveTo = (ny) => {
      if (y !== null && Math.abs(ny - y) > 0.5) flush();
      y = ny;
    };
    for (const tok of tokens(content)) {
      if (tok.t !== "op") {
        stack.push(tok);
        continue;
      }
      const nums = stack.filter((x) => x.t === "num").map((x) => x.v);
      switch (tok.v) {
        case "Tf": {
          const name = [...stack].reverse().find((x) => x.t === "name");
          font = name ? fonts.get(name.v) ?? null : null;
          break;
        }
        case "Td":
        case "TD":
          if (nums.length >= 2) moveTo((y ?? 0) + nums[nums.length - 1]);
          if (nums.length >= 2 && nums[nums.length - 1] === 0 && nums[nums.length - 2] > 0) line += " ";
          break;
        case "Tm":
          if (nums.length >= 6) moveTo(nums[5]);
          break;
        case "T*":
          flush();
          break;
        case "Tj":
        case "'":
        case '"': {
          const str = [...stack].reverse().find((x) => x.t === "str");
          if (tok.v !== "Tj") flush();
          if (str) line += showText(str.bytes, font);
          break;
        }
        case "TJ": {
          for (const x of stack) {
            if (x.t === "str") line += showText(x.bytes, font);
            else if (x.t === "num" && x.v < -200) line += " "; // a wide kerning gap is a space
          }
          break;
        }
        case "ET":
          break;
        default:
          break;
      }
      stack.length = 0;
    }
    flush();
  }
  return lines;
}

/** The PDF's text as one string (the validator's view), or null — also when it has no text layer (scanned / images). */
export function pdfToText(buf) {
  const lines = pdfToLines(buf);
  return lines && lines.length ? lines.join("\n") : null;
}
