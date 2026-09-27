import { htmlBlocks, htmlToText, nfc, normalizeName } from "../../../platform/knowledge/text.js";

// "Top N quán … Nha Trang" articles (robots-allowed public pages): each
// numbered heading is one place, followed by its details. Extracted ONLY
// when the section itself states it:
//   - merchant  = the numbered heading, when its section has an address line;
//   - address   = the "Địa chỉ:" line, verbatim (never geocoded, never fixed);
//   - hours     = the "Giờ mở cửa:" line, kept as text (no days are guessed);
//   - dishes    = known dish names in the heading (the place's own name,
//                 "Bún cá Cô Ba") or in an explicit "Món …:" line -> a product
//                 observed as a MENTION (published); anywhere else in the
//                 section -> the same, but only a proposal for review;
//   - prices    = only "<dish>: <price>" on one line. "Giá tham khảo" /
//                 per-person ranges are NOT product prices and are not stored.
// Ratings, "ngon nhất", reviews and anything not written are never taken.

const ORDINAL = /^(?:top\s*)?(\d{1,2}(?:\.\d{1,2})*)\s*(?:[.):\-–—]\s*|\s+)(?=\S)/iu;
const LABEL = String.raw`(?:địa chỉ(?: quán)?|đ\/c|giờ mở cửa|thời gian mở cửa|giờ hoạt động|thời gian hoạt động|thời gian phục vụ|khung giờ|mở cửa|giá tham khảo|giá cả|mức giá|giá|khoảng giá|điện thoại|số điện thoại|sđt|hotline|liên hệ|fanpage|facebook|website|món ngon|món nổi bật|món nên thử|món đặc trưng|món đặc biệt|món chính|thực đơn|menu|các món|món ăn|đặc sản|address|location|opening hours|opening time|open hours|hours|price range|prices?|average price|phone|tel|hotline|signature dishes?|must-try dishes?|recommended dishes?)`;
// normalized labels of each kind of field (Vietnamese and English listicles)
const ADDRESS_LABEL = /^(?:dia chi|d c|address|location)/;
const HOURS_LABEL = /(?:gio|mo cua|thoi gian|khung gio|opening|hours)/;
const PHONE_LABEL = /(?:dien thoai|sdt|hotline|lien he|phone|tel)/;
const PRICE_LABEL = /(?:gia|price)/;
const FIELD = new RegExp(`(?:^|[\\s•\\-–+*>▶►➤✅📍🏠⏰🕒💰☎📞]|^\\p{Extended_Pictographic})\\s*(${LABEL})\\s*:\\s*`, "giu");
const PRICE_TEXT = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*(?:k|K|nghìn|ngàn|tr|triệu))\s*(?:đ|đồng|vnđ|vnd|₫)?(?:\s*\/\s*\p{L}+)?/u;
const NEGATED = /(?:không (?:có|bán|phục vụ)|chưa có|khác với|thay vì|giống như|tương tự như?)\s+(?:[^\s,.;:]+\s+){0,2}$/iu; // within the same clause
// headings that are not places even if numbered ("1. Lưu ý khi đi ăn", "2. Kinh nghiệm …")
const NOT_A_PLACE = /^(?:lưu ý|kinh nghiệm|cách|tại sao|vì sao|giới thiệu|tổng kết|kết luận|câu hỏi|faq|mẹo|bảng giá|thời điểm|nên ăn|ăn gì)/iu;

const SUB_PART = /^(?:\d+(?:\.\d+)+\s*)?(?:địa chỉ|menu|thực đơn|không gian|món|giá|giờ|thời gian|review|đánh giá|phục vụ|vị trí|cách đi|thông tin)/iu;
const PAGE_END = /^(?:nguồn\s*:|bạn có hài lòng|xem thêm|bài viết liên quan|tags?\s*:|chia sẻ|đọc thêm)|(?:danh sách trên|trên đây là|hy vọng (?:bài viết|những)|tổng kết lại)/iu;
// SEO tails of a heading ("Bún bò Kim Ngân Nha Trang đông khách bậc nhất phố biển") — the name ends before them
const SEO_TAIL = /\s+(?:(?:rất |cực |siêu )?(?:đông khách|thơm ngon|ngon|nức tiếng|nổi tiếng|chuẩn vị|đậm đà|hấp dẫn|giá rẻ|bình dân|rất đáng|đáng thử|ăn là|gói gọn|hút khách|chất lượng|nhất định|không thể|khó cưỡng|siêu ngon|trứ danh|lâu đời|view đẹp|sang trọng|chuẩn|nhạc|ăn một lần|nhớ mãi|được lòng|chỉ dân|dân sành ăn|giá hợp lý|giá mềm|chill|siêu chất|lung linh|sang chảnh|view biển|hot|đắt khách|nên thử|mê ly|số 1|số một)(?![\p{L}]))/iu;
// venues that are not places to eat, whatever they serve
const NON_FOOD_VENUE = /(?<![\p{L}])(?:karaoke|massage|spa|khách sạn|hotel|homestay|rạp|cinema|gym)(?![\p{L}])/iu;
// a heading naming no particular place ("Địa chỉ quán cháo hàu ngon Nha Trang")
const GENERIC_HEADING = /^(?:địa chỉ|quán|những|các|top|list|danh sách|gợi ý)(?![\p{L}])/iu;
const MAX_SECTION_BLOCKS = 40;
const CAPTION = /(?:^|\s)(?:Ảnh|Nguồn ảnh|Hình ảnh|Hình|Photo|Nguồn)\s*:/u;
// words that name no particular place ("Nhà hàng", "Review quán ăn Nha Trang", "Những địa chỉ thưởng thức …")
const GENERIC_WORDS = new Set(["nhà hàng", "quán", "quán ăn", "review", "những", "các", "địa chỉ", "địa điểm", "thưởng thức", "ở", "tại", "ngon", "nha trang", "khánh hòa", "khánh hoà", "ăn", "món", "tiệm", "hàng", "combo", "ăn sáng", "ăn vặt", "ăn đêm", "nước dùng", "chuẩn vị", "giá rẻ", "phổ biến", "việt nam", "top"]);

/**
 * A place name that is only generic words and dish names ("Bún bò Huế", "Nhà hàng Nha Trang")
 * identifies no particular place: skipped rather than turned into a merchant.
 */
export function isGenericPlaceName(name, foodNames = []) {
  // accent-SENSITIVE: "Quán Nhã Trang" is a name, "Nhà hàng Nha Trang" is not
  const words = (t) => nfc(String(t)).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let rest = ` ${words(name)} `;
  const phrases = [...new Set([...foodNames.map((f) => words(f.name ?? f)), ...GENERIC_WORDS])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const p of phrases) rest = rest.split(` ${p} `).join(" ").split(` ${p} `).join(" ");
  return rest.trim() === "";
}

/** The fields written in one block: [{label, value}] ("Địa chỉ: …, Giờ mở cửa: …" -> two). */
export function blockFields(text) {
  const hits = [...text.matchAll(FIELD)];
  return hits.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    return { label: normalizeName(m[1]), value: text.slice(start, end).replace(/[\s|,;.–—-]+$/u, "").trim() };
  });
}

/** Merchant name from a numbered heading ("8 Nem nướng Đặng Văn Quyên - Nhà hàng …" -> "Nem nướng Đặng Văn Quyên"). */
function cleanPlaceName(part) {
  let name = part;
  // "Bún bò Nha Trang ở đâu ngon? Quán Huế Hà" -> the part after the question
  if (name.includes("?")) name = name.split("?").pop().trim();
  const tail = name.match(SEO_TAIL);
  // cut an SEO tail ("… đông khách bậc nhất") — not a capitalised word of the name ("Quán Hải Sản Bình Dân Nhà Tôi"),
  // and not when an address follows ("Bún bò Nha Trang ngon số 35 Huỳnh Thúc Kháng" is named by it)
  if (tail && tail.index > 0 && !/^\s*\p{Lu}/u.test(tail[0]) && !/\d/.test(name.slice(tail.index))) name = name.slice(0, tail.index);
  return name.split(/,\s+/u)[0].replace(/^["“'‘]+|["”'’]+$/gu, "").trim();
}

// capitalised words that do not make a phrase a proper name ("Nhà hàng Nhật ở Nha Trang")
const NOT_PROPER = new Set(["nha", "trang", "khánh", "hòa", "hoà", "nhật", "hàn", "thái", "trung", "ý", "pháp", "nga", "ấn", "âu", "việt", "nam", "quốc", "bản", "độ", "lan", "hoa", "mỹ"]);
const DESCRIPTOR_START = /^(?:nhà hàng|quán|quán ăn|địa điểm|địa chỉ|top|review|những|các|thưởng thức|đồ ăn|ăn|món|tiệm|điểm)(?![\p{L}])/iu;

/** A phrase that describes a kind of place but names none ("Nhà hàng buffet Nha Trang giá hợp lý"). */
function isDescriptor(phrase) {
  if (!DESCRIPTOR_START.test(phrase) || /\d/.test(phrase)) return false;
  const later = phrase.split(/\s+/u).slice(1);
  return !later.some((w) => /^\p{Lu}/u.test(w) && !NOT_PROPER.has(w.toLowerCase()));
}

export function placeNameFromHeading(heading) {
  const m = heading.match(ORDINAL);
  if (!m) return null;
  const rest = heading.slice(m[0].length).trim();
  if (NOT_A_PLACE.test(rest)) return null;
  // "Restaurants in Vinpearl Beachfront …": a group of places, not one place
  if (/^(?:restaurants|places|eateries|bars|cafes|spots|where to|best|top)\s+(?:in|within|at|near|on|for|to)\s/iu.test(rest)) return null;
  const parts = rest.split(/\s+[-–—|]\s+|:\s+/u).map((s) => s.trim()).filter(Boolean);
  // "Gia - The Organic Wine Cellar - …": a very short first part belongs with the next
  if (parts.length > 2 && parts[0].length < 5) parts.splice(0, 2, `${parts[0]} - ${parts[1]}`);
  // the first part that NAMES a place; "Nhà hàng Nhật ở Nha Trang nổi tiếng – Hanami",
  // "Địa điểm ăn đêm … cực hot – Ốc Quyên Sài Gòn": a descriptor first, the name after it
  let name = null;
  for (const part of parts) {
    const cleaned = cleanPlaceName(part);
    if (cleaned && !isDescriptor(cleaned)) {
      name = cleaned;
      break;
    }
  }
  if (!name || name.length < 3 || name.length > 80) return null;
  const properWords = name.replace(/Nha Trang|Khánh Hòa/gu, "").split(/\s+/u).slice(1).filter((w) => /^\p{Lu}/u.test(w));
  if (GENERIC_HEADING.test(name) && properWords.length === 0 && !/\d/.test(name)) return null;
  return name;
}

/**
 * Sections of a listicle: one per numbered heading that has an address.
 * @returns {{name, heading, blocks: string[], address?: {text, quote}, hours?: {text, quote}, phone?: {text, quote}, priceNotes: {value, quote}[]}[]}
 */
export function listicleSections(html) {
  const blocks = htmlBlocks(html);
  const out = [];
  let cur = null;
  for (const b of blocks) {
    if (b.heading && b.heading >= 2 && b.heading <= 4) {
      const name = placeNameFromHeading(b.text);
      if (name) {
        cur = { name, heading: b.text, level: b.heading, blocks: [], priceNotes: [] };
        out.push(cur);
        continue;
      }
      // an unnumbered heading ends the place, unless it is a sub-part of it ("Menu", "Không gian", "Địa chỉ")
      if (cur && (b.heading <= cur.level || !SUB_PART.test(b.text))) cur = null;
      continue;
    }
    if (!cur) continue;
    // the article's own ending (source line, feedback, "the list above…") is not about the last place
    if (PAGE_END.test(b.text) || cur.blocks.length >= MAX_SECTION_BLOCKS) {
      cur = null;
      continue;
    }
    // a photo caption / credit ("… Ảnh: Kem Dừa") is not text about the place: keep only what precedes it
    const text = b.text.split(CAPTION)[0].trim();
    if (!text) continue;
    cur.blocks.push(text);
    for (const f of blockFields(text)) {
      if (!f.value) continue;
      if (ADDRESS_LABEL.test(f.label) && !cur.address) cur.address = { text: f.value, quote: text };
      else if (HOURS_LABEL.test(f.label) && !cur.hours) cur.hours = { text: f.value, quote: text };
      else if (PHONE_LABEL.test(f.label) && /\d{3}/.test(f.value) && !cur.phone) cur.phone = { text: f.value, quote: text };
      else if (PRICE_LABEL.test(f.label)) cur.priceNotes.push({ value: f.value, quote: text });
    }
  }
  return out.filter((s) => s.address);
}

const lower = (s) => nfc(String(s)).toLowerCase();
const COMPONENT_OF = /(?:^|[\s,])(?:bánh mì|bánh|bún|cơm|mì|xôi|cháo|phở|hủ tiếu|miến|lẩu|gỏi)\s+$/u;

const SIGHT_NAME = /^(?:bãi|đảo|hòn|chùa|tháp|nhà thờ|khu du lịch|khu vui chơi|bảo tàng|viện|suối|vịnh|công viên|làng chài|đầm|núi|đèo|thác|vinwonders|vinpearl land|cáp treo|beach|island|pagoda|temple|museum|waterfall)(?![\p{L}])/iu;

const EATERY_WORD = /(?<![\p{L}])(?:quán|nhà hàng|restaurant|cafe|café|cà phê|coffee|bar|pub|buffet|lẩu|hải sản|seafood|bistro|kitchen|bếp|quầy|tiệm)(?![\p{L}])/iu;

// a listing is a place to EAT only if its own heading/text says something about food
const FOOD_PLACE_SIGNAL = /(?<![\p{L}])(?:quán|nhà hàng|ăn|món|thực đơn|menu|buffet|lẩu|nướng|hải sản|ốc|cà phê|cafe|coffee|bún|phở|bánh|cơm|cháo|chè|xôi|nem|chay|đặc sản|nhậu|bia|restaurant|food|dishes?|seafood|eat|bbq|bar|beer|cuisine)(?![\p{L}])/iu;

/** Does this section (heading + its text) speak about food at all? Attractions, temples, islands don't. */
export function isFoodPlaceSection(section, foodNames = []) {
  // "Bãi Dài", "Hòn Chồng", "Chùa Long Sơn", "Khu du lịch …": a sight — even if seafood is mentioned nearby
  const name = section.name ?? String(section.heading).replace(ORDINAL, "");
  if (SIGHT_NAME.test(name) && !EATERY_WORD.test(name)) return false;
  // "Karaoke Crown", "Khách sạn trên đường Trần Phú" — but "Bò né Hùng Vương khách sạn Potique" names a dish
  if (NON_FOOD_VENUE.test(name) && !EATERY_WORD.test(name) && dishMentions(name, foodNames).length === 0) return false;
  const text = [section.heading, ...section.blocks].join(" \n ");
  return FOOD_PLACE_SIGNAL.test(text) || dishMentions(text, foodNames).length > 0;
}

/**
 * Known dish names in a text, accent-SENSITIVE (Vietnamese text has accents:
 * "chào" is not "cháo"), whole words, longest first, no overlaps.
 * @param {{entityKey: string, name: string}[]} foodNames accented names only
 */
export function dishMentions(raw, foodNames) {
  const text = nfc(String(raw));
  const hay = text.toLowerCase();
  const taken = [];
  const out = [];
  for (const f of [...foodNames].sort((a, b) => b.name.length - a.name.length)) {
    const key = lower(f.name);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of hay.matchAll(re)) {
      const [s, e] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      if (NEGATED.test(text.slice(0, s))) continue;
      // "bánh mì chả cá", "cơm gà nướng": right after a dish-family head word it is a COMPONENT of another dish
      if (COMPONENT_OF.test(hay.slice(0, s))) continue;
      taken.push([s, e]);
      out.push({ entityKey: f.entityKey, name: f.name, seed: Boolean(f.seed), text: text.slice(s, e), start: s, end: e });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const MENU_LINE = /^(?:\S+\s+)?(?:món ngon|món nổi bật|món nên thử|món đặc trưng|món đặc biệt|món chính|thực đơn|menu|các món|món ăn|đặc sản)(?:[^:]{0,30})?:/iu;

/** "Bún cá: 35.000đ/tô" — a dish and its price on one line (nothing else). */
export function dishPriceLine(text, mention) {
  const after = text.slice(mention.end).match(/^\s*(?:[:–—-]|\()\s*/u);
  if (!after) return null;
  const price = text.slice(mention.end + after[0].length).match(PRICE_TEXT);
  if (!price || price.index !== 0) return null;
  if (/tham khảo|người|khoảng|từ\s/iu.test(text)) return null; // ranges / per person: not a product price
  return price[0].trim();
}

/**
 * Imports one listicle page into the discovery store.
 * @returns {{sections, merchants, locations, hours, phones, products: {published, review}, prices, links, skipped: string[], priceNotesIgnored}}
 */
// "TOP 10 địa chỉ … bánh mì chả cá", "Lưu gấp 12 quán lẩu bò …": a link to ANOTHER article, not this place
const RELATED_ARTICLE = /^(?:(?:top|list|lưu gấp|lưu ngay|thổ địa mách|chỉ điểm|bỏ túi|điểm danh|mách bạn|khám phá|review|càn quét|gợi ý|tổng hợp|xem thêm)\s+(?:\S+\s+){0,3}?\d+\+?\s+(?:quán|địa chỉ|món|nhà hàng|địa điểm|tiệm)|(?:top|list)\s*\d+|\d+\+?\s+(?:quán|địa chỉ|món ngon|nhà hàng|địa điểm|tiệm)\s)/iu;

/** A block that can say which dishes a place serves: not an address/hours/phone line, not a related-article link. */
export function isDishText(text) {
  if (RELATED_ARTICLE.test(text.trim())) return false;
  return !blockFields(text).some((f) => ADDRESS_LABEL.test(f.label) || HOURS_LABEL.test(f.label) || PHONE_LABEL.test(f.label));
}

// one product and ONE price: "<name> 17.000 VND/ chiếc" (no range, no "từ/khoảng", not per person)
const PRICE_SEGMENT = /^(.{3,60}?)\s*:?\s+((?:\d{1,3}(?:[.,]\d{3})+|\d+\s*[kK])(?:\s*(?:VNĐ|VND|vnđ|vnd|đồng|đ|₫))?)\s*(?:\/\s*(tô|chiếc|ổ|cái|phần|suất|dĩa|đĩa|ly|cốc|chén|bát|con|kg|lạng|trái|hộp|xiên|cuốn|miếng))?\s*\.?$/u;
const NOT_A_PRODUCT_PRICE = /(?:\d\s*[–—-]\s*\d|từ|khoảng|tầm|người|\+\+|tùy|tuỳ|trở lên|dao động)/iu;

/**
 * Product prices written in a price line: "Bánh mì gà 17.000 VND/ chiếc, bánh mì heo quay 20.000 VND/ ổ".
 * Taken only when EVERY comma-separated part is "<name> <one price>" (a part without its own price
 * makes the whole line ambiguous: "bánh mì thịt, xíu mại 18.000") and the name starts with a known dish.
 * @returns {{name, priceText, unit}[]}
 */
export function productPriceSegments(value, foodNames) {
  if (NOT_A_PRODUCT_PRICE.test(value)) return [];
  const parts = value.split(/\s*[;,]\s+/u).map((s) => s.trim()).filter(Boolean);
  const parsed = parts.map((p) => p.match(PRICE_SEGMENT));
  if (!parsed.length || parsed.some((m) => !m)) return [];
  const dishes = foodNames.map((f) => lower(f.name ?? f)).filter(Boolean);
  const out = [];
  for (const m of parsed) {
    const name = m[1].trim();
    const n = lower(name);
    if (!dishes.some((d) => n === d || n.startsWith(`${d} `))) continue;
    out.push({ name, priceText: m[2], unit: m[3] ?? null }); // the price exactly as written (it is checked against the quote)
  }
  return out;
}

/** The anchor of one place listing on one page (re-reading the page finds the same merchant). */
export function listingId(url, heading) {
  return `${url}#${normalizeName(heading)}`;
}

export function importListicle({ knowledge, discovery, source, html, foodNames, regionId = null, seenAt, localities = [] }) {
  const stats = { entitiesFromMentions: { review: 0, rejected: 0, published: 0 }, sections: 0, merchants: 0, duplicateCandidates: 0, locations: 0, hours: 0, phones: 0, products: { published: 0, review: 0 }, prices: 0, links: { published: 0, review: 0 }, skipped: [], priceNotesIgnored: 0 };
  const fullText = htmlToText(html);
  for (const s of listicleSections(html)) {
    stats.sections += 1;
    if (!fullText.includes(s.heading)) {
      stats.skipped.push(`${s.name}: heading not verbatim in page text`);
      continue;
    }
    if (!isFoodPlaceSection(s, foodNames)) {
      stats.nonFoodPlacesSkipped = (stats.nonFoodPlacesSkipped ?? 0) + 1;
      continue;
    }
    if (isGenericPlaceName(s.name, foodNames)) {
      stats.genericNamesSkipped = (stats.genericNamesSkipped ?? 0) + 1;
      continue;
    }
    const m = discovery.upsertMerchant({ name: s.name, identifiers: [{ scheme: "source_url", value: listingId(source.url, s.heading) }], address: s.address.text, seenAt, evidence: { sourceId: source.id, quote: s.heading, extraction: "explicit", proposedBy: "collector:listicle" } });
    if (!m.merchantId) {
      stats.skipped.push(`${s.name}: ${m.reasons.map((r) => r.code).join(",")}`);
      continue;
    }
    stats.merchants += 1;
    stats.duplicateCandidates += m.duplicateCandidates?.length ?? 0;
    // the place is in the article's region only if its address names it, or names no other locality
    const addr = normalizeName(s.address.text);
    const otherPlace = localities.some((l) => ` ${addr} `.includes(` ${normalizeName(l)} `));
    const loc = discovery.proposeLocation({ merchantId: m.merchantId, addressOriginal: s.address.text, regionId: otherPlace ? null : regionId, evidence: { sourceId: source.id, quote: s.address.quote, extraction: "explicit", proposedBy: "collector:listicle" }, capturedAt: seenAt });
    if (loc.outcome === "published") stats.locations += 1;
    if (s.hours) {
      const h = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "opening_hours", value: null, originalText: s.hours.text, evidence: { sourceId: source.id, quote: s.hours.quote, extraction: "explicit", proposedBy: "collector:listicle" }, capturedAt: seenAt });
      if (h.outcome === "published") stats.hours += 1;
    }
    if (s.phone) {
      const p = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "phone", value: s.phone.text.replace(/[^\d+]/g, ""), originalText: s.phone.text, evidence: { sourceId: source.id, quote: s.phone.quote, extraction: "explicit", proposedBy: "collector:listicle" }, capturedAt: seenAt });
      if (p.outcome === "published") stats.phones += 1;
    }
    // product prices written out in a price line; everything else in it (ranges, per person) is not stored
    for (const note of s.priceNotes) {
      const segments = productPriceSegments(nfc(note.value), foodNames);
      if (!segments.length) {
        stats.priceNotesIgnored += 1;
        continue;
      }
      for (const seg of segments) {
        const ev = { sourceId: source.id, quote: note.quote, extraction: "explicit", proposedBy: "collector:listicle-price" };
        const prod = discovery.proposeProduct({ merchantId: m.merchantId, originalName: seg.name, observation: "mention", evidence: ev, seenAt });
        if (!prod.productId || prod.outcome !== "published") continue;
        if (!prod.touched) stats.products.published += 1;
        const pr = discovery.proposePrice({ productId: prod.productId, priceTextOriginal: seg.priceText, unit: seg.unit, evidence: ev, capturedAt: seenAt });
        if (pr.outcome === "published" && !pr.touched) stats.prices += 1;
      }
    }
    // cuisine / vegetarian as the heading itself says it ("Nhà hàng chay Hoan Hỷ", "… món Hàn") — a merchant fact
    for (const c of knowledge.vocabulary.match(s.heading).matches) {
      if (!["facet:cuisine", "facet:dietary"].includes(c.concept) || c.ambiguous || c.negated) continue;
      const r = discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "cuisine", value: { facet: c.concept.slice(6), key: c.value }, originalText: c.text, evidence: { sourceId: source.id, quote: s.heading, extraction: "explicit", proposedBy: "collector:listicle" }, capturedAt: seenAt });
      if (r.outcome === "published") stats.cuisines = (stats.cuisines ?? 0) + 1;
    }

    // dishes: [text, explicit?] — the heading (the place's own name) and "Món …:" lines are explicit
    const seen = new Set();
    const lines = [{ text: s.heading, explicit: true }, ...s.blocks.filter((t) => isDishText(t)).map((t) => ({ text: t, explicit: MENU_LINE.test(t) }))];
    for (const line of lines) {
      const text = nfc(line.text);
      for (const d of dishMentions(text, foodNames)) {
        // a seed dish with no encyclopedia article: this mention is its only evidence -> a proposal for review
        if (d.seed && !knowledge.entity(d.entityKey)) {
          const r = knowledge.proposeEntity({ key: d.entityKey, canonicalName: d.name, evidence: { sourceId: source.id, quote: line.text, extraction: "rule", proposedBy: "collector:listicle-mention" } });
          stats.entitiesFromMentions[r.entity?.status ?? "rejected"] = (stats.entitiesFromMentions[r.entity?.status ?? "rejected"] ?? 0) + 1;
        }
        const key = `${d.entityKey}`;
        const firstTime = !seen.has(key);
        seen.add(key);
        const prod = discovery.proposeProduct({
          merchantId: m.merchantId,
          originalName: d.text,
          observation: "mention",
          evidence: { sourceId: source.id, quote: line.text, extraction: line.explicit ? "explicit" : "rule", proposedBy: "collector:listicle" },
          seenAt,
        });
        if (!prod.productId) continue;
        if (firstTime && !prod.touched) stats.products[prod.outcome === "published" ? "published" : "review"] += 1;
        const price = line.explicit || prod.outcome === "published" ? dishPriceLine(text, d) : null;
        if (price && prod.outcome === "published") {
          const pr = discovery.proposePrice({ productId: prod.productId, priceTextOriginal: price, evidence: { sourceId: source.id, quote: line.text, extraction: "explicit", proposedBy: "collector:listicle" }, capturedAt: seenAt });
          if (pr.outcome === "published" && !pr.touched) stats.prices += 1;
        }
        if (knowledge.entity(d.entityKey)?.status === "published") {
          const l = discovery.proposeFoodProductLink({ foodKey: d.entityKey, kbProductId: prod.productId, matchType: "exact" });
          if (!l.reasons?.some((r) => r.code === "ALREADY_EXISTS")) stats.links[l.outcome === "published" ? "published" : "review"] += 1;
        }
      }
    }
  }
  return stats;
}
