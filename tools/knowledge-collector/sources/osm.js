import { parseOpeningHours } from "../extract/openingHours.js";

// OpenStreetMap (ODbL-1.0) through a public Overpass API instance. One
// bounding-box query per run; every merchant fact is evidenced by the JSON
// element it came from (JSON-pointer evidence: /elements/<i>).

export const OVERPASS_ENDPOINT = "https://overpass.kumi.systems/api/interpreter";
export const OSM_LICENSE = "ODbL-1.0";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL 1.0)";
const FOOD_AMENITIES = ["restaurant", "fast_food", "cafe", "food_court", "ice_cream"];

export function buildOverpassQuery({ south, west, north, east }) {
  return `[out:json][timeout:90];nwr["amenity"~"^(${FOOD_AMENITIES.join("|")})$"]["name"](${south},${west},${north},${east});out center tags;`;
}

function coords(el) {
  return el.lat !== undefined ? { lat: el.lat, lng: el.lon } : el.center ? { lat: el.center.lat, lng: el.center.lon } : { lat: null, lng: null };
}

// How much a source says about a place: richer elements first. Deterministic.
function richness(el) {
  const t = el.tags || {};
  return ["cuisine", "addr:street", "opening_hours", "phone", "contact:phone", "website", "contact:website", "delivery", "takeaway"].filter((k) => t[k]).length;
}

/** The pilot subset: named food places, richest first, then by element id. */
export function selectPilot(elements, limit = 50) {
  return elements
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => el.tags?.name)
    .sort((a, b) => richness(b.el) - richness(a.el) || `${a.el.type}/${a.el.id}`.localeCompare(`${b.el.type}/${b.el.id}`))
    .slice(0, limit);
}

function phoneKey(p) {
  const digits = String(p).split(/[;,]/)[0].replace(/[^\d+]/g, "");
  return digits.replace(/^\+84/, "0") || null;
}

function websiteKey(w) {
  try {
    return new URL(String(w).split(";")[0].trim()).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Imports the selected OSM elements into the discovery store.
 * @returns {{merchants: number, locations: number, claims: number, results: Array}}
 */
export function importOsm({ discovery, source, elements, selection, regionId }) {
  const stats = { merchants: 0, locations: 0, claims: 0, results: [] };
  for (const { el, index } of selection) {
    const t = el.tags;
    const evidence = { sourceId: source.id, locator: `/elements/${index}`, quote: JSON.stringify(el), extraction: "explicit", proposedBy: "collector:osm" };
    const { lat, lng } = coords(el);
    const phone = t.phone || t["contact:phone"];
    const website = t.website || t["contact:website"];
    const identifiers = [{ scheme: "osm", value: `${el.type}/${el.id}` }];
    if (phone && phoneKey(phone)) identifiers.push({ scheme: "phone", value: phoneKey(phone) });
    if (website && websiteKey(website)) identifiers.push({ scheme: "website", value: websiteKey(website) });
    const m = discovery.upsertMerchant({ name: t.name, identifiers, lat, lng, address: t["addr:street"] ?? null, seenAt: source.fetched_at, evidence });
    stats.results.push({ element: `${el.type}/${el.id}`, name: t.name, ...m });
    if (!m.merchantId) continue;
    if (m.action !== "matched") stats.merchants += 1;
    const at = source.fetched_at;
    const address = t["addr:full"] ?? t["addr:street"] ?? null;
    if (address || lat !== null) {
      const loc = discovery.proposeLocation({
        merchantId: m.merchantId,
        addressOriginal: address,
        street: t["addr:street"] ?? null,
        ward: t["addr:suburb"] ?? t["addr:quarter"] ?? null,
        city: t["addr:city"] ?? null,
        province: t["addr:province"] ?? null,
        regionId,
        lat,
        lng,
        coordinatesFrom: lat === null ? null : "source",
        evidence,
        capturedAt: at,
      });
      if (loc.outcome === "published") stats.locations += 1;
    }
    const claim = (field, originalText, value = null) => {
      if (originalText === undefined || originalText === null || originalText === "") return;
      const r = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field, value, originalText: String(originalText), evidence, capturedAt: at });
      if (r.outcome === "published") stats.claims += 1;
    };
    claim("business_type", t.amenity, t.amenity);
    claim("cuisine", t.cuisine, t.cuisine ? t.cuisine.split(";").map((c) => c.trim()).filter(Boolean) : null);
    claim("opening_hours", t.opening_hours, parseOpeningHours(t.opening_hours));
    claim("phone", phone);
    claim("website", website);
    claim("facebook", t["contact:facebook"]);
    claim("delivery", t.delivery, t.delivery === "yes" ? true : t.delivery === "no" ? false : null);
    claim("takeaway", t.takeaway, t.takeaway === "yes" || t.takeaway === "only" ? true : t.takeaway === "no" ? false : null);
    claim("description", t.description);
  }
  return stats;
}
