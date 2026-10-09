import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  CONTINUATION_CAP,
  NUDGES,
  quietDelayMs,
  REVIEW_PROMPT,
  claudeNudges,
  codexNudges,
  recordedContinuations,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
  yieldsToGrokNative,
  resolveOwnerPrompt,
} from "../src/keep-going.mjs";
import { HOOK_FILES, VERSIONED, hookConfig, hookFile, stampVersion } from "../scripts/build.mjs";


const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "KEEP_GOING_QUIET_MS",
  "PATH",
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

// A mock reviewer CLI under the runner's command name, logging each call, with
// the call log, audit log, and continuation tally under a scratch root. PATH is
// the mock's directory alone, so no test can reach a real CLI.
async function reviewerFixture(name, mockSource) {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-keep-going-test-`));
  const bin = path.join(root, "bin");
  const mock = path.join(bin, name === "ghost" ? "ghostd" : name);
  const callLog = path.join(root, "calls.jsonl");
  await mkdir(bin);
  await writeFile(mock, `#!${process.execPath}\n${mockSource}`);
  await chmod(mock, 0o755);
  const previous = environmentSnapshot();
  Object.assign(process.env, {
    PATH: bin,
    MOCK_CALL_LOG: callLog,
    KEEP_GOING_AUDIT_LOG: path.join(root, "audit.jsonl"),
    XDG_STATE_HOME: path.join(root, "state"),
    // The quiet wait holds a fresh stop briefly; fixtures opt out so the
    // suite stays fast, and the wait itself is covered by its own tests below.
    KEEP_GOING_QUIET_MS: "0",
  });
  return {
    root,
    bin,
    mock,
    calls: () => readCalls(callLog),
    async cleanup() {
      restoreEnvironment(previous);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function fixture() {
  const context = await reviewerFixture("codex", `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const output = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ model, args, prompt }) + "\\n");
writeFileSync(output, process.env.MOCK_REVIEW_RESPONSE);
`);
  process.env.CODEX_HOME = path.join(context.root, "codex");
  const sessions = path.join(process.env.CODEX_HOME, "sessions", "2026", "08", "26");
  const transcript = path.join(sessions, "rollout.jsonl");
  const turnId = "turn-test";

  // Codex sends a rollout path with every stop. The owner prompt, the nudge
  // reader, and the quiet wait read it; the count never does — the turn id
  // beside it keys the tally.
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

  return {
    ...context,
    input: {
      session_id: "session-test",
      transcript_path: transcript,
      turn_id: turnId,
      model: "gpt-5.5",
      stop_hook_active: false,
      last_assistant_message: "Candidate final response.",
    },
  };
}

async function claudeFixture() {
  const context = await reviewerFixture("claude", `import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const value = process.env.MOCK_REVIEW_RESPONSE;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ model, args, prompt }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "\\n" + value + "\\n" }));
const pad = Number(process.env.MOCK_REVIEW_PAD || 0);
if (pad > 0) process.stdout.write("y".repeat(pad));
`);
  process.env.CLAUDE_CONFIG_DIR = path.join(context.root, "claude");
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-tmp-project");
  const transcript = path.join(projects, "session-test.jsonl");
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

  return {
    ...context,
    input: {
      session_id: "session-test",
      transcript_path: transcript,
      stop_hook_active: false,
      last_assistant_message: "Candidate final response.",
      background_tasks: [],
      session_crons: [],
    },
  };
}

async function ghostFixture() {
  const context = await reviewerFixture("ghost", `import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input), reviewing: process.env.KEEP_GOING_REVIEWING ?? null }) + "\\n");
process.stdout.write(JSON.stringify({ text: process.env.MOCK_REVIEW_RESPONSE }));
`);
  const ghostHome = path.join(context.root, "ghosts", "casper");
  await mkdir(ghostHome, { recursive: true });
  return {
    ...context,
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
  };
}

test("STOP accepts the stop", async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const output = await handleStop(context.input, "codex");
    assert.deepEqual(output, {});
    const calls = await context.calls();
    assert.deepEqual(calls.map((item) => item.model), ["gpt-5.5"]);
    assert.ok(calls[0].args.includes('model_reasoning_effort="low"'));
    assert.match(calls[0].prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.match(calls[0].prompt, /"owner_prompt":"Build it now. token=\[REDACTED\]"/);
    assert.doesNotMatch(calls[0].prompt, /supersecretvalue/);
    const [audit] = await auditRows();
    assert.equal(audit.verdict, "STOP");
    assert.equal(audit.rationale, "");
    assert.equal(audit.reviewer_output, "STOP");
  } finally {
    await context.cleanup();
  }
});

test("audit keeps the reviewer's raw text", async () => {
  const context = await fixture();
  try {
    await handleStop(context.input, "codex", { runModel: async () => "CONTINUE\nKeep going, finish it." });
    await handleStop(context.input, "codex", { runModel: async () => `STOP\n${"x".repeat(5000)}` });
    await handleStop(context.input, "codex", { runModel: async () => "just thinking out loud" });
    const [continueRow, longRow, invalidRow] = await auditRows();
    assert.equal(continueRow.verdict, "CONTINUE");
    assert.equal(continueRow.rationale, NUDGES[0]);
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

test("stub final messages without an owner prompt skip review", async () => {
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

test("last_assistant_message is reviewed when the transcript is unavailable", async () => {
  const context = await fixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop({ ...context.input, transcript_path: null }, "codex");
    assert.deepEqual(output, { decision: "block", reason: NUDGES[0] });
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
  await rm(context.mock);
  const output = await handleStop(context.input, "codex");
  assert.match(output.systemMessage, /ENOENT/);
  assert.equal(await recordedContinuations(context.input, "codex"), 0);
});

test("Claude counting starts at the last genuine prompt and counts only hook feedback", async () => {
  const context = await claudeFixture();
  try {
    assert.equal((await claudeNudges(context.input)).continuations, 0);

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

    assert.equal((await claudeNudges(context.input)).continuations, 1);
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Do one more thing.");
  } finally {
    await context.cleanup();
  }
});

test("an interruption is not a new owner prompt", async () => {
  // The marker the harness writes when a turn ends early carries none of the
  // flags the other injected records carry, so only its exact text keeps it
  // from restarting the count or becoming the request to judge against. An
  // interruption is the owner cutting a turn short, not asking for something.
  const context = await claudeFixture();
  try {
    const owner = { type: "user", message: { role: "user", content: "Fix the thing." }, origin: { kind: "human" } };
    const feedback = { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: continue" } };
    await appendRecords(context.input.transcript_path, [owner, feedback, feedback].map((r) => JSON.stringify(r)));
    assert.equal((await claudeNudges(context.input)).continuations, 2);

    for (const content of ["[Request interrupted by user]", "  [Request interrupted by user for tool use]  "]) {
      await appendRecords(context.input.transcript_path, [JSON.stringify({ type: "user", message: { role: "user", content } })]);
    }
    assert.equal((await claudeNudges(context.input)).continuations, 2);
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Fix the thing.");

    // Interrupting and then typing is the ordinary way to redirect a turn, and
    // the harness leads that message with the same text. Everything past the
    // marker is the owner's, so the record stays theirs and starts a new turn.
    await appendRecords(context.input.transcript_path, [JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "[Request interrupted by user] do the other thing instead" },
    })]);
    assert.equal((await claudeNudges(context.input)).continuations, 0);
    assert.match(await resolveOwnerPrompt(context.input, "claude"), /do the other thing instead/);
  } finally {
    await context.cleanup();
  }
});

test("Codex reads its own nudges, and neither they nor a subagent open a turn", async () => {
  // Codex records this hook's nudge as a user message in the turn it
  // continues, and a subagent reporting back the same way. Neither is the
  // owner: read as one, the nudge became the request the next stop was judged
  // against, and either would restart the count.
  const context = await fixture();
  try {
    const user = (text) => transcriptLine({ role: "user", content: [{ type: "input_text", text }] }, "turn-test");
    await appendRecords(context.input.transcript_path, [
      user('<hook_prompt hook_run_id="stop:9:/x/hooks.json">Keep going.</hook_prompt>'),
      user("<subagent_notification>agent 3 finished</subagent_notification>"),
      user("<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>"),
    ]);
    assert.equal(await resolveOwnerPrompt(context.input, "codex"), "Build it now. token=supersecretvalue");
    assert.deepEqual(await codexNudges(context.input), { continuations: 1, held: true });

    // Any tool item after the nudge is work done on it.
    await appendRecords(context.input.transcript_path, [
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec" } }),
    ]);
    assert.deepEqual(await codexNudges(context.input), { continuations: 1, held: false });
  } finally {
    await context.cleanup();
  }
});

test("running a command is not asking for anything", async () => {
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
    assert.equal((await claudeNudges(context.input)).continuations, 1);

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

    assert.equal((await claudeNudges(context.input)).continuations, 1);
    assert.equal(await resolveOwnerPrompt(context.input, "claude"), "Fix the thing.");

    // A slash command is the owner invoking something on purpose, so it still
    // opens a turn: the skills among them are the whole of the request.
    await appendRecords(context.input.transcript_path, [JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "<command-message>simplify</command-message> <command-name>/simplify</command-name>" },
    })]);
    assert.equal((await claudeNudges(context.input)).continuations, 0);
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
  assert.equal((await claudeNudges(context.input)).continuations, 0);
  await appendRecords(context.input.transcript_path, [owner, feedback, feedback].map((record) => JSON.stringify(record)));
  assert.equal((await claudeNudges(context.input)).continuations, 2);
  await appendRecords(context.input.transcript_path, [JSON.stringify(owner), "incomplete JSON"]);
  assert.equal((await claudeNudges(context.input)).continuations, 0);
});

test("Claude classifies with no tools and the lowest advertised effort", async () => {
  const context = await claudeFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const output = await handleStop(context.input, "claude");
    assert.deepEqual(output, {});
    const [call] = await context.calls();
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "low");
    assert.ok(call.args.includes("--safe-mode"));
    assert.ok(call.args.includes("--no-session-persistence"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.ok(!call.args.includes("--json-schema"));
    assert.match(call.prompt, /Reply with CONTINUE or STOP and nothing else/);
    assert.match(call.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.match(call.prompt, /"owner_prompt":"Build it now. token=\[REDACTED\]"/);
    assert.doesNotMatch(call.prompt, /supersecretvalue/);
  } finally {
    await context.cleanup();
  }
});

test("every reviewer runs on the host's own model", async () => {
  // Codex names the session's model in its stop and runs its reviewer without
  // the owner's config, so the stop's model is passed on. The other CLIs keep
  // their own configured default, so no model is named. Muse's stop has a
  // model field too, but a captured one read "unknown".
  for (const [runner, fixtureFor, expected] of [
    ["codex", fixture, "gpt-5.5"],
    ["claude", claudeFixture, undefined],
    ["muse", museFixture, undefined],
    ["grok", grokFixture, undefined],
  ]) {
    const context = await fixtureFor();
    try {
      process.env.MOCK_REVIEW_RESPONSE = "STOP";
      await handleStop(context.input, runner);
      const [call] = await context.calls();
      const named = call.args.includes("--model") ? call.args[call.args.indexOf("--model") + 1] : undefined;
      assert.equal(named, expected, `${runner} reviewed on ${named}`);
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
      await writeFile(context.mock, `#!${process.execPath}
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

test("Ghost delegates classification to ghostd, marked as a reviewer", async () => {
  const context = await ghostFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(context.input, "ghost");
    assert.deepEqual(output, { decision: "block", reason: NUDGES[0] });
    const [call] = await context.calls();
    assert.deepEqual(call.args, ["hook-complete"]);
    // ghostd's harness runs the owner's own hooks; this one must not review it.
    assert.equal(call.reviewing, "1");
    assert.equal(call.input.ghost_home, context.input.ghost_home);
    assert.match(call.input.prompt, /Reply with CONTINUE or STOP/);
    assert.match(call.input.prompt, /"last_assistant_message":"Candidate final response\."/);
    assert.match(call.input.prompt, /"owner_prompt":"Please finish the requested change\."/);
  } finally {
    await context.cleanup();
  }
});

test("Ghost stops are reviewed without a quiet wait, since Ghost lets the owner's follow-up win itself", async () => {
  const context = await ghostFixture();
  try {
    // ghostd sends the conversation log, which a queued follow-up reaches
    // only after this hook returns.
    const log = path.join(context.input.ghost_home, "sessions", "c1", ".conversation.jsonl");
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, `${JSON.stringify({ type: "user", text: "Please finish the requested change." })}\n`);
    process.env.KEEP_GOING_QUIET_MS = "60000";
    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    const started = Date.now();
    assert.deepEqual(await handleStop({ ...context.input, transcript_path: log }, "ghost"), {});
    assert.ok(Date.now() - started < 10_000, "a ghost stop waited for a follow-up it cannot see");
  } finally {
    await context.cleanup();
  }
});

test("the verdict is the first CONTINUE or STOP standing as a word, wherever the reviewer puts it", () => {
  for (const verdict of ["CONTINUE", "STOP"]) {
    assert.equal(parseReviewVerdict(` ${verdict}\n`), verdict);
  }
  for (const invalid of ["continue", "CONTINUEX", "STOPPED", "THINK", "RESCAN", "{}", "", null, undefined]) {
    assert.throws(() => parseReviewVerdict(invalid), /must be CONTINUE or STOP/);
  }
  assert.equal(parseReviewVerdict("I'll check the session state.\nSTOP"), "STOP");
  assert.equal(parseReviewVerdict("I'll inspect the workspace to see if the turn finished.STOP"), "STOP");
  assert.equal(parseReviewVerdict("CONTINUECONTINUE"), "CONTINUE");
  assert.equal(parseReviewVerdict("STOP — done, nothing to CONTINUE"), "STOP");
  // Linear, however long the reply.
  const started = Date.now();
  assert.equal(parseReviewVerdict(`${" -".repeat(100_000)}STOP`), "STOP");
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
});

test("the agent hears a fixed line, never the reviewer's", async () => {
  // Observed: an owner typed "spice.trade" for spicy.trade; the agent checked
  // and asked, and a reviewer that wrote its own line pushed the typo back as
  // "You said ... as instructed" until a dead link shipped. Another claimed
  // "Owner said 'Agreed with all' — commit and push". The reviewer now only
  // decides; what it writes beyond the verdict goes to the audit log alone.
  const context = await fixture();
  try {
    const output = await handleStop(context.input, "codex", {
      runModel: async () => "CONTINUE\nYou said spice.trade, so point the link there.",
    });
    assert.deepEqual(output, { decision: "block", reason: NUDGES[0] });
    assert.match((await auditRows())[0].reviewer_output, /spice\.trade/);
  } finally {
    await context.cleanup();
  }
  // Rotated, so a hundred continuations do not read as one stuck loop.
  assert.deepEqual(NUDGES.map((_, index) => hookOutputForVerdict("CONTINUE", index).reason), NUDGES);
  assert.equal(new Set(NUDGES).size, NUDGES.length);
  assert.deepEqual(hookOutputForVerdict("STOP", 3), {});
});

test("waiting on the owner ends the turn, and the reviewer does not second-guess the agent", () => {
  assert.match(REVIEW_PROMPT, /consent to deploy, publish, send, spend,\s+or delete/);
  assert.match(REVIEW_PROMPT, /which reading of their words they\s+meant/);
  assert.match(REVIEW_PROMPT, /Do not second-guess its findings/);
});

// A Grok session on disk: the updates log the stop names, its owner's chat
// history beside it, and the stop input pointing at the log.
async function grokSession(context) {
  const sessionDir = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent("/tmp/project"), context.input.session_id);
  await mkdir(sessionDir, { recursive: true });
  const updates = path.join(sessionDir, "updates.jsonl");
  await writeFile(updates, "{}\n");
  return {
    sessionDir,
    chat: path.join(sessionDir, "chat_history.jsonl"),
    input: { ...context.input, transcript_path: updates },
  };
}

async function grokFixture() {
  const context = await reviewerFixture("grok", `import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({
  args,
  grokHookEvent: process.env.GROK_HOOK_EVENT ?? null,
  grokHome: process.env.GROK_HOME ?? null,
  overlayHasConfig: process.env.GROK_HOME ? existsSync(path.join(process.env.GROK_HOME, "config.toml")) : false,
}) + "\\n");
process.stdout.write(process.env.MOCK_REVIEW_RESPONSE + "\\n");
`);
  process.env.GROK_HOME = path.join(context.root, "grok-home");
  return {
    ...context,
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
  };
}

async function museFixture() {
  const context = await reviewerFixture("muse", `import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
`);
  // The reviewer restores the default home's auth into its hook-free overlay,
  // so the fixture home carries a credential to be restored.
  process.env.HOME = path.join(context.root, "home");
  await mkdir(path.join(process.env.HOME, ".config", "muse"), { recursive: true });
  await writeFile(path.join(process.env.HOME, ".config", "muse", "auth.json"), "fixture-auth");
  return {
    ...context,
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
  };
}

test("a subagent is capped on its own account, not its parent's", async () => {
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

test("Grok is reviewed by Grok, on the message spelling it actually sends", async () => {
  const context = await grokFixture();
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    const output = await handleStop(context.input, "grok");
    assert.deepEqual(output, { decision: "block", reason: NUDGES[0] });

    // The overlay is a fresh GROK_HOME so the reviewer does not inherit MCP,
    // plugins, or the parent session's agent. --single still dispatches no
    // stop hook, so it cannot re-enter this one.
    const [call] = await context.calls();
    assert.ok(call.args.includes("--single"));
    assert.ok(call.args.includes("--verbatim"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "low");
    assert.equal(
      call.args[call.args.indexOf("--system-prompt-override") + 1],
      "Reply with exactly CONTINUE or STOP. No preamble, no analysis.",
    );
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.match(call.args[call.args.indexOf("--single") + 1], /Candidate final response\./);
    assert.equal(call.grokHookEvent, null);
    assert.ok(call.grokHome.endsWith(`${path.sep}home`));
    assert.notEqual(call.grokHome, process.env.GROK_HOME);
    assert.equal(call.overlayHasConfig, true);

    // A Grok nudge lands in the agent's reasoning, leaving nothing in the
    // transcript to count, so the tally is the cap.
    const [row] = await auditRows();
    assert.equal(row.counted_by, "tally");
    assert.equal(await recordedContinuations(context.input, "grok"), 1);
    assert.match(call.args[call.args.indexOf("--single") + 1], /"owner_prompt":""/);
  } finally {
    await context.cleanup();
  }
});

test("Grok recovers owner_prompt from chat_history", async () => {
  const context = await grokFixture();
  try {
    const { chat, input } = await grokSession(context);
    await writeFile(
      chat,
      `${JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Ship the hook.</user_query>" }] })}\n`,
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

test("Grok reads the chat log's wrapper blocks as nobody's prompt", async () => {
  // What the owner typed is tagged in the chat log. The untagged blocks
  // beside it — <user_info> and friends — are the log's own, and prompt
  // recovery takes none of them.
  const context = await grokFixture();
  try {
    const { chat, input } = await grokSession(context);
    await writeFile(chat, [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Ship the hook.</user_query>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>cwd=/home/dous shell=bash</user_info>" }] }),
    ].join("\n") + "\n");
    assert.equal(await resolveOwnerPrompt(input, "grok"), "Ship the hook.");
  } finally {
    await context.cleanup();
  }
});

test("Grok-dispatched Claude settings are reviewed by grok, not claude", async () => {
  const context = await grokFixture();
  const claudeBin = path.join(context.bin, "claude");
  try {
    await writeFile(claudeBin, `#!${process.execPath}\nprocess.exit(2);\n`);
    await chmod(claudeBin, 0o755);
    process.env.GROK_HOOK_EVENT = "stop";
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";

    assert.equal(await yieldsToGrokNative("claude"), false);
    const output = await handleStop(context.input, "claude");
    assert.deepEqual(output, { decision: "block", reason: NUDGES[0] });

    const [call] = await context.calls();
    assert.ok(call.args.includes("--single"));
    assert.ok(!call.args.includes("--print"));
    assert.equal(call.grokHookEvent, null);
  } finally {
    await context.cleanup();
  }
});

test("a harness running a ghost's turn yields to Ghost's own stop hook", async () => {
  const context = await grokFixture();
  try {
    process.env.GHOST = "dous";
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    for (const runner of ["codex", "claude", "grok", "muse", "pi"]) {
      assert.deepEqual(await handleStop(context.input, runner), {});
    }
    assert.deepEqual(await context.calls(), []);
  } finally {
    delete process.env.GHOST;
    await context.cleanup();
  }
});

test("a Muse hook, which gets no environment, knows a ghost's turn by its conversation directory", async () => {
  const context = await museFixture();
  const conversation = await mkdtemp(path.join(tmpdir(), "ghost-conversation-"));
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    await writeFile(path.join(conversation, ".conversation.jsonl"), "");
    assert.deepEqual(await handleStop({ ...context.input, cwd: conversation }, "muse"), {});
    assert.deepEqual(await context.calls(), []);
    // The same stop outside a ghost conversation is reviewed.
    assert.notDeepEqual(await handleStop({ ...context.input, cwd: tmpdir() }, "muse"), {});
  } finally {
    await rm(conversation, { recursive: true, force: true });
    await context.cleanup();
  }
});

test("a native Grok hook makes the Claude-settings copy yield", async () => {
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
    assert.deepEqual(native, { decision: "block", reason: NUDGES[0] });
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("Muse counts against the turn id it sends", async () => {
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

test("Muse is reviewed by muse exec in a hook-free overlay", async () => {
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
    assert.ok(call.configHome, "reviewer ran without a config overlay");
    assert.equal(call.overlayHasSettings, false);
    assert.equal(call.overlayHasAuth, true);

    // The reviewer sees the redacted final message and nothing else: no cwd,
    // no transcript content.
    assert.match(call.prompt, /Reply with CONTINUE or STOP/);
    assert.match(call.prompt, /"owner_prompt":""/);
    assert.doesNotMatch(call.prompt, /supersecretvalue/);
    assert.match(call.prompt, /token=\[REDACTED\]/);
    assert.doesNotMatch(call.prompt, /\/tmp\/project/);
  } finally {
    await context.cleanup();
  }
});

test("Muse blocks an empty final message once, then accepts the retry", async () => {
  const context = await museFixture();
  try {
    const input = { session_id: "session-empty", last_assistant_message: "" };
    const first = await handleStop(input, "muse");
    assert.equal(first.decision, "block");
    assert.match(first.reason, /did not see your last message/);
    assert.deepEqual(await handleStop({ ...input, stop_hook_active: true }, "muse"), {});
    // Both stops leave a row.
    const rows = await auditRows();
    assert.deepEqual(rows.map((row) => [row.verdict, row.counted_by]), [["CONTINUE", "empty"], ["STOP", "empty"]]);
    assert.equal(rows[0].rationale, first.reason);
    assert.equal(rows[1].rationale, "no last message on retry");
  } finally {
    await context.cleanup();
  }
});

test("Grok's camelCase stopHookActive lets an empty retry end", async () => {
  const context = await grokFixture();
  try {
    const input = { ...context.input, lastAssistantMessage: "" };
    assert.equal((await handleStop(input, "grok")).decision, "block");
    assert.deepEqual(await handleStop({ ...input, stopHookActive: true }, "grok"), {});
    assert.deepEqual(await context.calls(), []);
  } finally {
    await context.cleanup();
  }
});

test("a fresh stop waits out the quiet delay before any review", async () => {
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

test("a follow-up during the quiet wait lets the stop through unreviewed", async () => {
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

test("the host's own writes during the quiet wait are not a follow-up", async () => {
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
          JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
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

test("an owner message queued during the quiet wait lets a Claude stop through", async () => {
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

test("a retry, a subagent, and a stop with no transcript skip the quiet wait", async () => {
  // A retry already waited once; a subagent's owner is the parent agent, which
  // is waiting on it; and Muse sends transcript_path null, so no follow-up
  // could ever be observed.
  for (const [runner, fixtureFor, extra] of [
    ["codex", fixture, { stop_hook_active: true }],
    ["claude", claudeFixture, { agent_id: "agent-1" }],
    ["muse", museFixture, {}],
  ]) {
    const context = await fixtureFor();
    try {
      process.env.MOCK_REVIEW_RESPONSE = "STOP";
      process.env.KEEP_GOING_QUIET_MS = "60000";
      const output = await handleStop({ ...context.input, ...extra }, runner, {
        delay: async () => { throw new Error(`${runner} waited`); },
      });
      assert.deepEqual(output, {});
      assert.equal((await context.calls()).length, 1);
    } finally {
      await context.cleanup();
    }
  }
});

test("Grok's quiet wait watches the chat history beside the updates log", async () => {
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

test("the quiet wait defaults to fifteen seconds and parses defensively", () => {
  const previous = process.env.KEEP_GOING_QUIET_MS;
  try {
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

test("a Claude agent that holds after a nudge is not reviewed again", async () => {
  // The hook advances a session; it does not argue with the agent. A nudge
  // the agent answered with work earns another review. One it answered with
  // no tool at all was weighed and declined, and the stop goes through.
  const context = await claudeFixture();
  try {
    let reviews = 0;
    const runModel = async () => { reviews += 1; return "CONTINUE"; };
    const feedback = JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback:\nKeep going." } });
    const tool = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } });
    const said = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

    assert.deepEqual(await claudeNudges(context.input), { continuations: 0, held: false });
    assert.equal((await handleStop(context.input, "claude", { runModel })).decision, "block");

    await appendRecords(context.input.transcript_path, [feedback, tool, said("Checked; the domain in the request looks like a typo. Which did you mean?")]);
    assert.deepEqual(await claudeNudges(context.input), { continuations: 1, held: false });
    assert.equal((await handleStop(context.input, "claude", { runModel })).decision, "block");
    assert.equal(reviews, 2);

    await appendRecords(context.input.transcript_path, [feedback, said("I still need your answer on the domain.")]);
    assert.deepEqual(await claudeNudges(context.input), { continuations: 2, held: true });
    assert.deepEqual(await handleStop(context.input, "claude", { runModel }), {});
    assert.equal(reviews, 2);
    const row = (await auditRows()).at(-1);
    assert.equal(row.verdict, "HELD");
    assert.equal(row.counted_by, "transcript");

    // A subagent's stop carries its parent's transcript, so the parent's
    // holding is not the subagent's.
    assert.equal((await handleStop({ ...context.input, agent_id: "agent-1" }, "claude", { runModel })).decision, "block");
  } finally {
    await context.cleanup();
  }
});

test("the tally caps a turn the transcript cannot", async () => {
  // A Claude stop with no transcript to read is still counted, and capped, by
  // the tally.
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
  // The build stamps the version and writes both hook files, so the committed
  // copies must equal what it emits — a hand edit, or a release that skipped
  // `npm run build`, fails here.
  const readText = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
  const { version } = JSON.parse(await readText("../package.json"));
  for (const relative of VERSIONED) {
    const source = await readText(`../${relative}`);
    assert.equal(source, stampVersion(source, version), `${relative} is not stamped ${version}`);
  }
  for (const runner of Object.keys(HOOK_FILES)) {
    const source = await readText(`../${HOOK_FILES[runner].file}`);
    assert.equal(source, hookFile(runner, source), `${HOOK_FILES[runner].file} does not carry the ${runner} hooks`);
  }
  // Codex and Claude Code both load hooks/hooks.json from a plugin whatever its
  // manifest says, so a hook there runs on the host it wasn't written for.
  await assert.rejects(readText("../plugins/keep-going/hooks/hooks.json"), { code: "ENOENT" });

  // Generation makes the two hook files agree with one table, not with each
  // other, so the host-specific halves are still spelled out: a swap in that
  // table would emit two self-consistent files that fail open on every stop.
  const hookText = (runner) => JSON.stringify(hookConfig(runner), null, 2);
  assert.match(hookText("codex"), /node \\"\$PLUGIN_ROOT\/scripts\/keep-going\.mjs\\" codex/);
  assert.match(
    hookText("claude"),
    /node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/keep-going\.mjs\\" claude/,
  );

  // Claude finds its hook file through the manifest, which is hand-written.
  const claude = JSON.parse(await readText("../plugins/keep-going/.claude-plugin/plugin.json"));
  assert.equal(path.posix.join("plugins/keep-going", claude.hooks), HOOK_FILES.claude.file);
});

test("the shipped plugin bundles no runtime dependency", async () => {
  // The hook stays cheap to install and start: no runtime dependency, and a
  // bundle under a size cap that is raised only when src grows on purpose.
  // The drift check proves the bundle matches src, not that src stayed
  // dependency-free; this does.
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

test("Ghost's turn is its owner prompt, and its tally lives in the ghost home", async () => {
  const context = await ghostFixture();
  const tallyFile = path.join(context.input.ghost_home, "keep-going", "continuations.json");
  try {
    process.env.MOCK_REVIEW_RESPONSE = "CONTINUE";
    assert.equal((await handleStop(context.input, "ghost")).decision, "block");

    // Ghost declares where its state belongs: the count is written inside the
    // ghost home.
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

test("the hook runs when reached through a symlink", async () => {
  // Hosts often reach it through a symlinked home or plugin directory; a run
  // that printed nothing would read to them as an accepted stop.
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-symlink-"));
  try {
    const linked = path.join(root, "src");
    await symlink(path.join(import.meta.dirname, "..", "src"), linked);
    const child = spawn(process.execPath, [path.join(linked, "keep-going.mjs"), "claude"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stdin.end("{}");
    await new Promise((resolve) => child.on("close", resolve));
    assert.match(stdout, /keep-going failed open: Stop input is missing session_id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hook names no default runner: a command without one fails open", async () => {
  const entry = path.join(import.meta.dirname, "..", "src", "keep-going.mjs");
  const child = spawn(process.execPath, [entry], { env: { PATH: "" }, stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stdin.end(JSON.stringify({ session_id: "s", last_assistant_message: "Done." }));
  await new Promise((resolve) => child.on("close", resolve));
  assert.match(JSON.parse(stdout).systemMessage, /keep-going failed open: Unsupported keep-going runtime/);
});

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

test("a reviewer that floods stdout is cut off at the output limit", async () => {
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
