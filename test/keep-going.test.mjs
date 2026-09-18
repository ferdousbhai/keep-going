import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  CONTINUATION_CAP,
  BLOCKING_VERDICTS,
  VERDICTS,
  LAST_STRETCH,
  NUDGE_LIMIT,
  REVIEW_PROMPT,
  claudeContinuations,
  recordedContinuations,
  reviewPrompt,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
  resolveRunner,
  yieldsToGrokNative,
} from "../src/keep-going.mjs";
import { HOOK_FILES, VERSIONED, hookFile, stampVersion } from "../scripts/build.mjs";


const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "KEEP_GOING_CLAUDE_BIN",
  "KEEP_GOING_CLAUDE_MODEL",
  "KEEP_GOING_CODEX_BIN",
  "KEEP_GOING_CODEX_MODEL",
  "KEEP_GOING_GHOST_BIN",
  "KEEP_GOING_GROK_BIN",
  "KEEP_GOING_GROK_MODEL",
  "KEEP_GOING_MUSE_BIN",
  "KEEP_GOING_MUSE_MODEL",
  "GROK_HOOK_EVENT",
  "GROK_HOME",
  "MOCK_CALL_LOG",
  "MOCK_REVIEW_RESPONSE",
  "MOCK_REVIEW_PAD",
  "KEEP_GOING_AUDIT_LOG",
  // The hook keeps its continuation tally under this root; every fixture gets
  // its own so a test run never reads or writes the developer's real one.
  "XDG_STATE_HOME",
];

function environmentSnapshot() {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  // Grok's hook runner sets this; a test process started from a Grok session
  // must not inherit it or every runner remaps to grok.
  delete process.env.GROK_HOOK_EVENT;
  return snapshot;
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

async function auditRows() {
  return (await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
}

// The tally key, spelled out here so a change to how a turn is identified has
// to be made twice: session plus the host's turn discriminator, and a host that
// sends none (Claude) has one key for the session.
const tallyKey = (sessionId, discriminator = "") => `${sessionId}\u0000${discriminator}`;
const promptDigest = (prompt) => createHash("sha256").update(prompt.trim()).digest("hex").slice(0, 16);

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
  const sessions = path.join(root, "codex", "sessions", "2026", "08", "26");
  const transcript = path.join(sessions, "rollout.jsonl");
  const turnId = "turn-test";
  const modelMock = path.join(root, "mock-codex.mjs");
  const callLog = path.join(root, "calls.jsonl");

  // Codex sends a rollout path with every stop. Nothing reads it — the turn id
  // beside it is the whole of what the hook needs — and a secret in it is how a
  // test would notice if that changed.
  await mkdir(sessions, { recursive: true });
  await writeFile(
    transcript,
    [
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

test("Codex counts against the turn id it sends, not its rollout", { concurrency: false }, async () => {
  // The turn id is in the payload, so the count is keyed on it directly rather
  // than rebuilt by matching it against every user message in the rollout.
  const context = await fixture();
  const tallyFile = path.join(process.env.XDG_STATE_HOME, "keep-going", "continuations.json");
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    for (const expected of [1, 2]) {
      assert.equal((await handleStop(context.input)).decision, "block");
      assert.equal(await recordedContinuations(context.input, "codex"), expected);
    }

    // The next turn is a new key, so it starts at zero whether or not the hook
    // ever saw the stop that ended this one.
    assert.equal(await recordedContinuations({ ...context.input, turn_id: "turn-next" }, "codex"), 0);

    // The rollout is on disk and next to the hook's own state; nothing reads it.
    for (const row of await auditRows()) assert.equal(row.counted_by, "tally");

    // At the cap the stop is accepted with no review at all.
    await writeFile(
      tallyFile,
      JSON.stringify({
        [tallyKey(context.input.session_id, context.input.turn_id)]: {
          count: CONTINUATION_CAP,
          updated: Date.now(),
        },
      }),
    );
    const before = (await context.calls()).length;
    const capped = await handleStop(context.input);
    assert.match(capped.systemMessage, /continuation cap \(100\) reached/);
    assert.equal((await context.calls()).length, before);
    assert.equal(await recordedContinuations(context.input, "codex"), 0);
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
    assert.ok(calls[0].args.includes('model_reasoning_effort="none"'));
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

test("a missing reviewer executable fails open and clears the turn tally", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await handleStop(context.input, "codex", { runModel: async () => "CONTINUE" });
  assert.equal(await recordedContinuations(context.input, "codex"), 1);
  process.env.KEEP_GOING_CODEX_BIN += ".missing";
  const output = await handleStop(context.input);
  assert.match(output.systemMessage, /ENOENT/);
  assert.equal(await recordedContinuations(context.input, "codex"), 0);
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
    assert.equal(await claudeContinuations(context.input), 0);

    const additions = [
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Do one more thing." }, origin: { kind: "human" } }),
      // Context the host injects as a user message is nobody's prompt: counting
      // it would start the turn over on every pass.
      JSON.stringify({ type: "user", message: { role: "user", content: "<environment_context>injected</environment_context>" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\ncontinue" } }),
      JSON.stringify({
        type: "user",
        origin: { kind: "task-notification" },
        message: { role: "user", content: "Background task finished." },
      }),
    ];
    await appendRecords(context.input.transcript_path, additions);

    assert.equal(await claudeContinuations(context.input), 1);
  } finally {
    await context.cleanup();
  }
});

test("Claude ignores orphan feedback and resets the streaming count for a new owner", async (t) => {
  const context = await claudeFixture();
  t.after(() => context.cleanup());
  const feedback = { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: continue" } };
  const owner = { type: "user", message: { role: "user", content: "New request" } };
  await writeFile(context.input.transcript_path, JSON.stringify(feedback));
  assert.equal(await claudeContinuations(context.input), 0);
  await appendRecords(context.input.transcript_path, [owner, feedback, feedback].map((record) => JSON.stringify(record)));
  assert.equal(await claudeContinuations(context.input), 2);
  await appendRecords(context.input.transcript_path, [JSON.stringify(owner), "incomplete JSON"]);
  assert.equal(await claudeContinuations(context.input), 0);
});

test("Claude classifies with no tools and the lowest advertised effort", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const output = await handleStop(context.input, "claude");
    assert.deepEqual(output, {});
    const [call] = await context.calls();
    assert.equal(call.model, "sonnet");
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "low");
    assert.ok(call.args.includes("--safe-mode"));
    assert.ok(call.args.includes("--no-session-persistence"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.ok(!call.args.includes("--json-schema"));
    assert.ok(!call.args.includes("--max-turns"));
    assert.match(call.prompt, /Reply with the verdict word alone/);
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.doesNotMatch(call.prompt, /Build it now|supersecretvalue|tool_events|project_context/);
  } finally {
    await context.cleanup();
  }
});

test("names no model unless one is configured", { concurrency: false }, async () => {
  // Every host picks its own reviewer when the knob is unset, the way ghost and
  // grok always have. A default here would be this tool choosing a vendor's
  // model on the owner's behalf, and would age: the codex one named a specific
  // release, not a tier.
  for (const [runner, fixtureFor, variable] of [
    ["codex", fixture, "KEEP_GOING_CODEX_MODEL"],
    ["claude", claudeFixture, "KEEP_GOING_CLAUDE_MODEL"],
    ["muse", museFixture, "KEEP_GOING_MUSE_MODEL"],
    ["grok", grokFixture, "KEEP_GOING_GROK_MODEL"],
  ]) {
    const context = await fixtureFor();
    try {
      delete process.env[variable];
      process.env.MOCK_REVIEW_RESPONSE = "STOP";
      await handleStop(context.input, runner);
      const [call] = await context.calls();
      assert.ok(!call.args.includes("--model"), `${runner} passed --model with ${variable} unset`);
    } finally {
      await context.cleanup();
    }
  }
});

test("temporary reviewers remove their scratch directories after process failure", async () => {
  for (const [runner, createFixture] of [
    ["codex", fixture], ["claude", claudeFixture], ["grok", grokFixture], ["muse", museFixture],
  ]) {
    const context = await createFixture();
    try {
      await writeFile(process.env[`KEEP_GOING_${runner.toUpperCase()}_BIN`], `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
for await (const chunk of process.stdin) {} // Consume input before exiting.
const args = process.argv.slice(2);
const directory = args.includes("--cd") ? args[args.indexOf("--cd") + 1] : process.cwd();
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ directory }) + "\\n");
process.exitCode = 1;
`);
      const result = await handleStop(context.input, runner);
      assert.match(result.systemMessage, /exited 1/);
      const [call] = await context.calls();
      await assert.rejects(stat(call.directory), { code: "ENOENT" });
      if (runner === "muse") await assert.rejects(stat(path.dirname(call.directory)), { code: "ENOENT" });
    } finally {
      await context.cleanup();
    }
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
    assert.match(call.input.prompt, /"owner_prompt":"Please finish the requested change\."/);
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
  assert.deepEqual(
    parseReviewVerdict("I'll check the session state.\nSTOP"),
    { verdict: "STOP", nudge: "" },
  );
  assert.deepEqual(
    parseReviewVerdict("A short look at the last message.\nCONTINUE\nKeep going."),
    { verdict: "CONTINUE", nudge: "Keep going." },
  );
  assert.deepEqual(
    parseReviewVerdict("I'll inspect the workspace and recent activity to see if the turn actually finished.STOP"),
    { verdict: "STOP", nudge: "" },
  );
});

test("a verdict answered twice is still one verdict", () => {
  // Small reviewers repeat themselves. Measured on ghost's free-tier model,
  // roughly one reply in seven came back doubled. Requiring a word boundary
  // threw away an answer that had been given, and the separated form was worse
  // than that: it parsed, and the agent was sent back with "CONTINUE." as its
  // encouragement.
  for (const doubled of ["CONTINUECONTINUE", "CONTINUE.CONTINUE.", "CONTINUE CONTINUE"]) {
    assert.deepEqual(parseReviewVerdict(doubled), { verdict: "CONTINUE", nudge: "" });
  }
  assert.deepEqual(parseReviewVerdict("STOPSTOP"), { verdict: "STOP", nudge: "" });
  // A real line still survives beside the verdict.
  assert.deepEqual(parseReviewVerdict("CONTINUE Keep going."), {
    verdict: "CONTINUE",
    nudge: "Keep going.",
  });
  // Widening the boundary must not start accepting a longer word.
  for (const invalid of ["CONTINUEX", "JUDGE_ADVISOR", "continue"]) {
    assert.throws(() => parseReviewVerdict(invalid));
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
  for (const blocking of BLOCKING_VERDICTS) {
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
  // Each verdict the parser accepts has to be a verdict the prompt asks for,
  // and each blocking one has to tell the reviewer what to write after it.
  for (const [verdict, spec] of Object.entries(VERDICTS)) {
    assert.match(REVIEW_PROMPT, new RegExp(`^${verdict} \\u2014 `, "m"));
    if (spec.blocks) assert.ok(REVIEW_PROMPT.includes(`After ${verdict}, ${spec.directive}.`));
  }
});

async function grokFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "grok-keep-going-test-"));
  const modelMock = path.join(root, "mock-grok.mjs");
  const callLog = path.join(root, "calls.jsonl");
  await writeFile(
    modelMock,
    `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({
  args,
  grokHookEvent: process.env.GROK_HOOK_EVENT ?? null,
  grokHome: process.env.GROK_HOME ?? null,
  overlayHasConfig: process.env.GROK_HOME ? existsSync(path.join(process.env.GROK_HOME, "config.toml")) : false,
}) + "\\n");
process.stdout.write(process.env.MOCK_REVIEW_RESPONSE + "\\n");
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.KEEP_GOING_GROK_BIN = modelMock;
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.GROK_HOME = path.join(root, "grok-home");

  return {
    // The payload Grok's native Stop hook actually sends, spelling intact.
    input: {
      hook_event_name: "Stop",
      session_id: "01a0aa1a-41d9-7e61-ab32-485671aff04c",
      cwd: "/tmp/project",
      transcript_path: "/home/someone/.grok/sessions/%2Ftmp%2Fproject/01a0aa1a/updates.jsonl",
      lastAssistantMessage: "Candidate final response.",
      stopHookActive: false,
      reason: "end_turn",
    },
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function museFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "muse-keep-going-test-"));
  const modelMock = path.join(root, "mock-muse.mjs");
  const callLog = path.join(root, "calls.jsonl");
  // The reviewer restores the default home's auth into its hook-free overlay,
  // so the fixture home carries a credential to be restored.
  const fakeHome = path.join(root, "home");
  await mkdir(path.join(fakeHome, ".config", "muse"), { recursive: true });
  await writeFile(path.join(fakeHome, ".config", "muse", "auth.json"), "fixture-auth");
  await writeFile(
    modelMock,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const prompt = readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
const configHome = process.env.XDG_CONFIG_HOME ?? null;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({
  args,
  prompt,
  configHome,
  overlayHasSettings: configHome ? existsSync(path.join(configHome, "muse", "settings.json")) : null,
  overlayHasAuth: configHome ? existsSync(path.join(configHome, "muse", "auth.json")) : null,
}) + "\\n");
process.stdout.write(process.env.MOCK_REVIEW_RESPONSE);
`,
  );
  await chmod(modelMock, 0o755);

  const previous = environmentSnapshot();
  process.env.HOME = fakeHome;
  process.env.KEEP_GOING_MUSE_BIN = modelMock;
  process.env.KEEP_GOING_MUSE_MODEL = "muse-spark-fixture";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");

  return {
    // The payload Muse's native Stop hook actually sends, spelling intact.
    input: {
      cwd: "/tmp/project",
      hook_event_name: "Stop",
      last_assistant_message: "Candidate final response.",
      model: "muse-spark-fixture",
      permission_mode: "default",
      session_id: "session-test",
      stop_hook_active: false,
      transcript_path: null,
      turn_id: "turn-test",
    },
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a subagent is capped on its own account, not its parent's", { concurrency: false }, async () => {
  // SubagentStop carries the parent session's id, so without agent_id in the
  // key a handful of subagents would spend the cap of the turn that launched
  // them. The parent's transcript is the parent's, too: its user messages are
  // not this subagent's continuations.
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const subagent = {
      ...context.input,
      hook_event_name: "SubagentStop",
      agent_id: "agent-7f3c",
      agent_type: "Explore",
      agent_transcript_path: "/tmp/agent-7f3c.jsonl",
      last_assistant_message: "Searched three files and stopped.",
    };

    for (const expected of [1, 2]) {
      assert.equal((await handleStop(subagent, "claude")).decision, "block");
      assert.equal(await recordedContinuations(subagent, "claude"), expected);
    }
    // The turn that launched it is untouched, and a second subagent starts fresh.
    assert.equal(await recordedContinuations(context.input, "claude"), 0);
    assert.equal(await recordedContinuations({ ...subagent, agent_id: "agent-b201" }, "claude"), 0);

    // Its parent's transcript is never opened on its behalf.
    assert.deepEqual([...new Set((await auditRows()).map((row) => row.counted_by))], ["tally"]);
  } finally {
    await context.cleanup();
  }
});

test("Grok is reviewed by Grok, on the message spelling it actually sends", { concurrency: false }, async () => {
  const context = await grokFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(context.input, "grok");
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[0] });

    // The overlay is a fresh GROK_HOME so the reviewer does not inherit MCP,
    // plugins, or the parent session's agent. --single still dispatches no
    // stop hook, so it cannot re-enter this one.
    const [call] = await context.calls();
    assert.ok(call.args.includes("--single"));
    assert.ok(!call.args.includes("--max-turns"));
    assert.ok(call.args.includes("--verbatim"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "low");
    assert.equal(
      call.args[call.args.indexOf("--system-prompt-override") + 1],
      "Reply with exactly one of CONTINUE, JUDGE, or STOP as the first line. No preamble, no analysis.",
    );
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.match(call.args[call.args.indexOf("--single") + 1], /Candidate final response\./);
    assert.equal(call.grokHookEvent, null);
    assert.ok(call.grokHome.endsWith(`${path.sep}home`));
    assert.notEqual(call.grokHome, process.env.GROK_HOME);
    assert.equal(call.overlayHasConfig, true);

    // Grok sends no transcript this runtime can read, so the tally is the cap.
    const [row] = (await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(row.counted_by, "tally");
    assert.equal(await recordedContinuations(context.input, "grok"), 1);
    assert.ok(!call.args.includes("--model"));
  } finally {
    await context.cleanup();
  }
});

test("Grok-dispatched Claude settings are reviewed by grok, not claude", { concurrency: false }, async () => {
  const context = await grokFixture();
  const claudeBin = path.join(path.dirname(process.env.KEEP_GOING_GROK_BIN), "must-not-run-claude.mjs");
  try {
    await writeFile(claudeBin, "#!/usr/bin/env node\nprocess.exit(2);\n");
    await chmod(claudeBin, 0o755);
    process.env.KEEP_GOING_CLAUDE_BIN = claudeBin;
    process.env.GROK_HOOK_EVENT = "stop";
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";

    assert.equal(resolveRunner("claude"), "grok");
    assert.equal(resolveRunner("codex"), "grok");
    assert.equal(await yieldsToGrokNative("claude"), false);
    const output = await handleStop(context.input, "claude");
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[0] });

    const [call] = await context.calls();
    assert.ok(call.args.includes("--single"));
    assert.ok(!call.args.includes("--print"));
    assert.equal(call.grokHookEvent, null);
    assert.ok(!call.args.includes("--model"));
  } finally {
    await context.cleanup();
  }
});

test("a native Grok hook makes the Claude-settings copy yield", { concurrency: false }, async () => {
  const context = await grokFixture();
  try {
    process.env.GROK_HOOK_EVENT = "stop";
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const hookFile = path.join(process.env.GROK_HOME, "hooks", "keep-going.json");
    await mkdir(path.dirname(hookFile), { recursive: true });
    await writeFile(hookFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/x/keep-going.mjs' grok" }] }],
      },
    }));

    assert.equal(await yieldsToGrokNative("claude"), true);
    assert.equal(await yieldsToGrokNative("grok"), false);
    assert.deepEqual(await handleStop(context.input, "claude"), {});
    assert.deepEqual(await context.calls(), []);

    const native = await handleStop(context.input, "grok");
    assert.deepEqual(native, { decision: "block", reason: VERDICTS.CONTINUE.fallbacks[0] });
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("Claude Code is still reviewed by claude when Grok is not the host", { concurrency: false }, async () => {
  const previous = process.env.GROK_HOOK_EVENT;
  delete process.env.GROK_HOOK_EVENT;
  try {
    assert.equal(resolveRunner("claude"), "claude");
    assert.equal(resolveRunner("codex"), "codex");
  } finally {
    if (previous === undefined) delete process.env.GROK_HOOK_EVENT;
    else process.env.GROK_HOOK_EVENT = previous;
  }
});

test("Muse counts against the turn id it sends", { concurrency: false }, async () => {
  // The turn id is in the payload, so the count is keyed on it directly. Only
  // session_id is required: a stop that stopped naming its turn is still
  // reviewed and capped per session rather than refused outright.
  const context = await museFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    for (const expected of [1, 2]) {
      assert.equal((await handleStop(context.input, "muse")).decision, "block");
      assert.equal(await recordedContinuations(context.input, "muse"), expected);
    }

    assert.equal(
      await recordedContinuations({ ...context.input, turn_id: "turn-next" }, "muse"),
      0,
    );

    const sessionOnly = { ...context.input };
    delete sessionOnly.turn_id;
    assert.equal(await recordedContinuations(sessionOnly, "muse"), 0);
    assert.equal((await handleStop(sessionOnly, "muse")).decision, "block");
    assert.equal(await recordedContinuations(sessionOnly, "muse"), 1);

    for (const row of await auditRows()) assert.equal(row.counted_by, "tally");
  } finally {
    await context.cleanup();
  }
});

test("Muse is reviewed by muse exec in a hook-free overlay", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const output = await handleStop(
      { ...context.input, last_assistant_message: "Shipped it. token=supersecretvalue" },
      "muse",
    );
    assert.deepEqual(output, {});

    const [call] = await context.calls();
    // A headless run fires Stop hooks, so the reviewer must not see the
    // registration it was spawned from: the overlay carries auth but no hooks.
    assert.equal(call.args[0], "exec");
    assert.ok(call.args.includes("--prompt-file"));
    assert.ok(!call.args.includes("--max-model-steps"));
    assert.ok(call.configHome, "reviewer ran without a config overlay");
    assert.equal(call.overlayHasSettings, false);
    assert.equal(call.overlayHasAuth, true);

    // The reviewer sees the redacted final message and nothing else: no cwd,
    // no transcript content.
    assert.match(call.prompt, /Reply with the verdict word alone/);
    assert.doesNotMatch(call.prompt, /supersecretvalue/);
    assert.match(call.prompt, /token=\[REDACTED\]/);
    assert.doesNotMatch(call.prompt, /\/tmp\/project/);
  } finally {
    await context.cleanup();
  }
});

test("an empty last assistant message blocks once instead of accepting the stop", { concurrency: false }, async () => {
  const context = await claudeFixture();
  const input = { session_id: "session-empty", last_assistant_message: "" };
  try {
    const first = await handleStop(input, "claude");
    assert.equal(first.decision, "block");
    assert.match(first.reason, /did not see your last message/);
    const second = await handleStop({ ...input, stop_hook_active: true }, "claude");
    assert.deepEqual(second, {});
  } finally {
    await context.cleanup();
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
    assert.equal(await recordedContinuations(input, "claude"), 0);
    for (const expected of [1, 2, 3]) {
      const output = await handleStop(input, "claude");
      assert.equal(output.decision, "block");
      assert.equal(await recordedContinuations(input, "claude"), expected);
    }

    // Claude's payload names no turn, so one key covers the whole session and
    // letting a stop through is the only thing that says the turn is over.
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    assert.deepEqual(await handleStop(input, "claude"), {});
    assert.equal(await recordedContinuations(input, "claude"), 0);

    // At the cap the stop is accepted with no review at all.
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    await mkdir(path.dirname(tallyFile), { recursive: true });
    await writeFile(
      tallyFile,
      JSON.stringify({ [tallyKey(input.session_id)]: { count: CONTINUATION_CAP, updated: Date.now() } }),
    );
    const before = (await context.calls()).length;
    const capped = await handleStop(input, "claude");
    assert.match(capped.systemMessage, /continuation cap \(100\) reached/);
    assert.equal((await context.calls()).length, before);
    assert.equal(await recordedContinuations(input, "claude"), 0);

    // Entries are collected rather than kept: an interrupted turn never comes
    // back for its own to be cleared.
    await writeFile(
      tallyFile,
      JSON.stringify({ [tallyKey(input.session_id)]: { count: 7, updated: Date.now() - 31 * 60_000 } }),
    );
    assert.equal(await recordedContinuations(input, "claude"), 0);
  } finally {
    await context.cleanup();
  }
});

test("version stamping requires an actual string version field", () => {
  for (const source of ['{}', '{"description":"version"}', '{"version":null}']) {
    assert.throws(() => stampVersion(source, "0.9.0"), /no version/);
  }
  assert.equal(stampVersion('{"version": "0.8.0"}', "0.9.0"), '{"version": "0.9.0"}');
  assert.equal(stampVersion('{"version":"0.9.0"}', "0.9.0"), '{"version":"0.9.0"}');
});

test("the committed manifests and hook files are what the build emits", async () => {
  // v0.1.1 shipped a manifest still declaring 0.1.0: four files had to agree
  // and the drift was invisible until someone read them side by side. The
  // build stamps the version and writes both hook files now, so the thing
  // left to check is that the committed copies equal what it emits — a hand
  // edit, or a release that skipped `npm run build`, fails here.
  const readText = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
  const { version } = JSON.parse(await readText("../package.json"));
  for (const relative of VERSIONED) {
    const source = await readText(`../${relative}`);
    assert.equal(source, stampVersion(source, version), `${relative} is not stamped ${version}`);
  }
  for (const runner of Object.keys(HOOK_FILES)) {
    assert.equal(await readText(`../${HOOK_FILES[runner].file}`), hookFile(runner));
  }

  // Generation makes the two hook files agree with one table, not with each
  // other, so the host-specific halves are still spelled out: a swap in that
  // table would emit two self-consistent files that fail open on every stop.
  assert.match(hookFile("codex"), /node \\"\$PLUGIN_ROOT\/scripts\/keep-going\.mjs\\" codex/);
  assert.match(
    hookFile("claude"),
    /node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/keep-going\.mjs\\" claude/,
  );

  // Claude finds its hook file through the manifest, which is hand-written.
  const claude = JSON.parse(await readText("../plugins/keep-going/.claude-plugin/plugin.json"));
  assert.equal(path.posix.join("plugins/keep-going", claude.hooks), HOOK_FILES.claude.file);
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

test("Ghost's turn is its owner prompt, and its tally lives in the ghost home", { concurrency: false }, async () => {
  const context = await ghostFixture();
  const tallyFile = path.join(context.input.ghost_home, "keep-going", "continuations.json");
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    assert.equal((await handleStop(context.input, "ghost")).decision, "block");

    // Ghost declares where its state belongs, and the hook that refuses to read
    // a transcript outside the ghost home writes the count inside it too.
    assert.deepEqual(Object.keys(JSON.parse(await readFile(tallyFile, "utf8"))), [
      tallyKey(context.input.session_id, promptDigest(context.input.owner_prompt)),
    ]);
    await assert.rejects(access(path.join(process.env.XDG_STATE_HOME, "keep-going")));

    // A second owner prompt in the same session is a different turn, so the
    // finished one's count is not spent on it.
    const next = { ...context.input, owner_prompt: "Now do the other thing." };
    assert.equal(await recordedContinuations(next, "ghost"), 0);
    assert.equal(await recordedContinuations(context.input, "ghost"), 1);

    // The owner prompt is the turn and the ghost home is the state, so a stop
    // without either is refused rather than counted against the wrong turn.
    for (const missing of ["owner_prompt", "ghost_home"]) {
      await assert.rejects(
        handleStop({ ...context.input, [missing]: "" }, "ghost"),
        new RegExp(`missing ${missing}`),
      );
    }
  } finally {
    await context.cleanup();
  }
});

test("Ghost opens no transcript of its own", { concurrency: false }, async () => {
  // Reading Pi's session tree rebuilt, from a format ghost chose, the turn that
  // owner_prompt already names. The payload is the cheaper source and the only
  // one that works for a ghost whose runtime writes no transcript at all.
  const context = await ghostFixture();
  try {
    const transcript = path.join(context.input.ghost_home, "sessions", "conv.jsonl");
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      JSON.stringify({ id: "m1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: context.input.owner_prompt }] } }),
      JSON.stringify({ id: "c1", parentId: "m1", type: "custom_message", customType: "session-stop-continuation", content: "continue" }),
    ].join("\n"));

    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const input = { ...context.input, conversation_runtime: "pi", transcript_path: transcript };
    // The bare verdict carries no line, so the fallback is the first of the pool.
    assert.deepEqual(await handleStop(input, "ghost"), {
      decision: "block",
      reason: VERDICTS.CONTINUE.fallbacks[0],
    });
    const [call] = await context.calls();
    assert.match(call.input.prompt, /Please finish the requested change/);

    // One row per stop, saying which mechanism capped the turn — and for a
    // host counted by the tally, the field names a RUNTIMES entry needs.
    const [row] = await auditRows();
    assert.equal(row.counted_by, "tally");
    assert.ok(row.stop_input_fields.includes("transcript_path"));
    assert.equal(row.verdict, "CONTINUE");
  } finally {
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
