import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, "..", "..", "data", "restaurants.json");

function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

export function loadRestaurants() {
  const raw = fs.readFileSync(SEED_PATH, "utf8");
  return JSON.parse(raw);
}

// Only ever returns entries present in the seed file — the caller must not
// add anything on top, so the bot can never invent a restaurant that isn't seeded.
export function findMatchingRestaurants(text, { limit = 5 } = {}) {
  const all = loadRestaurants();
  const normalized = stripAccents(text || "");

  const scored = all
    .map((r) => {
      const haystack = stripAccents([r.name, r.area, ...(r.dish_tags || [])].join(" "));
      const tagHit = (r.dish_tags || []).some((tag) => normalized.includes(stripAccents(tag)));
      const areaHit = normalized.includes(stripAccents(r.area || ""));
      const score = (tagHit ? 2 : 0) + (areaHit ? 1 : 0);
      return { r, score, haystack };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const matches = (scored.length > 0 ? scored : all.map((r) => ({ r, score: 0 }))).slice(0, limit);
  return matches.map((x) => x.r);
}

export function formatRestaurantList(restaurants) {
  if (restaurants.length === 0) {
    return "Dạ hiện em chưa có quán nào trong danh sách phù hợp, anh/chị cho em thêm khu vực hoặc món cụ thể để em tìm lại nha.";
  }
  const lines = restaurants.map(
    (r, i) =>
      `${i + 1}. ${r.name} — ${r.area}\n   Địa chỉ: ${r.address}\n   Giá: ${r.price_range}${
        r.notes ? `\n   Ghi chú: ${r.notes}` : ""
      }`
  );
  return `Dạ có, em gợi ý mấy quán sau nha:\n\n${lines.join("\n\n")}`;
}
