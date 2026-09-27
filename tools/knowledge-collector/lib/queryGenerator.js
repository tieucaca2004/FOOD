import fs from "node:fs";

// Discovery queries for a region, generated from that region's config (no
// merchant or dish is hard-coded here — another city is another config file).
//   food:     "<món> <nơi>", "món ngon <nơi>", "đặc sản <nơi>"
//   cuisine:  "quán <ẩm thực> <nơi>"
//   location: "quán ăn <đường|khu vực> <nơi>"
//   menu:     "<quán> menu|thực đơn|giá|món ăn|bảng giá" for merchants already discovered

export function loadRegion(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const MENU_SUFFIXES = ["menu", "thực đơn", "giá", "món ăn", "bảng giá"];

/**
 * @param {object} region region config (tools/knowledge-collector/config/regions/*.json)
 * @param {{merchantNames?: string[]}} [opts]
 * @returns {Array<{group: "food"|"cuisine"|"location"|"menu", text: string}>}
 */
const DISH_TEMPLATES = ["{dish} {place}", "quán {dish} {place}", "{dish} {place} thực đơn", "{dish} {place} giá", "{dish} {place} menu", "{dish} {place} nhà hàng"];
const OFFICIAL_MENU = ["nhà hàng {place} menu", "nhà hàng {place} thực đơn bảng giá", "{place} restaurant menu", "khách sạn {place} nhà hàng menu", "resort {place} restaurant menu", "{place} menu pdf"];

/**
 * @param {{merchantNames?: string[], dishes?: string[], sites?: string[]}} [opts]
 *   dishes: dish names to build per-dish queries for; sites: permitted domains for "site:" queries
 */
export function generateQueries(region, { merchantNames = [], dishes = [], sites = [] } = {}) {
  const place = region.search_names?.[0] ?? region.name;
  const out = [];
  const add = (group, text) => out.push({ group, text: text.replace(/\s+/g, " ").trim() });
  add("food", `món ngon ${place}`);
  add("food", `đặc sản ${place}`);
  add("food", `quán ăn ${place}`);
  for (const food of region.foods ?? []) add("food", `${food} ${place}`);
  for (const dish of dishes) for (const t of DISH_TEMPLATES) add("dish", t.replace("{dish}", dish.toLowerCase()).replace("{place}", place));
  for (const cuisine of region.cuisines ?? []) add("cuisine", `quán ${cuisine} ${place}`);
  for (const where of [...(region.streets ?? []), ...(region.areas ?? []), ...(region.wards ?? [])]) add("location", `quán ăn ${where} ${place}`);
  for (const t of OFFICIAL_MENU) add("official_menu", t.replace("{place}", place));
  for (const site of sites) for (const dish of dishes.slice(0, 40)) add("site", `site:${site} ${dish.toLowerCase()} ${place}`);
  for (const name of merchantNames) for (const suffix of MENU_SUFFIXES) add("menu", `${name} ${suffix}`);
  const seen = new Set();
  return out.filter((q) => {
    const key = q.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
