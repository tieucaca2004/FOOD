import { normalizeName } from "../../../platform/knowledge/text.js";

// Google Maps merchant DISCOVERY through the OFFICIAL Places API (New)
// Text Search — never by scraping the Maps web app (consent / anti-bot /
// terms). Runs only when GOOGLE_PLACES_API_KEY is configured; without it the
// step reports "not_configured" and nothing is fetched.
//
// Maps is a merchant-METADATA source: name, address, coordinates, phone,
// website, hours, category, rating + review count (an observed external
// signal with its date — never "the best"). Never a menu, a price or a food
// fact. Every value is evidenced by a JSON pointer into the stored API
// response. NOTE: Google Maps Platform terms limit how long Places content may
// be kept (the place ID may be stored) — see the report; the founder decides.

export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
export const PLACES_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location", "places.rating", "places.userRatingCount",
  "places.regularOpeningHours.weekdayDescriptions", "places.nationalPhoneNumber", "places.websiteUri", "places.primaryType", "places.types", "places.googleMapsUri",
].join(",");
export const PLACES_ATTRIBUTION = "Google Maps (Places API)";
// place types that are places to eat or drink
const FOOD_TYPES = /(?:restaurant|food|cafe|coffee|bakery|bar|meal_takeaway|meal_delivery|diner|steak|seafood|noodle|sushi|ramen|pizza|barbecue|vegetarian|vegan|dessert|ice_cream|juice|tea|breakfast|brunch|buffet|fast_food)/;

export class GooglePlacesSearch {
  constructor({ apiKey = process.env.GOOGLE_PLACES_API_KEY, fetcher } = {}) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /** One Text Search page: the raw stored response (or why not). */
  async search(textQuery, { languageCode = "vi", regionCode = "VN", locationBias = null } = {}) {
    if (!this.configured) return { ok: false, blocked: "not_configured" };
    const body = JSON.stringify({ textQuery, languageCode, regionCode, ...(locationBias ? { locationBias } : {}) });
    return this.fetcher.fetch(PLACES_ENDPOINT, {
      sourceType: "maps_business",
      method: "POST",
      body,
      contentType: "application/json",
      accept: "application/json",
      extraHeaders: { "X-Goog-Api-Key": this.apiKey, "X-Goog-FieldMask": PLACES_FIELDS },
    });
  }
}

/** Is a Places result a place to eat/drink (by its own types)? */
export function isFoodPlace(place) {
  return [place.primaryType, ...(place.types ?? [])].some((t) => t && FOOD_TYPES.test(t));
}

/**
 * Imports the places of one stored Text Search response.
 * @param {{knowledge, discovery, source, response: object, capturedAt: string, regionId?: string, localities?: string[]}} p
 */
export function importPlaces({ discovery, source, response, capturedAt, regionId = null, localities = [] }) {
  const stats = { places: 0, not_food: 0, merchants: 0, matched: 0, locations: 0, ratings: 0, phones: 0, websites: 0, hours: 0 };
  (response.places ?? []).forEach((place, i) => {
    stats.places += 1;
    if (!isFoodPlace(place)) {
      stats.not_food += 1;
      return;
    }
    const at = (suffix) => `/places/${i}${suffix}`;
    const ev = (pointer, value) => ({ sourceId: source.id, locator: pointer, quote: typeof value === "string" ? value : JSON.stringify(value), extraction: "explicit", proposedBy: "collector:google-places" });
    const name = place.displayName?.text;
    if (!name || !place.id) return;
    const m = discovery.upsertMerchant({
      name,
      identifiers: [{ scheme: "maps_place_id", value: place.id }, ...(place.websiteUri ? [{ scheme: "website", value: new URL(place.websiteUri).hostname.replace(/^www\./, "") }] : [])],
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      address: place.formattedAddress ?? null,
      seenAt: capturedAt,
      evidence: ev(at("/displayName/text"), name),
    });
    if (!m.merchantId) return;
    stats[m.action === "matched" ? "matched" : "merchants"] += 1;
    if (place.formattedAddress || place.location) {
      const addr = normalizeName(place.formattedAddress ?? "");
      const elsewhere = localities.some((l) => ` ${addr} `.includes(` ${normalizeName(l)} `));
      const hasPoint = place.location?.latitude !== undefined;
      const r = discovery.proposeLocation({
        merchantId: m.merchantId,
        addressOriginal: place.formattedAddress ?? null,
        regionId: elsewhere ? null : regionId,
        lat: hasPoint ? place.location.latitude : null,
        lng: hasPoint ? place.location.longitude : null,
        coordinatesFrom: hasPoint ? "source" : null,
        evidence: hasPoint ? ev(at(""), place) : ev(at("/formattedAddress"), place.formattedAddress),
        capturedAt,
      });
      if (r.outcome === "published") stats.locations += 1;
    }
    if (place.rating !== undefined || place.userRatingCount !== undefined) {
      const r = discovery.proposeRating({ merchantId: m.merchantId, ratingSource: "google_maps", rating: place.rating ?? null, ratingScale: 5, reviewCount: place.userRatingCount ?? null, evidence: ev(at(""), place), capturedAt });
      if (r.outcome === "published") stats.ratings += 1;
    }
    if (place.nationalPhoneNumber) {
      const r = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "phone", value: place.nationalPhoneNumber.replace(/[^\d+]/g, ""), originalText: place.nationalPhoneNumber, evidence: ev(at("/nationalPhoneNumber"), place.nationalPhoneNumber), capturedAt });
      if (r.outcome === "published") stats.phones += 1;
    }
    if (place.websiteUri) {
      const r = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "website", value: place.websiteUri, originalText: place.websiteUri, evidence: ev(at("/websiteUri"), place.websiteUri), capturedAt });
      if (r.outcome === "published") stats.websites += 1;
    }
    const days = place.regularOpeningHours?.weekdayDescriptions;
    if (days?.length) {
      // kept as the source wrote it (one line per weekday); not parsed into a schedule here
      const r = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "opening_hours", value: null, originalText: days.join("; "), evidence: ev(at("/regularOpeningHours/weekdayDescriptions"), days), capturedAt });
      if (r.outcome === "published") stats.hours += 1;
    }
  });
  return stats;
}

/** Category × locality text queries ("quán bún cá Lộc Thọ Nha Trang"). */
export function placesQueries(region, categories) {
  const place = region.search_names?.[0] ?? region.name;
  const areas = ["", ...(region.wards ?? [])];
  const out = [];
  for (const c of categories) for (const a of areas) out.push(`${c} ${a} ${place}`.replace(/\s+/g, " ").trim());
  return [...new Set(out)];
}
