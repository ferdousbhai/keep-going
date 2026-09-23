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
  QUIET_DELAY_MS,
  quietDelayMs,
  REVIEW_PROMPT,
  claudeContinuations,
  recordedContinuations,
  recordedRescan,
  RESCAN_SPENT_PROMPT,
  RESCAN_SPENT_VERDICTS,
  reviewPrompt,
  handleStop,
  hookOutputForVerdict,
  listPastTurns,
  parseReviewVerdict,
  parseTurnRequest,
  turnIndexSection,
  formatTurns,
  resolveRunner,
  yieldsToGrokNative,
  resolveOwnerPrompt,
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
  "KEEP_GOING_QUIET_MS",
  "KEEP_GOING_TURNS",
  "GROK_HOOK_EVENT",
  "GROK_HOME",
  "CODEX_HOME",
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
  process.env.KEEP_GOING_CODEX_MODEL = "gpt-5.5";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.CODEX_HOME = path.join(root, "codex");
  // The quiet wait holds a fresh stop briefly; fixtures opt out so the
  // suite stays fast, and the wait itself is covered by its own tests below.
  process.env.KEEP_GOING_QUIET_MS = "0";

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
  process.env.KEEP_GOING_CLAUDE_MODEL = "haiku";
  process.env.MOCK_CALL_LOG = callLog;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.KEEP_GOING_QUIET_MS = "0";

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
  process.env.KEEP_GOING_QUIET_MS = "0";

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
    assert.deepEqual(calls.map((item) => item.model), ["gpt-5.5"]);
    assert.ok(calls[0].args.includes('model_reasoning_effort="low"'));
    assert.ok(!calls[0].args.includes("--output-schema"));
    assert.match(calls[0].prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.match(calls[0].prompt, /"owner_prompt":"Build it now. token=\[REDACTED\]"/);
    assert.doesNotMatch(calls[0].prompt, /supersecretvalue|tool_events|project_context/);
    const [audit] = await auditRows();
    assert.equal(audit.verdict, "STOP");
    assert.equal(audit.rationale, "");
    assert.equal(audit.reviewer_output, "STOP");
  } finally {
    await context.cleanup();
  }
});

test("audit keeps the reviewer's raw text", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    await handleStop(context.input, "codex", { runModel: async () => "CONTINUE\nKeep going, finish it." });
    await handleStop(context.input, "codex", { runModel: async () => `STOP\n${"x".repeat(5000)}` });
    await handleStop(context.input, "codex", { runModel: async () => "just thinking out loud" });
    const [continueRow, longRow, invalidRow] = await auditRows();
    assert.equal(continueRow.verdict, "CONTINUE");
    assert.equal(continueRow.rationale, "Keep going, finish it.");
    assert.equal(continueRow.reviewer_output, "CONTINUE\nKeep going, finish it.");
    assert.equal(longRow.verdict, "STOP");
    assert.match(longRow.reviewer_output, /^\s*STOP/);
    assert.match(longRow.reviewer_output, /\.\.\.\[truncated\]\.\.\./);
    assert.equal(invalidRow.verdict, "ERROR");
    assert.equal(invalidRow.reviewer_output, "just thinking out loud");
  } finally {
    await context.cleanup();
  }
});

test("stub final messages without an owner prompt skip review", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    let reviews = 0;
    const review = async () => {
      reviews++;
      return "STOP";
    };
    const stop = (message, extra = {}) =>
      handleStop({ ...context.input, last_assistant_message: message, ...extra }, "muse", {
        runModel: review,
      });
    // Bare completion tokens with nothing to match against are accepted
    // without spending a reviewer call.
    for (const message of ["None", "Done."]) {
      assert.deepEqual(await stop(message), {});
    }
    assert.equal(reviews, 0);
    // Anything carrying task content is still reviewed...
    assert.deepEqual(await stop("Not done"), {});
    assert.equal(reviews, 1);
    // ...as is any stub arriving with an owner prompt to match against.
    assert.deepEqual(await stop("Done.", { owner_prompt: "Finish the migration." }), {});
    assert.equal(reviews, 2);
    const rows = await auditRows();
    assert.equal(rows.length, 4);
    for (const row of rows.slice(0, 2)) {
      assert.equal(row.verdict, "STOP");
      assert.equal(row.counted_by, "stub");
      assert.ok(!("reviewer_output" in row));
    }
  } finally {
    await context.cleanup();
  }
});

test("RESCAN blocks with a fresh-scan nudge", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    const output = await handleStop(context.input, "codex", {
      runModel: async () => "RESCAN\nScan once more for leftovers.",
    });
    assert.deepEqual(output, { decision: "block", reason: "Scan once more for leftovers." });
    const bare = await handleStop({ ...context.input, turn_id: "turn-rescan" }, "codex", {
      runModel: async () => "RESCAN",
    });
    assert.deepEqual(bare, { decision: "block", reason: VERDICTS.RESCAN.fallbacks[0] });
  } finally {
    await context.cleanup();
  }
});

test("RESCAN is offered once per turn; a second one fails open as an unoffered verdict", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    const prompts = [];
    const runModel = async ({ prompt }) => {
      prompts.push(prompt);
      return "RESCAN\nLook again with fresh eyes.";
    };
    const first = await handleStop(context.input, "codex", { runModel });
    assert.deepEqual(first, { decision: "block", reason: "Look again with fresh eyes." });
    assert.equal(await recordedRescan(context.input, "codex"), true);
    assert.match(prompts[0], /RESCAN — the agent claims/);

    // The reviewer is offered three verdicts now; a RESCAN anyway is no answer
    // to that prompt, and takes the fail-open path with a visible reason.
    const verdicts = [];
    const second = await handleStop(context.input, "codex", { runModel, onVerdict: (verdict) => verdicts.push(verdict) });
    assert.match(second.systemMessage, /keep-going was skipped: Reviewer answered RESCAN, which was not offered/);
    assert.deepEqual(verdicts, []);
    assert.doesNotMatch(prompts[1], /RESCAN — the agent claims/);
    assert.match(prompts[1], /already asked for this turn, so RESCAN is not on offer/);
    assert.match(prompts[1], /verdict word alone on the first line: CONTINUE, THINK, or STOP\./);
    const rows = (await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).verdict, "ERROR");
    assert.match(rows.at(-1).reviewer_output, /^RESCAN/);
    // The accepted stop ends the turn, and with it the memory of the scan.
    assert.equal(await recordedRescan(context.input, "codex"), false);

    // Under the reduced prompt the three offered verdicts work as ever, the
    // flag survives blocks in between, and it is per turn.
    await handleStop(context.input, "codex", { runModel });
    const kept = await handleStop(context.input, "codex", { runModel: async () => "CONTINUE\nKeep going." });
    assert.deepEqual(kept, { decision: "block", reason: "Keep going." });
    assert.equal(await recordedRescan(context.input, "codex"), true);
    assert.equal(await recordedContinuations(context.input, "codex"), 2);
    assert.equal(await recordedRescan({ ...context.input, turn_id: "turn-next" }, "codex"), false);
    assert.deepEqual(await handleStop(context.input, "codex", { runModel: async () => "STOP" }), {});
    assert.equal(await recordedRescan(context.input, "codex"), false);
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
    assert.match(call.prompt, /"owner_prompt":""/);
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
    process.env.MOCK_REVIEW_RESPONSE = "THINK_ADVISOR";
    const output = await handleStop(context.input);
    assert.match(output.systemMessage, /begin with CONTINUE, THINK, RESCAN, or STOP/);
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
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Do one more thing.");
  } finally {
    await context.cleanup();
  }
});

test("an interruption is not a new owner prompt", { concurrency: false }, async () => {
  // The marker the harness writes when a turn ends early carries none of the
  // flags the other injected records carry, so it used to pass as a genuine
  // prompt: the count restarted at zero and the reviewer was handed
  // "[Request interrupted by user]" as the request to judge against. An
  // interruption is the owner cutting a turn short, not asking for something.
  const context = await claudeFixture();
  try {
    const owner = { type: "user", message: { role: "user", content: "Fix the thing." }, origin: { kind: "human" } };
    const feedback = { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: continue" } };
    await appendRecords(context.input.transcript_path, [owner, feedback, feedback].map((r) => JSON.stringify(r)));
    assert.equal(await claudeContinuations(context.input), 2);

    for (const content of ["[Request interrupted by user]", "  [Request interrupted by user for tool use]  "]) {
      await appendRecords(context.input.transcript_path, [JSON.stringify({ type: "user", message: { role: "user", content } })]);
    }
    assert.equal(await claudeContinuations(context.input), 2);
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Fix the thing.");

    // Interrupting and then typing is the ordinary way to redirect a turn, and
    // the harness leads that message with the same text. Everything past the
    // marker is the owner's, so the record stays theirs and starts a new turn.
    await appendRecords(context.input.transcript_path, [JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "[Request interrupted by user] do the other thing instead" },
    })]);
    assert.equal(await claudeContinuations(context.input), 0);
    assert.match(await resolveOwnerPrompt(context.input, "claude"), /do the other thing instead/);
  } finally {
    await context.cleanup();
  }
});

test("a subagent reporting back does not open a turn", { concurrency: false }, async () => {
  // Codex has no flag for these the way Claude's task notifications do, and
  // codexOwnerPrompt only escapes them because a notification carries no
  // turn_id to match. Turn segmentation has no such guard, so they opened
  // turns of their own in the history the reviewer can ask to read.
  const context = await fixture();
  try {
    await appendRecords(context.input.transcript_path, [
      { type: "turn_context", payload: { turn_id: "t1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the thing." }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<subagent_notification>agent 3 finished</subagent_notification>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>" }] } },
      { type: "turn_context", payload: { turn_id: "t2" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Now the other thing." }] } },
    ].map((r) => JSON.stringify(r)));

    const owners = (await listPastTurns({ ...context.input, turn_id: "t2" }, "codex"))
      .map((turn) => turn.owner);
    assert.ok(!owners.some((owner) => owner.startsWith("<subagent_notification>")), owners.join(" | "));
    // The notification sat between the two prompts; the turn it used to open
    // would have come last, pushing the real request out of that slot.
    assert.deepEqual(owners.slice(-1), ["Fix the thing."]);
  } finally {
    await context.cleanup();
  }
});

test("running a command is not asking for anything", { concurrency: false }, async () => {
  // A command the owner runs from the prompt lands as three user-role records
  // — the echo, the output, and any error — each carrying the flags a typed
  // prompt carries. Counted, they restart the turn; read as the request, they
  // hand the reviewer "vscode" to judge the last message against. Same for a
  // compaction summary, which says what it is in a field of its own.
  const context = await claudeFixture();
  try {
    const owner = { type: "user", message: { role: "user", content: "Fix the thing." }, origin: { kind: "human" } };
    const feedback = { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: continue" } };
    await appendRecords(context.input.transcript_path, [owner, feedback].map((r) => JSON.stringify(r)));
    assert.equal(await claudeContinuations(context.input), 1);

    const noise = [
      "<bash-input>vscode</bash-input>",
      "<bash-stdout></bash-stdout><bash-stderr>vscode: command not found</bash-stderr>",
      "<local-command-stdout>Set model to `Opus 5`</local-command-stdout>",
      // Claude Code says it in the caveat itself: "The messages below were
      // generated by the user while running local commands. DO NOT respond."
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
    ].map((content) => JSON.stringify({ type: "user", message: { role: "user", content } }));
    noise.push(JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." },
    }));
    await appendRecords(context.input.transcript_path, noise);

    assert.equal(await claudeContinuations(context.input), 1);
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Fix the thing.");

    // A slash command is the owner invoking something on purpose, so it still
    // opens a turn: the skills among them are the whole of the request.
    await appendRecords(context.input.transcript_path, [JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "<command-message>simplify</command-message> <command-name>/simplify</command-name>" },
    })]);
    assert.equal(await claudeContinuations(context.input), 0);
    assert.match(await resolveOwnerPrompt(context.input, "claude"), /simplify/);
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
    assert.equal(call.model, "haiku");
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "low");
    assert.ok(call.args.includes("--safe-mode"));
    assert.ok(call.args.includes("--no-session-persistence"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.ok(!call.args.includes("--json-schema"));
    assert.ok(!call.args.includes("--max-turns"));
    assert.match(call.prompt, /Reply with the verdict word alone/);
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.match(call.prompt, /"owner_prompt":"Build it now. token=\[REDACTED\]"/);
    assert.doesNotMatch(call.prompt, /supersecretvalue|tool_events|project_context/);
  } finally {
    await context.cleanup();
  }
});

test("Codex and Claude review on a smaller tier unless one is configured", { concurrency: false }, async () => {
  // A one-word verdict does not need the host's frontier default. Claude's
  // alias tracks the latest Sonnet; Codex has no family alias, so its default
  // names a release and ages with it. Muse and Grok have no smaller tier to
  // name and keep their own defaults, the way Ghost's smol bridge always has.
  for (const [runner, fixtureFor, variable, expected] of [
    ["codex", fixture, "KEEP_GOING_CODEX_MODEL", "gpt-5.6-luna"],
    ["claude", claudeFixture, "KEEP_GOING_CLAUDE_MODEL", "sonnet"],
    ["muse", museFixture, "KEEP_GOING_MUSE_MODEL", undefined],
    ["grok", grokFixture, "KEEP_GOING_GROK_MODEL", undefined],
  ]) {
    const context = await fixtureFor();
    try {
      delete process.env[variable];
      process.env.MOCK_REVIEW_RESPONSE = "STOP";
      await handleStop(context.input, runner);
      const [call] = await context.calls();
      const named = call.args.includes("--model") ? call.args[call.args.indexOf("--model") + 1] : undefined;
      assert.equal(named, expected, `${runner} reviewed on ${named} with ${variable} unset`);
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

test("an exact reply the owner asked for is still the reviewer's call", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const input = {
      ...context.input,
      owner_prompt: "Do not use tools. Reply with exactly this one line and nothing else: Ghost hook test ready.",
      last_assistant_message: {
        role: "assistant",
        content: [{ type: "text", text: "Ghost hook test ready." }],
      },
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Ghost hook test ready." }],
      }],
    };
    assert.deepEqual(await handleStop(input, "ghost"), {});
    assert.equal((await context.calls()).length, 1);
    const [row] = (await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(row.verdict, "STOP");
    assert.equal(row.counted_by, "tally");
  } finally {
    await context.cleanup();
  }
});

test("Ghost delegates classification to its smol-model bridge", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "THINK";
    const output = await handleStop(context.input, "ghost");
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.THINK.fallbacks[0] });
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
  for (const verdict of ["CONTINUE", "THINK", "RESCAN", "STOP"]) {
    assert.deepEqual(parseReviewVerdict(` ${verdict}\n`), { verdict, nudge: "" });
  }
  for (const invalid of ["continue", "CONSULT", "THINK_ADVISOR", "JUDGE", "RESCAN_NOW", "{}", "", null, undefined]) {
    assert.throws(() => parseReviewVerdict(invalid), /begin with CONTINUE, THINK, RESCAN, or STOP/);
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
  // Small reviewers repeat themselves. Requiring a word boundary threw away an
  // answer that had been given. The repeat is not edited out of the line: what
  // the reviewer wrote reaches the agent as written.
  assert.deepEqual(parseReviewVerdict("CONTINUECONTINUE"), { verdict: "CONTINUE", nudge: "CONTINUE" });
  assert.deepEqual(parseReviewVerdict("CONTINUE CONTINUE"), { verdict: "CONTINUE", nudge: "CONTINUE" });
  assert.deepEqual(parseReviewVerdict("STOPSTOP"), { verdict: "STOP", nudge: "STOP" });
  assert.deepEqual(
    parseReviewVerdict("THINK\nKeep going.THINK\nKeep going."),
    { verdict: "THINK", nudge: "Keep going.THINK\nKeep going." },
  );
  // Widening the boundary must not start accepting a longer word.
  for (const invalid of ["CONTINUEX", "THINK_ADVISOR", "JUDGE", "continue"]) {
    assert.throws(() => parseReviewVerdict(invalid));
  }
});

test("the reviewer's own line reaches the agent as written, secrets aside", () => {
  // The reviewer writes the whole blocking message, so a line that arrives
  // unusable has to fall back rather than ship empty.
  const { verdict, nudge } = parseReviewVerdict(
    "CONTINUE\nThree files into the rename and the last one is small.",
  );
  assert.equal(verdict, "CONTINUE");
  assert.equal(nudge, "Three files into the rename and the last one is small.");
  // Both blocking verdicts ship this line and nothing else: THINK's fixed
  // preamble is gone, so the reviewer writes the whole message either way.
  for (const blocking of BLOCKING_VERDICTS) {
    assert.deepEqual(hookOutputForVerdict(blocking, 0, nudge), { decision: "block", reason: nudge });
  }

  // The separator after the verdict belongs to the verdict; the line keeps its
  // own shape.
  assert.equal(parseReviewVerdict("CONTINUE \u2014 keep\n  at it").nudge, "keep\n  at it");
  assert.equal(parseReviewVerdict("CONTINUE: nearly there").nudge, "nearly there");

  // Secrets the reviewer echoes back never reach the agent's next turn.
  assert.match(
    parseReviewVerdict(`CONTINUE\nYou already have token=${"s".repeat(20)} in hand.`).nudge,
    /token=\[REDACTED\]/,
  );

  // A speech rather than a sentence is carried whole.
  const long = "go on and on ".repeat(60).trim();
  assert.equal(parseReviewVerdict(`CONTINUE\n${long}`).nudge, long);
  assert.deepEqual(hookOutputForVerdict("CONTINUE", 0, ""), {
    decision: "block",
    reason: VERDICTS.CONTINUE.fallbacks[0],
  });
});

test("a turn waiting on the owner's consent may end", () => {
  // Consent is the one thing the agent cannot reason its way to, so the
  // reviewer is given somewhere honest to land a turn that ends on it rather
  // than filing it under questions the agent could have answered itself.
  assert.match(VERDICTS.STOP.describe, /only the owner has standing to make/);
  assert.match(REVIEW_PROMPT, /only the owner has standing to make/);
});

test("the reviewer is told when it is being refused", () => {
  // Earlier nudges are filtered out of the transcript it reads, so without the
  // count every firing looks like the first and a holding agent reads as a
  // stalling one. The note is the only thing that tells it otherwise.
  assert.doesNotMatch(reviewPrompt(0), /already been continued/);
  assert.match(reviewPrompt(1), /already been continued 1 time\./);
  assert.match(reviewPrompt(3), /already been continued 3 times\./);
  assert.match(reviewPrompt(2), /that reason is a real blocker \u2014 STOP/);
  // Near the cap it carries both notes, and the rescan variant keeps its own.
  assert.match(reviewPrompt(CONTINUATION_CAP - 1), /already been continued[\s\S]*land what is in flight/);
  assert.match(reviewPrompt(CONTINUATION_CAP - 1, true), /not on offer[\s\S]*already been continued/);
});

test("the fallback line rotates and the last stretch asks for a landing", () => {
  // One sentence repeated a hundred times reads as a loop, not a push.
  const reasons = Array.from(
    { length: VERDICTS.CONTINUE.fallbacks.length },
    (_, index) => hookOutputForVerdict("CONTINUE", index).reason,
  );
  assert.deepEqual(reasons, VERDICTS.CONTINUE.fallbacks);
  assert.equal(new Set(reasons).size, VERDICTS.CONTINUE.fallbacks.length);

  // A dropped THINK line must not degrade into CONTINUE: the whole of the
  // verdict is "think it through", and the agent has just asked the user.
  const shared = VERDICTS.THINK.fallbacks.filter((line) => VERDICTS.CONTINUE.fallbacks.includes(line));
  assert.deepEqual(shared, []);

  // Only this side knows the cap, so it reaches the reviewer the way every
  // other hook-side fact does: in the prompt, before the line is written.
  assert.equal(reviewPrompt(0), REVIEW_PROMPT);
  assert.doesNotMatch(reviewPrompt(CONTINUATION_CAP - LAST_STRETCH - 1), /near its limit/);
  assert.match(reviewPrompt(CONTINUATION_CAP - LAST_STRETCH), /near its limit/);
  assert.match(reviewPrompt(CONTINUATION_CAP - 1), /land what is in flight/);
  assert.equal(reviewPrompt(0, true), RESCAN_SPENT_PROMPT);
  assert.throws(() => parseReviewVerdict("RESCAN\nLook again.", RESCAN_SPENT_VERDICTS), /not offered on this stop; expected CONTINUE, THINK, or STOP/);
  assert.deepEqual(parseReviewVerdict("STOP", RESCAN_SPENT_VERDICTS), { verdict: "STOP", nudge: "" });
  assert.doesNotMatch(RESCAN_SPENT_PROMPT, /RESCAN —|Prefer RESCAN/);
  assert.match(reviewPrompt(CONTINUATION_CAP - 1, true), /not on offer[\s\S]*land what is in flight/);
  // The note changes the instruction, never the answer the reviewer gave.
  assert.equal(
    hookOutputForVerdict("CONTINUE", CONTINUATION_CAP - 1, "Nearly done.").reason,
    "Nearly done.",
  );
});

test("each verdict the parser accepts is one the prompt asks for", () => {
  // Each verdict the parser accepts has to be a verdict the prompt asks for.
  for (const verdict of Object.keys(VERDICTS)) {
    assert.match(REVIEW_PROMPT, new RegExp(`^${verdict} \\u2014 `, "m"));
  }
});

// A Grok session on disk: the updates log the stop names, its owner's chat
// history beside it, and the stop input pointing at the log.
async function grokSession(context) {
  const enc = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/project"));
  const sessionDir = path.join(enc, context.input.session_id);
  await mkdir(sessionDir, { recursive: true });
  const updates = path.join(sessionDir, "updates.jsonl");
  await writeFile(updates, "{}\n");
  return {
    enc,
    sessionDir,
    chat: path.join(sessionDir, "chat_history.jsonl"),
    input: { ...context.input, transcript_path: updates },
  };
}

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
  process.env.KEEP_GOING_QUIET_MS = "0";

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
  process.env.KEEP_GOING_QUIET_MS = "0";

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
      "Reply with exactly one of CONTINUE, THINK, RESCAN, or STOP as the first line. No preamble, no analysis.",
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
    assert.match(call.args[call.args.indexOf("--single") + 1], /"owner_prompt":""/);
  } finally {
    await context.cleanup();
  }
});

test("Grok recovers owner_prompt from prompt_history", { concurrency: false }, async () => {
  const context = await grokFixture();
  try {
    const { enc, input } = await grokSession(context);
    await writeFile(
      path.join(enc, "prompt_history.jsonl"),
      `${JSON.stringify({ session_id: context.input.session_id, prompt: "Ship the hook.", is_bash: false })}\n`,
    );
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    assert.equal(await resolveOwnerPrompt(input, "grok"), "Ship the hook.");
    await handleStop(input, "grok");
    const [call] = await context.calls();
    assert.match(call.args[call.args.indexOf("--single") + 1], /"owner_prompt":"Ship the hook\."/);
  } finally {
    await context.cleanup();
  }
});

test("Grok reads the chat log's wrapper blocks as nobody's prompt", { concurrency: false }, async () => {
  // With no prompt_history the chat log is the fallback, and what the owner
  // typed is tagged there. The untagged blocks beside it — <user_info> and
  // friends — are the log's own. Turn segmentation always skipped them;
  // prompt recovery used to hand the last one to the reviewer as the request.
  const context = await grokFixture();
  try {
    const { enc, input } = await grokSession(context);
    await rm(path.join(enc, "prompt_history.jsonl"), { force: true });
    await writeFile(path.join(path.dirname(input.transcript_path), "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Ship the hook.</user_query>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>cwd=/home/dous shell=bash</user_info>" }] }),
    ].join("\n") + "\n");
    assert.equal(await resolveOwnerPrompt(input, "grok"), "Ship the hook.");
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
    assert.match(call.prompt, /"owner_prompt":""/);
    assert.doesNotMatch(call.prompt, /supersecretvalue/);
    assert.match(call.prompt, /token=\[REDACTED\]/);
    assert.doesNotMatch(call.prompt, /\/tmp\/project/);
  } finally {
    await context.cleanup();
  }
});

test("Muse THINK blocks with a thinking fallback", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    const output = await handleStop(context.input, "muse", { runModel: async () => "THINK" });
    assert.deepEqual(output, { decision: "block", reason: VERDICTS.THINK.fallbacks[0] });
  } finally {
    await context.cleanup();
  }
});

test("Muse CONTINUE carries the reviewer's own line", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    const output = await handleStop(context.input, "muse", {
      runModel: async () => "CONTINUE\nLand the change first.",
    });
    assert.deepEqual(output, { decision: "block", reason: "Land the change first." });
  } finally {
    await context.cleanup();
  }
});

test("Muse accepts the stop at the continuation cap without a review", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    const tallyFile = path.join(process.env.XDG_STATE_HOME, "keep-going", "continuations.json");
    await mkdir(path.dirname(tallyFile), { recursive: true });
    await writeFile(
      tallyFile,
      JSON.stringify({
        [tallyKey(context.input.session_id, context.input.turn_id)]: {
          count: CONTINUATION_CAP,
          updated: Date.now(),
        },
      }),
    );
    const output = await handleStop(context.input, "muse", {
      runModel: async () => { throw new Error("reviewer must not run at the cap"); },
    });
    assert.match(output.systemMessage, /continuation cap \(100\) reached/);
    assert.equal(await recordedContinuations(context.input, "muse"), 0);
  } finally {
    await context.cleanup();
  }
});

test("Muse fails open when the reviewer throws and clears the tally", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    assert.equal(
      (await handleStop(context.input, "muse", { runModel: async () => "CONTINUE" })).decision,
      "block",
    );
    assert.equal(await recordedContinuations(context.input, "muse"), 1);
    const output = await handleStop(context.input, "muse", {
      runModel: async () => { throw new Error("boom"); },
    });
    assert.match(output.systemMessage, /keep-going was skipped: boom/);
    assert.equal(await recordedContinuations(context.input, "muse"), 0);
  } finally {
    await context.cleanup();
  }
});

test("Muse blocks an empty final message once, then accepts the retry", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    const input = { session_id: "session-empty", last_assistant_message: "" };
    const first = await handleStop(input, "muse");
    assert.equal(first.decision, "block");
    assert.match(first.reason, /did not see your last message/);
    assert.deepEqual(await handleStop({ ...input, stop_hook_active: true }, "muse"), {});
    // Both stops leave a row: this is the path every Muse reminder observer
    // takes first, and it used to vanish from the audit log.
    const rows = await auditRows();
    assert.deepEqual(rows.map((row) => [row.verdict, row.counted_by]), [["CONTINUE", "empty"], ["STOP", "empty"]]);
    assert.equal(rows[0].rationale, first.reason);
    assert.equal(rows[1].rationale, "no last message on retry");
  } finally {
    await context.cleanup();
  }
});

test("Muse ignores the quiet and history knobs it cannot use", { concurrency: false }, async () => {
  // No transcript means no quiet wait to skip and no turns to index, whatever
  // the knobs say: the stop goes straight to review.
  const context = await museFixture();
  const previous = process.env.KEEP_GOING_QUIET_MS;
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop(context.input, "muse", {
      runModel: async () => "STOP",
      delay: async () => { throw new Error("no transcript, so no wait"); },
    });
    assert.deepEqual(output, {});
  } finally {
    if (previous === undefined) delete process.env.KEEP_GOING_QUIET_MS;
    else process.env.KEEP_GOING_QUIET_MS = previous;
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

test("a fresh stop waits out the quiet delay before any review", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    let waitedMs = null;
    const output = await handleStop(context.input, "codex", {
      delay: async (ms) => { waitedMs = ms; },
    });
    assert.deepEqual(output, {});
    assert.equal(waitedMs, 60000);
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("a follow-up during the quiet wait lets the stop through unreviewed", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop(context.input, "codex", {
      delay: async () => {
        await appendRecords(context.input.transcript_path, [
          transcriptLine(
            { role: "user", content: [{ type: "input_text", text: "Actually, one more thing." }] },
            "turn-next",
          ),
        ]);
      },
    });
    assert.deepEqual(output, {});
    assert.deepEqual(await context.calls(), []);
    const [row] = await auditRows();
    assert.equal(row.verdict, "STOP");
    assert.equal(row.counted_by, "quiet-wait");
  } finally {
    await context.cleanup();
  }
});

test("the host's own writes during the quiet wait are not a follow-up", { concurrency: false }, async () => {
  // Claude Code fires Stop before the final assistant message reaches the
  // transcript, then lands it, the hook summary, and housekeeping records
  // while the hook waits. None of that is the owner speaking, so the stop
  // is still reviewed.
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop(context.input, "claude", {
      delay: async () => {
        await appendRecords(context.input.transcript_path, [
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Candidate final response." }] },
          }),
          JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "Stop" } }),
          JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookCount: 1 }),
          JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "<task-notification>done</task-notification>" }),
          JSON.stringify({ type: "last-prompt", lastPrompt: "Build it now." }),
          JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: keep going" } }),
          JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
        ]);
      },
    });
    assert.deepEqual(output, {});
    assert.equal((await context.calls()).length, 1);
    const [row] = await auditRows();
    assert.equal(row.counted_by, "transcript");
  } finally {
    await context.cleanup();
  }
});

test("an owner message queued during the quiet wait lets a Claude stop through", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop(context.input, "claude", {
      delay: async () => {
        await appendRecords(context.input.transcript_path, [
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Candidate final response." }] },
          }),
          JSON.stringify({
            type: "user",
            promptSource: "queued",
            message: { role: "user", content: [{ type: "text", text: "Actually, one more thing." }] },
          }),
        ]);
      },
    });
    assert.deepEqual(output, {});
    assert.deepEqual(await context.calls(), []);
    const [row] = await auditRows();
    assert.equal(row.counted_by, "quiet-wait");
  } finally {
    await context.cleanup();
  }
});

test("a subagent stop skips the quiet wait", { concurrency: false }, async () => {
  // Its owner is the parent agent, which is waiting on it and cannot follow up.
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop({ ...context.input, agent_id: "agent-1" }, "claude", {
      delay: async () => { throw new Error("a subagent has no owner to wait for"); },
    });
    assert.deepEqual(output, {});
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("Grok's quiet wait watches the chat history beside the updates log", { concurrency: false }, async () => {
  const context = await grokFixture();
  try {
    const { chat, input } = await grokSession(context);
    await writeFile(chat, `${JSON.stringify({ type: "user", content: [{ type: "text", text: "Ship the hook." }] })}\n`);
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";

    // The updates log growing is the host at work, not the owner.
    await handleStop(input, "grok", {
      delay: async () => { await appendRecords(input.transcript_path, ["{}", "{}"]); },
    });
    assert.equal((await context.calls()).length, 1);

    await handleStop(input, "grok", {
      delay: async () => {
        await appendRecords(chat, [JSON.stringify({ type: "user", content: [{ type: "text", text: "One more thing." }] })]);
      },
    });
    assert.equal((await context.calls()).length, 1);
    assert.equal((await auditRows()).at(-1).counted_by, "quiet-wait");
  } finally {
    await context.cleanup();
  }
});

test("a retry after hook feedback skips the quiet wait", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop({ ...context.input, stop_hook_active: true }, "codex", {
      delay: async () => { throw new Error("quiet wait must not run on a retry"); },
    });
    assert.deepEqual(output, {});
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("a stop with no transcript to watch is reviewed at once", { concurrency: false }, async () => {
  // Muse sends transcript_path null, so no follow-up could ever be observed.
  // Holding it for the quiet minute would only add latency.
  const context = await museFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    process.env.KEEP_GOING_QUIET_MS = "60000";
    const output = await handleStop(context.input, "muse", {
      delay: async () => { throw new Error("nothing to watch, so no wait"); },
    });
    assert.deepEqual(output, {});
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("the quiet wait defaults to fifteen seconds and parses defensively", () => {
  const previous = process.env.KEEP_GOING_QUIET_MS;
  try {
    assert.equal(QUIET_DELAY_MS, 15_000);
    delete process.env.KEEP_GOING_QUIET_MS;
    assert.equal(quietDelayMs(), 15_000);
    process.env.KEEP_GOING_QUIET_MS = "5000";
    assert.equal(quietDelayMs(), 5000);
    for (const invalid of ["nope", "-1", "Infinity"]) {
      process.env.KEEP_GOING_QUIET_MS = invalid;
      assert.equal(quietDelayMs(), 15_000);
    }
  } finally {
    if (previous === undefined) delete process.env.KEEP_GOING_QUIET_MS;
    else process.env.KEEP_GOING_QUIET_MS = previous;
  }
});

test("TURN requests name past turns 1-based, oldest first", () => {
  assert.deepEqual(parseTurnRequest("TURN 1", 3), { start: 1, end: 1 });
  assert.deepEqual(parseTurnRequest("turn 2-3", 3), { start: 2, end: 3 });
  assert.deepEqual(parseTurnRequest("TURN 3-1", 5), { start: 1, end: 3 });
  assert.deepEqual(parseTurnRequest("TURN -1", 3), { start: 3, end: 3 });
  assert.deepEqual(parseTurnRequest("TURN -2", 3), { start: 2, end: 2 });
  assert.deepEqual(parseTurnRequest("TURN 1-5", 9), { start: 1, end: 5 });
  for (const invalid of ["CONTINUE", "TURN", "TURN 0", "TURN 4", "TURN 1-6", "TURN 1-9", "TURN -4", "", null]) {
    assert.equal(parseTurnRequest(invalid, 3), null);
  }
});

test("fulfilled turns carry redacted prompts and finals, never raw secrets", () => {
  const out = formatTurns(
    [{ owner: "do it token=supersecretvalue", final: "done token=supersecretvalue" }],
    { start: 1, end: 1 },
  );
  assert.match(out, /Turn 1/);
  assert.match(out, /token=\[REDACTED\]/);
  assert.doesNotMatch(out, /supersecretvalue/);
  assert.match(
    turnIndexSection([{ owner: "First request", final: "x" }, { owner: "Second request", final: "y" }]),
    /1: First request\n2: Second request/,
  );
});

test("Claude past turns exclude the current turn and tool traffic", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    assert.deepEqual(await listPastTurns(context.input, "claude"), [
      { owner: "Earlier context.", final: "Earlier answer." },
    ]);
  } finally {
    await context.cleanup();
  }
});

test("Codex past turns segment on turn_context and skip hook feedback", { concurrency: false }, async () => {
  const context = await fixture();
  try {
    await appendRecords(context.input.transcript_path, [
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-next" } }),
      transcriptLine(
        { role: "user", content: [{ type: "input_text", text: "Now the next thing." }] },
        "turn-next",
      ),
      transcriptLine(
        { role: "assistant", content: [{ type: "output_text", text: "Working on it." }] },
        "turn-next",
      ),
    ]);
    const past = await listPastTurns({ ...context.input, turn_id: "turn-next" }, "codex");
    assert.deepEqual(past, [{ owner: "Build it now. token=supersecretvalue", final: "Candidate final response." }]);
  } finally {
    await context.cleanup();
  }
});

test("Grok past turns pair chat log users with their assistant finals", { concurrency: false }, async () => {
  const context = await grokFixture();
  try {
    const { chat, input } = await grokSession(context);
    await writeFile(chat, [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "First thing." }] }),
      JSON.stringify({ type: "assistant", content: "First done." }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "Second thing." }] }),
      JSON.stringify({ type: "assistant", content: "Second done." }),
    ].join("\n"));
    assert.deepEqual(await listPastTurns(input, "grok"), [
      { owner: "First thing.", final: "First done." },
    ]);
  } finally {
    await context.cleanup();
  }
});

test("Ghost past turns read the pi session file and skip tool passes", { concurrency: false }, async () => {
  const context = await ghostFixture();
  try {
    const sessionFile = path.join(context.input.ghost_home, "session.jsonl");
    const message = (role, content, extra = {}) => JSON.stringify({
      type: "message", id: Math.random().toString(36).slice(2), message: { role, content, ...extra },
    });
    const text = (value) => [{ type: "text", text: value }];
    await writeFile(sessionFile, [
      message("user", text("First errand.")),
      message("assistant", [{ type: "toolCall", name: "read" }], { stopReason: "toolUse" }),
      message("assistant", text("First errand done."), { stopReason: "stop" }),
      message("user", text("Second errand.")),
      message("assistant", text("Second errand done."), { stopReason: "stop" }),
    ].join("\n"));
    const past = await listPastTurns({ ...context.input, transcript_path: sessionFile }, "ghost");
    assert.deepEqual(past, [{ owner: "First errand.", final: "First errand done." }]);
  } finally {
    await context.cleanup();
  }
});

test("Pi turns arrive with the stop and Muse has nothing to index", async () => {
  assert.deepEqual(
    await listPastTurns({ past_turns: [{ owner_prompt: "  ", final_response: "x" }, null] }, "pi"),
    [],
  );
  assert.deepEqual(
    await listPastTurns(
      { past_turns: [{ owner_prompt: "Earlier.", final_response: "Did it." }] },
      "pi",
    ),
    [{ owner: "Earlier.", final: "Did it." }],
  );
  const context = await museFixture();
  try {
    assert.deepEqual(await listPastTurns(context.input, "muse"), []);
  } finally {
    await context.cleanup();
  }
});

test("KEEP_GOING_TURNS=0 disables the index everywhere", { concurrency: false }, async () => {
  const context = await claudeFixture();
  const previous = process.env.KEEP_GOING_TURNS;
  try {
    process.env.KEEP_GOING_TURNS = "0";
    assert.deepEqual(await listPastTurns(context.input, "claude"), []);
  } finally {
    if (previous === undefined) delete process.env.KEEP_GOING_TURNS;
    else process.env.KEEP_GOING_TURNS = previous;
    await context.cleanup();
  }
});

test("a reviewer TURN request is fulfilled and then verdicts", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    const prompts = [];
    const responses = ["TURN 1", "CONTINUE\nStill unfinished."];
    const output = await handleStop(context.input, "claude", {
      runModel: async ({ prompt }) => {
        prompts.push(prompt);
        return responses.shift();
      },
    });
    assert.deepEqual(output, { decision: "block", reason: "Still unfinished." });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Past turns, oldest first/);
    assert.match(prompts[1], /Turn 1\nowner_prompt: Earlier context\.\nfinal_response: Earlier answer\./);
  } finally {
    await context.cleanup();
  }
});

test("an unreadable TURN request fails open without a second call", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    let calls = 0;
    const output = await handleStop(context.input, "claude", {
      runModel: async () => {
        calls += 1;
        return "TURN 9";
      },
    });
    assert.match(output.systemMessage, /begin with CONTINUE, THINK, RESCAN, or STOP/);
    assert.equal(calls, 1);
  } finally {
    await context.cleanup();
  }
});

test("repeated TURN requests hit the round cap and fail open", { concurrency: false }, async () => {
  const context = await claudeFixture();
  try {
    let calls = 0;
    const output = await handleStop(context.input, "claude", {
      runModel: async () => {
        calls += 1;
        return "TURN 1";
      },
    });
    assert.match(output.systemMessage, /begin with CONTINUE, THINK, RESCAN, or STOP/);
    assert.equal(calls, 3);
  } finally {
    await context.cleanup();
  }
});

test("without past turns a TURN line is just a bad verdict", { concurrency: false }, async () => {
  const context = await museFixture();
  try {
    const prompts = [];
    const output = await handleStop(context.input, "muse", {
      runModel: async ({ prompt }) => {
        prompts.push(prompt);
        return "TURN 1";
      },
    });
    assert.match(output.systemMessage, /begin with CONTINUE, THINK, RESCAN, or STOP/);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /Past turns/);
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
  // the bundle matches src, not that src stayed dependency-free. The size cap
  // below is recalibrated when a feature grows src on purpose (16 KiB through
  // the quiet wait, 22 KiB with reviewer history lookup, 23 KiB with audit raw
  // text and the stub skip, 24 KiB with the once-per-turn rescan, 25 KiB with
  // the owner-authority prompt rules); the dependency assertions above are the
  // part that never moves.
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.dependencies ?? {}, {});

  const bundlePath = new URL("../plugins/keep-going/scripts/keep-going.mjs", import.meta.url);
  const bundle = await stat(bundlePath);
  assert.ok(bundle.size < 25 * 1024, `expected bundle below 25 KiB, received ${bundle.size} bytes`);

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
