import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { KeepGoing } from "../src/opencode.mjs";
import ompKeepGoing from "../src/omp.mjs";

const HOOK = path.resolve(import.meta.dirname, "..", "src", "keep-going.mjs");

// Each host runs the hook as a command: stdin in, one JSON answer out. A mock
// reviewer records the prompt it was asked and answers MOCK_REVIEW_RESPONSE.
async function hostFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-hosts-"));
  const reviewer = path.join(root, "reviewer.mjs");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(reviewer, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MOCK_CALL_LOG, JSON.stringify({ args: process.argv.slice(2), reviewing: process.env.KEEP_GOING_REVIEWING ?? null }) + "\\n");
process.stdout.write(process.env.MOCK_REVIEW_RESPONSE);
`);
  await chmod(reviewer, 0o755);
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    COPILOT_HOME: path.join(root, "home", ".copilot"),
    KEEP_GOING_COPILOT_BIN: reviewer,
    KEEP_GOING_AGY_BIN: reviewer,
    KEEP_GOING_CURSOR_BIN: reviewer,
    KEEP_GOING_QUIET_MS: "0",
    MOCK_CALL_LOG: calls,
    MOCK_REVIEW_RESPONSE: "CONTINUE",
  };
  return {
    root,
    env,
    async run(runner, input, extra = {}) {
      const child = spawn(process.execPath, [HOOK, runner], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stdin.end(JSON.stringify(input));
      await new Promise((resolve) => child.on("close", resolve));
      return JSON.parse(out);
    },
    async calls() {
      const text = await readFile(calls, "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function jsonl(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

test("Copilot: reads the reply and request from events.jsonl and blocks to continue", async () => {
  const context = await hostFixture();
  try {
    const transcript = path.join(context.env.COPILOT_HOME, "session-state", "s1", "events.jsonl");
    await jsonl(transcript, [
      { type: "user.message", data: { content: "Fix the build" } },
      { type: "assistant.message", data: { content: "I started on it." } },
      { type: "user.message", data: { content: "Keep going." } },
      { type: "assistant.message", data: { content: "Half done; next I update the tests." } },
    ]);
    const stop = { sessionId: "s1", cwd: context.root, transcriptPath: transcript, stopReason: "end_turn", stop_hook_active: false };
    assert.deepEqual(await context.run("copilot", stop), { decision: "block", reason: "Keep going." });
    const [call] = await context.calls();
    const asked = call.args[call.args.indexOf("-p") + 1];
    // The nudge is not the request; the latest reply is the one reviewed.
    assert.match(asked, /"owner_prompt":"Fix the build"/);
    assert.match(asked, /Half done; next I update the tests/);
    assert.equal(call.reviewing, "1");

    // Any other stop reason is not a stop to review.
    assert.deepEqual(await context.run("copilot", { ...stop, stopReason: "error" }), {});
    assert.equal((await context.calls()).length, 1);
  } finally {
    await context.cleanup();
  }
});

test("Antigravity: reviews a model_stop from its transcript and answers continue", async () => {
  const context = await hostFixture();
  try {
    const transcript = path.join(context.env.HOME, ".gemini", "antigravity-cli", "brain", "c1", ".system_generated", "logs", "transcript_full.jsonl");
    await jsonl(transcript, [
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>\nShip the docs\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" },
      { type: "PLANNER_RESPONSE", source: "MODEL", content: "" },
      { type: "PLANNER_RESPONSE", source: "MODEL", content: "Drafted two of five pages." },
    ]);
    const stop = { conversationId: "c1", transcriptPath: transcript, terminationReason: "MODEL_STOP", workspacePaths: [context.root] };
    assert.deepEqual(await context.run("agy", stop), { decision: "continue", reason: "Keep going." });
    const [call] = await context.calls();
    const asked = call.args[call.args.indexOf("-p") + 1];
    assert.match(asked, /"owner_prompt":"Ship the docs"/);
    assert.match(asked, /Drafted two of five pages/);

    assert.deepEqual(await context.run("agy", { ...stop, terminationReason: "ERROR" }), {});
    context.env.MOCK_REVIEW_RESPONSE = "STOP";
    assert.deepEqual(await context.run("agy", stop, { MOCK_REVIEW_RESPONSE: "STOP" }), {});
  } finally {
    await context.cleanup();
  }
});

test("Cursor: records the prompt and reply from their hooks and reviews at stop", async () => {
  const context = await hostFixture();
  try {
    const base = { conversation_id: "cv1", cursor_version: "2026.10.01" };
    assert.deepEqual(await context.run("cursor", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Refactor the parser" }), {});
    assert.deepEqual(await context.run("cursor", { ...base, hook_event_name: "afterAgentResponse", text: "Split it into two files so far." }), {});
    // A nudge Cursor resubmits as the next prompt is not the owner's request.
    assert.deepEqual(await context.run("cursor", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Keep going." }), {});
    assert.deepEqual(await context.calls(), []);

    const stop = { ...base, hook_event_name: "stop", status: "completed", loop_count: 0 };
    assert.deepEqual(await context.run("cursor", stop), { followup_message: "Keep going." });
    const [call] = await context.calls();
    const asked = call.args.at(-1);
    assert.match(asked, /"owner_prompt":"Refactor the parser"/);
    assert.match(asked, /Split it into two files so far/);

    assert.deepEqual(await context.run("cursor", { ...stop, status: "aborted" }), {});
  } finally {
    await context.cleanup();
  }
});

test("Cursor's run of Claude's settings hook yields to Cursor's own", async () => {
  const context = await hostFixture();
  try {
    assert.deepEqual(
      await context.run("claude", { session_id: "cv1", cursor_version: "2026.10.01", hook_event_name: "stop", status: "completed" }),
      {},
    );
    assert.deepEqual(await context.calls(), []);
  } finally {
    await context.cleanup();
  }
});

test("a reviewer's own stop is never reviewed", async () => {
  const context = await hostFixture();
  try {
    const stop = { sessionId: "s1", cwd: context.root, stopReason: "end_turn" };
    assert.deepEqual(await context.run("copilot", stop, { KEEP_GOING_REVIEWING: "1" }), {});
    assert.deepEqual(await context.calls(), []);
  } finally {
    await context.cleanup();
  }
});

// A fake OpenCode client: the session's messages, and what the plugin sends.
function opencodeClient(messages, { parentID } = {}) {
  const sent = [];
  return {
    sent,
    session: {
      get: async () => ({ data: { id: "ses_1", ...(parentID ? { parentID } : {}) } }),
      messages: async () => ({ data: messages }),
      promptAsync: async ({ path: where, body }) => { sent.push({ id: where.id, text: body.parts[0].text }); },
    },
  };
}

const said = (role, text, extra = {}) => ({ info: { role, id: `msg_${role}_${text.length}`, ...extra }, parts: [{ type: "text", text }] });

test("OpenCode: an idle session whose work remains gets the nudge as its next message", async () => {
  const context = await hostFixture();
  const saved = { ...process.env };
  Object.assign(process.env, context.env, { KEEP_GOING_OPENCODE_BIN: context.env.KEEP_GOING_COPILOT_BIN });
  try {
    const client = opencodeClient([
      said("user", "Port the parser"),
      said("assistant", "Ported two of five modules."),
      said("user", "Keep going."),
      said("assistant", "Ported four of five modules."),
    ]);
    const plugin = await KeepGoing({ client, directory: context.root });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.deepEqual(client.sent, [{ id: "ses_1", text: "Keep going." }]);
    const [call] = await context.calls();
    assert.equal(call.args[0], "run");
    assert.ok(call.args.includes("--pure"));
    assert.match(call.args.at(-1), /"owner_prompt":"Port the parser"/);
    assert.match(call.args.at(-1), /Ported four of five modules/);

    // A subagent's session, and an errored reply, are left alone.
    const sub = opencodeClient([said("user", "x"), said("assistant", "y")], { parentID: "ses_0" });
    await (await KeepGoing({ client: sub, directory: context.root })).event({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
    const failed = opencodeClient([said("user", "x"), said("assistant", "y", { error: { name: "MessageAbortedError" } })]);
    await (await KeepGoing({ client: failed, directory: context.root })).event({ event: { type: "session.idle", properties: { sessionID: "ses_3" } } });
    assert.deepEqual([sub.sent, failed.sent], [[], []]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await context.cleanup();
  }
});

test("Oh My Pi: session_stop blocks with the nudge while work remains", async () => {
  const context = await hostFixture();
  const saved = { ...process.env };
  Object.assign(process.env, context.env, { KEEP_GOING_OMP_BIN: context.env.KEEP_GOING_COPILOT_BIN });
  try {
    const handlers = {};
    ompKeepGoing({ on: (event, handler) => { handlers[event] = handler; } });
    const text = (role, value) => ({ role, content: [{ type: "text", text: value }] });
    const event = {
      type: "session_stop",
      session_id: "omp-1",
      turn_id: 3,
      messages: [text("user", "Write the migration"), text("assistant", "Wrote half."), text("user", "Keep going.")],
      last_assistant_message: text("assistant", "Wrote the schema; the backfill is next."),
      stop_hook_active: false,
      signal: new AbortController().signal,
    };
    assert.deepEqual(await handlers.session_stop(event, { cwd: context.root }), { decision: "block", reason: "Keep going." });
    const [call] = await context.calls();
    assert.ok(call.args.includes("--no-extensions"));
    assert.match(call.args.at(-1), /"owner_prompt":"Write the migration"/);
    assert.match(call.args.at(-1), /the backfill is next/);

    process.env.MOCK_REVIEW_RESPONSE = "STOP";
    assert.equal(await handlers.session_stop(event, { cwd: context.root }), undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await context.cleanup();
  }
});
