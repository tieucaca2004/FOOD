// MERCHANT DATA UPDATE: TEXT / IMAGE -> extraction -> DRAFT | REVIEW_REQUIRED -> APPROVED (a person) -> PUBLISHED
// (a person) -> search / tools / answer. Also: price change of an existing dish (in place, audited), merchant
// address update (a person, audited), merchant scoping, the operator CLI, and the OpenAI vision provider contract.
// In-memory platform DB + a fake vision provider; the OpenAI provider is tested with a stubbed fetch (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { OpenAIMenuVisionProvider } from "../../ai/menu/OpenAIMenuVisionProvider.js";
import { createPlatformConnection, runPlatformMigrations } from "../../db/connection.js";
import { runPlatformSeed } from "../../db/seed.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const NOM = "DEMO_NOMNOM001";
const ATIEU = "ATIEU001";

function platform() {
  const kb = nhaTrangKnowledge();
  const p = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: kb, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const customer = p.services.customers.getOrCreateByZaloUserId(`du-${Math.random()}`, "D");
  const say = (text) => p.router.handle({ customer, session: p.services.sessions.getOrCreate(customer.id), text }).then((r) => r.replyText);
  const events = (type) => p.db.prepare(`SELECT merchant_id, payload_json FROM merchant_events WHERE event_type = ? ORDER BY id`).all(type).map((r) => ({ merchantId: r.merchant_id, ...JSON.parse(r.payload_json) }));
  const product = (merchantId, name) => p.services.menu.listProducts(merchantId, { includeUnavailable: true }).filter((x) => x.name.toLowerCase() === name.toLowerCase());
  return { p, kb, say, events, product };
}

test("TEXT: 'Thêm món Bún Cá 45k' is a DRAFT until a person approves AND publishes — then search and tools see it", async () => {
  const { p, say, events, product } = platform();
  const imp = p.services.menuImport.importText(NOM, "Thêm món Bún Cá 45k", { createdBy: "founder" });
  assert.deepEqual([imp.status, imp.draft.categories[0].products.map((x) => [x.name, x.price, x.needs_review, x.existing_product_id])], ["DRAFT", [["Bún Cá", 45000, false, null]]]);
  assert.equal(product(NOM, "Bún Cá").length, 0); // nothing published yet
  assert.throws(() => p.services.menuImport.publishImport(NOM, imp.id, { by: "founder" }), /not approved/); // no bypass
  p.services.menuImport.approveImport(NOM, imp.id, { by: "founder" });
  p.services.menuImport.publishImport(NOM, imp.id, { by: "founder" });
  assert.deepEqual(product(NOM, "Bún Cá").map((x) => x.price), [45000]);
  assert.match(await say("tìm bún cá"), /NÔM NÔM[\s\S]*Bún Cá/i); // global discovery now lists the catalog dish
  const tools = new FoodTools({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter });
  const menu = await tools.run("get_menu", { merchant_id: `cat:${NOM}` }, {});
  assert.ok(JSON.stringify(menu.data).includes("Bún Cá") && JSON.stringify(menu.data).includes("45000")); // the AI's tools read the same catalog
  assert.deepEqual(events("MENU_IMPORT_PUBLISHED").map((e) => [e.merchantId, e.by]), [[NOM, "founder"]]);
});

test("PRICE: a new price for a dish the merchant sells changes it IN PLACE (no duplicate), audited before -> after, one merchant only", async () => {
  const { p, say, events, product } = platform();
  const before = product(ATIEU, "HỦ TIẾU XÀO BÒ");
  assert.equal(before.length, 1);
  const nomBefore = JSON.stringify(p.services.menu.listProducts(NOM, { includeUnavailable: true }));
  const imp = p.services.menuImport.importText(ATIEU, "Cập nhật giá Hủ Tiếu Xào Bò 70.000đ", { createdBy: "founder" });
  const line = imp.draft.categories[0].products[0];
  assert.deepEqual([line.name, line.price, line.existing_product_id, line.previous_price], ["Hủ Tiếu Xào Bò", 70000, before[0].id, before[0].price]); // the reviewer sees it is an UPDATE
  p.services.menuImport.approveImport(ATIEU, imp.id, { by: "founder" });
  p.services.menuImport.publishImport(ATIEU, imp.id, { by: "founder" });
  const after = product(ATIEU, "HỦ TIẾU XÀO BÒ");
  assert.deepEqual([after.length, after[0].id, after[0].price, after[0].available], [1, before[0].id, 70000, before[0].available]);
  assert.deepEqual(events("MENU_IMPORT_PUBLISHED").at(-1).priceChanges, [{ productId: before[0].id, name: "Hủ Tiếu Xào Bò", before: before[0].price, after: 70000 }]);
  assert.equal(JSON.stringify(p.services.menu.listProducts(NOM, { includeUnavailable: true })), nomBefore); // no other merchant touched
  await say("Menu A Tiểu");
  assert.match(await say("hủ tiếu xào bò giá bao nhiêu"), /70\.000/);
  // a dish that is NOT the same name (accents respected) is a new dish, never an update of "Bò"
  const other = p.services.menuImport.importText(ATIEU, "Hủ Tiếu Xào Bơ 50k", { createdBy: "founder" });
  assert.equal(other.draft.categories[0].products[0].existing_product_id, null);
});

test("IMAGE: vision output is a PROPOSAL — low confidence / missing price needs review; approval is blocked until a person fixes it", async () => {
  const { p, product } = platform();
  p.visionProvider.result = { categories: [{ name: "Món nước", confidence: 0.9, products: [{ name: "Bún cá sứa", price: 55000, description: null, confidence: 0.95 }, { name: "Bánh canh", price: null, description: null, confidence: 0.4 }] }] };
  const imp = await p.services.menuImport.importImage(NOM, { buffer: JPEG, mimeType: "image/jpeg" }, { createdBy: "founder" });
  assert.equal(imp.status, "REVIEW_REQUIRED");
  assert.throws(() => p.services.menuImport.approveImport(NOM, imp.id, { by: "founder" }), /need review/);
  const fixed = structuredClone(imp.draft);
  fixed.categories[0].products[1].price = 40000;
  assert.equal(p.services.menuImport.reviewImport(NOM, imp.id, fixed).status, "DRAFT");
  p.services.menuImport.approveImport(NOM, imp.id, { by: "founder" });
  p.services.menuImport.publishImport(NOM, imp.id, { by: "founder" });
  assert.deepEqual([product(NOM, "Bún cá sứa")[0]?.price, product(NOM, "Bánh canh")[0]?.price], [55000, 40000]);
  // a failing vision call leaves a FAILED import and changes nothing
  p.visionProvider.result = null;
  p.visionProvider.failWith = Object.assign(new Error("boom"), { code: "VISION_PROVIDER_ERROR" });
  const failed = await p.services.menuImport.importImage(NOM, { buffer: JPEG, mimeType: "image/jpeg" }, { createdBy: "founder" });
  assert.equal(failed.status, "FAILED");
});

test("ADDRESS: a person updates ONE merchant's address (audited); an AI actor is refused; customers get that address", async () => {
  const { p, say, events } = platform();
  assert.throws(() => p.services.merchants.updateAddress(ATIEU, "86 Lạc Long Quân, Nha Trang", { by: "ai:gpt" }), /named person/);
  assert.throws(() => p.services.merchants.updateAddress(ATIEU, "x", { by: "founder" }), /too short/);
  p.services.merchants.updateAddress(ATIEU, "86 Lạc Long Quân, Nha Trang", { by: "founder" });
  assert.equal(p.repos.merchants.getById(ATIEU).address, "86 Lạc Long Quân, Nha Trang");
  assert.notEqual(p.repos.merchants.getById(NOM).address, "86 Lạc Long Quân, Nha Trang"); // scoped
  assert.deepEqual(events("MERCHANT_ADDRESS_UPDATED").map((e) => [e.merchantId, e.after, e.by]), [[ATIEU, "86 Lạc Long Quân, Nha Trang", "founder"]]);
  await say("Menu A Tiểu");
  assert.match(await say("quán ở đâu"), /86 Lạc Long Quân/);
});

test("SEPARATION: publishing the catalog never writes Food Knowledge; Food Knowledge never becomes orderable", async () => {
  const { p, kb, say } = platform();
  const sha = () => crypto.createHash("sha256").update(fs.readFileSync(kb)).digest("hex");
  const before = sha();
  const imp = p.services.menuImport.importText(NOM, "Bánh căn 30k", { createdBy: "founder" });
  p.services.menuImport.approveImport(NOM, imp.id, { by: "founder" });
  p.services.menuImport.publishImport(NOM, imp.id, { by: "founder" });
  assert.equal(sha(), before);
  const reply = await say("tìm bánh căn");
  assert.match(reply, /NÔM NÔM/i); // the catalog dish is orderable at Nôm Nôm
  assert.match(reply, /Tham khảo thêm \(chưa đặt qua FOOD được\)[\s\S]*Bánh căn Cô Tư/); // reference places stay reference
});

test("CLI: import-text -> show -> approve -> publish -> set-address on a temp DB; AI actors refused", () => {
  const dbFile = path.join(os.tmpdir(), `menu-cli-${crypto.randomUUID()}.db`);
  const db = createPlatformConnection(dbFile);
  runPlatformMigrations(db);
  runPlatformSeed(db, { atieuEngine: "generic" });
  db.close();
  const cli = (...a) => execFileSync(process.execPath, ["platform/scripts/menu.js", ...a, "--db", dbFile], { cwd: REPO, encoding: "utf8", env: { ...process.env, OPENAI_ENABLED: "false" } });
  assert.match(cli("merchants"), /ATIEU001/);
  const created = cli("import-text", "ATIEU001", "--by", "founder", "--text", "Thêm món Bún Cá 45k");
  const id = created.match(/#(\d+)/)[1];
  assert.match(created, /DRAFT[\s\S]*Bún Cá: 45\.000đ/);
  assert.throws(() => cli("approve", "ATIEU001", id, "--by", "ai:gpt"), /Command failed/);
  assert.match(cli("approve", "ATIEU001", id, "--by", "founder"), /APPROVED/);
  assert.match(cli("publish", "ATIEU001", id, "--by", "founder"), /PUBLISHED/);
  assert.match(cli("set-address", "ATIEU001", "--by", "founder", "--address", "86 Lạc Long Quân, Nha Trang"), /86 Lạc Long Quân/);
  const check = createPlatformConnection(dbFile);
  try {
    assert.equal(check.prepare(`SELECT price FROM merchant_products WHERE merchant_id = 'ATIEU001' AND name = 'Bún Cá'`).get().price, 45000);
  } finally {
    check.close();
  }
});

test("OPENAI VISION provider: sends the image as input_image with a strict schema, parses the proposal, never leaks key or body", async () => {
  const calls = [];
  const ok = new OpenAIMenuVisionProvider({
    apiKey: "sk-test-not-real",
    model: "test-vision-model",
    baseUrl: "https://example.invalid/v1",
    fetchImpl: async (url, req) => {
      calls.push({ url, req, body: JSON.parse(req.body) });
      return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ categories: [{ name: null, confidence: null, products: [{ name: "Bún cá", price: 45000, description: null, confidence: 0.9 }] }] }) }] }] }) };
    },
  });
  const out = await ok.parseImage(JPEG, "image/jpeg");
  assert.deepEqual(out.categories[0].products[0], { name: "Bún cá", price: 45000, description: null, confidence: 0.9 });
  const { body, url, req } = calls[0];
  assert.equal(url, "https://example.invalid/v1/responses");
  assert.equal(req.headers.authorization, "Bearer sk-test-not-real");
  assert.deepEqual([body.model, body.store, body.text.format.type, body.text.format.strict], ["test-vision-model", false, "json_schema", true]);
  assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  const bad = new OpenAIMenuVisionProvider({ apiKey: "sk-test-not-real", model: "m", baseUrl: "https://example.invalid/v1", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "invalid key sk-test-not-real" }) });
  await assert.rejects(() => bad.parseImage(JPEG, "image/jpeg"), (err) => err.code === "VISION_PROVIDER_ERROR" && !/sk-test|invalid key/.test(err.message));
  await assert.rejects(() => new OpenAIMenuVisionProvider({ apiKey: "", model: "m" }).parseImage(JPEG, "image/jpeg"), (err) => err.code === "VISION_PROVIDER_NOT_CONFIGURED");
});
