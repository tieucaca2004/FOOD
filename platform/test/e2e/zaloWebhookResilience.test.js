// The Zalo webhook controller itself is frozen; these cover the resilience
// supplied around it (app-level async error routing, shared analytics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function zaloMessage(zaloUserId, msgId, text = "Tôi muốn ăn hủ tiếu xào") {
  return JSON.stringify({ event_name: "user_send_text", sender: { id: zaloUserId }, message: { text, msg_id: msgId }, timestamp: Date.now() });
}

// Runs the app without an unhandledRejection handler (like platform/server.js);
// the idempotency reserve() fails once, then recovers.
const CHILD_SCRIPT = `
const { buildTestPlatform, startServer } = await import(process.env.HELPER_URL);
const { platformConfig } = await import(process.env.CONFIG_URL);
const platform = buildTestPlatform({ withAtieu: true });
const repo = platform.repos.webhookEvents;
const reserve = repo.reserve.bind(repo);
let failuresLeft = 1;
repo.reserve = (...args) => {
  if (failuresLeft-- > 0) throw new Error("SQLITE_BUSY: database is locked");
  return reserve(...args);
};
const server = await startServer(platform.app);
process.send({ port: server.address().port, path: platformConfig.webhookPath });
`;

test("a Zalo idempotency-store failure returns a controlled 500 and the server keeps serving", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-resilience-"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    cwd,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      HELPER_URL: pathToFileURL(path.join(REPO_ROOT, "platform/test/helpers/testPlatform.js")).href,
      CONFIG_URL: pathToFileURL(path.join(REPO_ROOT, "platform/config.js")).href,
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  try {
    const { port, path: hookPath } = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("exit", (code) => reject(new Error(`child exited early (${code}): ${stderr}`)));
    });
    const post = (body) =>
      fetch(`http://127.0.0.1:${port}${hookPath}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });

    const failed = await post(zaloMessage("zalo-resilience-1", "zr-1"));
    const failedText = await failed.text();
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failedText), { status: "error", error: "internal_error" });
    assert.ok(!failedText.includes("SQLITE"));
    assert.ok(child.exitCode === null && child.signalCode === null, `server died: ${stderr}`);

    const next = await post(zaloMessage("zalo-resilience-1", "zr-2"));
    assert.equal(next.status, 200);
    assert.equal((await next.json()).status, "processed");
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a funnel-analytics failure on Zalo still processes the message and still sends the reply", async () => {
  const platform = buildTestPlatform({ withAtieu: true });
  const server = await startServer(platform.app);
  platform.repos.analytics.logSearch = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  try {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: zaloMessage("zalo-analytics-1", "za-1"),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "processed");
    assert.match(body.reply_text, /HỦ TIẾU XÀO A TIỂU/);
    // The send step ran: with no platform Zalo token configured it reports exactly this.
    assert.equal(body.respond_error, "PLATFORM_ZALO_OA_ACCESS_TOKEN not configured");
  } finally {
    server.close();
  }
});
