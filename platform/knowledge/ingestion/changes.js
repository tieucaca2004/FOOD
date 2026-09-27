import { normalizeName } from "../text.js";
import { addressKey } from "../discoveryStore.js";

// Change detection: what does a claim say compared with PUBLISHED knowledge?
//   NEW        nothing published for it yet (a new product / price / hours)
//   UPDATED    published says something else (45k -> 50k; a new address)
//   UNCHANGED  published says the same
//   REMOVED    "bỏ món …" for a product that is published
//   CONFLICT   an authoritative source (the place's own menu / site) recently said otherwise — never auto-resolved
//   DUPLICATE  the same claim is already waiting for review from another message
//   UNCERTAIN  the place is unknown / ambiguous / missing, or the value is implausible
// It reads published knowledge only; it never changes it.

const OFFICIAL = new Set(["merchant_official", "merchant_social"]);
const OFFICIAL_RECENT_DAYS = 180;

export function detectChange(db, { finding, resolution, product }) {
  // an implausible value (1đ, an OCR slip, an instruction written as text) is high-risk wherever it comes from
  if (finding.implausible) return { change: "UNCERTAIN", severity: "HIGH", previous: null };
  if (resolution.status !== "resolved") {
    return { change: "UNCERTAIN", severity: resolution.status === "ambiguous" ? "HIGH" : "MEDIUM", previous: null };
  }
  const place = resolution.kbPlaceId;
  if (finding.kind === "price") {
    if (!product) return { change: "NEW", severity: "LOW", previous: null };
    const latest = db
      .prepare(
        `SELECT p.price, p.price_max, p.captured_at, s.source_type FROM kb_v_latest_prices p
         JOIN kb_evidence e ON e.id = p.evidence_id JOIN kb_sources s ON s.id = e.source_id
         WHERE p.product_id = ? AND p.variant IS NULL ORDER BY p.captured_at DESC LIMIT 1`
      )
      .get(product.id);
    if (!latest) return { change: "NEW", severity: "LOW", previous: null };
    const previous = latest.price_max ? `${latest.price}-${latest.price_max}` : String(latest.price);
    if (previous === finding.normalizedValue) return { change: "UNCHANGED", severity: "LOW", previous };
    const officialRecently = OFFICIAL.has(latest.source_type) && (Date.now() - Date.parse(latest.captured_at)) / 86_400_000 <= OFFICIAL_RECENT_DAYS;
    return officialRecently ? { change: "CONFLICT", severity: "HIGH", previous } : { change: "UPDATED", severity: "MEDIUM", previous };
  }
  if (finding.kind === "availability") {
    return product ? { change: "REMOVED", severity: "MEDIUM", previous: "listed" } : { change: "UNCERTAIN", severity: "LOW", previous: null };
  }
  if (finding.kind === "address") {
    const latest = db.prepare(`SELECT address_original FROM kb_merchant_locations WHERE merchant_id = ? AND status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1`).get(place);
    if (!latest) return { change: "NEW", severity: "MEDIUM", previous: null };
    const same = (addressKey(latest.address_original) ?? normalizeName(latest.address_original)) === (addressKey(finding.normalizedValue) ?? normalizeName(finding.normalizedValue));
    // an address change always matters to a customer: HIGH, never automatic
    return same ? { change: "UNCHANGED", severity: "LOW", previous: latest.address_original } : { change: "UPDATED", severity: "HIGH", previous: latest.address_original };
  }
  if (finding.kind === "opening_hours") {
    const latest = db.prepare(`SELECT original_text FROM kb_merchant_claims WHERE merchant_id = ? AND field = 'opening_hours' AND status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1`).get(place);
    if (!latest) return { change: "NEW", severity: "LOW", previous: null };
    return normalizeName(latest.original_text) === normalizeName(finding.rawValue) ? { change: "UNCHANGED", severity: "LOW", previous: latest.original_text } : { change: "UPDATED", severity: "MEDIUM", previous: latest.original_text };
  }
  return { change: "UNCERTAIN", severity: "MEDIUM", previous: null };
}

// Confidence of a candidate — a number for ordering the review queue and for a FUTURE
// auto-approval policy; V1 publishes nothing automatically whatever the number.
const ROLE_BONUS = { admin: 0.3, editor: 0.2, verified: 0.15, member: 0, blocked: -1 };
const RESOLUTION_BONUS = { resolved: 0.15, ambiguous: -0.15, unknown: -0.2, none: -0.25 };
const CHANGE_BONUS = { UNCHANGED: 0.1, NEW: 0, UPDATED: 0, REMOVED: 0, DUPLICATE: 0, CONFLICT: -0.2, UNCERTAIN: -0.1 };

export function confidenceOf({ role, resolution, change, finding, fromOcr = false, ocrConfidence = null }) {
  let c = 0.35 + (ROLE_BONUS[role] ?? 0) + (RESOLUTION_BONUS[resolution.status] ?? 0) + (CHANGE_BONUS[change] ?? 0);
  if (finding.kind === "price" && !finding.implausible) c += 0.05;
  if (finding.implausible) c -= 0.3;
  if (fromOcr) c = c * Math.min(1, Math.max(0, ocrConfidence ?? 0.5));
  return Math.round(Math.min(0.99, Math.max(0.01, c)) * 100) / 100;
}
