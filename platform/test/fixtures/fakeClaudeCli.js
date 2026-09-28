// A stand-in for the `claude` executable (FORM 11 tests): reads the prompt from stdin like `claude -p` and answers in
// the same stream-json shape. The prompt's first word picks the behaviour; nothing here ever runs a shell.
import fs from "node:fs";
import path from "node:path";

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const mode = prompt.split(/\s/)[0];
  const init = (tools = []) => out({ type: "system", subtype: "init", tools, mcp_servers: [], model: "fake" });
  const result = (text) => out({ type: "result", subtype: "success", is_error: false, result: text });

  switch (mode) {
    case "HANG":
      fs.writeFileSync(path.join(process.cwd(), "hang.pid"), String(process.pid));
      setInterval(() => {}, 1000);
      return;
    case "EXIT3":
      process.stderr.write("fatal: something internal PLATFORM_TELEGRAM_BOT_TOKEN=leak\n");
      process.exit(3);
      return;
    case "TOOLS":
      init(["Bash", "Read"]);
      return result("I could run commands");
    case "BIG":
      init();
      return result("x".repeat(3 * 1024 * 1024));
    case "GARBAGE":
      process.stdout.write("not json at all\n");
      return;
    case "ERROR":
      init();
      return out({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    case "ARGS":
      init();
      return result(JSON.stringify({ argv: process.argv.slice(2), prompt }));
    case "ENV":
      init();
      return result(JSON.stringify(Object.keys(process.env)));
    case "SECRET":
      init();
      return result(`token is ${prompt.split(/\s/)[1]}`);
    case "LONG":
      init();
      return result("y".repeat(5000));
    default:
      init();
      return result(`echo: ${prompt}`);
  }
});

function out(ev) {
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}
