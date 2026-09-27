import { normalizeName, collapseWhitespace, nfc } from "../text.js";
import { parsePrice } from "../price.js";

// Structured image readings (menu items, a merchant name, an address) -> findings, EVIDENCE FIRST:
//   - an item counts only if its words are found in the OCR text of the same image (a model that "sees" a dish the
//     transcription does not contain is not evidence) — the quote is the OCR line itself, verbatim, so the validator
//     can check it against the stored OCR file later;
//   - the price is re-read by FOOD's own parser from the price as written; the model's number is never trusted, and
//     an approximate amount ("khoảng 45k", "tầm 40-50k") is never a price;
//   - a merchant / address counts only if it is written in the image text.
// Everything returned is a PROPOSAL; nothing here decides what is true.

const APPROX = /(?:khoảng|khoang|tầm|tam|chừng|chung|cỡ|co|~|≈|hơn|dưới|duoi|trên|tren|từ|tu)\s*$/iu;
const PLAUSIBLE = { min: 1000, max: 20_000_000 };

const clean = (s) => collapseWhitespace(nfc(String(s ?? ""))).trim();

/** The verbatim line(s) of the OCR text that contain the given words, or null. */
export function locateInText(ocrText, words) {
  const needle = normalizeName(words);
  if (!needle) return null;
  const lines = String(ocrText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => ` ${normalizeName(l)} `.includes(` ${needle} `));
  if (line) return line;
  // two lines (a name above its price)
  for (let i = 0; i + 1 < lines.length; i++) {
    const two = `${lines[i]}\n${lines[i + 1]}`;
    if (` ${normalizeName(two)} `.includes(` ${needle} `)) return two;
  }
  return null;
}

/** An amount written with an approximation word just before it ("khoảng 45k") is not a price. */
export function isApproximate(segment, rawValue) {
  const at = String(segment ?? "").indexOf(String(rawValue ?? ""));
  if (at < 0) return false;
  return APPROX.test(String(segment).slice(Math.max(0, at - 12), at));
}

/**
 * @param {{items?: object[], merchant?: {name?: string}|null, address?: {text?: string}|null}} reading
 * @param {string} ocrText
 * @returns {{findings: object[], placeText: string|null, rejected: {name: string, reason: string}[]}}
 */
export function imageFindings(reading, ocrText) {
  const findings = [];
  const rejected = [];
  for (const item of reading?.items ?? []) {
    const name = clean(item?.name);
    if (!name) continue;
    const evidence = clean(item?.evidence_text) || name;
    const line = locateInText(ocrText, evidence) ?? locateInText(ocrText, name);
    if (!line) {
      rejected.push({ name, reason: "not_in_image_text" });
      continue;
    }
    if (!` ${normalizeName(line)} `.includes(` ${normalizeName(name)} `)) {
      rejected.push({ name, reason: "name_not_in_evidence" });
      continue;
    }
    const variant = clean(item?.variant) || null;
    const priceRaw = clean(item?.price_raw);
    const parsed = priceRaw ? parsePrice(priceRaw) : { price: null };
    const priceWritten = priceRaw && normalizeName(line).replace(/\s/g, "").includes(normalizeName(priceRaw).replace(/\s/g, ""));
    if (parsed.price !== null && priceWritten && !isApproximate(line, priceRaw)) {
      findings.push({
        segment: line,
        kind: "price",
        productText: name,
        rawValue: priceRaw,
        normalizedValue: parsed.priceMax ? `${parsed.price}-${parsed.priceMax}` : String(parsed.price),
        variant,
        implausible: !(parsed.price >= PLAUSIBLE.min && (parsed.priceMax ?? parsed.price) <= PLAUSIBLE.max),
        itemConfidence: typeof item.confidence === "number" ? item.confidence : null,
      });
    } else {
      if (priceRaw) rejected.push({ name, reason: parsed.price === null ? "price_unreadable" : !priceWritten ? "price_not_in_evidence" : "price_approximate" });
      // the dish is on the menu even when its price is unreadable / missing: a product candidate, price unknown
      findings.push({ segment: line, kind: "product", productText: name, rawValue: name, normalizedValue: normalizeName(name), variant, itemConfidence: typeof item.confidence === "number" ? item.confidence : null });
    }
  }
  const merchantName = clean(reading?.merchant?.name);
  const placeText = merchantName && locateInText(ocrText, merchantName) ? merchantName : null;
  if (merchantName && !placeText) rejected.push({ name: merchantName, reason: "merchant_not_in_image_text" });
  const addressText = clean(reading?.address?.text);
  if (addressText) {
    const line = locateInText(ocrText, addressText);
    if (line) findings.push({ segment: line, kind: "address", rawValue: addressText, normalizedValue: addressText });
    else rejected.push({ name: addressText, reason: "address_not_in_image_text" });
  }
  return { findings, placeText, rejected };
}
