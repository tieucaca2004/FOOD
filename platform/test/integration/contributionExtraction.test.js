// Multimodal V1 — PHASE 4–8 gate: classification (evidence metadata), structured provider output, EVIDENCE-FIRST
// extraction (every candidate keeps raw / normalized / quote / source / confidence / provider / model / time), price
// normalization, text contributions vs queries, injection as data. SYNTHETIC fixtures, fake reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contributionKit, FixtureImageUnderstanding } from "../helpers/contributionKit.js";
import { sanitizeReading, DOCUMENT_TYPES } from "../../ai/ingest/ImageUnderstandingProvider.js";
import { imageFindings, isApproximate } from "../../knowledge/ingestion/imageFindings.js";
import { classifyContributionText, classifyReply } from "../../knowledge/ingestion/contributionIntent.js";
import { explicitPlace } from "../../knowledge/ingestion/textClaims.js";
import { parsePrice } from "../../knowledge/price.js";

function flow(kit, files, { caption = null, text = null } = {}) {
  const senderHash = kit.hasher.user("telegram", "111");
  const s = kit.store.create({ channel: "telegram", senderHash, kid: "k1", sessionRef: 1 });
  let n = 0;
  for (const f of files.length ? files : [null]) {
    kit.store.addMessage(kit.store.get(s.id), {
      chatId: kit.hasher.chat("telegram", "111"),
      messageId: String(++n),
      sentAt: "2026-09-27T08:59:00Z",
      caption: f ? caption : null,
      text: f ? null : text,
      media: f ? [{ type: "photo", fileId: f, mimeType: "image/jpeg" }] : [],
      raw: { message: { message_id: n } },
    });
  }
  kit.store.transition(s.id, "EXTRACTING");
  return s;
}

async function confirm(kit, s, placeText = null, ports = {}) {
  await kit.ingestion.drain();
  const patch = placeText ? { place_text: placeText, place_resolution: kit.store.resolvePlace(placeText), place_message_id: kit.store.messages(s.id)[0].id } : {};
  kit.store.transition(s.id, "CANDIDATE", { actor: "customer", patch });
  kit.store.materialize(s.id, ports);
  return kit.store.candidates(s.id);
}

test("PROVIDER: structured output is sanitised to one schema; unknown types -> UNKNOWN; classification is metadata only", () => {
  const r = sanitizeReading({ document_type: "HACK", text: 5, items: [{ name: "Bún bò Huế", price: "45000", price_raw: "45K", extra: "x" }, { name: "" }], merchant: { name: "  " }, food_guess: [{ name: "Phở", confidence: 3 }] });
  assert.equal(r.document_type, "UNKNOWN");
  assert.equal(r.text, "");
  assert.deepEqual(r.items, [{ name: "Bún bò Huế", price_raw: "45K", price: null, currency: "VND", variant: null, confidence: null, evidence_text: null }]);
  assert.equal(r.merchant, null);
  assert.equal(r.food_guess[0].confidence, 1);
  assert.deepEqual(DOCUMENT_TYPES, ["MENU", "MERCHANT_SIGN", "ADDRESS", "PRICE_BOARD", "FOOD_PHOTO", "BUSINESS_CARD", "RECEIPT", "GENERAL_FOOD", "UNKNOWN"]);
});

test("PROVIDER capabilities: classifyImage / extractText / extractMenu / extractMerchant / extractEvidence — one model call per image", async () => {
  const reader = new FixtureImageUnderstanding();
  const img = { buffer: fs.readFileSync(path.resolve("platform/test/fixtures/multimodal/menu_clean.jpg")), mimeType: "image/jpeg", sha256: "abc" };
  assert.equal((await reader.classifyImage(img)).document_type, "MENU");
  assert.match((await reader.extractText(img)).text, /Bún bò Huế/);
  assert.equal((await reader.extractMenu(img)).items.length, 4);
  assert.equal((await reader.extractMerchant(img)).merchant.name, "Quán Bún Mẫu Thử");
  assert.equal((await reader.extractEvidence(img)).document_type, "MENU");
  assert.equal(reader.calls, 1);
});

test("PRICES: 45k / 45 K / 45.000 / 45,000 / 45 nghìn / 45 ngàn / 45.000đ / 45.000 đồng -> 45000 VND; approximate / bare numbers never", () => {
  for (const s of ["45k", "45 K", "45.000", "45,000", "45 nghìn", "45 ngàn", "45.000đ", "45.000 đồng", "45K"]) assert.equal(parsePrice(s).price, 45000, s);
  for (const s of ["khoảng 45k", "45", "giá liên hệ", ""]) assert.equal(parsePrice(s).price, null, s);
  assert.equal(isApproximate("bún bò khoảng 45k", "45k"), true);
  assert.equal(isApproximate("bún bò tầm 45k", "45k"), true);
  assert.equal(isApproximate("bún bò 45k", "45k"), false);
});

test("EVIDENCE FIRST: an item counts only where the image text shows it; the model's number is never trusted", () => {
  const ocr = "Quán X\nBún bò Huế ........ 45K\nBánh hỏi 40.000đ";
  const r = imageFindings(
    {
      items: [
        { name: "Bún bò Huế", price_raw: "45K", price: 99000, evidence_text: "Bún bò Huế ........ 45K" }, // wrong number from the model
        { name: "Phở cuốn", price_raw: "35k", price: 35000, evidence_text: "Phở cuốn 35k" }, // not in the image text
        { name: "Bánh hỏi", price_raw: "4?K", price: 45000, evidence_text: "Bánh hỏi 40.000đ" }, // unreadable price as written
      ],
      merchant: { name: "Quán Bịa" },
    },
    ocr
  );
  const bun = r.findings.find((f) => f.productText === "Bún bò Huế");
  assert.equal(bun.kind, "price");
  assert.equal(bun.normalizedValue, "45000", "FOOD's parser, not the model's 99000");
  assert.equal(bun.segment, "Bún bò Huế ........ 45K", "quote = verbatim OCR line");
  assert.ok(!r.findings.some((f) => f.productText === "Phở cuốn"));
  assert.equal(r.findings.find((f) => f.productText === "Bánh hỏi").kind, "product", "dish kept, price unknown");
  assert.equal(r.placeText, null, "a merchant name not written in the image is not a place");
  assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ["merchant_not_in_image_text", "not_in_image_text", "price_unreadable"]);
});

test("IMAGE -> EXTRACTION -> CANDIDATE: a menu yields product+price candidates with complete provenance", async () => {
  const kit = contributionKit();
  const s = flow(kit, ["menu_clean.jpg"], { caption: "Đây là menu quán Bún Mẫu Thử" });
  await kit.ingestion.drain();
  const reading = kit.store.reading(s.id);
  assert.deepEqual(reading.documentTypes, ["MENU"]);
  assert.equal(reading.findings.filter((f) => f.kind === "price").length, 4);
  // nothing is a candidate before the customer confirms (DB gate)
  assert.equal(kit.store.candidates(s.id).length, 0);
  const foodId = kit.db.prepare(`SELECT id FROM kb_food_entities ORDER BY id LIMIT 1`).get().id;
  const cands = await confirm(kit, s, "Quán Bún Mẫu Thử", { resolveFood: (n) => (n === "Bún bò Huế" ? { foodEntityId: foodId } : null) });
  const bun = cands.find((c) => c.product_text === "Bún bò Huế");
  assert.equal(bun.kind, "price");
  assert.equal(bun.raw_value, "45K");
  assert.equal(bun.normalized_value, "45000");
  assert.equal(bun.evidence_quote, "Bún bò Huế ........ 45K");
  assert.equal(bun.assertion_kind, "OBSERVED");
  assert.equal(bun.status, "review");
  assert.equal(bun.food_entity_id, foodId, "food resolved through the injected resolver only");
  assert.ok(bun.message_media_id, "which image");
  assert.ok(bun.place_message_id, "which message named the place");
  assert.ok(bun.confidence > 0 && bun.confidence < 1);
  // provenance chain: source = the stored OCR text; extraction = provider + model + time
  const src = kit.db.prepare(`SELECT * FROM kb_sources WHERE id = ?`).get(bun.source_id);
  assert.equal(src.source_type, "user_contribution");
  assert.match(src.url, /^ocr:\/\//);
  assert.ok(fs.readFileSync(path.join(kit.rawRoot, src.raw_path), "utf8").includes(bun.evidence_quote));
  const ocrX = kit.db.prepare(`SELECT provider, model, created_at FROM kb_ingest_extractions WHERE kind = 'ocr' AND provider != 'reuse'`).get();
  assert.deepEqual([ocrX.provider, ocrX.model], ["fixture", "readings.json"]);
  assert.ok(ocrX.created_at);
  const media = kit.db.prepare(`SELECT m.sha256 FROM kb_ingest_fetched f JOIN kb_ingest_media m ON m.id = f.media_id WHERE f.message_media_id = ?`).get(bun.message_media_id);
  assert.match(media.sha256, /^[0-9a-f]{64}$/, "the original image is the primary evidence");
});

test("IMAGE + CAPTION that disagree: both kept as evidence, both marked CONFLICT — nothing chosen silently", async () => {
  const kit = contributionKit();
  const s = flow(kit, ["menu_small.png"], { caption: "Quán Bún Mẫu Thử bún bò huế 40k" });
  const cands = await confirm(kit, s, "Quán Bún Mẫu Thử");
  const bun = cands.filter((c) => c.kind === "price" && /bún bò huế/i.test(c.product_text));
  assert.deepEqual(bun.map((c) => [c.assertion_kind, c.normalized_value]).sort(), [["OBSERVED", "45000"], ["USER_ASSERTION", "40000"]]);
  for (const c of bun) {
    assert.equal(c.change, "CONFLICT");
    assert.equal(c.severity, "HIGH");
  }
});

test("CATALOG PRECEDENCE: a different catalog price makes the candidate a CONFLICT with the catalog value kept; the same price is UNCHANGED", async () => {
  const kit = contributionKit();
  const s = flow(kit, ["menu_clean.jpg"]);
  await kit.ingestion.drain();
  const resolution = { status: "unknown", class: "EXACT_EXISTING_MERCHANT", kbPlaceId: null, catalogMerchantId: "DEMO001", candidates: [] };
  kit.store.transition(s.id, "CANDIDATE", { patch: { place_text: "Quán Demo", place_resolution: resolution, place_message_id: kit.store.messages(s.id)[0].id } });
  kit.store.materialize(s.id, { catalogPrice: (m, p) => (m === "DEMO001" && p === "Bún bò Huế" ? 50000 : p === "Bánh hỏi" ? 40000 : null) });
  const cands = kit.store.candidates(s.id);
  const bun = cands.find((c) => c.product_text === "Bún bò Huế");
  assert.deepEqual([bun.change, bun.severity, bun.previous_value, bun.catalog_merchant_id], ["CONFLICT", "HIGH", "50000", "DEMO001"]);
  assert.equal(cands.find((c) => c.product_text === "Bánh hỏi").change, "UNCHANGED");
});

test("CLASSES: sign -> place only; address -> address; food photo -> INFERRED dish only (no price / place); irrelevant -> nothing", async () => {
  const kit = contributionKit();
  const sign = flow(kit, ["merchant_sign.jpg"]);
  await kit.ingestion.drain();
  assert.equal(kit.store.reading(sign.id).places[0].place, "BÚN CÁ CÔ BA", "as written in the image");
  assert.equal(kit.store.reading(sign.id).places[0].resolution.status, "resolved", "an existing place is found, not created");

  const kit2 = contributionKit();
  const addr = flow(kit2, ["address.jpg"]);
  const a = await confirm(kit2, addr, "Quán Bún Mẫu Thử");
  assert.deepEqual(a.map((c) => [c.kind, c.raw_value]), [["address", "12 Đường Thử Nghiệm, Nha Trang"]]);

  const kit3 = contributionKit();
  const photo = flow(kit3, ["food_photo.jpg"]);
  const p = await confirm(kit3, photo);
  assert.deepEqual(p.map((c) => [c.kind, c.field, c.assertion_kind, c.raw_value, c.place_text, c.source_id]), [["food", "dish", "INFERRED", "Bún bò Huế", null, null]]);

  const kit4 = contributionKit();
  const irr = flow(kit4, ["irrelevant_text.jpg"]);
  await kit4.ingestion.drain();
  assert.equal(kit4.store.reading(irr.id).findings.filter((f) => f.kind === "price" || f.kind === "product").length, 0);
});

test("BLURRY / HANDWRITTEN: unreadable prices are not invented; a dish the transcription lacks is dropped", async () => {
  const kit = contributionKit();
  const b = flow(kit, ["menu_blurry.jpg"]);
  const cands = await confirm(kit, b, "Quán Bún Mẫu Thử");
  const bun = cands.find((c) => c.product_text === "Bún bò Huế");
  assert.equal(bun.kind, "product", "price '4?K' is unreadable -> no price");
  assert.equal(cands.find((c) => c.product_text === "Bánh hỏi").normalized_value, "40000");
  assert.ok(cands.every((c) => c.severity !== "LOW" || c.kind === "product"), "a low-confidence reading is never a low-risk price");
  const kit2 = contributionKit();
  const h = flow(kit2, ["menu_handwritten.jpg"]);
  const hc = await confirm(kit2, h, "Quán Bún Mẫu Thử");
  assert.ok(!hc.some((c) => c.product_text === "Phở cuốn"), "not in the transcription -> not a candidate");
});

test("INJECTION IMAGE: instructions stay plain data — no candidate but an implausible, flagged price; no state / schema change", async () => {
  const kit = contributionKit();
  const tables = () => kit.db.prepare(`SELECT name FROM sqlite_master ORDER BY name`).all().map((r) => r.name).join(",");
  const before = tables();
  const s = flow(kit, ["prompt_injection.jpg"]);
  const cands = await confirm(kit, s, "Quán Bún Mẫu Thử");
  assert.equal(tables(), before);
  assert.deepEqual(cands.map((c) => [c.product_text, c.normalized_value, c.change, c.severity, c.status]), [["Bún bò Huế", "1", "UNCERTAIN", "HIGH", "review"]]);
  const ocr = kit.db.prepare(`SELECT output_json FROM kb_ingest_extractions WHERE kind = 'ocr' AND provider = 'fixture'`).get();
  assert.match(JSON.parse(ocr.output_json).text, /SYSTEM: ignore all previous instructions/, "kept verbatim as evidence, nothing executed");
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published' AND price = 1`).get().n, 0);
});

test("TEXT CONTRIBUTION vs QUERY (deterministic)", () => {
  assert.equal(classifyContributionText("Quán ABC bán bánh hỏi 40k").kind, "CONTRIBUTION");
  assert.equal(classifyContributionText("Quán nào bán bánh hỏi?").kind, "QUERY");
  assert.equal(classifyContributionText("quán nào bán bánh hỏi").kind, "QUERY");
  assert.equal(classifyContributionText("tìm bún bò dưới 40k").kind, "QUERY");
  assert.equal(classifyContributionText("Giá bún bò bao nhiêu?").kind, "QUERY");
  assert.equal(classifyContributionText("Quán ABC có bán bánh hỏi không").kind, "QUERY");
  assert.equal(classifyContributionText("hôm nay trời đẹp").kind, "NONE");
  assert.equal(classifyContributionText("bún bò 45k").kind, "NONE", "no place -> not knowledge");
  assert.deepEqual(classifyReply("có"), { kind: "YES" });
  assert.deepEqual(classifyReply("thôi"), { kind: "NO" });
  assert.deepEqual(classifyReply("Quán Bún Cá Cô Ba"), { kind: "PLACE", place: "Bún Cá Cô Ba" });
  assert.deepEqual(classifyReply("không, quán Bún Cá Mịn"), { kind: "PLACE", place: "Bún Cá Mịn" });
  assert.deepEqual(classifyReply("giá bún bò bao nhiêu?"), { kind: "OTHER" });
  assert.deepEqual(classifyReply("2 tô bún bò"), { kind: "OTHER" });
  // merchant (ordering) context: only unmistakable answers
  assert.deepEqual(classifyReply("có", { strict: true }), { kind: "OTHER" });
  assert.deepEqual(classifyReply("lưu", { strict: true }), { kind: "YES" });
  assert.deepEqual(classifyReply("bỏ qua", { strict: true }), { kind: "NO" });
});

test("TEXT: a customer's text contribution becomes USER_ASSERTION candidates after confirmation; approximate amounts ignored", async () => {
  const kit = contributionKit();
  const s = flow(kit, [], { text: "Quán Bún Cá Cô Ba bún cá 35k; chả cá khoảng 20k" });
  const cands = await confirm(kit, s, "Bún Cá Cô Ba");
  assert.deepEqual(cands.map((c) => [c.kind, c.product_text, c.normalized_value, c.assertion_kind]), [["price", "bún cá", "35000", "USER_ASSERTION"]]);
  assert.equal(cands[0].place_resolution.status, "resolved");
  assert.equal(cands[0].change, "NEW", "no published price for it yet: a NEW proposal, never applied");
});

test("OPENING HOURS (live finding): an hour range without an opening-hours cue is not opening hours for a customer", async () => {
  // image: the notice "Cúp điện từ 8h đến 11h sáng mai" (live gpt-5.6-terra read it exactly like this)
  const kit = contributionKit();
  const img = flow(kit, ["irrelevant_text.jpg"]);
  await kit.ingestion.drain();
  assert.equal(kit.store.reading(img.id).findings.filter((f) => f.kind === "opening_hours").length, 0);
  // text: the same sentence about a named place -> no hours candidate; with "mở cửa" -> one
  const kit2 = contributionKit();
  const no = flow(kit2, [], { text: "Quán Bún Cá Cô Ba cúp điện từ 8h đến 11h" });
  const noCands = await confirm(kit2, no, "Bún Cá Cô Ba");
  assert.ok(!noCands.some((c) => c.kind === "opening_hours"), JSON.stringify(noCands.map((c) => c.kind)));
  const kit3 = contributionKit();
  const yes = flow(kit3, [], { text: "Quán Bún Cá Cô Ba mở cửa từ 8h đến 11h" });
  const yesCands = await confirm(kit3, yes, "Bún Cá Cô Ba");
  assert.deepEqual(yesCands.filter((c) => c.kind === "opening_hours").map((c) => c.normalized_value), ["08:00-11:00"]);
  // a cue on the line above ("Giờ mở cửa:" header of a menu) counts; "nghỉ thứ hai" carries its own cue
  const kit4 = contributionKit();
  const mixed = flow(kit4, [], { text: "Quán Bún Cá Cô Ba\nGiờ mở cửa:\n7h - 22h\nnghỉ thứ hai" });
  const mixedCands = await confirm(kit4, mixed, "Bún Cá Cô Ba");
  assert.deepEqual(mixedCands.filter((c) => c.kind === "opening_hours").map((c) => c.normalized_value).sort(), ["07:00-22:00", "closed:thứ hai"]);
  // the Knowledge Group path is unchanged (frozen): its rule still reads the range, for a person to review
  const g = kit.ingestion.receive({ channel: "telegram", chatId: "-100777", messageId: "g1", senderId: "501", text: "Quán Bún Cá Cô Ba cúp điện từ 8h đến 11h", raw: {} });
  await kit.ingestion.drain();
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates WHERE message_id = ? AND kind = 'opening_hours'`).get(g.id).n, 1);
});

test("PLACE NAME stops at the end of its line (multi-line '#' input)", () => {
  assert.equal(explicitPlace("Quán Bún Bò ABC\nĐịa chỉ: 123 Nguyễn Trãi"), "Bún Bò ABC");
  assert.equal(explicitPlace("Quán Test ABC\nBún bò 45k"), "Test ABC");
  assert.equal(explicitPlace("menu Quán Bún Cá Cô Ba ngon"), "Bún Cá Cô Ba");
});
