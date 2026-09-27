import { vnd, day, host } from "./answer.js";

// Answers a follow-up question about the Food Knowledge REFERENCE list the
// customer was just shown ("sao ko có giá?", "địa chỉ quán đầu", "còn quán
// nào nữa?"). It works on that list — every place that matched, in the order
// it was listed — never on a new search of the follow-up's own words.
//
// Same rules as answer.js: a price is only a recorded price of a product the
// list itself matched (never a similar dish, never another place's), with its
// source and date; what no source records is said plainly; nothing is ranked
// or praised; nothing here is orderable.

const PAGE = 5;
const REFERENCE = "ℹ️ Thông tin tham khảo theo nguồn — chưa đặt qua FOOD được.";

const priceText = (price) => `giá tham khảo ${vnd(price.price)}${price.priceMax ? `–${vnd(price.priceMax)}` : ""}, ghi nhận ${day(price.capturedAt)} (${host(price.sourceUrl)})`;
const pricedProducts = (m) =>
  m.products.map((p) => ({ name: p.name, price: p.prices.find((x) => x.price !== null) })).filter((p) => p.price);
const heading = (m) => `• ${m.name}${m.location?.address ? ` — ${m.location.address}` : ""}`;

const PRODUCTS_PER_PLACE = 8;

function priceBlock(m) {
  const priced = pricedProducts(m);
  const lines = priced.slice(0, PRODUCTS_PER_PLACE).map((p) => `   – ${p.name}: ${priceText(p.price)}`);
  if (priced.length > PRODUCTS_PER_PLACE) lines.push(`   – … và ${priced.length - PRODUCTS_PER_PLACE} món khác có giá`);
  return [heading(m), ...lines].join("\n");
}

function price({ context, merchants, target }) {
  if (target) {
    return pricedProducts(target).length ? `${priceBlock(target)}\n\n${REFERENCE}` : `${heading(target)}\nDạ các nguồn hiện có chưa ghi giá cho quán này, em không đoán giá ạ.`;
  }
  const priced = merchants.filter((m) => pricedProducts(m).length > 0);
  const scope = `Trong ${merchants.length} quán em tìm được cho “${context.query}”`;
  if (!priced.length) return `${scope}, hiện chưa quán nào có nguồn giá được xác minh — em không đoán giá ạ.`;
  const out = [`${scope}, em mới xác minh được giá của ${priced.length} quán:`, ...priced.slice(0, 10).map(priceBlock)];
  if (priced.length > 10) out.push(`… và ${priced.length - 10} quán khác có giá.`);
  if (priced.length < merchants.length) out.push("Các quán còn lại hiện chưa có nguồn giá được xác minh.");
  const shown = merchants.slice(0, context.shownCount);
  if (shown.length && !shown.some((m) => priced.includes(m))) out.push(`(${shown.length} quán em vừa gửi đều chưa có giá trong các nguồn hiện có.)`);
  out.push(REFERENCE);
  return out.join("\n\n");
}

function address({ targets }) {
  return targets.map((m) => `• ${m.name}: ${m.location?.address ?? "các nguồn hiện có chưa ghi địa chỉ"}`).join("\n");
}

function hours({ targets }) {
  return targets
    .map((m) => (m.openingHours.length ? `• ${m.name}: ${m.openingHours.map((h) => h.text).join(" / ")} (theo nguồn, ghi nhận ${day(m.openingHours[0].capturedAt)})` : `• ${m.name}: các nguồn hiện có chưa ghi giờ mở cửa`))
    .join("\n");
}

/**
 * @param {"price"|"address"|"hours"|"more"|"place"} kind
 * @param {{context: object, merchants: object[], ordinal: number|null, renderMerchant: (m) => string}} args
 * @returns {{text: string, shownCount: number}}
 */
export function buildFollowUpAnswer(kind, { context, merchants, ordinal = null, targetId = null, renderMerchant }) {
  const shownCount = context.shownCount;
  const focusId = context.focusId ?? null;
  if (!merchants.length) return { text: "Dạ danh sách em vừa gửi không còn dữ liệu, anh/chị tìm lại giúp em nha.", shownCount, focusId };
  // one place: by position in the list ("quán thứ 2") or the place being talked about ("quán đó", resolved by the caller)
  let target = null;
  if (ordinal !== null) {
    target = merchants[ordinal < 0 ? Math.min(shownCount, merchants.length) + ordinal : ordinal] ?? null;
    if (!target) return { text: `Dạ danh sách vừa rồi có ${merchants.length} quán thôi ạ.`, shownCount, focusId };
  } else if (targetId !== null) {
    target = merchants.find((m) => m.id === targetId) ?? null;
    if (!target) return { text: "Dạ anh/chị hỏi quán nào trong danh sách ạ? (VD: “quán đầu tiên”, “quán thứ 2”)", shownCount, focusId };
  }
  // the place answered about becomes the place the conversation is about
  const nextFocus = target ? target.id : focusId;
  const targets = target ? [target] : merchants.slice(0, shownCount);
  if (kind === "price") return { text: price({ context, merchants, target }), shownCount, focusId: nextFocus };
  if (kind === "address") return { text: address({ targets }), shownCount, focusId: nextFocus };
  if (kind === "hours") return { text: hours({ targets }), shownCount, focusId: nextFocus };
  if (kind === "place") {
    if (!target) return { text: "Dạ anh/chị hỏi quán nào trong danh sách ạ? (VD: “quán đầu tiên”, “quán thứ 2”)", shownCount, focusId };
    return { text: renderMerchant(target), shownCount, focusId: nextFocus };
  }
  // more: the next places of the same list
  const next = merchants.slice(shownCount, shownCount + PAGE);
  if (!next.length) return { text: `Dạ em đã gửi hết ${merchants.length} quán có dữ liệu cho “${context.query}” rồi ạ.`, shownCount, focusId };
  const rest = merchants.length - shownCount - next.length;
  const text = [`Thêm ${next.length} quán cho “${context.query}”:`, ...next.map(renderMerchant), ...(rest > 0 ? [`… còn ${rest} quán nữa, anh/chị nhắn “còn quán nào nữa” để xem tiếp.`] : [])].join("\n\n");
  return { text, shownCount: shownCount + next.length, focusId };
}
