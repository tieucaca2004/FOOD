// FORM 11 — Search V2: a LIST / DISCOVERY request phrase ("danh sách", "danh mục", "tổng hợp", "địa điểm") is what the
// customer asks for, never a place's name. As whole phrases only: a place really called "Danh …" / "Quán Danh" is still
// found by its name. Synthetic knowledge + the two places that exposed it (a name ending in "Danh", a real "Quán Danh").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-form11";

/** withRealDanh: also a REAL place called "Quán Danh" (fixture B). Without it (fixture A), "danh" is as rare in place
 * names as on the production data — where the misreading was found. */
function knowledge({ withRealDanh = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "form11-")), "knowledge.db");
  fs.copyFileSync(nhaTrangKnowledge(), file);
  const d = new Database(file);
  const ins = (sql, ...p) => d.prepare(sql).run(...p).lastInsertRowid;
  const ev = (q) => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES ((SELECT MIN(id) FROM kb_sources), ?, 'explicit', 'verified')`, q);
  const place = (key, name, address, products = []) => {
    const m = ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', '2026-09-26', '2026-09-26')`, key, name, name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase());
    ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, region_id, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, 'vn.khanh-hoa.nha-trang', ?, '2026-09-26', '2026-09-26', 'published')`, m, address, ev(address));
    for (const p of products) {
      const pid = ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at, observation) VALUES (?, ?, ?, ?, 'published', '2026-09-26', '2026-09-26', 'mention')`, m, p, p.toLowerCase(), ev(p));
      if (/bún cá/i.test(p)) ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, confidence, evidence_id, status) VALUES ((SELECT id FROM kb_food_entities WHERE key = 'bun-ca'), ?, 'exact', 0.9, ?, 'published')`, pid, ev(p));
    }
    return m;
  };
  // as many places as a real city (the rarity weights of name words depend on it: with ~1,100 places, "danh" alone
  // covered 47% of "danh sách" — above the 45% MEDIUM bar; with a dozen places it would not)
  for (let i = 0; i < 300; i += 1) ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', '2026-09-26', '2026-09-26')`, `filler-${i}`, `Tiệm Zq${i} Xv${i}`, `tiem zq${i} xv${i}`);
  place("quan-ruou-nep-tru-danh", "Quán Rượu Nếp Trứ Danh", "số 100/08 Hùng Vương, Nha Trang", ["Rượu nếp"]); // the place that exposed it
  if (withRealDanh) place("quan-danh", "Quán Danh", "15 Lê Thánh Tôn, Nha Trang", ["Bún cá Danh"]); // a REAL name "Danh"
  place("tong-quan-yen", "Tổng quan về Yên Nhà hàng chay", "5 Hàn Thuyên, Nha Trang", ["Cơm chay"]);
  place("dia-diem-an-sang", "Địa điểm ăn sáng Chị Bảy", "7 Ngô Quyền, Nha Trang", ["Bánh xèo"]);
  d.close();
  return file;
}

const FILE = knowledge();
const FILE_B = knowledge({ withRealDanh: true });
const planner = (file) => createFoodKnowledge({ dbPath: file, services: { merchantData: { listDiscoverable: () => [] } }, isRoutable: () => false });
const fkA = planner(FILE);
const fkB = planner(FILE_B);
const read = (text, fk = fkA) => {
  const u = fk.searchIntelligence().understand(text);
  return { plan: u.plan?.type ?? null, foods: (u.plan?.foods ?? u.entities.foods ?? []).map((f) => f.name), regionId: u.plan?.regionId ?? u.filters.regionId ?? null, merchant: u.plan?.type === "MERCHANT_OPERATION" || u.plan?.type === "CLARIFY" && u.plan?.reason === "AMBIGUOUS_PLACE" ? u.plan?.said ?? null : null, merchants: (u.entities.merchants ?? []).map((m) => m.name) };
};
const discovery = (text, food, regionId = null) => {
  const r = read(text);
  assert.equal(r.plan, "FOOD_DISCOVERY", `${text}: ${JSON.stringify(r)}`);
  assert.deepEqual(r.foods, [food], text);
  assert.equal(r.merchant, null, text);
  assert.deepEqual(r.merchants, [], text);
  if (regionId) assert.equal(r.regionId, regionId, text);
  return r;
};

test("T1–T6: list / discovery wordings are FOOD_DISCOVERY of the dish, never a place called 'danh sách'", () => {
  discovery("Cho tôi danh sách quán bán bún cá", "Bún cá"); // T1
  discovery("Cho tôi các quán bán bún cá", "Bún cá"); // T2
  discovery("Ở Nha Trang có quán nào bán bún cá?", "Bún cá", "vn.khanh-hoa.nha-trang"); // T3
  discovery("quán bán bún cá", "Bún cá"); // T4
  discovery("danh sách quán bán bánh căn", "Bánh căn"); // T5
  discovery("Cho tôi danh sách quán bán bún cá ở Nha Trang", "Bún cá", "vn.khanh-hoa.nha-trang"); // T6
  // the contract words (Phase 2)
  for (const t of ["danh sách quán bán bún cá", "list quán bán bún cá", "những quán bán bún cá", "quán nào bán bún cá", "tìm quán bán bún cá", "cho tôi danh sách quán bún cá", "cho tôi các quán bún cá", "danh sach quan ban bun ca"]) discovery(t, "Bún cá");
  // the same misreading, found in Phase 1 on the production data
  for (const t of ["danh mục quán bún cá", "tổng hợp quán bán bún cá", "địa điểm bán bún cá"]) discovery(t, "Bún cá");
});

test("T7 / T8: 'danh sách món bún cá' is about the dish; 'Cho tôi danh sách' alone names nothing — never a place", () => {
  const t7 = read("danh sách món bún cá");
  assert.equal(t7.merchant, null, JSON.stringify(t7));
  assert.deepEqual(t7.merchants, []);
  assert.ok(t7.foods.includes("Bún cá") || t7.plan === "FOOD_DISCOVERY", JSON.stringify(t7));
  const t8 = read("Cho tôi danh sách");
  assert.notEqual(t8.plan, "MERCHANT_OPERATION", JSON.stringify(t8));
  assert.equal(t8.merchant, null);
  assert.deepEqual(t8.merchants, [], "no place invented");
});

test("T9: a REAL place whose name contains 'Danh' is still found by its name", () => {
  for (const t of ["Quán Danh", "Quán Danh ở đâu", "Quán Danh bán bún cá không", "Quán Danh có menu gì"]) {
    const r = read(t, fkB);
    assert.equal(r.plan, "MERCHANT_OPERATION", `${t}: ${JSON.stringify(r)}`);
    assert.ok(r.merchants.includes("Quán Danh"), `${t}: ${JSON.stringify(r)}`);
  }
  const tru = read("Quán Rượu Nếp Trứ Danh ở đâu", fkB);
  assert.equal(tru.plan, "MERCHANT_OPERATION");
  assert.ok(tru.merchants.includes("Quán Rượu Nếp Trứ Danh"));
  // a real name starting with the other phrases stays findable by its own words
  assert.ok(read("Địa điểm ăn sáng Chị Bảy ở đâu", fkB).merchants.includes("Địa điểm ăn sáng Chị Bảy"));
  // and with a real "Quán Danh" present, the list request is still the dish list
  const both = read("Cho tôi danh sách quán bán bún cá", fkB);
  assert.equal(both.plan, "FOOD_DISCOVERY", JSON.stringify(both));
});

test("T10 / T11: the deterministic answer to 'Cho tôi danh sách quán bán bún cá' is the bún cá list — not Trứ Danh", async () => {
  platformConfig.telegramWebhookSecret = SECRET;
  const platform = buildTestPlatform({ withAtieu: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: FILE, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 1111, first_name: "L" }, chat: { id: 1111, type: "private" }, date: 1, text: "Cho tôi danh sách quán bán bún cá" } }) });
    const reply = (await res.json()).reply_text;
    assert.doesNotMatch(reply, /Trứ Danh|Rượu nếp/, reply);
    assert.match(reply, /Bún cá Cô Ba/, reply);
    assert.match(reply, /Bún Cá Mẫu/, reply);
    // T11: "danh" alone matched nothing it should not
    assert.deepEqual(read("danh sách").merchants, []);
  } finally {
    server.close();
    platform.agentSearch.foodKnowledge.close();
  }
});
