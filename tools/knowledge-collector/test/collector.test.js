// Knowledge collector — robots, fetch/raw storage, access control, query
// generation, official search API, OSM/Wikipedia/official extraction, linking.
// Network is ALWAYS faked; fixtures are made-up texts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseRobots, isAllowed, RobotsCache } from "../lib/robots.js";
import { RawFetcher, AGENT_TOKEN } from "../lib/fetcher.js";
import { generateQueries, loadRegion } from "../lib/queryGenerator.js";
import { GoogleProgrammableSearch } from "../lib/searchProviders.js";
import { parseOpeningHours } from "../extract/openingHours.js";
import { proposalsFromSentence, aliasesFromSentence, splitSentences } from "../extract/foodFacts.js";
import { planLinks } from "../extract/foodLinker.js";
import { buildOverpassQuery, selectPilot } from "../sources/osm.js";
import { parseArticle, isFoodArticle } from "../sources/wikipedia.js";
import { FoodTaxonomy } from "../../../platform/knowledge/taxonomy.js";
import { FoodVocabulary } from "../../../platform/knowledge/vocabulary.js";
import { fakeNetwork, noWait } from "./helpers.js";
import { DEFAULTS } from "../pipeline.js";

const vocabulary = new FoodVocabulary(undefined, new FoodTaxonomy());
const tmp = () => {
  const dir = path.join(os.tmpdir(), `collector-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// --- robots.txt ------------------------------------------------------------------------

test("ROBOTS: groups, longest match, Allow over Disallow on ties, wildcards", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /w/\nDisallow: /api/\nAllow: /w/load.php\nDisallow: /*.pdf$\n\nUser-agent: BadBot\nDisallow: /`);
  assert.equal(isAllowed(groups, AGENT_TOKEN, "/wiki/B%C3%A1nh_c%C4%83n"), true);
  assert.equal(isAllowed(groups, AGENT_TOKEN, "/w/api.php?action=query"), false);
  assert.equal(isAllowed(groups, AGENT_TOKEN, "/w/load.php?x=1"), true);
  assert.equal(isAllowed(groups, AGENT_TOKEN, "/menu.pdf"), false);
  assert.equal(isAllowed(groups, AGENT_TOKEN, "/menu.pdf?x"), true);
  assert.equal(isAllowed(groups, "badbot/1.0", "/wiki/x"), false);
  assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow:"), AGENT_TOKEN, "/anything"), true);
});

test("ROBOTS: missing robots.txt allows; an unreachable or failing one denies", async () => {
  const net = fakeNetwork({ "https://ok.example/robots.txt": { status: 404, body: "" }, "https://down.example/robots.txt": { status: 503, body: "" }, "https://err.example/robots.txt": new Error("ECONNRESET") });
  const robots = new RobotsCache({ fetchImpl: net.fetchImpl, userAgent: "x", agentToken: AGENT_TOKEN });
  assert.equal((await robots.allowed("https://ok.example/a")).allowed, true);
  assert.equal((await robots.allowed("https://down.example/a")).allowed, false);
  assert.equal((await robots.allowed("https://err.example/a")).allowed, false);
});

// --- fetcher ------------------------------------------------------------------------------

test("FETCH: a successful page is stored as an immutable raw snapshot with metadata and a crawl log", async () => {
  const repo = tmp();
  const net = fakeNetwork({ "https://site.example/robots.txt": { body: "User-agent: *\nDisallow: /private" }, "https://site.example/menu": { body: "<p>Bún cá - 45.000đ</p>" } });
  const f = new RawFetcher({ rawRoot: path.join(repo, "data/raw"), repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait, now: () => new Date("2026-09-25T01:02:03Z") });
  const r = await f.fetch("https://site.example/menu", { sourceType: "merchant_official" });
  assert.equal(r.ok, true);
  assert.match(r.rawPath, /^data\/raw\/merchant_official\/site\.example\/2026-09-25\/[0-9a-f]{64}\.html$/);
  assert.equal(fs.readFileSync(path.join(repo, r.rawPath), "utf8"), "<p>Bún cá - 45.000đ</p>");
  const meta = JSON.parse(fs.readFileSync(path.join(repo, `${r.rawPath}.meta.json`), "utf8"));
  assert.equal(meta.url, "https://site.example/menu");
  assert.equal(meta.fetchedAt, "2026-09-25T01:02:03.000Z");
  assert.equal(meta.sha256, r.sha256);
  assert.ok(fs.readFileSync(path.join(repo, "data/raw/_crawl-log.jsonl"), "utf8").includes('"stored"'));
  // robots-disallowed: refused before any request to the page
  const denied = await f.fetch("https://site.example/private/x", { sourceType: "merchant_official" });
  assert.equal(denied.blocked, "robots");
  assert.ok(!net.calls.some((c) => c.url === "https://site.example/private/x"));
});

test("ACCESS CONTROL: login walls, CAPTCHAs, 401/403/429 and search result pages are never stored", async () => {
  const repo = tmp();
  const net = fakeNetwork({
    "https://a.example/page": { status: 403, body: "Forbidden" },
    "https://b.example/page": { body: '<div class="g-recaptcha"></div>' },
    "https://c.example/page": { body: "<form>", finalUrl: "https://c.example/login?next=/page" },
    "https://d.example/page": { status: 429, body: "slow down" },
  });
  const f = new RawFetcher({ rawRoot: path.join(repo, "data/raw"), repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait });
  assert.equal((await f.fetch("https://a.example/page", { sourceType: "directory" })).blocked, "access_control");
  assert.equal((await f.fetch("https://b.example/page", { sourceType: "directory" })).blocked, "captcha_or_login");
  assert.equal((await f.fetch("https://c.example/page", { sourceType: "directory" })).blocked, "access_control");
  assert.equal((await f.fetch("https://d.example/page", { sourceType: "directory" })).blocked, "access_control");
  const google = await f.fetch("https://www.google.com/search?q=b%C3%BAn+c%C3%A1+nha+trang", { sourceType: "other" });
  assert.equal(google.blocked, "search_engine_results");
  assert.ok(!net.calls.some((c) => c.url.includes("google.com")), "not even robots.txt is requested");
  const stored = fs.existsSync(path.join(repo, "data/raw")) ? fs.readdirSync(path.join(repo, "data/raw")).filter((f2) => f2 !== "_crawl-log.jsonl") : [];
  assert.deepEqual(stored, []);
});

test("ACCESS CONTROL: the word 'captcha' in a page's config is not a wall (real Wikipedia articles carry it)", async () => {
  const repo = tmp();
  const page = `<html><script>RLCONF={"wgConfirmEditCaptchaNeededForGenericEdit":"hcaptcha"};</script><h1 id="firstHeading">Bánh căn</h1><p>Bánh căn là món bánh.</p></html>`;
  const net = fakeNetwork({ "https://wiki.example/robots.txt": { status: 404, body: "" }, "https://wiki.example/wiki/Banh_can": { body: page }, "https://w2.example/p": { body: '<script src="https://hcaptcha.com/1/api.js"></script>' } });
  const f = new RawFetcher({ rawRoot: path.join(repo, "data/raw"), repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait });
  assert.equal((await f.fetch("https://wiki.example/wiki/Banh_can", { sourceType: "encyclopedia" })).ok, true);
  assert.equal((await f.fetch("https://w2.example/p", { sourceType: "directory" })).blocked, "captcha_or_login");
});

test("REUSE: within the window a stored page (or a known 404) is served from the raw store — no request; outside it, fetched again", async () => {
  const repo = tmp();
  const rawRoot = path.join(repo, "data/raw");
  let clock = new Date("2026-09-26T00:00:00Z");
  const net = fakeNetwork({ "https://r.example/robots.txt": { status: 404, body: "" }, "https://r.example/a": { body: "<p>Bún cá</p>" }, "https://r.example/gone": { status: 404, body: "nope" } });
  const first = new RawFetcher({ rawRoot, repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait, now: () => clock });
  const a1 = await first.fetch("https://r.example/a", { sourceType: "blog" });
  await first.fetch("https://r.example/gone", { sourceType: "blog" });
  const calls = net.calls.length;
  clock = new Date("2026-09-28T00:00:00Z");
  const second = new RawFetcher({ rawRoot, repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait, now: () => clock, reuseWithinDays: 7 });
  const a2 = await second.fetch("https://r.example/a", { sourceType: "blog" });
  const g2 = await second.fetch("https://r.example/gone", { sourceType: "blog" });
  assert.equal(net.calls.length, calls); // nothing requested
  assert.deepEqual([a2.ok, a2.cached, a2.rawPath, a2.fetchedAt, a2.content], [true, true, a1.rawPath, a1.fetchedAt, "<p>Bún cá</p>"]);
  assert.deepEqual([g2.ok, g2.status, g2.cached], [false, 404, true]);
  clock = new Date("2026-10-20T00:00:00Z"); // older than the window -> a new observation
  const third = new RawFetcher({ rawRoot, repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait, now: () => clock, reuseWithinDays: 7 });
  const a3 = await third.fetch("https://r.example/a", { sourceType: "blog" });
  assert.equal(a3.cached, undefined);
  assert.ok(net.calls.length > calls);
});

test("NETWORK: a body that times out after the headers is a failed fetch (logged, nothing stored), not a crash", async () => {
  const repo = tmp();
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/robots.txt")) return new Response("", { status: 404 });
    const res = new Response(new ReadableStream({ start(c) { c.error(new DOMException("The operation was aborted due to timeout", "TimeoutError")); } }), { status: 200, headers: { "content-type": "text/html" } });
    return res;
  };
  const f = new RawFetcher({ rawRoot: path.join(repo, "data/raw"), repoRoot: repo, fetchImpl, wait: noWait });
  const r = await f.fetch("https://slow.example/page", { sourceType: "encyclopedia" });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, "network");
  const stored = fs.readdirSync(path.join(repo, "data/raw")).filter((x) => x !== "_crawl-log.jsonl");
  assert.deepEqual(stored, []);
});

test("ACCESS CONTROL: invisible reCAPTCHA v3 for a site's own forms is not a wall; a challenge widget still is", async () => {
  const repo = tmp();
  const article = '<script src="https://www.google.com/recaptcha/api.js?render=6LfoG_cUAAAAAP3sCnZjMMk2eNrlZfD5c0o3yn31&amp;ver=3.0"></script><h2>1. Quán A</h2><p>Địa chỉ: 1 Trần Phú</p>';
  const net = fakeNetwork({
    "https://v3.example/robots.txt": { status: 404, body: "" },
    "https://v3.example/a": { body: article },
    "https://v3.example/b": { body: '<script src="https://www.google.com/recaptcha/api.js?render=explicit"></script><div class="g-recaptcha"></div>' },
    "https://v3.example/c": { body: '<script src="https://www.google.com/recaptcha/api.js"></script>' },
  });
  const f = new RawFetcher({ rawRoot: path.join(repo, "data/raw"), repoRoot: repo, fetchImpl: net.fetchImpl, wait: noWait });
  assert.equal((await f.fetch("https://v3.example/a", { sourceType: "blog" })).ok, true);
  assert.equal((await f.fetch("https://v3.example/b", { sourceType: "blog" })).blocked, "captcha_or_login");
  assert.equal((await f.fetch("https://v3.example/c", { sourceType: "blog" })).blocked, "captcha_or_login");
});

test("POLITENESS: requests to the same host are spaced out", async () => {
  const repo = tmp();
  const waits = [];
  let clock = 0;
  const net = fakeNetwork({ "https://s.example/1": { body: "a" }, "https://s.example/2": { body: "b" } });
  const f = new RawFetcher({ rawRoot: path.join(repo, "raw"), repoRoot: repo, fetchImpl: net.fetchImpl, minIntervalMs: 2000, now: () => new Date(clock), wait: async (ms) => { waits.push(ms); clock += ms; } });
  await f.fetch("https://s.example/1", { sourceType: "other" });
  await f.fetch("https://s.example/2", { sourceType: "other" });
  assert.deepEqual(waits, [2000]);
});

// --- discovery queries --------------------------------------------------------------------------

test("QUERIES: food, cuisine, location and menu groups generated from the region config", () => {
  const region = loadRegion(DEFAULTS.region);
  const q = generateQueries(region, { merchantNames: ["Quán Mẫu"] });
  const texts = q.map((x) => x.text);
  for (const t of ["món ngon Nha Trang", "đặc sản Nha Trang", "bún cá Nha Trang", "bánh căn Nha Trang", "quán Trung Hoa Nha Trang", "quán chay Nha Trang", "quán ăn Trần Phú Nha Trang", "quán ăn Vĩnh Hải Nha Trang", "Quán Mẫu menu", "Quán Mẫu thực đơn", "Quán Mẫu bảng giá"]) {
    assert.ok(texts.includes(t), t);
  }
  assert.equal(new Set(texts).size, texts.length);
  // another region is just another config
  const other = generateQueries({ name: "Cam Ranh", search_names: ["Cam Ranh"], foods: ["bún cá"], cuisines: ["hải sản"], streets: ["Nguyễn Trọng Kỷ"] });
  assert.deepEqual(other.map((x) => x.text).slice(0, 4), ["món ngon Cam Ranh", "đặc sản Cam Ranh", "quán ăn Cam Ranh", "bún cá Cam Ranh"]);
});

test("SEARCH: only the official API — skipped without a key, never a result page", async () => {
  const net = fakeNetwork({});
  const none = new GoogleProgrammableSearch({ key: "", cx: "", fetchImpl: net.fetchImpl });
  assert.deepEqual(await none.search("bún cá Nha Trang"), { skipped: "NO_API_KEY" });
  assert.equal(net.calls.length, 0);
  const api = new GoogleProgrammableSearch({ key: "k", cx: "c", fetchImpl: net.fetchImpl });
  await api.search("bún cá Nha Trang");
  assert.match(net.calls[0].url, /^https:\/\/www\.googleapis\.com\/customsearch\/v1\?/);
});

// --- OSM ------------------------------------------------------------------------------------------

test("OSM: bbox query for named food places; pilot selection is deterministic, richest first", () => {
  assert.match(buildOverpassQuery({ south: 12.17, west: 109.13, north: 12.32, east: 109.23 }), /amenity"~"\^\(restaurant\|fast_food\|cafe\|food_court\|ice_cream\)\$"\]\["name"\]\(12\.17,109\.13,12\.32,109\.23\)/);
  const els = [
    { type: "node", id: 3, tags: { name: "C" } },
    { type: "node", id: 1, tags: { name: "A", cuisine: "x", phone: "1" } },
    { type: "node", id: 2, tags: { amenity: "cafe" } }, // no name
    { type: "way", id: 9, tags: { name: "B", cuisine: "y" } },
  ];
  assert.deepEqual(selectPilot(els, 10).map((s) => s.el.tags.name), ["A", "B", "C"]);
  assert.deepEqual(selectPilot(els, 10).map((s) => s.index), [1, 3, 0]);
});

test("OPENING HOURS: simple OSM forms are structured; anything else stays text only", () => {
  assert.deepEqual(parseOpeningHours("Mo-Su 06:00-10:00").mo, [["06:00", "10:00"]]);
  const w = parseOpeningHours("Mo-Fr 07:00-21:00; Sa,Su 08:00-11:00,17:00-22:00");
  assert.deepEqual(w.fr, [["07:00", "21:00"]]);
  assert.deepEqual(w.su, [["08:00", "11:00"], ["17:00", "22:00"]]);
  assert.equal(parseOpeningHours("24/7").we[0][1], "24:00");
  assert.deepEqual(Object.keys(parseOpeningHours("06:00-22:00")), ["mo", "tu", "we", "th", "fr", "sa", "su"]);
  for (const t of ["Mo-Su 06:00-22:00; PH off", "sunrise-sunset", "Mo-Fr 7h-21h", "", "Jan-Mar Mo 10:00-12:00"]) assert.equal(parseOpeningHours(t), null, t);
});

// --- food facts from sentences ---------------------------------------------------------------------

const names = new Map([
  ["bun-cha-ca", ["Bún chả cá"]],
  ["banh-can", ["Bánh căn"]],
  ["banh-xeo", ["Bánh xèo"]],
  ["nem-nuong", ["Nem nướng"]],
]);
const facts = (sentence, entityKey) =>
  proposalsFromSentence({ sentence, entityKey, namesByEntity: names, vocabulary, regions: [{ id: "vn.khanh-hoa.nha-trang", name: "Nha Trang" }, { id: "vn.khanh-hoa", name: "Khánh Hòa" }] });

test("FOOD FACTS: a sentence naming exactly one dish yields proposals for that dish only", () => {
  const p = facts("Bún chả cá là món nước được ăn nóng vào buổi sáng, có chả cá chiên và hơi cay.", "bun-cha-ca");
  const keys = p.map((x) => `${x.kind}:${x.key}:${x.value ?? x.level}`);
  for (const k of ["facet:dish_form:soup_dish", "attribute:temperature.serving:hot", "attribute:taste.spicy:low", "ingredient:protein.seafood.fish_cake:unspecified", "facet:meal_period:breakfast"]) {
    assert.ok(keys.includes(k), k);
  }
  // "chả cá chiên": the frying belongs to the fish cake, not to the dish
  assert.ok(!keys.includes("facet:preparation:fry"));
  // "đặc sản" / "đặc biệt" are not the texture "đặc"
  assert.ok(!facts("Bún chả cá là đặc sản, bản đặc biệt có thêm chả.", "bun-cha-ca").some((x) => x.key === "texture.thick"));
  assert.deepEqual(facts("Bún chả cá là món nước.", "banh-can"), []); // another dish's sentence
  assert.deepEqual(facts("Khác với bánh xèo, bánh căn giòn ở đáy.", "banh-can"), []); // two dishes: skipped
});

test("FOOD FACTS: never from words inside the dish name; negation; ambiguity; regional specialty", () => {
  // "nướng" is part of "Nem nướng": not evidence of grilling
  assert.ok(!facts("Nem nướng là món ăn phổ biến.", "nem-nuong").some((x) => x.key === "preparation"));
  assert.ok(facts("Nem nướng được nướng trên than hồng.", "nem-nuong").some((x) => x.key === "preparation" && x.value === "grill"));
  // "cá" inside "Bún chả cá" is not an ingredient claim on its own
  assert.ok(!facts("Bún chả cá rất phổ biến.", "bun-cha-ca").some((x) => x.kind === "ingredient"));
  assert.ok(facts("Bún chả cá không cay.", "bun-cha-ca").some((x) => x.key === "taste.spicy" && x.level === "none"));
  assert.ok(!facts("Bún chả cá không có tôm.", "bun-cha-ca").some((x) => x.kind === "ingredient"));
  assert.ok(facts("Bún chả cá là đặc sản của Nha Trang.", "bun-cha-ca").some((x) => x.kind === "relation" && x.value === "vn.khanh-hoa.nha-trang"));
  assert.ok(!facts("Bún chả cá có ở Nha Trang.", "bun-cha-ca").some((x) => x.kind === "relation"));
  // out-of-scope "tính mát" never becomes a temperature
  assert.ok(!facts("Bún chả cá có tính mát.", "bun-cha-ca").some((x) => x.key === "temperature.serving"));
});

test("FOOD FACTS: only the dish's own clause counts; accompaniments are served_with, never the dish's taste", () => {
  // real pilot false positives, now refused
  const sour = facts("Bánh căn thường ít được dọn cùng rau sống ăn lá, mà thường ăn kèm với xoài xanh, khế chua, dưa leo băm sợi.", "banh-can");
  assert.ok(!sour.some((x) => x.key === "taste.sour"), "khế chua is the side's taste");
  const pho = new Map([...names, ["pho", ["Phở"]]]);
  const bold = proposalsFromSentence({ sentence: "Thịt dùng cho món phở là thịt bò hoặc thịt gà (gà ta luộc, xé thịt cho thịt ngọt đậm đà).", entityKey: "pho", namesByEntity: pho, vocabulary });
  assert.ok(!bold.some((x) => x.key === "taste.bold"), "the chicken's taste is not the dish's");
  assert.ok(bold.some((x) => x.kind === "ingredient" && x.key === "protein.beef"));
  // a plain ingredient list continues the dish's clause
  const list = facts("Bánh căn có nhân tôm, mực, trứng.", "banh-can").filter((x) => x.kind === "ingredient").map((x) => x.key);
  assert.deepEqual(list, ["protein.seafood.shrimp", "protein.seafood.squid", "protein.egg"]);
  // after "chấm / ăn kèm": accompaniments
  const side = facts("Bánh căn chấm nước mắm chua ngọt với xoài.", "banh-can");
  assert.ok(side.some((x) => x.kind === "ingredient" && x.key === "condiment.fish_sauce" && x.value === "served_with"));
  assert.ok(!side.some((x) => x.key === "taste.sour" || x.key === "taste.sweet"));
});

test("FOOD FACTS: real pilot false positives are refused (proper nouns, variants, components, regions, other subjects)", () => {
  const more = new Map([...names, ["banh-cuon", ["Bánh cuốn"]], ["pho", ["Phở"]], ["hoanh-thanh", ["Hoành thánh"]], ["bun-cha", ["Bún chả"]], ["nem-chua", ["Nem chua"]], ["lau", ["Lẩu"]], ["banh-xeo", ["Bánh xèo"]], ["nem-ran", ["Nem rán"]], ["xoi", ["Xôi"]]]);
  const f = (sentence, key) => proposalsFromSentence({ sentence, entityKey: key, namesByEntity: more, vocabulary });
  // "Thanh" in a place name is not the taste "thanh"; a regional variant is not the typical dish
  assert.deepEqual(f("Bánh cuốn Thanh Trì không có nhân, thường được xếp thành từng lớp.", "banh-cuon"), []);
  assert.deepEqual(f("Nổi tiếng nhất là nem chua Thanh Hóa.", "nem-chua"), []);
  assert.deepEqual(f("Thông thường thì phở miền Bắc đặc trưng bởi vị mặn còn miền Nam thì ngọt.", "pho"), []);
  // words glued to the name name a variant
  assert.deepEqual(f("Phở khô là món của vùng Tây Nguyên.", "pho"), []);
  assert.ok(!f("Nhiều chủ quán phở bò đóng cửa, tạo điều kiện cho phở gà phát triển.", "pho").some((x) => x.kind === "ingredient"));
  assert.ok(!f("Các món lẩu thường được đặt tên theo nguyên liệu chính, ví dụ lẩu nấm.", "lau").some((x) => x.key === "vegetable.mushroom"));
  // a taste after a component describes the component
  assert.ok(!f("Bún chả gồm bún, chả thịt lợn nướng và bát nước mắm chua cay mặn ngọt.", "bun-cha").some((x) => x.kind === "attribute"));
  assert.ok(!f("Xôi được làm bằng cách ngâm gạo nếp cho gạo mềm.", "xoi").some((x) => x.key === "texture.soft"));
  // another dish is the subject; other dishes listed
  assert.deepEqual(f("Bánh khoái là một loại bánh xèo, có bột gạo bên ngoài.", "banh-xeo"), []);
  assert.deepEqual(f("Ngoài nem rán truyền thống còn có một số loại nem rán khác như nem rán chay.", "nem-ran"), []);
  // "không quá dẻo" is not "not sticky"; "trứng gà" is egg, not chicken
  assert.ok(!f("Bánh cuốn dùng gạo không quá khô cũng không quá dẻo.", "banh-cuon").some((x) => x.level === "none"));
  assert.ok(!f("Bánh cuốn có trứng gà và hành.", "banh-cuon").some((x) => x.key === "protein.chicken"));
  // second audit round
  const cc = new Map([...more, ["cha-ca", ["Chả cá"]], ["banh-duc", ["Bánh đúc"]], ["bo-pia", ["Bò bía"]], ["canh-chua", ["Canh chua"]], ["sui-cao", ["Sủi cảo"]], ["bun-rieu-cua", ["Bún riêu cua"]]]);
  const g = (sentence, key) => proposalsFromSentence({ sentence, entityKey: key, namesByEntity: cc, vocabulary });
  assert.deepEqual(g("Ở Barbados, chả cá được làm từ cá tuyết muối và bột mì, sau đó chiên trong dầu.", "cha-ca"), []);
  assert.deepEqual(g("Cách nấu tương tự như bún riêu cua, riêng với phần ốc để ráo nước.", "bun-rieu-cua"), []);
  assert.ok(!g("Lời bình luận về món bánh đúc của nhà văn trong cuốn Miếng ngon Hà Nội.", "banh-duc").some((x) => x.value === "roll"));
  assert.ok(!g("Đối với loại bò bía ngọt, nguyên liệu gồm một thanh kẹo mạch nha.", "bo-pia").some((x) => x.key === "taste.light"));
  assert.ok(!g("Các tiệm phở còn bán thêm chén trứng chần và tiết canh.", "pho").some((x) => x.value === "canh"));
  assert.ok(!g("Chả cá phong cách châu Âu gồm cá phi lê chiên giòn.", "cha-ca").length);
  assert.ok(!g("Canh chua đôi khi chỉ là một tô nước luộc rau.", "canh-chua").some((x) => x.value === "boil"));
  assert.deepEqual(g("Sủi cảo sử dụng trứng thay cho bột được gọi là Sủi cảo trứng.", "sui-cao"), []);
  assert.ok(!g("Chả cá được nướng trên than, không để nóng quá hoặc nguội quá.", "cha-ca").some((x) => x.key === "temperature.serving"));
  // …while plain statements about the dish still work
  assert.ok(f("Bánh cuốn được tráng mỏng và hấp chín trong vài phút.", "banh-cuon").some((x) => x.key === "preparation" && x.value === "steam"));
  assert.ok(f("Nước dùng của phở được làm từ xương bò.", "pho").some((x) => x.key === "protein.beef"));
});

test("ALIASES and SENTENCES: stated alternative names; sentence splitting keeps verbatim text", () => {
  assert.deepEqual(splitSentences("Món của người Chăm.[1] Qua thời gian, món thay đổi."), ["Món của người Chăm.[1]", "Qua thời gian, món thay đổi."]);
  assert.deepEqual(aliasesFromSentence("Bánh căn, còn gọi là bánh khọt hay bánh căn Phan Rang, là món bánh."), ["bánh khọt", "bánh căn Phan Rang"]);
  assert.deepEqual(aliasesFromSentence("Bánh căn là món bánh."), []);
  const s = splitSentences("Bánh căn là món bánh. Nó được nướng trong khuôn đất! Ăn kèm nước chấm.");
  assert.deepEqual(s, ["Bánh căn là món bánh.", "Nó được nướng trong khuôn đất!", "Ăn kèm nước chấm."]);
});

test("WIKIPEDIA: parses the title and paragraphs; disambiguation pages are not articles", () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body><h1 id="firstHeading"><span class="mw-page-title-main">Bánh căn</span></h1>
  <div id="mw-content-text"><p><b>Bánh căn</b> là món bánh của <a href="/wiki/Nha_Trang">Nha Trang</a>.</p><p>Bánh được nướng trong khuôn.</p></div></body></html>`;
  const a = parseArticle(html);
  assert.equal(a.title, "Bánh căn");
  assert.deepEqual(a.paragraphs, ["Bánh căn là món bánh của Nha Trang.", "Bánh được nướng trong khuôn."]);
  assert.equal(parseArticle(html.replace("<div id=\"mw-content-text\">", '<div id="mw-content-text"><div id="disambigbox"></div>')), null);
  assert.equal(isFoodArticle(a), true);
  // "Sinh tố" redirects to the vitamin article: not a food
  assert.equal(isFoodArticle({ title: "Vitamin", paragraphs: ["Vitamin hay sinh tố là một hợp chất hữu cơ cần thiết với lượng nhỏ cho cơ thể."] }), false);
});

// --- linking --------------------------------------------------------------------------------------

test("LINKS: exact names link exactly; a dish inside a longer product name is only a variant candidate", () => {
  const foods = [
    { key: "bun-ca", names: ["bun ca"] },
    { key: "bun-sua", names: ["bun sua"] },
    { key: "bun", names: ["bun"] },
  ];
  const plan = planLinks(
    [
      { id: 1, normalized_name: "bun ca" },
      { id: 2, normalized_name: "bun ca dac biet" },
      { id: 3, normalized_name: "bun ca bun sua" },
      { id: 4, normalized_name: "tra da" },
    ],
    foods
  );
  assert.deepEqual(plan, [
    { kbProductId: 1, foodKey: "bun-ca", matchType: "exact" },
    { kbProductId: 2, foodKey: "bun-ca", matchType: "variant" },
    { kbProductId: 3, foodKey: "bun-ca", matchType: "variant" },
    { kbProductId: 3, foodKey: "bun-sua", matchType: "variant" },
  ]);
});
