import { FoodTaxonomy } from "./taxonomy.js";

// Turns a FoodDiscoveryService result into a short Vietnamese answer that
// keeps every statement in its proper class:
//   FACT            recorded data, with its source and date   ("4.5/5 theo X, ghi nhận 20/09/2026")
//   TYPICAL         published dish knowledge, hedged           ("Bún chả cá thường là món nước")
//   UNKNOWN         said plainly                               ("em chưa có thông tin …")
//   REFERENCE PRICE a recorded price, never "the price now"    ("giá tham khảo 45.000đ, ghi nhận …")
//   ORDERABLE       only when the platform catalog says so     ("✅ đặt được qua FOOD")
// Nothing here ranks, praises or invents.

export const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;
export const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
export const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "nguồn đã ghi";
  }
};

export class AnswerBuilder {
  constructor({ taxonomy = new FoodTaxonomy() } = {}) {
    this.taxonomy = taxonomy;
  }

  label(fact) {
    if (fact.kind === "ingredient") return this.taxonomy.ingredients.get(fact.key)?.label_vi ?? fact.key;
    if (fact.kind === "facet") return this.taxonomy.facetNodes.get(fact.key)?.get(fact.value)?.label_vi ?? fact.value;
    if (fact.kind === "relation") return `đặc sản`;
    const attr = this.taxonomy.attribute(fact.key);
    if (!attr) return fact.key;
    return attr.type === "enum" ? `dùng ${attr.values[fact.value] ?? fact.value}` : `${attr.label_vi}${fact.level && fact.level !== "medium" ? ` (${{ low: "nhẹ", high: "nhiều", none: "không", adjustable: "tùy chọn" }[fact.level] ?? fact.level})` : ""}`;
  }

  conceptLabel(concept) {
    if (concept === "ingredient") return "nguyên liệu";
    if (concept.startsWith("facet:")) return this.taxonomy.json.facets[concept.slice(6)]?.label_vi ?? concept;
    if (concept === "relation:regional_specialty") return "đặc sản";
    if (concept.startsWith("relation:")) return this.taxonomy.relation(concept.slice(9))?.label_vi ?? concept;
    return this.taxonomy.attribute(concept.replace(/ \(.*\)$/, ""))?.label_vi ?? concept;
  }

  /** TYPICAL: what published knowledge says about a dish, hedged, with its sources. */
  describeFood(food) {
    const typical = food.facts.filter((f) => f.scope === "typical" && f.kind !== "relation");
    const specialty = [...new Set(food.facts.filter((f) => f.kind === "relation" && f.key === "regional_specialty").map((f) => f.valueLabel ?? f.value))];
    const regionFacts = (key) => food.facts.filter((f) => f.kind === "relation" && f.key === key);
    const regionText = (key, lead) => {
      const facts = regionFacts(key);
      if (!facts.length) return "";
      return ` ${lead} ${[...new Set(facts.map((f) => f.valueLabel ?? f.value))].join(", ")} (theo ${[...new Set(facts.map((f) => host(f.source)))].join(", ")}).`;
    };
    // a dish's specialty / origin / style — never where a merchant is
    const specialtyText = regionText("regional_specialty", "Đặc sản") + regionText("origin_region", "Có nguồn gốc từ") + regionText("regional_style", "Mang kiểu/tên vùng");
    specialty.push(...regionFacts("origin_region"), ...regionFacts("regional_style"));
    if (!typical.length) return specialty.length ? `${food.name}:${specialtyText}` : `${food.name}: em chưa có thông tin mô tả món này có nguồn xác minh.`;
    const ingredients = [...new Set(typical.filter((f) => f.kind === "ingredient" && f.value !== "served_with").map((f) => this.label(f)))];
    const traits = [...new Set(typical.filter((f) => f.kind !== "ingredient").map((f) => this.label(f)))];
    const sources = [...new Set(typical.map((f) => host(f.source)))];
    const parts = [];
    if (traits.length) parts.push(`thường: ${traits.join(", ")}`);
    if (ingredients.length) parts.push(`thường có ${ingredients.join(", ")}`);
    return `${food.name} ${parts.join("; ")} (theo ${sources.join(", ")}).${specialtyText}`;
  }

  merchantLine(m) {
    const lines = [`• ${m.name}${m.location?.address ? ` — ${m.location.address}` : ""}`];
    for (const p of m.products.slice(0, 5)) {
      const price = p.prices.find((x) => x.price !== null);
      const priceText = price ? `giá tham khảo ${vnd(price.price)}${price.priceMax ? `–${vnd(price.priceMax)}` : ""}, ghi nhận ${day(price.capturedAt)} (${host(price.sourceUrl)})${price.stale ? " — dữ liệu cũ" : ""}${price.conflict ? " — các nguồn ghi khác nhau" : ""}` : "chưa có giá";
      lines.push(`   – ${p.name}: ${priceText}${p.orderable ? " ✅ đặt được qua FOOD" : ""}`);
    }
    if (m.products.length > 5) lines.push(`   – … và ${m.products.length - 5} món khác`);
    for (const r of m.ratings.filter((x) => x.rating !== null || x.reviewCount !== null)) {
      lines.push(`   ⭐ ${r.rating !== null ? `${r.rating}/${r.scale}` : "—"}${r.reviewCount !== null ? ` (${r.reviewCount} đánh giá)` : ""} theo ${r.source}, ghi nhận ${day(r.capturedAt)}${r.stale ? " — dữ liệu cũ" : ""}`);
    }
    if (m.openingHours.length) lines.push(`   🕒 ${m.openingHours.map((h) => h.text).join(" / ")} (theo nguồn, ghi nhận ${day(m.openingHours[0].capturedAt)})`);
    if (m.distanceMeters !== null) lines.push(`   📍 cách khoảng ${m.distanceMeters < 1000 ? `${m.distanceMeters} m` : `${(m.distanceMeters / 1000).toFixed(1)} km`}`);
    lines.push(m.orderable ? "   ✅ Quán này đặt được qua FOOD" : "   ℹ️ Thông tin tham khảo — chưa đặt qua FOOD được");
    return lines.join("\n");
  }

  build(result) {
    const out = [];
    const q = result.query;
    if (q.outOfScope.length) out.push(`Dạ em không đánh giá "${q.outOfScope.map((o) => o.text).join(", ")}" (theo Đông y) — em chỉ có thông tin về món ăn và cách phục vụ.`);
    if (q.subjective) out.push("Em không xếp hạng quán hay món nào là “ngon nhất”; em có thể sắp theo đánh giá, giá hoặc khoảng cách nếu anh/chị muốn.");
    if (q.context.weather === "hot") out.push("Trời nóng thì anh/chị có thể cân nhắc món mát hoặc đồ uống lạnh — đây chỉ là gợi ý.");
    const okFoods = result.foods.filter((f) => f.ok);
    // a place the customer NAMED is the answer; the dish words inside its name are not a question about the dish
    const namedPlace = result.notes.includes("MERCHANT_NAME");
    // when places are listed, a dish with nothing verified to say is left out instead of "em chưa có thông tin mô tả"
    const describable = (f) => !result.merchants.length || f.facts.some((x) => x.scope === "typical" || x.kind === "relation");
    if (!namedPlace) for (const f of okFoods.filter(describable).slice(0, 3)) out.push(this.describeFood(f));
    // "chưa rõ" is said about dishes the customer NAMED — not about every dish in the knowledge base
    for (const f of result.foods.filter((x) => !x.ok && x.unknown.length && !x.excludedBy && q.foods.some((qf) => qf.entityKey === x.key)).slice(0, 3)) {
      out.push(`${f.name}: em chưa có thông tin về ${[...new Set(f.unknown.map((u) => this.conceptLabel(u)))].join(", ")}.`);
    }
    if (result.merchants.length) {
      out.push(`Em tìm thấy ${result.totalMerchants} quán có dữ liệu phù hợp:`);
      for (const m of result.merchants) out.push(this.merchantLine(m));
      if (result.totalMerchants > result.merchants.length) out.push(`… và ${result.totalMerchants - result.merchants.length} quán khác có dữ liệu tham khảo.`);
    } else if (q.foods.length || q.intent === "find_merchant" || okFoods.length) {
      out.push("Em chưa tìm thấy quán nào có dữ liệu xác minh phù hợp.");
    } else if (!okFoods.length) {
      out.push("Em chưa có món nào có đủ thông tin xác minh phù hợp với yêu cầu này.");
    }
    for (const n of result.notes) {
      if (n === "NEED_USER_LOCATION") out.push("Anh/chị cho em biết vị trí (hoặc tên đường) để em tìm quán gần ạ.");
      else if (n === "NO_RATING_DATA") out.push("Hiện em chưa có dữ liệu đánh giá của các quán này nên chưa sắp theo đánh giá được.");
      else if (n.startsWith("OPEN_STATUS_UNKNOWN")) out.push(`Có ${n.split(":")[1]} quán em chưa rõ giờ mở cửa nên chưa đưa vào.`);
      else if (n.startsWith("PRICE_UNKNOWN")) out.push(`Có ${n.split(":")[1]} món chưa có giá nên chưa đưa vào.`);
    }
    if (q.intent === "order" && !result.merchants.some((m) => m.orderable)) out.push("Để đặt món, anh/chị chọn một quán có ✅ “đặt được qua FOOD”.");
    return out.join("\n\n");
  }
}
