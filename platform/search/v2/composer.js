// SEARCH INTELLIGENCE V2 — steps 12–13: fact guard + answer composer (pure).
// Everything printed comes from a RETRIEVED record: name, address, product, recorded price (with source and date),
// recorded hours. What no source records is said plainly; nothing is ranked, praised, guessed or made orderable.
import { describePriceFilter } from "./priceFilter.js";

// same formats as the Food Knowledge answers (knowledge/answer.js) — repeated here: the search layer does not
// import the knowledge layer (architecture boundary: only the read-only adapter does)
const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "nguồn đã ghi";
  }
};
const REFERENCE = "ℹ️ Thông tin tham khảo — chưa đặt qua FOOD được";
const priceOf = (p) => p.prices?.find((x) => x.price !== null) ?? null;
const priceText = (x) => `giá tham khảo ${vnd(x.price)}${x.priceMax ? `–${vnd(x.priceMax)}` : ""}, ghi nhận ${day(x.capturedAt)} (${host(x.sourceUrl)})`;
const MAX_PRODUCTS = 10;

/** "• Name — address" for one place (several records of the same address: their names together). */
function heading(group) {
  const names = [...new Set(group.map((m) => m.name))];
  const address = group.find((m) => m.location?.address)?.location.address ?? null;
  const more = group.length > 1 ? ` (${group.length} nguồn ghi cùng địa chỉ)` : "";
  return `• ${names.join(" / ")}${address ? ` — ${address}` : " — các nguồn hiện có chưa ghi địa chỉ"}${more}`;
}

function productsOf(group) {
  const seen = new Map();
  for (const m of group) for (const p of m.products ?? []) if (!seen.has(p.name.toLowerCase()) || (!priceOf(seen.get(p.name.toLowerCase())) && priceOf(p))) seen.set(p.name.toLowerCase(), p);
  return [...seen.values()];
}

function operationLines(op, group) {
  if (op === "address") return [];
  if (op === "hours") {
    const hours = group.flatMap((m) => (m.openingHours ?? []).map((h) => ({ ...h })));
    return hours.length ? [`   🕒 ${[...new Set(hours.map((h) => h.text))].join(" / ")} (theo nguồn, ghi nhận ${day(hours[0].capturedAt)})`] : ["   🕒 Các nguồn hiện có chưa ghi giờ mở cửa."];
  }
  const products = productsOf(group);
  if (op === "price") {
    const priced = products.filter(priceOf);
    if (!priced.length) return ["   – Các nguồn hiện có chưa ghi giá cho quán này, em không đoán giá ạ."];
    const lines = priced.slice(0, MAX_PRODUCTS).map((p) => `   – ${p.name}: ${priceText(priceOf(p))}`);
    if (priced.length > MAX_PRODUCTS) lines.push(`   – … và ${priced.length - MAX_PRODUCTS} món khác có giá`);
    return lines;
  }
  // menu / place: the recorded products (a mention in an article is not a full menu)
  if (!products.length) return ["   – Các nguồn hiện có chưa ghi món của quán này."];
  const lines = products.slice(0, MAX_PRODUCTS).map((p) => `   – ${p.name}: ${priceOf(p) ? priceText(priceOf(p)) : "chưa có giá"}`);
  if (products.length > MAX_PRODUCTS) lines.push(`   – … và ${products.length - MAX_PRODUCTS} món khác`);
  if (op === "place") {
    const hours = group.flatMap((m) => m.openingHours ?? []);
    if (hours.length) lines.push(`   🕒 ${[...new Set(hours.map((h) => h.text))].join(" / ")} (theo nguồn, ghi nhận ${day(hours[0].capturedAt)})`);
  }
  return lines;
}

/**
 * @param {{operation: string, groups: object[][], confidence: string, said: string}} a
 *   groups: places (merchant details + products) grouped by written address
 */
export function composeMerchantOperation({ operation, groups, confidence, said, renderPlace = null }) {
  const out = [];
  if (confidence === "MEDIUM_CONFIDENCE") out.push(`Dạ em chưa chắc đúng quán anh/chị hỏi (“${said}”). FOOD có quán tên gần giống:`);
  else if (groups.length > 1) out.push(`Dạ FOOD có ${groups.length} địa chỉ khác nhau cho “${said}” (có thể là các chi nhánh, hoặc nguồn ghi khác nhau):`);
  if (operation === "place" && renderPlace) {
    // the place itself: the same card as every Food Knowledge list (the fullest record of each address)
    for (const g of groups) {
      const main = [...g].sort((a, b) => (b.products?.length ?? 0) - (a.products?.length ?? 0))[0];
      const others = [...new Set(g.filter((m) => m !== main).map((m) => m.name))];
      out.push(renderPlace(main) + (others.length ? `\n   (cùng địa chỉ, nguồn khác ghi tên: ${others.join(" / ")})` : ""));
    }
    return out.join("\n\n");
  }
  for (const g of groups) out.push([heading(g), ...operationLines(operation, g)].join("\n"));
  const orderable = groups.some((g) => g.some((m) => m.orderable));
  out.push(orderable ? "✅ Quán này đặt được qua FOOD" : REFERENCE);
  return out.join("\n\n");
}

export function composeAmbiguousPlace({ said, groups }) {
  const names = groups.slice(0, 6).map((g) => `• ${[...new Set(g.map((m) => m.name))].join(" / ")}${g[0].address ? ` — ${g[0].address}` : ""}`);
  return [`Dạ FOOD có nhiều quán liên quan tới “${said}”:`, ...names, "Anh/chị hỏi quán nào ạ? (gõ tên đầy đủ hơn hoặc thêm tên đường)"].join("\n");
}

export function composeFoodChoice({ said, options }) {
  const names = options.slice(0, 5).map((f) => f.name);
  const more = options.length > 5 ? ` (và ${options.length - 5} món khác)` : "";
  return `Dạ “${said}” có thể là nhiều món: ${names.join(", ")}${more}. Anh/chị muốn tìm món nào ạ?`;
}

export function composeDidYouMean({ said, food }) {
  return `Dạ ý anh/chị là “${food.name}” phải không ạ? (anh/chị gõ “${said}”) — nhắn “đúng” để em tìm, hoặc gõ lại tên món.`;
}

export function composeNoContext(operation) {
  const about = { price: "giá", address: "địa chỉ", hours: "giờ mở cửa", menu: "món" }[operation] ?? "thông tin";
  return `Dạ anh/chị muốn hỏi ${about} của món hoặc quán nào ạ? (VD: "tìm <tên món>")`;
}

export function composeAskDish(price) {
  return `Dạ anh/chị muốn tìm món gì trong tầm giá ${describePriceFilter(price)} ạ?`;
}

export function composeUnknownPlace({ name }) {
  return `Dạ em chưa có dữ liệu về “${name}” trong FOOD, em không đoán địa chỉ hay giá của quán này ạ.`;
}

export function priceHeader(price) {
  return price ? `🔎 Lọc giá: ${describePriceFilter(price)} — chỉ tính giá tham khảo đã ghi nhận trong nguồn.` : "";
}

/**
 * @param {{regionName: string|null, foods: {name: string, merchants: number}[], nearMe: boolean, unsupportedArea: string|null, excluded: string[]}} a
 */
export function composeArea({ regionName, foods, nearMe, unsupportedArea, excluded }) {
  const out = [];
  if (nearMe || unsupportedArea) out.push(`Dạ hiện FOOD chưa có tọa độ các quán nên em chưa lọc được theo khoảng cách${unsupportedArea ? ` (“${unsupportedArea}”)` : ""}.`);
  if (!foods.length) {
    out.push("Dạ em chưa có dữ liệu món ăn có quán ghi nhận cho khu vực này.");
    return out.join("\n");
  }
  out.push(`${regionName ? `Ở ${regionName}` : "Trong dữ liệu hiện có"}, FOOD có dữ liệu tham khảo về các món${excluded.length ? ` (ngoài ${excluded.join(", ")})` : ""}:`);
  out.push(foods.map((f) => `• ${f.name} — ${f.merchants} quán có ghi nhận`).join("\n"));
  out.push("Anh/chị muốn xem quán của món nào ạ?");
  return out.join("\n\n");
}
