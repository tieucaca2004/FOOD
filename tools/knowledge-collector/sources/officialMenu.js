import fs from "node:fs";
import { htmlToText, nfc } from "../../../platform/knowledge/text.js";
import { importOfficialHtmlMenu } from "./officialHtmlMenu.js";

// A merchant's OWN published information: its homepage (name, address,
// hours as shown there) and a menu snapshot of its website supplied by the
// owner (products and prices). Everything is evidenced: homepage facts by a
// verbatim excerpt of the stored homepage, menu rows by a JSON pointer into
// the stored snapshot. Nothing is completed or inferred (hours without days
// stay unstructured; no bridge to the ordering platform is made here).

// the page's own text around the first occurrence of `needle` (case-insensitive: sites write "BÚN CÁ MỊN")
function excerpt(text, needle, radius = 60) {
  let i = text.indexOf(needle);
  if (i < 0) i = nfc(text).toLowerCase().indexOf(nfc(needle).toLowerCase());
  if (i < 0) return null;
  return text.slice(Math.max(0, i - radius), i + needle.length + radius).trim();
}

/**
 * @param {object} p
 * @param {object} p.config {homepage, merchant_name, snapshot, address_text?, hours_text?, region_id}
 */
export async function importOfficialMerchant({ knowledge, discovery, fetcher, config, repoRoot }) {
  const report = { homepage: null, merchant: null, products: 0, prices: 0, menu: null, skipped: [] };
  // 1. homepage (robots-checked fetch) -> name / address / hours evidence
  const page = await fetcher.fetch(config.homepage, { sourceType: "merchant_official" });
  report.homepage = page.ok ? page.rawPath : `blocked: ${page.blocked}`;
  if (!page.ok) return report;
  const home = knowledge.registerSource({ url: page.finalUrl, sourceType: "merchant_official", rawPath: page.rawPath, contentType: page.contentType, fetchedAt: page.fetchedAt, robotsAllowed: true });
  const text = htmlToText(page.content);
  const nameQuote = excerpt(text, config.merchant_name);
  if (!nameQuote) {
    report.skipped.push(`merchant name "${config.merchant_name}" not found on the homepage`);
    return report;
  }
  const seenAt = page.fetchedAt;
  const m = discovery.upsertMerchant({
    name: config.merchant_name,
    identifiers: [{ scheme: "official_snapshot", value: new URL(page.finalUrl).hostname.replace(/^www\./, "") }, { scheme: "website", value: new URL(page.finalUrl).hostname.replace(/^www\./, "") }],
    seenAt,
    evidence: { sourceId: home.id, quote: nameQuote, extraction: "explicit", proposedBy: "collector:official" },
  });
  report.merchant = m;
  if (!m.merchantId) return report;
  if (config.address_text) {
    const q = excerpt(text, config.address_text, 20);
    if (q) discovery.proposeLocation({ merchantId: m.merchantId, addressOriginal: config.address_text, street: config.street ?? null, regionId: config.region_id ?? null, evidence: { sourceId: home.id, quote: q, extraction: "explicit" }, capturedAt: seenAt });
    else report.skipped.push(`address "${config.address_text}" not on the homepage`);
  }
  if (config.hours_text) {
    const q = excerpt(text, config.hours_text, 20);
    // days are not stated next to the hours: kept as text, never structured
    if (q) discovery.proposeMerchantClaim({ merchantId: m.merchantId, field: "opening_hours", value: null, originalText: config.hours_text, evidence: { sourceId: home.id, quote: q, extraction: "explicit" }, capturedAt: seenAt });
    else report.skipped.push(`hours "${config.hours_text}" not on the homepage`);
  }

  // 2a. the merchant's own HTML menu page (robots-checked fetch) -> products + prices
  if (!config.snapshot && config.menu_url) {
    const menuPage = await fetcher.fetch(config.menu_url, { sourceType: "merchant_official" });
    report.menu = menuPage.ok ? menuPage.rawPath : `blocked: ${menuPage.blocked}`;
    if (!menuPage.ok) return report;
    const src = knowledge.registerSource({ url: menuPage.finalUrl, sourceType: "merchant_official", rawPath: menuPage.rawPath, contentType: menuPage.contentType, fetchedAt: menuPage.fetchedAt, robotsAllowed: true });
    // the address as the menu page itself writes it, when the homepage did not show it
    if (config.address_text && report.skipped.some((s) => s.startsWith("address"))) {
      const q = excerpt(htmlToText(menuPage.content), config.address_text, 20);
      if (q) {
        discovery.proposeLocation({ merchantId: m.merchantId, addressOriginal: config.address_text, regionId: config.region_id ?? null, evidence: { sourceId: src.id, quote: q, extraction: "explicit" }, capturedAt: menuPage.fetchedAt });
        report.skipped = report.skipped.filter((s) => !s.startsWith("address"));
      }
    }
    const r = importOfficialHtmlMenu({ discovery, merchantId: m.merchantId, source: src, html: menuPage.content, capturedAt: menuPage.fetchedAt });
    report.products = r.products;
    report.prices = r.prices;
    report.menu_items = r.items;
    return report;
  }
  if (!config.snapshot) return report;

  // 2b. the owner-supplied menu snapshot, stored byte-for-byte as a raw source
  const bytes = fs.readFileSync(`${repoRoot}/${config.snapshot}`);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  const capturedAt = `${snapshot.extracted}T00:00:00.000Z`;
  const stored = fetcher.store({ content: bytes, sourceType: "merchant_official", url: snapshot.source, contentType: "application/json", fetchedAt: capturedAt, note: "menu snapshot of the merchant website, supplied by the merchant owner" });
  const src = knowledge.registerSource({ url: snapshot.source, sourceType: "merchant_official", rawPath: stored.rawPath, contentType: "application/json", fetchedAt: capturedAt, attribution: "menu snapshot supplied by the merchant owner" });
  const menu = discovery.proposeMenu({ merchantId: m.merchantId, name: "Thực đơn", evidence: { sourceId: src.id, locator: "/source", quote: snapshot.source, extraction: "explicit" }, capturedAt });
  report.menu = menu.menuId;
  const categories = new Map();
  snapshot.items.forEach((item, i) => {
    const evidence = { sourceId: src.id, locator: `/items/${i}`, quote: JSON.stringify(item), extraction: "explicit", proposedBy: "collector:official-snapshot" };
    if (!categories.has(item.category)) categories.set(item.category, discovery.category(menu.menuId, item.category, categories.size + 1));
    const p = discovery.proposeProduct({
      merchantId: m.merchantId,
      menuId: menu.menuId,
      categoryId: categories.get(item.category),
      originalName: item.name,
      description: item.description || null,
      availability: "unknown", // the snapshot does not say what is available today
      evidence,
      seenAt: capturedAt,
    });
    if (p.outcome !== "published") return;
    report.products += 1;
    if (Number.isInteger(item.price_vnd)) {
      const pr = discovery.proposePrice({ productId: p.productId, priceTextOriginal: String(item.price_vnd), unit: null, evidence, capturedAt });
      if (pr.outcome === "published") report.prices += 1;
    }
  });
  return report;
}
