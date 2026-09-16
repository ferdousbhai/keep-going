import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  CONTINUATION_CAP,
  VERDICTS,
  LAST_STRETCH,
  NUDGE_LIMIT,
  REVIEW_PROMPT,
  countContinuations,
  recordedContinuations,
  reviewPrompt,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
} from "../src/keep-going.mjs";


const ENV_KEYS = [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "KEEP_GOING_CLAUDE_BIN",
  "KEEP_GOING_CLAUDE_MODEL",
  "KEEP_GOING_CODEX_BIN",
  "KEEP_GOING_CODEX_MODEL",
  "KEEP_GOING_GHOST_BIN",
  "MOCK_CALL_LOG",
  "MOCK_REVIEW_RESPONSE",
  "MOCK_REVIEW_PAD",
  "KEEP_GOING_AUDIT_LOG",
  // The hook keeps its continuation tally under this root; every fixture gets
  // its own so a test run never reads or writes the developer's real one.
  "XDG_STATE_HOME",
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

async function appendRecords(file, records) {
  const existing = await readFile(file, "utf8");
  await writeFile(file, `${existing.trimEnd()}\n${records.join("\n")}\n`);
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
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-test-"));
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
  process.env.KEEP_GOING_CODEX_BIN = modelMock;
  process.env.KEEP_GOING_CODEX_MODEL = "gpt-5.6-luna";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");

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
  const root = await mkdtemp(path.join(tmpdir(), "claude-keep-going-test-"));
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
const pad = Number(process.env.MOCK_REVIEW_PAD || 0);
if (pad > 0) process.stdout.write("y".repeat(pad));
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.KEEP_GOING_CLAUDE_BIN = modelMock;
  process.env.KEEP_GOING_CLAUDE_MODEL = "sonnet";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");

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
  const root = await mkdtemp(path.join(tmpdir(), "ghost-keep-going-test-"));
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
  process.env.KEEP_GOING_GHOST_BIN = modelMock;
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");

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
    await appendRecords(context.input.transcript_path, additions);

    assert.equal(await countContinuations(context.input), 1);
  } finally {
    await context.cleanup();
  }
});

test("STOP accepts the stop", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const output = await handleStop(context.input);
    assert.deepEqual(output, {});
    const calls = await context.calls();
    assert.deepEqual(calls.map((item) => item.model), ["gpt-5.6-luna"]);
    assert.ok(!calls[0].args.some((arg) => arg.includes("model_reasoning_effort")));
    assert.ok(!calls[0].args.includes("--output-schema"));
    assert.match(calls[0].prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(calls[0].prompt, /Build it now|supersecretvalue|tool_events|project_context/);
    const audit = JSON.parse((await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8")).trim());
    assert.equal(audit.verdict, "STOP");
    assert.equal(audit.rationale, "");
  } finally {
    await context.cleanup();
  }
});

test("last_assistant_message is reviewed when the transcript is unavailable", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop({ ...context.input, transcript_path: null });
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[0] });
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
    assert.match(output.systemMessage, /begin with CONTINUE, JUDGE, or STOP/);
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
    await appendRecords(context.input.transcript_path, additions);

    assert.equal(await countContinuations(context.input, "claude"), 1);
  } finally {
    await context.cleanup();
  }
});

test("Claude uses Sonnet with its default effort for classification", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
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
    assert.match(call.prompt, /Reply with the verdict word alone/);
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(call.prompt, /Build it now|supersecretvalue|tool_events|project_context/);
  } finally {
    await context.cleanup();
  }
});

test("Ghost delegates classification to its smol-model bridge", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "JUDGE";
    const output = await handleStop(context.input, "ghost");
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.JUDGE.fallbacks[0] });
    const [call] = await context.calls();
    assert.deepEqual(call.args, ["hook-smol-complete"]);
    assert.equal(call.input.ghost_home, context.input.ghost_home);
    assert.match(call.input.prompt, /Reply with the verdict word alone/);
    assert.match(call.input.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(call.input.prompt, /Please finish the requested change/);
  } finally {
    await context.cleanup();
  }
});

test("verdict parsing accepts only the exact review enum", () => {
  for (const verdict of ["CONTINUE", "JUDGE", "STOP"]) {
    assert.deepEqual(parseReviewVerdict(` ${verdict}\n`), { verdict, nudge: "" });
  }
  for (const invalid of ["continue", "CONSULT", "JUDGE_ADVISOR", "{}", "", null, undefined]) {
    assert.throws(() => parseReviewVerdict(invalid), /begin with CONTINUE, JUDGE, or STOP/);
  }
});

test("the reviewer's own line is carried through, sanitised, or dropped", () => {
  // The reviewer writes the whole blocking message, so a line that arrives
  // unusable has to fall back rather than ship empty.
  const { verdict, nudge } = parseReviewVerdict(
    "CONTINUE\nThree files into the rename and the last one is small.",
  );
  assert.equal(verdict, "CONTINUE");
  assert.equal(nudge, "Three files into the rename and the last one is small.");
  // Both blocking verdicts ship this line and nothing else: JUDGE's fixed
  // preamble is gone, so the reviewer writes the whole message either way.
  for (const blocking of ["CONTINUE", "JUDGE"]) {
    assert.deepEqual(hookOutputForVerdict(blocking, 0, nudge), { decision: "block", reason: nudge });
  }

  // Separators are stripped and the line is flattened, so a multi-line reply
  // cannot forge transcript structure in the message the agent receives.
  assert.equal(parseReviewVerdict("CONTINUE \u2014 keep\n  at it").nudge, "keep at it");
  assert.equal(parseReviewVerdict("CONTINUE: nearly there").nudge, "nearly there");

  // Secrets the reviewer echoes back never reach the agent's next turn.
  assert.match(
    parseReviewVerdict(`CONTINUE\nYou already have token=${"s".repeat(20)} in hand.`).nudge,
    /token=\[REDACTED\]/,
  );

  // A speech rather than a sentence is dropped whole: truncating would leave a
  // broken clause, and the reviewer never saw the transcript to begin with.
  const long = "go on and on ".repeat(30);
  assert.ok(long.length > NUDGE_LIMIT);
  assert.equal(parseReviewVerdict(`CONTINUE\n${long}`).nudge, "");
  assert.deepEqual(hookOutputForVerdict("CONTINUE", 0, ""), {
    decision: "block",
    reason: VERDICTS.CONTINUE.fallbacks[0],
  });
});

test("the fallback line rotates and the last stretch asks for a landing", () => {
  // One sentence repeated a hundred times reads as a loop, not a push.
  const reasons = Array.from(
    { length: VERDICTS.CONTINUE.fallbacks.length },
    (_, index) => hookOutputForVerdict("CONTINUE", index).reason,
  );
  assert.deepEqual(reasons, VERDICTS.CONTINUE.fallbacks);
  assert.equal(new Set(reasons).size, VERDICTS.CONTINUE.fallbacks.length);

  // A dropped JUDGE line must not degrade into CONTINUE: the whole of the
  // verdict is "do not ask yet", and the agent has just asked the user.
  const shared = VERDICTS.JUDGE.fallbacks.filter((line) => VERDICTS.CONTINUE.fallbacks.includes(line));
  assert.deepEqual(shared, []);
  assert.match(hookOutputForVerdict("JUDGE", 0, "").reason, /not ask|yourself|before/i);

  // Only this side knows the cap, so it reaches the reviewer the way every
  // other hook-side fact does: in the prompt, before the line is written.
  assert.equal(reviewPrompt(CONTINUATION_CAP - LAST_STRETCH - 1), REVIEW_PROMPT);
  assert.match(reviewPrompt(CONTINUATION_CAP - LAST_STRETCH), /near its limit/);
  assert.match(reviewPrompt(CONTINUATION_CAP - 1), /land what is in flight/);
  // The note changes the instruction, never the answer the reviewer gave.
  assert.equal(
    hookOutputForVerdict("CONTINUE", CONTINUATION_CAP - 1, "Nearly done.").reason,
    "Nearly done.",
  );
});

test("the hook never asks for a register it does not keep itself", () => {
  // The reviewer writes the whole blocking message against a budget this side
  // enforces, so every line the hook itself supplies — the prompt's examples,
  // the fallbacks, and the composed reason — has to fit that same budget.
  for (const example of REVIEW_PROMPT.match(/"[^"]+"/g) ?? []) {
    assert.ok(example.length - 2 <= NUDGE_LIMIT, example);
  }
  for (const spec of Object.values(VERDICTS)) {
    for (const line of spec.fallbacks ?? []) assert.ok(line.length <= NUDGE_LIMIT, line);
  }
  for (const verdict of ["CONTINUE", "JUDGE"]) {
    const reason = hookOutputForVerdict(verdict, CONTINUATION_CAP - 1, "a".repeat(NUDGE_LIMIT)).reason;
    assert.ok(reason.length <= NUDGE_LIMIT, reason);
  }
  // Each verdict the parser accepts has to be a verdict the prompt asks for,
  // and each blocking one has to tell the reviewer what to write after it.
  for (const [verdict, spec] of Object.entries(VERDICTS)) {
    assert.match(REVIEW_PROMPT, new RegExp(`^${verdict} \\u2014 `, "m"));
    assert.equal(parseReviewVerdict(verdict).verdict, verdict);
    if (spec.blocks) assert.ok(REVIEW_PROMPT.includes(`After ${verdict}, ${spec.directive}.`));
  }
});

test("the tally caps a turn the transcript cannot", { concurrency: false }, async () => {
  // Grok Build loads this hook through its Claude compatibility layer, and its
  // transcripts are neither in Claude's directories nor in Claude's shape. The
  // cap is the only thing between a stuck reviewer and a hundred turns of
  // spend, so it cannot depend on parsing a format the host chose.
  const context = await claudeFixture();
  const tallyFile = path.join(process.env.XDG_STATE_HOME, "keep-going", "continuations.json");
  const { transcript_path: _ignored, ...input } = context.input;
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    assert.equal(await recordedContinuations(input), 0);
    for (const expected of [1, 2, 3]) {
      const output = await handleStop(input, "claude");
      assert.equal(output.decision, "block");
      assert.equal(await recordedContinuations(input), expected);
    }

    // A turn ends when the hook lets a stop through, which is what makes the
    // count mean "continuations in this turn" without reading a transcript.
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    assert.deepEqual(await handleStop(input, "claude"), {});
    assert.equal(await recordedContinuations(input), 0);

    // At the cap the stop is accepted with no review at all.
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    await mkdir(path.dirname(tallyFile), { recursive: true });
    await writeFile(
      tallyFile,
      JSON.stringify({ [input.session_id]: { count: CONTINUATION_CAP, updated: Date.now() } }),
    );
    const before = (await context.calls()).length;
    const capped = await handleStop(input, "claude");
    assert.match(capped.systemMessage, /continuation cap \(100\) reached/);
    assert.equal((await context.calls()).length, before);
    assert.equal(await recordedContinuations(input), 0);

    // An interrupted turn never comes back to be cleared, so its entry expires
    // instead of counting against whatever that session does next.
    await writeFile(
      tallyFile,
      JSON.stringify({ [input.session_id]: { count: 7, updated: Date.now() - 31 * 60_000 } }),
    );
    assert.equal(await recordedContinuations(input), 0);
  } finally {
    await context.cleanup();
  }
});

test("every plugin manifest declares the package version", async () => {
  // v0.1.1 shipped a manifest still declaring 0.1.0, so the marketplace
  // reported the wrong version for the whole release. Nothing referenced both
  // files, so the drift was invisible until someone read them side by side.
  // There are three manifests to keep in step now, one per install route.
  const read = async (relative) =>
    JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  const [pkg, codex, claude, marketplace] = await Promise.all([
    read("../package.json"),
    read("../plugins/keep-going/.codex-plugin/plugin.json"),
    read("../plugins/keep-going/.claude-plugin/plugin.json"),
    read("../.claude-plugin/marketplace.json"),
  ]);
  assert.equal(codex.version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.deepEqual(
    marketplace.plugins.map((entry) => entry.version),
    marketplace.plugins.map(() => pkg.version),
  );

  // Each host reads its own manifest, so the Claude hook has to name the Claude
  // runner: the Codex file next to it spells the same script with a different
  // trailing argument, and a copy-paste between them fails open on every stop.
  const hooks = await read(`../plugins/keep-going/${claude.hooks}`);
  const [{ command }] = hooks.hooks.Stop[0].hooks;
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(command, /keep-going\.mjs" claude$/);
});

test("the shipped plugin bundles no runtime dependency", async () => {
  // v0.1.1 dropped Zod to keep the hook cheap to install and start. Nothing
  // else would notice a dependency reappearing: the CI drift check only proves
  // the bundle matches src, not that src stayed dependency-free.
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.dependencies ?? {}, {});

  const bundlePath = new URL("../plugins/keep-going/scripts/keep-going.mjs", import.meta.url);
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
    assert.equal(CONTINUATION_CAP, 100);
    const feedback = Array.from({ length: CONTINUATION_CAP }, () =>
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } })
    );
    await appendRecords(context.input.transcript_path, feedback);
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(context.input, "claude");
    assert.match(output.systemMessage, /continuation cap \(100\) reached/);
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
    await appendRecords(context.input.transcript_path, records);

    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(context.input);
    assert.match(output.systemMessage, /continuation cap \(100\) reached/);
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

    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(input, "ghost");
    // The bare verdict carries no line, so the fallback rotates with the count.
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[1] });
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
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop({ ...context.input, conversation_runtime: "pi", transcript_path: outside }, "ghost");
    // The path is refused, so nothing reads it; the tally caps the turn in its
    // place and the reviewer still gets its say.
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[0] });
    assert.equal((await context.calls()).length, 1);
    const audit = await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8");
    assert.match(audit, /falling back to the tally: .*outside the ghost transcript directories/);

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
  const previousEnvironment = environmentSnapshot();
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
    restoreEnvironment(previousEnvironment);
    await rm(claudeHome, { recursive: true, force: true });
    await context.cleanup();
  }
});

// Both byte guards were rewritten from "remeasure everything on each chunk" to a
// running counter. Neither had coverage, so nothing would have caught the limit
// silently ceasing to fire.
test("oversized Stop input is refused before any reviewer is spawned", async () => {
  const entry = path.join(import.meta.dirname, "..", "src", "keep-going.mjs");
  const child = spawn(process.execPath, [entry, "claude"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout += chunk);
  // The hook exits as soon as the limit trips, so the tail of this write lands
  // on a closed pipe.
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ session_id: "s", last_assistant_message: "x".repeat(1_500_000) }));
  await new Promise((resolve) => child.on("close", resolve));
  assert.match(JSON.parse(stdout).systemMessage, /exceeds 1 MB/);
});

test("a reviewer that floods stdout is cut off at the output limit", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    process.env.MOCK_REVIEW_PAD = String(2 * 1024 * 1024 + 1024);
    const output = await handleStop(context.input, "claude");
    assert.match(output.systemMessage, /exceeded 2 MB/);
    assert.equal(output.decision, undefined);
  } finally {
    await context.cleanup();
  }
});
