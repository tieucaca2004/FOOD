// Image validation BEFORE any reader sees a file: the real type from the bytes (never the claimed MIME or the file
// name), the size, the dimensions from the header, and basic integrity (a truncated / corrupt file is refused).
// No image library: JPEG / PNG / WEBP headers are read directly. A refusal is a normal result, never a throw.

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_LIMITS = { maxBytes: 10 * 1024 * 1024, minSide: 16, maxSide: 12000, maxPixels: 60_000_000 };

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

function pngInfo(buf) {
  // IHDR must be the first chunk; IEND must close the file
  if (buf.length < 33 || buf.toString("latin1", 12, 16) !== "IHDR") return { ok: false, reason: "corrupt" };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const tail = buf.subarray(Math.max(0, buf.length - 12));
  if (!tail.includes(Buffer.from("IEND", "latin1"))) return { ok: false, reason: "truncated" };
  return { ok: true, width, height };
}

function jpegInfo(buf) {
  let i = 2;
  let dims = null;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return { ok: false, reason: "corrupt" };
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return { ok: false, reason: "truncated" };
    // SOF0..SOF15 except DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      dims = { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) break; // start of scan: entropy-coded data follows
    i += 2 + len;
  }
  if (!dims) return { ok: false, reason: "corrupt" };
  // a complete JPEG ends with EOI (FFD9), give or take trailing padding
  const tail = buf.subarray(Math.max(0, buf.length - 64));
  let eoi = false;
  for (let j = tail.length - 2; j >= 0; j--) if (tail[j] === 0xff && tail[j + 1] === 0xd9) eoi = true;
  if (!eoi) return { ok: false, reason: "truncated" };
  return { ok: true, ...dims };
}

function webpInfo(buf) {
  if (buf.length < 30) return { ok: false, reason: "corrupt" };
  if (buf.readUInt32LE(4) + 8 > buf.length) return { ok: false, reason: "truncated" };
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { ok: true, width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { ok: true, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { ok: true, width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  return { ok: false, reason: "corrupt" };
}

/**
 * @param {Buffer} buf
 * @param {{claimedMimeType?: string|null, limits?: object}} [opts]
 * @returns {{ok: true, mimeType: string, width: number, height: number, bytes: number} | {ok: false, reason: string, detail?: string, mimeType?: string|null}}
 *   reasons: empty | too_large | unsupported_type | corrupt | truncated | dimensions
 */
export function checkImage(buf, { claimedMimeType = null, limits = IMAGE_LIMITS } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: "empty" };
  if (buf.length > limits.maxBytes) return { ok: false, reason: "too_large", detail: `${buf.length} bytes > ${limits.maxBytes}` };
  const mimeType = sniff(buf);
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.includes(mimeType)) return { ok: false, reason: "unsupported_type", mimeType, detail: `claimed ${claimedMimeType ?? "?"}` };
  const info = mimeType === "image/png" ? pngInfo(buf) : mimeType === "image/jpeg" ? jpegInfo(buf) : webpInfo(buf);
  if (!info.ok) return { ok: false, reason: info.reason, mimeType };
  const { width, height } = info;
  if (!(width >= limits.minSide && height >= limits.minSide && width <= limits.maxSide && height <= limits.maxSide && width * height <= limits.maxPixels)) {
    return { ok: false, reason: "dimensions", mimeType, detail: `${width}x${height}` };
  }
  return { ok: true, mimeType, width, height, bytes: buf.length };
}
