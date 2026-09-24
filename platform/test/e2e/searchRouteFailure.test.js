// EDGE-001: the server runs in a child process with no unhandledRejection
// handler (like platform/server.js), so a rejection escaping the route would
// kill it rather than be masked by the test runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const CHILD_SCRIPT = `
const { buildTestPlatform, startServer } = await import(process.env.HELPER_URL);
const platform = buildTestPlatform({ withAtieu: false });
platform.discovery.searchByKeywords = async () => {
  throw new Error("SQLITE_IOERR: disk I/O error at /data/platform.db");
};
const server = await startServer(platform.app);
process.send({ port: server.address().port });
`;

async function startFailingSearchServer() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-edge001-"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    cwd,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, HELPER_URL: pathToFileURL(path.join(REPO_ROOT, "platform/test/helpers/testPlatform.js")).href },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const { port } = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`child exited early (${code}): ${stderr}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    diagnostics: () => stderr,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("EDGE-001: a discovery failure returns a controlled 500 and the server keeps serving", async () => {
  const srv = await startFailingSearchServer();
  try {
    const res = await fetch(`${srv.base}/api/platform/search?q=bo`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { status: "error", error: "internal_error" });
    assert.ok(!text.includes("SQLITE") && !text.includes("/data/"));

    assert.ok(srv.isAlive(), `server died: ${srv.diagnostics()}`);
    const health = await fetch(`${srv.base}/api/platform/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
  } finally {
    await srv.stop();
  }
});

test("EDGE-001: normal search behaviour is unchanged", async () => {
  const platform = buildTestPlatform({ withAtieu: true });
  const server = await startServer(platform.app);
  try {
    const missing = await fetch(`${baseUrl(server)}/api/platform/search`);
    assert.equal(missing.status, 400);
    const res = await fetch(`${baseUrl(server)}/api/platform/search?q=${encodeURIComponent("hủ tiếu xào")}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.organic.map((c) => c.merchant_id), ["ATIEU001"]);
  } finally {
    server.close();
  }
});
