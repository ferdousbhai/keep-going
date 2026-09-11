import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTINUATION_CAP,
  REVIEW_PROMPT,
  countContinuations,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
} from "../src/stop-review.mjs";
import * as bundled from "../plugins/stop-review/scripts/stop-review.mjs";

const stopResponse = "STOP";
const continueResponse = "CONTINUE";
const judgeResponse = "JUDGE";

const ENV_KEYS = [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_STOP_REVIEW_CLAUDE_BIN",
  "CODEX_STOP_REVIEW_CODEX_BIN",
  "CODEX_STOP_REVIEW_GHOST_BIN",
  "STOP_REVIEW_CLAUDE_BIN",
  "STOP_REVIEW_CLAUDE_MODEL",
  "STOP_REVIEW_CODEX_BIN",
  "STOP_REVIEW_CODEX_MODEL",
  "STOP_REVIEW_GHOST_BIN",
  "MOCK_CALL_LOG",
  "MOCK_REVIEW_RESPONSE",
  "STOP_REVIEW_AUDIT_LOG",
];

function environmentSnapshot() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function readCalls(callLog) {
  try {
    return (await readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function transcriptLine(payload, turnId) {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stop-review-test-"));
  const codexHome = path.join(root, "codex");
  const sessions = path.join(codexHome, "sessions", "2026", "08", "26");
  const transcript = path.join(sessions, "rollout.jsonl");
  const turnId = "turn-test";
  const modelMock = path.join(root, "mock-codex.mjs");
  const callLog = path.join(root, "calls.jsonl");

  await mkdir(sessions, { recursive: true });
  await writeFile(
    transcript,
    [
      transcriptLine(
        { role: "user", content: [{ type: "input_text", text: "Please build the requested change." }] },
        "previous-turn",
      ),
      transcriptLine(
        { role: "assistant", content: [{ type: "output_text", text: "We agreed on the design." }] },
        "previous-turn",
      ),
      transcriptLine(
        {
          role: "user",
          content: [{
            type: "input_text",
            text: "<recommended_plugins>injected</recommended_plugins>\n<environment_context>injected</environment_context>",
          }],
        },
        turnId,
      ),
      transcriptLine(
        {
          role: "user",
          content: [{ type: "input_text", text: "Build it now. token=supersecretvalue" }],
        },
        turnId,
      ),
      transcriptLine(
        { role: "assistant", content: [{ type: "output_text", text: "Candidate final response." }] },
        turnId,
      ),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "CommandExecution",
            command: ["npm", "test", "--token", "supersecretvalue"],
            status: "completed",
            exit_code: 0,
          },
        },
      }),
    ].join("\n"),
  );

  await writeFile(
    modelMock,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const output = args[args.indexOf("--output-last-message") + 1];
const value = process.env.MOCK_REVIEW_RESPONSE;
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ model, args, prompt }) + "\\n");
writeFileSync(output, value);
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.CODEX_HOME = codexHome;
  process.env.STOP_REVIEW_CODEX_BIN = modelMock;
  process.env.STOP_REVIEW_CODEX_MODEL = "gpt-5.6-luna";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.STOP_REVIEW_AUDIT_LOG = path.join(root, "audit.jsonl");

  return {
    input: {
      session_id: "session-test",
      transcript_path: transcript,
      turn_id: turnId,
      stop_hook_active: false,
      last_assistant_message: "Candidate final response.",
    },
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function claudeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "claude-stop-review-test-"));
  const claudeHome = path.join(root, "claude");
  const projects = path.join(claudeHome, "projects", "-tmp-project");
  const transcript = path.join(projects, "session-test.jsonl");
  const modelMock = path.join(root, "mock-claude.mjs");
  const callLog = path.join(root, "calls.jsonl");

  await mkdir(projects, { recursive: true });
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Earlier context." },
        origin: { kind: "human" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Build it now. token=supersecretvalue" },
        origin: { kind: "human" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: "deploy --token supersecretvalue" },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "secret result supersecretvalue" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Candidate final response." }] },
      }),
    ].join("\n"),
  );

  await writeFile(
    modelMock,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const value = process.env.MOCK_REVIEW_RESPONSE;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ model, args, prompt }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "\\n" + value + "\\n" }));
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.STOP_REVIEW_CLAUDE_BIN = modelMock;
  process.env.STOP_REVIEW_CLAUDE_MODEL = "sonnet";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.STOP_REVIEW_AUDIT_LOG = path.join(root, "audit.jsonl");

  return {
    input: {
      session_id: "session-test",
      transcript_path: transcript,
      stop_hook_active: false,
      last_assistant_message: "Candidate final response.",
      background_tasks: [],
      session_crons: [],
    },
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function ghostFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ghost-stop-review-test-"));
  const modelMock = path.join(root, "mock-ghostd.mjs");
  const callLog = path.join(root, "calls.jsonl");
  const ghostHome = path.join(root, "ghosts", "casper");

  await mkdir(ghostHome, { recursive: true });
  await writeFile(
    modelMock,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input) }) + "\\n");
process.stdout.write(JSON.stringify({ text: process.env.MOCK_REVIEW_RESPONSE }));
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.STOP_REVIEW_GHOST_BIN = modelMock;
  process.env.MOCK_CALL_LOG = callLog;
  process.env.STOP_REVIEW_AUDIT_LOG = path.join(root, "audit.jsonl");

  return {
    input: {
      type: "session_stop",
      session_id: "session-test",
      ghost_name: "casper",
      ghost_home: ghostHome,
      owner_prompt: "Please finish the requested change.",
      runtime: "omp",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Candidate final response." }],
      }],
      last_assistant_message: {
        role: "assistant",
        content: [{ type: "text", text: "Candidate final response." }],
      },
      stop_hook_active: false,
    },
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Codex counting includes only hook prompts in the current turn", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    assert.equal(await countContinuations(context.input), 0);

    const additions = [
      transcriptLine({
        role: "user",
        content: [{ type: "input_text", text: '<hook_prompt hook_run_id="stop:1:/x">continue</hook_prompt>' }],
      }, context.input.turn_id),
      transcriptLine({
        role: "user",
        content: [{ type: "input_text", text: '<hook_prompt hook_run_id="stop:1:/x">continue</hook_prompt>' }],
      }, "previous-turn"),
      transcriptLine({
        role: "user",
        content: [{ type: "input_text", text: "please keep going" }],
      }, context.input.turn_id),
    ];
    const existing = await readFile(context.input.transcript_path, "utf8");
    await writeFile(context.input.transcript_path, `${existing}\n${additions.join("\n")}\n`);

    assert.equal(await countContinuations(context.input), 1);
  } finally {
    await context.cleanup();
  }
});

test("STOP accepts the stop", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = stopResponse;
    const output = await handleStop(context.input);
    assert.deepEqual(output, {});
    const calls = await context.calls();
    assert.deepEqual(calls.map((item) => item.model), ["gpt-5.6-luna"]);
    assert.ok(!calls[0].args.some((arg) => arg.includes("model_reasoning_effort")));
    assert.ok(!calls[0].args.includes("--output-schema"));
    assert.match(calls[0].prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(calls[0].prompt, /Build it now|supersecretvalue|tool_events|project_context/);
    const audit = JSON.parse((await readFile(process.env.STOP_REVIEW_AUDIT_LOG, "utf8")).trim());
    assert.equal(audit.verdict, "STOP");
    assert.equal(audit.rationale, "");
  } finally {
    await context.cleanup();
  }
});

test("last_assistant_message is reviewed when the transcript is unavailable", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = continueResponse;
    const output = await handleStop({ ...context.input, transcript_path: null });
    assert.deepEqual(output, { decision: "block", reason: "Please continue." });
    const [call] = await context.calls();
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
  } finally {
    await context.cleanup();
  }
});

test("invalid reviewer verdict fails open", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "JUDGE_ADVISOR";
    const output = await handleStop(context.input);
    assert.match(output.systemMessage, /exactly CONTINUE, JUDGE, or STOP/);
  } finally {
    await context.cleanup();
  }
});

test("Claude counting starts at the last genuine prompt and counts only hook feedback", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    assert.equal(await countContinuations(context.input, "claude"), 0);

    const additions = [
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Do one more thing." }, origin: { kind: "human" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } }),
      JSON.stringify({
        type: "user",
        origin: { kind: "task-notification" },
        message: { role: "user", content: "Background task finished." },
      }),
    ];
    const existing = await readFile(context.input.transcript_path, "utf8");
    await writeFile(context.input.transcript_path, `${existing.trimEnd()}\n${additions.join("\n")}\n`);

    assert.equal(await countContinuations(context.input, "claude"), 1);
  } finally {
    await context.cleanup();
  }
});

test("Claude uses Sonnet with its default effort for classification", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = stopResponse;
    const output = await handleStop(context.input, "claude");
    assert.deepEqual(output, {});
    const [call] = await context.calls();
    assert.equal(call.model, "sonnet");
    assert.ok(!call.args.includes("--effort"));
    assert.ok(call.args.includes("--safe-mode"));
    assert.ok(call.args.includes("--no-session-persistence"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.ok(!call.args.includes("--json-schema"));
    assert.equal(call.args[call.args.indexOf("--max-turns") + 1], "1");
    assert.match(call.prompt, /Reply with exactly one word/);
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(call.prompt, /Build it now|supersecretvalue|tool_events|project_context/);
  } finally {
    await context.cleanup();
  }
});

test("Ghost delegates classification to its smol-model bridge", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = judgeResponse;
    const output = await handleStop(context.input, "ghost");
    assert.deepEqual(output, {
      decision: "block",
      reason: "Do not ask the user yet. Apply more reasoning or research to unblock yourself; only stop if genuinely blocked.",
    });
    const [call] = await context.calls();
    assert.deepEqual(call.args, ["hook-smol-complete"]);
    assert.equal(call.input.ghost_home, context.input.ghost_home);
    assert.match(call.input.prompt, /Reply with exactly one word/);
    assert.match(call.input.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(call.input.prompt, /Please finish the requested change/);
  } finally {
    await context.cleanup();
  }
});

test("verdict parsing accepts only the exact review enum", () => {
  for (const verdict of ["CONTINUE", "JUDGE", "STOP"]) {
    assert.equal(parseReviewVerdict(` ${verdict}\n`), verdict);
  }
  for (const invalid of ["continue", "CONSULT", "JUDGE_ADVISOR", "STOP now", "{}", "", null, undefined]) {
    assert.throws(() => parseReviewVerdict(invalid), /exactly CONTINUE, JUDGE, or STOP/);
  }
  assert.deepEqual(hookOutputForVerdict("CONTINUE"), { decision: "block", reason: "Please continue." });
  assert.deepEqual(hookOutputForVerdict("JUDGE"), {
    decision: "block",
    reason: "Do not ask the user yet. Apply more reasoning or research to unblock yourself; only stop if genuinely blocked.",
  });
  assert.deepEqual(hookOutputForVerdict("STOP"), {});
});

test("bundled plugin preserves the validated verdict protocol", () => {
  for (const verdict of ["CONTINUE", "JUDGE", "STOP"]) {
    assert.equal(bundled.parseReviewVerdict(verdict), verdict);
    assert.deepEqual(bundled.hookOutputForVerdict(verdict), hookOutputForVerdict(verdict));
  }
  assert.equal(bundled.REVIEW_PROMPT, REVIEW_PROMPT);
});

test("the shipped plugin bundles no runtime dependency", async () => {
  // v0.1.1 dropped Zod to keep the hook cheap to install and start. Nothing
  // else would notice a dependency reappearing: the CI drift check only proves
  // the bundle matches src, not that src stayed dependency-free.
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.dependencies ?? {}, {});

  const bundlePath = new URL("../plugins/stop-review/scripts/stop-review.mjs", import.meta.url);
  const bundle = await stat(bundlePath);
  assert.ok(bundle.size < 16 * 1024, `expected bundle below 16 KiB, received ${bundle.size} bytes`);

  const source = await readFile(bundlePath, "utf8");
  const bareImports = [...source.matchAll(/^\s*import[^\n]*?from\s+"([^"]+)"/gm)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."));
  assert.deepEqual(bareImports, [], `bundle imports a package: ${bareImports.join(", ")}`);
});

test("Claude stops unconditionally once the continuation cap is reached", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    assert.equal(CONTINUATION_CAP, 20);
    const feedback = Array.from({ length: CONTINUATION_CAP }, () =>
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } })
    );
    const existing = await readFile(context.input.transcript_path, "utf8");
    await writeFile(context.input.transcript_path, `${existing.trimEnd()}\n${feedback.join("\n")}\n`);
    process.env.MOCK_REVIEW_RESPONSE = continueResponse;
    const output = await handleStop(context.input, "claude");
    assert.match(output.systemMessage, /continuation cap \(20\) reached/);
    assert.equal((await context.calls()).length, 0);
  } finally {
    await context.cleanup();
  }
});

test("Codex stops unconditionally once the continuation cap is reached", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    const feedback = Array.from({ length: CONTINUATION_CAP }, () =>
      transcriptLine({ role: "user", content: [{ type: "input_text", text: '<hook_prompt hook_run_id="stop:1:/x">continue</hook_prompt>' }] }, context.input.turn_id)
    );
    const existing = await readFile(context.input.transcript_path, "utf8");
    await writeFile(context.input.transcript_path, `${existing.trimEnd()}\n${feedback.join("\n")}\n`);
    process.env.MOCK_REVIEW_RESPONSE = continueResponse;
    const output = await handleStop(context.input);
    assert.match(output.systemMessage, /continuation cap \(20\) reached/);
    assert.equal((await context.calls()).length, 0);
  } finally {
    await context.cleanup();
  }
});

test("verbose assistant passes cannot hide the Codex continuation cap", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    const records = [];
    for (let continuation = 0; continuation < CONTINUATION_CAP; continuation += 1) {
      records.push(transcriptLine({
        role: "user",
        content: [{
          type: "input_text",
          text: `<hook_prompt hook_run_id="stop:${continuation}:/x">continue</hook_prompt>`,
        }],
      }, context.input.turn_id));
      for (let update = 0; update < 4; update += 1) {
        records.push(transcriptLine({
          role: "assistant",
          content: [{ type: "output_text", text: `Update ${continuation}.${update}.` }],
        }, context.input.turn_id));
      }
    }
    const existing = await readFile(context.input.transcript_path, "utf8");
    await writeFile(context.input.transcript_path, `${existing.trimEnd()}\n${records.join("\n")}\n`);

    process.env.MOCK_REVIEW_RESPONSE = continueResponse;
    const output = await handleStop(context.input);
    assert.match(output.systemMessage, /continuation cap \(20\) reached/);
    assert.equal((await context.calls()).length, 0);
  } finally {
    await context.cleanup();
  }
});

function piLine(entry, id, parentId) {
  return JSON.stringify({ id, parentId, timestamp: "2026-08-28T00:00:00.000Z", ...entry });
}

async function piTranscriptFixture(context) {
  const sessionDir = path.join(context.input.ghost_home, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const transcript = path.join(sessionDir, "conv.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "conv", timestamp: "2026-08-28T00:00:00.000Z", cwd: "/tmp" }),
    piLine({ type: "message", message: { role: "user", content: [{ type: "text", text: "Earlier owner prompt." }] } }, "m1", null),
    piLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] } }, "m2", "m1"),
    // An abandoned branch that must not leak into the evidence.
    piLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch answer." }] } }, "m2b", "m1"),
    piLine({ type: "message", message: { role: "user", content: [{ type: "text", text: context.input.owner_prompt }] } }, "m3", "m2"),
    piLine({ type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/etc/passwd" } },
    ] } }, "m4", "m3"),
    piLine({ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "secret result supersecretvalue" }] } }, "m5", "m4"),
    piLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "First pass." }] } }, "m6", "m5"),
  ];
  lines.push(piLine({ type: "custom_message", customType: "session-stop-continuation", content: "continue", display: false, attribution: "agent" }, "c0", "m6"));
  lines.push(piLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Pass 2." }] } }, "p0", "c0"));
  await writeFile(transcript, `${lines.join("\n")}\n`);
  return transcript;
}

test("Ghost counts the current owner turn from its Pi transcript", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    const transcript = await piTranscriptFixture(context);
    const input = {
      ...context.input,
      conversation_runtime: "pi",
      transcript_path: transcript,
      last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Pass 2." }] },
    };
    assert.equal(await countContinuations(input, "ghost"), 1);

    process.env.MOCK_REVIEW_RESPONSE = continueResponse;
    const output = await handleStop(input, "ghost");
    assert.deepEqual(output, { decision: "block", reason: "Please continue." });
    const [call] = await context.calls();
    assert.match(call.input.prompt, /"last_assistant_message":"Pass 2\."/);
    assert.doesNotMatch(
      call.input.prompt,
      /Earlier owner prompt|First pass|supersecretvalue|Abandoned branch|private|\/etc\/passwd/,
    );
  } finally {
    await context.cleanup();
  }
});

test("Ghost rejects a transcript outside the ghost home and falls back without one", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    const outside = path.join(path.dirname(context.input.ghost_home), "outside.jsonl");
    await writeFile(outside, "");
    const output = await handleStop({ ...context.input, conversation_runtime: "pi", transcript_path: outside }, "ghost");
    assert.match(output.systemMessage, /outside the ghost transcript directories/);
    assert.equal((await context.calls()).length, 0);

    assert.equal(await countContinuations(context.input, "ghost"), 0);
    await assert.rejects(
      countContinuations({ ...context.input, owner_prompt: " " }, "ghost"),
      /missing owner_prompt/,
    );
  } finally {
    await context.cleanup();
  }
});

test("Ghost's Claude Code runtime anchors the turn on the owner prompt", { concurrency: false }, async () => {
  const context = await ghostFixture();
  const claudeHome = await mkdtemp(path.join(tmpdir(), "ghost-claude-home-"));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const projectDir = path.join(claudeHome, "projects", "-tmp-project");
    await mkdir(projectDir, { recursive: true });
    const transcript = path.join(projectDir, "sdk-session.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "Older prompt." } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Older answer." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: context.input.owner_prompt } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First pass." }] } }),
      // Ghost's Claude Code runtime re-prompts with a plain user message.
      JSON.stringify({ type: "user", message: { role: "user", content: "continue" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second pass." }] } }),
    ].join("\n"));
    assert.equal(await countContinuations({
      ...context.input,
      runtime: "claude-code",
      conversation_runtime: "claude-code",
      transcript_path: transcript,
      last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Second pass." }] },
    }, "ghost"), 1);
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(claudeHome, { recursive: true, force: true });
    await context.cleanup();
  }
});
