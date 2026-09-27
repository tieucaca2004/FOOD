import { htmlBlocks, htmlToText, nfc } from "../../../platform/knowledge/text.js";

// A merchant's OWN menu page in HTML: "<dish name> [description] <price>"
// sequences under section headings. Conservative: a product is taken only
// when a block that is JUST a price follows its name, and the text from the
// name to the price appears verbatim on the page (that text is the evidence).
// "Giá theo thời điểm" / "market price" / ranges are never turned into numbers.

const PRICE_BLOCK = /^(?:giá(?: bán)?\s*:?\s*)?((?:\d{1,3}(?:[.,]\d{3})+|\d+\s*[kK])\s*(?:₫|đ|đồng|VNĐ|VND|vnđ|vnd)?)\s*(?:\(([^)]{1,30})\))?\s*$/iu;
const NOT_A_NAME = /^(?:[+\-–•*▴▾►✓✔︎]+|add to cart|thêm vào giỏ|mua ngay|đặt ngay|order|chọn|xem thêm|read more|\d+)$/iu;
const LEADING_MARKS = /^[\s▴▾►•*✓✔︎+\-–]+/u;

/**
 * Menu items of an official menu page.
 * @returns {{category: string|null, name: string, description: string|null, priceText: string, portion: string|null, quote: string}[]}
 */
export function officialMenuItems(html) {
  const blocks = htmlBlocks(html);
  const fullText = htmlToText(html);
  const items = [];
  let category = null;
  let sinceLast = []; // blocks after the previous price (or section heading)
  for (const b of blocks) {
    const text = nfc(b.text);
    if (b.heading && b.heading <= 3) {
      category = text;
      sinceLast = [];
      continue;
    }
    const price = b.heading ? null : text.match(PRICE_BLOCK);
    if (!price) {
      sinceLast.push({ ...b, text });
      if (sinceLast.length > 8) sinceLast.shift();
      continue;
    }
    // the name: the last small heading (h4–h6) before the price, else the last plain line that can be a name
    const candidates = sinceLast.filter((x) => !NOT_A_NAME.test(x.text.trim()));
    // "380,000 ₫ (for 1)" then "520,000 ₫ (for 2)": a second portion price of the SAME dish
    const last = items[items.length - 1];
    if (!candidates.length && last && price[2] && last.portion) {
      const quote = `${last.quote} ${b.text}`;
      if (fullText.includes(quote)) items.push({ ...last, priceText: price[1].trim(), portion: price[2].trim(), quote });
      sinceLast = [];
      continue;
    }
    let nameAt = -1;
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].heading) {
      nameAt = i;
      break;
    }
    if (nameAt < 0) nameAt = candidates.length - 1;
    sinceLast = [];
    if (nameAt < 0) continue;
    let nameBlock = candidates[nameAt];
    let between = candidates.slice(nameAt + 1).filter((x) => !x.heading).map((x) => x.text);
    // a product card titled by a big heading: "<h3>Nem nướng Nha Trang</h3> <p>Nem nướng được chế biến từ…</p> 50.000 ₫"
    // — the only plain line is a (truncated) description, so the heading just before it is the dish's name
    if (!nameBlock.heading && category && (nameBlock.text.length > 60 || /(?:\.\.\.|…)\s*$/u.test(nameBlock.text)) && candidates.length === 1) {
      between = [nameBlock.text];
      nameBlock = { text: category, heading: 3 };
    }
    const name = nameBlock.text.replace(LEADING_MARKS, "").trim();
    if (name.length < 2 || name.length > 120 || /^(?:giá|price)/iu.test(name)) continue;
    const quote = [nameBlock.text, ...between, b.text].join(" ");
    if (!fullText.includes(quote)) continue; // not contiguous on the page: no evidence -> nothing
    items.push({ category, name, description: between.length ? between.join(" ") : null, priceText: price[1].trim(), portion: price[2]?.trim() ?? null, quote });
  }
  return items;
}

/**
 * Imports an official HTML menu for an already identified merchant.
 * @returns {{items, products, prices, skipped}}
 */
export function importOfficialHtmlMenu({ discovery, merchantId, source, html, capturedAt }) {
  const stats = { items: 0, products: 0, prices: 0, skipped: 0 };
  const items = officialMenuItems(html);
  if (!items.length) return stats;
  const menu = discovery.proposeMenu({ merchantId, name: "Menu", evidence: { sourceId: source.id, quote: items[0].quote, extraction: "explicit", proposedBy: "collector:official-html-menu" }, capturedAt });
  const categories = new Map();
  for (const it of items) {
    stats.items += 1;
    const ev = { sourceId: source.id, quote: it.quote, extraction: "explicit", proposedBy: "collector:official-html-menu" };
    let categoryId = null;
    if (it.category && menu.menuId) {
      if (!categories.has(it.category)) categories.set(it.category, discovery.category(menu.menuId, it.category, categories.size + 1));
      categoryId = categories.get(it.category);
    }
    const p = discovery.proposeProduct({ merchantId, menuId: menu.menuId ?? null, categoryId, originalName: it.name, description: it.description, observation: "menu", evidence: ev, seenAt: capturedAt });
    if (!p.productId || p.outcome !== "published") {
      stats.skipped += 1;
      continue;
    }
    if (!p.touched) stats.products += 1;
    // "(for 2)", "(100gr)": the portion the price is for -> the price's variant, verbatim
    const pr = discovery.proposePrice({ productId: p.productId, variant: it.portion, priceTextOriginal: it.priceText, evidence: ev, capturedAt });
    if (pr.outcome === "published" && !pr.touched) stats.prices += 1;
  }
  return stats;
}
