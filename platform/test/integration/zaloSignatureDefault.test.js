// The platform Zalo webhook is reachable through the public tunnel. Its
// signature check must fail closed: only an explicit
// PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK=false turns it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const CONFIG_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config.js")).href;

// Imports platform/config.js in a fresh process, from an empty working
// directory so no .env is loaded, with the variable set to `value`
// (undefined = not set at all).
function signatureCheckFor(value) {
  const env = { ...process.env };
  delete env.PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK;
  if (value !== undefined) env.PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK = value;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-sig-default-"));
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const { platformConfig } = await import(${JSON.stringify(CONFIG_URL)}); process.stdout.write(JSON.stringify(platformConfig.enableZaloSignatureCheck));`],
      { cwd, env, encoding: "utf8" }
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("signature checking is on when PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK is unset or empty", () => {
  assert.equal(signatureCheckFor(undefined), true);
  assert.equal(signatureCheckFor(""), true);
});

test("only an explicit false turns signature checking off", () => {
  assert.equal(signatureCheckFor("false"), false);
  assert.equal(signatureCheckFor(" FALSE "), false);
  for (const value of ["true", "1", "0", "no", "off", "flase"]) {
    assert.equal(signatureCheckFor(value), true, value);
  }
});

test("with the default configuration and no secret, a forged unsigned Zalo event is rejected and never processed", async () => {
  const saved = { check: platformConfig.enableZaloSignatureCheck, secret: platformConfig.zaloOaSecretKey };
  platformConfig.enableZaloSignatureCheck = signatureCheckFor(undefined);
  platformConfig.zaloOaSecretKey = "";
  const platform = buildTestPlatform({ withAtieu: true });
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: "forged-sender-1" }, message: { text: "hủ tiếu", msg_id: "forged-1" }, timestamp: Date.now() }),
    });
    assert.equal(res.status, 401);
    assert.equal(platform.repos.customers.findByZaloUserId("forged-sender-1"), undefined);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM platform_webhook_events").get().n, 0);
  } finally {
    server.close();
    platformConfig.enableZaloSignatureCheck = saved.check;
    platformConfig.zaloOaSecretKey = saved.secret;
  }
});
