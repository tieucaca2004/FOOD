// SYNTHETIC TEST FIXTURE: a small Food Knowledge DB shaped like the Nha Trang collector data
// (regions, dishes, places, products, recorded prices with a source). Never production data.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";

export function nhaTrangKnowledge() {
  const file = path.join(os.tmpdir(), `kb-chat-${crypto.randomUUID()}.db`);
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  for (const [id, name, parent, level] of [["vn", "Việt Nam", null, "country"], ["vn.khanh-hoa", "Khánh Hòa", "vn", "province"], ["vn.khanh-hoa.nha-trang", "Nha Trang", "vn.khanh-hoa", "locality"], ["vn.khanh-hoa.cam-ranh", "Cam Ranh", "vn.khanh-hoa", "locality"]]) {
    ins(`INSERT INTO kb_regions (id, name, parent_id, level) VALUES (?, ?, ?, ?)`, id, name, parent, level);
  }
  const src = ins(`INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://buncamau.example/menu', 'buncamau.example', 'merchant_official', '2026-09-26', 'text/html', 'h', 'raw/m')`);
  const ev = (quote = "q") => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, ?, 'explicit', 'verified')`, src, quote);
  const food = (key, name, extra = []) => {
    const id = ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, 'published')`, key, name, key.replace(/-/g, " "));
    ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, 'canonical', 'sourced', 'published')`, id, name, key.replace(/-/g, " "));
    for (const [n, norm, kind] of extra) ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, ?, 'derived', 'published')`, id, n, norm, kind);
    return id;
  };
  const bunCa = food("bun-ca", "Bún cá", [["bun ca", "bun ca", "no_accent"]]);
  const banhCan = food("banh-can", "Bánh căn");
  food("long-lon", "Lòng lợn", [["tràng", "trang", "alias"]]); // the alias that once swallowed "Nha Trang"
  const merchant = (key, name, address, region) => {
    const id = ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', '2026-09-26', '2026-09-26')`, key, name, name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase());
    ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, region_id, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, '2026-09-26', '2026-09-26', 'published')`, id, address, region, ev(address));
    return id;
  };
  const product = (m, name, food, price = null) => {
    const p = ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at, observation) VALUES (?, ?, ?, ?, 'published', '2026-09-26', '2026-09-26', ?)`, m, name, name.toLowerCase(), ev(name), price ? "menu" : "mention");
    if (food) ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, confidence, evidence_id, status) VALUES (?, ?, 'exact', 0.9, ?, 'published')`, food, p, ev(name));
    if (price) ins(`INSERT INTO kb_product_prices (product_id, price, currency, price_text_original, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, 'VND', ?, ?, '2026-09-26', '2026-09-26', 'published')`, p, price, `${price}₫`, ev(`${name} ${price}₫`));
    return p;
  };
  const mau = merchant("bun-ca-mau", "Bún Cá Mẫu", "170 Bạch Đằng, Tân Lập, Nha Trang", "vn.khanh-hoa.nha-trang");
  product(mau, "Bún cá", bunCa, 45000);
  const coBa = merchant("bun-ca-co-ba", "Bún cá Cô Ba", "105 Hoàng Hoa Thám, Nha Trang", "vn.khanh-hoa.nha-trang");
  product(coBa, "Bún cá", bunCa);
  // priced SIMILAR dishes at a bún cá place — never an answer to "giá bún cá"
  product(coBa, "Bún chả cá tô nhỏ", null, 15000);
  product(coBa, "Bún riêu", null, 25000);
  const banh = merchant("banh-can-co-tu", "Bánh căn Cô Tư", "227 Võ Thị Sáu, Nha Trang", "vn.khanh-hoa.nha-trang");
  product(banh, "Bánh căn", banhCan);
  const camRanh = merchant("bun-ca-cam-ranh", "Bún cá Cam Ranh Hai", "12 Nguyễn Trãi, Cam Ranh", "vn.khanh-hoa.cam-ranh");
  product(camRanh, "Bún cá", bunCa);
  // the catalog's own merchant, recorded by the collector but NOT bridged by a person, and a different hủ tiếu place
  const huTieu = food("hu-tieu", "Hủ tiếu");
  const atieuKb = merchant("a-tieu", "A. Tiểu", "86 Lạc Long Quân, Nha Trang", "vn.khanh-hoa.nha-trang");
  for (const n of ["HỦ TIẾU XÀO BÒ", "HỦ TIẾU XÀO HẢI SẢN", "HỦ TIẾU XÀO THẬP CẨM"]) product(atieuKb, n, huTieu, 65000);
  const coNam = merchant("hu-tieu-co-nam", "Hủ tiếu Cô Năm", "9 Ngô Gia Tự, Nha Trang", "vn.khanh-hoa.nha-trang");
  product(coNam, "Hủ tiếu xào bò", huTieu);
  const min = merchant("bun-ca-min", "Bún Cá Mịn", "12 Lý Tự Trọng, Nha Trang", "vn.khanh-hoa.nha-trang"); // synthetic twin of the live query
  product(min, "Bún cá dầm – chả cá", null, 45000);
  merchant("hai-san-song-bien", "Quán hải sản Sóng Biển", "30 Trần Phú, Nha Trang", "vn.khanh-hoa.nha-trang");
  db.close();
  return file;
}
