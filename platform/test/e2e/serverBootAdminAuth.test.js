// Boots the real platform/server.js (temp databases, a temp working directory
// so no developer .env is loaded, messaging credentials blanked) and checks
// the admin API's fail-closed behaviour and what startup logs say about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FAKE_ADMIN_TOKEN = "boot-test-admin-token-" + "c".repeat(40);

async function bootServer(adminToken, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "platform-boot-"));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "platform/server.js")], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PLATFORM_PORT: String(port),
      PLATFORM_SQLITE_PATH: path.join(cwd, "platform.db"),
      SQLITE_PATH: path.join(cwd, "atieu.db"),
      MENU_IMPORT_UPLOAD_DIR: path.join(cwd, "uploads"),
      PLATFORM_ADMIN_API_TOKEN: adminToken,
      PLATFORM_ZALO_OA_ACCESS_TOKEN: "",
      PLATFORM_TELEGRAM_BOT_TOKEN: "",
      ZALO_OA_ACCESS_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      PLATFORM_AI_PROVIDER: "null",
      AI_PROVIDER: "null",
      LOG_LEVEL: "info",
      PLATFORM_TRUST_PROXY: "",
      ...extraEnv,
    },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000);
    child.stdout.on("data", () => {
      if (output.includes("platform listening")) {
        clearTimeout(timer);
        // The admin-token warning is written right after the listening line.
        setTimeout(resolve, 100);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${output}`));
    });
  });
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    output: () => output,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("booted without PLATFORM_ADMIN_API_TOKEN, the server warns and the admin API refuses everything", async () => {
  const server = await bootServer("");
  try {
    assert.match(server.output(), /PLATFORM_ADMIN_API_TOKEN is not set/);
    const list = await fetch(server.url("/api/platform/merchants"));
    assert.equal(list.status, 503);
    const issue = await fetch(server.url("/api/platform/merchants/ATIEU001/api-keys"), { method: "POST", headers: { authorization: "Bearer " } });
    assert.equal(issue.status, 503);
    const health = await fetch(server.url("/api/platform/health"));
    assert.equal(health.status, 200);
  } finally {
    await server.stop();
  }
});

test("booted with a token, the admin API accepts it and the token never appears in the logs", async () => {
  const server = await bootServer(FAKE_ADMIN_TOKEN);
  try {
    const denied = await fetch(server.url("/api/platform/merchants"), { headers: { authorization: "Bearer wrong-token-value" } });
    assert.equal(denied.status, 401);
    const list = await fetch(server.url("/api/platform/merchants"), { headers: { authorization: `Bearer ${FAKE_ADMIN_TOKEN}` } });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.ok(body.merchants.some((m) => m.merchant_id === "ATIEU001"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(server.output(), /PLATFORM_ADMIN_API_TOKEN .*refuses every request/);
    assert.ok(!server.output().includes(FAKE_ADMIN_TOKEN.slice(22)), "admin token leaked into server output");
    assert.ok(!server.output().includes("wrong-token-value"), "presented token leaked into server output");
  } finally {
    await server.stop();
  }
});

test("booted with a PLATFORM_TRUST_PROXY that would trust any client, the server refuses it and says so", async () => {
  const server = await bootServer(FAKE_ADMIN_TOKEN, { PLATFORM_TRUST_PROXY: "true" });
  try {
    assert.match(server.output(), /PLATFORM_TRUST_PROXY was refused/);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await fetch(server.url("/api/platform/health"), { headers: { "x-forwarded-for": `203.0.113.${i}` } })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200]);
  } finally {
    await server.stop();
  }
});

test("booted with PLATFORM_TRUST_PROXY=loopback, there is no proxy warning", async () => {
  const server = await bootServer(FAKE_ADMIN_TOKEN, { PLATFORM_TRUST_PROXY: "loopback" });
  try {
    assert.doesNotMatch(server.output(), /PLATFORM_TRUST_PROXY was refused|no trusted proxy/);
  } finally {
    await server.stop();
  }
});
