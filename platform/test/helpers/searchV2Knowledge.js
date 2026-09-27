// SYNTHETIC TEST FIXTURE for Search Intelligence V2: a small Food Knowledge DB shaped like the Nha Trang
// collector data, with the exact situations Phase 1.5 found on the real warehouse — one-word place names,
// places named after streets, decoys sharing a word ("Hồng", "Phan"), a dish family ("Bún"), a REVIEW entity
// ("Bún bò"), recorded reference prices for the price filters. Never production data.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { TermRelationService } from "../../knowledge/terms/termRelationService.js";

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
const NT = "vn.khanh-hoa.nha-trang";

/**
 * @param {{atieuLink?: boolean, bunBoHue?: boolean}} [opts] atieuLink: also record the Founder-approved link kb "A. Tiểu" ->
 *   catalog ATIEU001; bunBoHue: the Founder-approved names "bún bò" / "bun bo" -> canonical "Bún bò Huế" (approved
 *   term relations, the same lifecycle and rows as the real warehouse)
 */
export function searchV2Knowledge({ atieuLink = false, bunBoHue = false } = {}) {
  const file = path.join(os.tmpdir(), `kb-si2-${crypto.randomUUID()}.db`);
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  for (const [id, name, parent, level] of [["vn", "Việt Nam", null, "country"], ["vn.khanh-hoa", "Khánh Hòa", "vn", "province"], [NT, "Nha Trang", "vn.khanh-hoa", "locality"]]) {
    ins(`INSERT INTO kb_regions (id, name, parent_id, level) VALUES (?, ?, ?, ?)`, id, name, parent, level);
  }
  const src = ins(`INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://guide.example/nha-trang', 'guide.example', 'blog', '2026-09-26', 'text/html', 'h', 'raw/g')`);
  const ev = (quote = "q") => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, ?, 'explicit', 'verified')`, src, quote);
  const food = (name, { status = "published" } = {}) => {
    const key = fold(name).replace(/[^a-z0-9]+/g, "-");
    const id = ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, ?)`, key, name, fold(name), status);
    ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, 'canonical', 'sourced', ?)`, id, name, fold(name), status);
    if (fold(name) !== name.toLowerCase()) ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, 'no_accent', 'derived', ?)`, id, fold(name), fold(name), status);
    return id;
  };
  const F = {};
  for (const n of ["Bún cá", "Bún chả", "Bún riêu", "Bún bò Huế", "Bún bò Nam Bộ", "Bún", "Bánh căn", "Bánh canh", "Bánh xèo", "Nem nướng", "Hủ tiếu", "Phở", "Phở cuốn", "Pizza", "Cháo lòng", "Mì Quảng"]) F[n] = food(n);
  F["Bún bò"] = food("Bún bò", { status: "review" }); // exists in the warehouse, NOT published
  const merchant = (name, address, { status = "candidate" } = {}) => {
    const id = ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, '2026-09-26', '2026-09-26')`, `${fold(name).replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 6)}`, name, fold(name), status);
    ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, region_id, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, '2026-09-26', '2026-09-26', 'published')`, id, address, NT, ev(address));
    return id;
  };
  const product = (m, name, foodId, price = null) => {
    const p = ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at, observation) VALUES (?, ?, ?, ?, 'published', '2026-09-26', '2026-09-26', ?)`, m, name, fold(name), ev(name), price ? "menu" : "mention");
    if (foodId) ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, confidence, evidence_id, status) VALUES (?, ?, 'exact', 0.9, ?, 'published')`, foodId, p, ev(name));
    if (price) ins(`INSERT INTO kb_product_prices (product_id, price, currency, price_text_original, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, 'VND', ?, ?, '2026-09-26', '2026-09-26', 'published')`, p, price, `${price}₫`, ev(`${name} ${price}₫`));
    return p;
  };
  const hours = (m, text) => ins(`INSERT INTO kb_merchant_claims (merchant_id, field, value_json, original_text, evidence_id, captured_at, last_seen_at, status) VALUES (?, 'opening_hours', NULL, ?, ?, '2026-09-26', '2026-09-26', 'published')`, m, text, ev(text));

  // bún cá: three places, one priced
  product(merchant("Bún cá Nguyên Loan", "123 Ngô Gia Tự, Nha Trang"), "Bún cá", F["Bún cá"]);
  product(merchant("Bún chả cá Nguyên Loan Nha Trang", "123 Ngô Gia Tự, tỉnh Khánh Hòa"), "Bún cá", F["Bún cá"]); // same place, second source
  product(merchant("Bún cá Cô Ba", "105 Hoàng Hoa Thám, Nha Trang"), "Bún cá", F["Bún cá"]);
  product(merchant("Bún Cá Mịn", "170 Bạch Đằng, Nha Trang"), "Bún cá", F["Bún cá"], 45000);
  // bánh căn: Út Năm recorded at two addresses (two sources), priced 45k / 80k; a place named after its street
  const utNam = merchant("Bánh căn Út Năm Nha Trang", "16 Phạm Hồng Thái, Nha Trang");
  product(utNam, "Bánh căn", F["Bánh căn"], 45000);
  hours(utNam, "06:00–10:00");
  product(merchant("Quán bánh căn Nha Trang Út Năm", "Số 127 Nguyễn Bỉnh Khiêm, Nha Trang"), "Bánh căn", F["Bánh căn"]);
  product(merchant("Bánh căn Tô Hiến Thành Nha Trang", "51 Tô Hiến Thành, Nha Trang"), "Bánh căn đặc biệt", F["Bánh căn"], 80000);
  // one-word / foreign names, street-name decoys
  product(merchant("Nhà hàng Nhật Bản KIWAMI", "136 Bạch Đằng, Nha Trang"), "Sushi", null, 120000);
  product(merchant("Vfruit", "24 Tô Hiến Thành, Nha Trang"), "Kem bơ", null, 30000);
  merchant("LIVIN Barbecue restaurant in Nha Trang", "5A Ngo Thoi Nhiem, Nha Trang");
  product(merchant("Phở Hồng", "số 40 đường Lê Thánh Tôn, Nha Trang"), "Phở bò", F["Phở"]);
  product(merchant("Bún ốc Hồng Ngọc", "79 Hoàng Diệu, Nha Trang"), "Bún ốc", null); // decoy: shares "Hồng"
  product(merchant("Bánh bèo Phan Bội Châu", "101 Phan Bội Châu, Nha Trang"), "Bánh bèo", null); // decoy: shares "Phan"
  product(merchant("The Pizza Company", "99A 23 tháng 10, Nha Trang"), "Pizza hải sản", F["Pizza"], 150000);
  // bún bò Huế places; a place NAMED "bún bò" (the REVIEW entity is not published)
  product(merchant("Bún bò Huế Cố Đô", "17 Hoàng Diệu, Nha Trang"), "Bún bò Huế", F["Bún bò Huế"], 40000);
  product(merchant("Bún bò 100 Ngô Gia Tự", "100 Ngô Gia Tự, Nha Trang"), "Bún bò", null);
  // other dishes for area discovery
  product(merchant("Bánh xèo Chị Bảy", "Ngã ba Lê Thành Phương, Nha Trang"), "Bánh xèo", F["Bánh xèo"]);
  product(merchant("Bánh xèo 85 Tô Hiến Thành", "85 Tô Hiến Thành, Nha Trang"), "Bánh xèo", F["Bánh xèo"]);
  product(merchant("Nem nướng Đặng Văn Quyên", "16A Lãn Ông, Nha Trang"), "Nem nướng", F["Nem nướng"], 50000);
  product(merchant("Nem nướng Ngọc Tiên", "59 Lê Thành Phương, Nha Trang"), "Nem nướng", F["Nem nướng"]);
  product(merchant("Hủ tiếu Cô Năm", "9 Ngô Gia Tự, Nha Trang"), "Hủ tiếu xào bò", F["Hủ tiếu"]);
  product(merchant("Hủ Tiếu Nam Vang Bayon", "93 Yersin, Nha Trang"), "Hủ tiếu", F["Hủ tiếu"]);
  product(merchant("Cháo lòng 148 Võ Trứ", "148 Võ Trứ, Nha Trang"), "Cháo lòng", F["Cháo lòng"]);
  product(merchant("Cháo lòng Bà Điên", "70 Núi Một, Nha Trang"), "Cháo lòng", F["Cháo lòng"]);
  // the catalog's own merchant, recorded by the collector ("A. Tiểu"); linked to ATIEU001 only when a person approved it
  const atieuKb = merchant("A. Tiểu", "86 Lạc Long Quân, Nha Trang");
  for (const n of ["HỦ TIẾU XÀO BÒ", "HỦ TIẾU XÀO HẢI SẢN", "HỦ TIẾU XÀO THẬP CẨM"]) product(atieuKb, n, F["Hủ tiếu"], 65000);
  if (atieuLink) ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by, note) VALUES (?, 'ATIEU001', 'founder', '[TEST] approved link')`, atieuKb);
  // a REJECTED record is never an answer
  product(merchant("Bún cá Rejected Test", "1 Không Có, Nha Trang", { status: "rejected" }), "Bún cá", F["Bún cá"], 10000);
  if (bunBoHue) {
    const terms = new TermRelationService({ db });
    const quote = "[TEST] Founder: \"bún bò\" -> canonical \"bún bò Huế\"";
    const sha = crypto.createHash("sha256").update(quote).digest("hex");
    for (const [term, type] of [["bún bò", "COMMON_QUERY"], ["bun bo", "DIACRITIC_VARIANT"]]) {
      const r = terms.propose({ foodEntityId: F["Bún bò Huế"], term, relationType: type, createdBy: "test-fixture", evidence: [{ sourceKind: "text", sourceRef: sha, quote }] });
      terms.submitForReview(r.id, "test-fixture");
      terms.approve(r.id, { by: "Founder (test)" });
    }
  }
  db.close();
  return file;
}
