// Optional end-to-end tests against an installed Pi 0.84.2+. All model calls
// go to a loopback fixture; no credentials or paid inference are used.
// Run: npm run test:pi (or KEEP_GOING_PI_BIN=/path/to/pi npm run test:pi).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONTINUATION_CAP } from "../src/keep-going.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function runPi(t, { cap = false, duplicate = false, verdict = "CONTINUE", reviewerModel } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "keep-going-pi-e2e-"));
  const agentDir = path.join(home, "agent");
  await mkdir(agentDir);
  let mainCalls = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const review = JSON.stringify(input.messages).includes("An agent just tried to end its turn.");
      requests.push({ input, review });
      let text;
      if (review) {
        text = cap || mainCalls === 1 ? `${verdict}\nFinish the calculation.` : "STOP";
      } else {
        mainCalls++;
        text = cap || mainCalls === 1 ? "I still need to calculate 2 + 2." : "2 + 2 = 4. Done.";
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => ({
        id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    fixture: {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "local-test-only",
      models: ["fixture", "reviewer"].map((id) => ({ id, reasoning: false, contextWindow: 128000, maxTokens: 4096 })),
    },
  } }));
  const args = ["--offline", "--print", "--no-session", "--no-extensions", "--extension", root,
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools",
    "--provider", "fixture", "--model", "fixture", "--thinking", "off"];
  if (duplicate) {
    const second = path.join(home, "second-copy.js");
    await copyFile(path.join(root, "extensions", "keep-going.js"), second);
    args.push("--extension", second);
  }
  args.push("Calculate 2 + 2.");
  const audit = path.join(home, "audit.jsonl");
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir,
    KEEP_GOING_AUDIT_LOG: audit, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  if (reviewerModel) env.KEEP_GOING_PI_MODEL = reviewerModel;
  else delete env.KEEP_GOING_PI_MODEL;
  const child = spawn(process.env.KEEP_GOING_PI_BIN || "pi", args, { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, stderr + stdout);
  const rows = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { mainCalls, requests, rows, stdout, stderr };
}

test("real Pi continues once, then stops; duplicate installs still review each response once", { timeout: 60_000 }, async (t) => {
  const result = await runPi(t, { duplicate: true });
  assert.equal(result.mainCalls, 2, result.stderr);
  assert.equal(result.requests.length, 4);
  assert.deepEqual(result.rows.map((row) => row.verdict), ["CONTINUE", "STOP"]);
  for (const { input } of result.requests.filter((r) => r.review)) {
    assert.equal(input.messages.length, 1);
    assert.equal(input.tools, undefined);
    assert.equal(input.model, "fixture");
  }
  const main = result.requests.filter((r) => !r.review);
  assert.match(JSON.stringify(main[1].input.messages), /Finish the calculation\./);
  assert.match(result.stdout, /2 \+ 2 = 4\. Done\./);
});

test("real Pi honors THINK and an explicit reviewer model", { timeout: 60_000 }, async (t) => {
  const result = await runPi(t, { verdict: "THINK", reviewerModel: "fixture/reviewer" });
  assert.equal(result.mainCalls, 2);
  assert.deepEqual(result.rows.map((row) => row.verdict), ["THINK", "STOP"]);
  for (const { input, review } of result.requests) {
    assert.equal(input.model, review ? "reviewer" : "fixture");
  }
});

test("real Pi accepts STOP and fails open on invalid reviewer output", { timeout: 60_000 }, async (t) => {
  for (const verdict of ["STOP", "INVALID"]) {
    const result = await runPi(t, { verdict });
    assert.equal(result.mainCalls, 1);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.rows.map((row) => row.verdict), [verdict === "STOP" ? "STOP" : "ERROR"]);
  }
});

test("real Pi stops at 100 continuations without calling the reviewer again", { timeout: 60_000 }, async (t) => {
  const result = await runPi(t, { cap: true });
  assert.equal(result.mainCalls, CONTINUATION_CAP + 1);
  assert.equal(result.requests.filter((r) => r.review).length, CONTINUATION_CAP);
  assert.equal(result.rows.length, CONTINUATION_CAP + 1);
  assert.equal(result.rows.at(-1).verdict, "CAP");
});
