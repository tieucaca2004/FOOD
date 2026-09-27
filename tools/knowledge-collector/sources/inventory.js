import { normalizeName } from "../../../platform/knowledge/text.js";

// Source inventory: walks the LISTING pages of a permitted source family
// (a site's own archive / category pages, robots-checked like every fetch)
// and keeps the article URLs that are about eating out. Systematic instead of
// random searching; the result is persisted so a later run does not rediscover.

// words of an article slug that make it worth reading for places / dishes
const FOOD_TOKENS = new Set([
  "quan", "nha-hang", "an", "mon", "am-thuc", "dac-san", "bun", "pho", "banh", "com", "chao", "lau", "nuong", "hai-san", "oc", "che", "xoi",
  "nem", "hu-tieu", "mi", "buffet", "chay", "sushi", "pizza", "cafe", "ca-phe", "bbq", "nhau", "vit", "bo", "ga", "de", "cua", "ghe", "tom",
  "muc", "yen", "kem", "tra-sua", "restaurant", "restaurants", "food", "eat", "seafood", "dishes", "cuisine", "specialties", "street-food", "night-market", "breakfast", "dinner", "vegetarian", "vegan", "noodle", "noodles", "banh", "bun", "pho", "coffee", "desserts", "cho-dem", "an-vat", "an-sang", "an-dem", "sua",
]);
// how-to / recipe / non-place articles
const SKIP_TOKENS = ["cach-nau", "cach-lam", "cong-thuc", "meo-", "tour-", "ve-may-bay", "khach-san", "resort", "homestay", "gia-ve", "lich-trinh", "tham-quan", "check-in", "diem-du-lich", "vui-choi"];

export function isFoodSlug(url) {
  const slug = normalizeName(decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "")).replace(/ /g, "-");
  if (SKIP_TOKENS.some((t) => slug.includes(t))) return false;
  const words = slug.split("-");
  const pairs = words.slice(1).map((w, i) => `${words[i]}-${w}`);
  return [...words, ...pairs].some((w) => FOOD_TOKENS.has(w));
}

/** Absolute article links on a listing page that match the family's pattern. */
export function articleLinks(html, baseUrl, pattern) {
  const re = new RegExp(pattern);
  const out = new Set();
  // relative links resolve against <base href> when the page declares one (mia.vn: <base href="https://mia.vn">)
  const declared = html.match(/<base\s[^>]*href="([^"]+)"/i)?.[1];
  if (declared) {
    try {
      baseUrl = new URL(declared.endsWith("/") ? declared : `${declared}/`, baseUrl).toString();
    } catch {
      // keep the page URL
    }
  }
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    let u;
    try {
      const url = new URL(m[1].replace(/&amp;/g, "&"), baseUrl);
      url.hash = "";
      u = url.toString();
    } catch {
      continue;
    }
    if (re.test(u)) out.add(u);
  }
  return [...out];
}

/**
 * Walks listing pages {n} = from..to of one family, stopping after `stopAfterEmpty`
 * pages in a row bring no new article. Failures are recorded, never thrown.
 * @param {{id, listing: {url_template, from, to, stop_after_empty?}, article_pattern, source_type}} family
 */
export async function discoverFamily({ fetcher, family, log = () => {} }) {
  const found = new Map();
  const failures = [];
  let empty = 0;
  const { url_template: tpl, from = 1, to = 50, stop_after_empty: stopAfterEmpty = 2 } = family.listing;
  for (let n = from; n <= to; n++) {
    const url = tpl.replace("{n}", String(n));
    let page;
    try {
      page = await fetcher.fetch(url, { sourceType: family.source_type });
    } catch (err) {
      page = { ok: false, blocked: "error", reason: err.message };
    }
    if (!page.ok) {
      failures.push({ url, reason: page.blocked, status: page.status ?? null });
      if (++empty >= stopAfterEmpty) break;
      continue;
    }
    const before = found.size;
    for (const a of articleLinks(page.content, page.finalUrl ?? url, family.article_pattern)) if (!found.has(a)) found.set(a, { url: a, family: family.id, listing: url, food: isFoodSlug(a) });
    log(`inventory ${family.id} page ${n}: ${found.size - before} new`);
    empty = found.size === before ? empty + 1 : 0;
    if (empty >= stopAfterEmpty) break;
  }
  return { articles: [...found.values()], failures };
}
