// A Tiểu's standalone app (npm start / Docker, port 3900) has no
// authentication on its REST API (order creation, order status changes,
// customer lookup) and listens on every interface. src/ is frozen, so its
// protection is the perimeter: the documented deployment must publish port
// 3900 on loopback only and expose nothing but the Zalo webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

test("the documented docker run publishes port 3900 on loopback only", () => {
  const commands = [...readme.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  const mappings = [...commands.matchAll(/(?:-p|--publish)[ =](\S+)/g)].map((m) => m[1]);
  assert.ok(mappings.length > 0, "README should document the docker run port mapping");
  for (const mapping of mappings) {
    if (!mapping.includes("3900")) continue;
    assert.match(mapping, /^127\.0\.0\.1:\d+:3900$/, `publishes on all interfaces: ${mapping}`);
  }
});

test("the documented reverse proxy forwards only the Zalo webhook path", () => {
  const proxied = [...readme.matchAll(/`https?:\/\/127\.0\.0\.1:3900(\/[^`]*)`/g)].map((m) => m[1]);
  assert.deepEqual(proxied, ["/zalo/webhook"]);
});

test("the README warns that the standalone REST API is unauthenticated and must stay local", () => {
  assert.match(readme, /REST API[^\n]*(KHÔNG|không) có xác thực/);
  assert.match(readme, /(Không|KHÔNG) (được )?expose port 3900/i);
});
