import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import keepGoing, { reviewerModel, reviewReasoning, reviewWithPi } from "../src/pi.mjs";
import { CONTINUATION_CAP, handleStop } from "../src/keep-going.mjs";

const text = (value) => [{ type: "text", text: value }];
const reply = (value, stopReason = "stop") => ({ role: "assistant", content: text(value), stopReason });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-pi-test-"));
  const keys = ["KEEP_GOING_PI_MODEL", "KEEP_GOING_AUDIT_LOG", "XDG_STATE_HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.KEEP_GOING_PI_MODEL;
  process.env.KEEP_GOING_AUDIT_LOG = path.join(root, "audit.jsonl");
  process.env.XDG_STATE_HOME = root;
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  const branch = [{ id: "owner-1", type: "message", message: { role: "user", content: text("private owner request") } }];
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const sent = [];
  const notifications = [];
  const statuses = [];
  const abort = new AbortController();
  let nextId = 1;
  let pending = false;
  let reviewer = async () => reply("STOP");
  const model = { provider: "test", id: "active-model" };
  const alternative = { provider: "other", id: "vendor/reviewer" };
  const ctx = {
    cwd: "/private/workspace",
    model,
    signal: abort.signal,
    sessionManager: { getBranch: () => branch, getSessionId: () => "pi-session" },
    hasPendingMessages: () => pending || sent.length > 0,
    modelRegistry: {
      find: (provider, id) => provider === alternative.provider && id === alternative.id ? alternative : undefined,
      complete: async (...args) => { calls.push(args); return reviewer(...args); },
    },
    ui: {
      notify: (...args) => notifications.push(args),
      setStatus: (...args) => statuses.push(args),
    },
  };
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => branch.push({ id: `custom-${nextId++}`, type: "custom", customType, data }),
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  keepGoing(pi);
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return {
    root, ctx, pi, branch, calls, sent, notifications, statuses, abort, emit, alternative,
    review: (fn) => { reviewer = fn; },
    pending: (value) => { pending = value; },
    command: (args) => commands.get("keep-going").handler(args, ctx),
    finish: async (message = reply("Finished."), toolResults = []) => {
      branch.push({ id: `assistant-${nextId++}`, type: "message", message });
      await emit("turn_end", { message, toolResults });
    },
    deliver: () => {
      for (const { message } of sent.splice(0)) {
        branch.push({ id: `nudge-${nextId++}`, type: "custom_message", ...message });
      }
    },
    audit: async () => (await readFile(process.env.KEEP_GOING_AUDIT_LOG, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line)),
  };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition never became true");
}

test("Pi uses its active model and sends only the redacted final text", async (t) => {
  const f = await fixture(t);
  await f.finish(reply("Done. token=private-value"));
  assert.equal(f.calls.length, 1);
  const [model, context, options] = f.calls[0];
  assert.equal(model, f.ctx.model);
  assert.equal(context.messages.length, 1);
  assert.equal(context.tools, undefined);
  const prompt = context.messages[0].content[0].text;
  assert.match(prompt, /token=\[REDACTED\]/);
  assert.match(prompt, /"owner_prompt":"private owner request"/);
  assert.doesNotMatch(prompt, /private-value|private\/workspace/);
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.reasoning, false); // the fixture model does not reason
  assert.equal(f.sent.length, 0);
  const [row] = await f.audit();
  assert.equal(row.runner, "pi");
  assert.equal(row.counted_by, "session");
  assert.equal(row.reviewer_model, "test/active-model");
  // Native branch state replaces the standalone hook's tally.
  await assert.rejects(stat(path.join(f.root, "keep-going", "continuations.json")), { code: "ENOENT" });
});

test("Pi sends earlier turns for reviewer TURN requests", async (t) => {
  const f = await fixture(t);
  f.branch.unshift(
    { id: "assistant-0", type: "message", message: { role: "assistant", content: text("First done."), stopReason: "stop" } },
  );
  f.branch.unshift(
    { id: "owner-0", type: "message", message: { role: "user", content: text("First errand.") } },
  );
  await f.finish(reply("Second done."));
  assert.equal(f.calls.length, 1);
  const prompt = f.calls[0][1].messages[0].content[0].text;
  assert.match(prompt, /Past turns, oldest first/);
  assert.match(prompt, /1: First errand\./);
  assert.match(prompt, /"owner_prompt":"private owner request"/);
});

test("Pi model override is exact provider/model-id, including slashes in model IDs", async (t) => {
  const f = await fixture(t);
  process.env.KEEP_GOING_PI_MODEL = "other/vendor/reviewer";
  await f.finish();
  assert.equal(f.calls[0][0], f.alternative);
  for (const invalid of ["reviewer", "/reviewer", "provider/", "missing/model"]) {
    process.env.KEEP_GOING_PI_MODEL = invalid;
    assert.throws(() => reviewerModel(f.ctx));
  }
  delete process.env.KEEP_GOING_PI_MODEL;
  assert.throws(() => reviewerModel({ ...f.ctx, model: undefined }), /No Pi model/);
});

test("CONTINUE and THINK queue one custom follow-up, not a new owner prompt", async (t) => {
  const f = await fixture(t);
  for (const verdict of ["CONTINUE", "THINK"]) {
    f.review(async () => reply(`${verdict}\nWork it out first.`));
    await f.finish(reply("There is work left."));
    assert.deepEqual(f.sent, [{
      message: { customType: "keep-going", content: "Work it out first.", display: true },
      options: { deliverAs: "followUp", triggerTurn: true },
    }]);
    f.deliver();
  }
  assert.equal(f.branch.filter((e) => e.message?.role === "user").length, 1);
  assert.equal(f.calls.length, 2);
});

test("Pi marks a RESCAN on the branch and reports it spent on the next stop", async (t) => {
  const f = await fixture(t);
  f.review(async () => reply("RESCAN\nLook again."));
  await f.finish(reply("Everything is done."));
  assert.equal(f.sent.length, 1);
  assert.ok(f.branch.some((e) => e.type === "custom" && e.customType === "keep-going-rescan"));
  f.deliver();

  // The reviewer no longer has RESCAN to give; giving it anyway is no answer,
  // so the stop goes through with a warning, the way an unparseable one does.
  f.review(async () => reply("RESCAN\nLook again."));
  await f.finish(reply("The scan found nothing."));
  assert.equal(f.sent.length, 0);
  assert.match(f.notifications.at(-1)[0], /keep-going was skipped: Reviewer answered RESCAN, which was not offered/);
  const prompt = f.calls[1][1].messages[0].content[0].text;
  assert.match(prompt, /already asked for this turn/);
  assert.doesNotMatch(prompt, /RESCAN — the agent claims/);
  const rows = await f.audit();
  assert.equal(rows.at(-1).verdict, "ERROR");

  // A new owner turn starts with the scan on offer again.
  f.branch.push({ id: "owner-2", type: "message", message: { role: "user", content: text("next request") } });
  f.review(async () => reply("STOP"));
  await f.finish(reply("Done with the next thing."));
  assert.match(f.calls[2][1].messages[0].content[0].text, /RESCAN — the agent claims/);
});

test("Pi does not review twice, even when two copies of the extension are loaded", async (t) => {
  const f = await fixture(t);
  keepGoing(f.pi);
  await f.finish();
  const message = f.branch.findLast((e) => e.message?.role === "assistant").message;
  await f.emit("turn_end", { message, toolResults: [] });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.audit()).length, 1);
});

test("Pi skips tool turns, partial/error/aborted responses, empty text and queued work", async (t) => {
  const f = await fixture(t);
  for (const reason of ["toolUse", "length", "error", "aborted", "pending"]) {
    await f.finish(reply("Unfinished.", reason));
  }
  await f.finish({ ...reply("Tool call."), content: [...text("Tool call."), { type: "toolCall" }] });
  await f.finish(reply("Finished tool."), [{}]);
  await f.finish(reply(""));
  await f.finish({ role: "user", content: text("Not an assistant") });
  f.pending(true);
  await f.finish();
  f.pending(false);
  f.ctx.signal = undefined;
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test("Pi counts continuations on the active branch, survives reload, and caps without reviewing", async (t) => {
  const f = await fixture(t);
  f.review(async () => reply("CONTINUE"));
  for (let i = 0; i < CONTINUATION_CAP - 1; i++) {
    f.branch.push({ type: "custom_message", customType: "keep-going", content: "Keep going." });
  }
  // A freshly loaded copy still sees the persisted branch state and markers.
  keepGoing(f.pi);
  await f.finish(reply("Work remains."));
  assert.match(f.calls[0][1].messages[0].content[0].text, /near its limit/);
  assert.equal(f.sent.length, 1);
  f.deliver();
  await f.finish(reply("Work remains."));
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.audit()).at(-1).verdict, "CAP");
  // Repeating stop notifications cannot reset the cap or trigger a review.
  await f.finish(reply("Still work left."));
  assert.equal(f.calls.length, 1);
  // A new owner message starts at zero, even when the text is identical.
  f.branch.push({ id: "owner-2", type: "message", message: { role: "user", content: text("private owner request") } });
  await f.finish(reply("Work remains."));
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(f.calls[1][1].messages[0].content[0].text, /near its limit/);
  assert.equal(f.sent.length, 1);
});

test("Pi branch navigation excludes continuations from abandoned branches", async (t) => {
  const f = await fixture(t);
  f.review(async () => reply("CONTINUE"));
  await f.finish();
  f.deliver();
  f.branch.splice(1); // Navigate back to the owner, abandoning the reviewed reply.
  await f.emit("session_before_tree");
  await f.finish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.content, "Keep going.");
});

test("Pi fails open on provider errors, invalid verdicts, and incomplete reviewer responses", async (t) => {
  const f = await fixture(t);
  for (const run of [
    async () => { throw new Error("Provider unavailable"); },
    async () => reply("NOT_A_VERDICT"),
    async () => reply("CONTINUE", "error"),
    async () => reply("CONTINUE", "aborted"),
    async () => reply("CONTINUE", "length"),
  ]) {
    f.review(run);
    await f.finish();
  }
  process.env.KEEP_GOING_PI_MODEL = "not-found/model";
  await f.finish();
  assert.equal(f.sent.length, 0);
  assert.equal(f.notifications.length, 6);
  assert.ok(f.notifications.every(([message]) => message.includes("skipped")));
});

test("Escape cancels a review even when the provider ignores AbortSignal", async (t) => {
  const f = await fixture(t);
  f.review(() => new Promise(() => {}));
  const review = f.finish();
  await until(() => f.calls.length === 1);
  f.abort.abort();
  await review;
  assert.equal(f.calls[0][2].signal.aborted, true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.notifications.length, 0);
  assert.deepEqual(f.statuses.at(-1), ["keep-going", undefined]);
});

test("new input, model changes, and session navigation cancel in-flight reviews", async (t) => {
  const f = await fixture(t);
  f.review(() => new Promise(() => {}));
  for (const event of ["input", "model_select", "session_before_tree", "session_before_switch", "session_before_fork"]) {
    const count = f.calls.length;
    const review = f.finish();
    await until(() => f.calls.length > count);
    await f.emit(event);
    await review;
  }
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.statuses.at(-1), ["keep-going", undefined]);
});

test("shutdown cancels the reviewer without touching a stale Pi context", async (t) => {
  const f = await fixture(t);
  f.review(() => new Promise(() => {}));
  const review = f.finish();
  await until(() => f.calls.length === 1);
  await f.emit("session_shutdown");
  f.ctx.ui.setStatus = () => assert.fail("used stale ctx");
  f.ctx.sessionManager.getBranch = () => assert.fail("used stale ctx");
  await review;
  assert.equal(f.sent.length, 0);
});

test("a queued message or changed session makes a completed verdict stale", async (t) => {
  const f = await fixture(t);
  f.review(async () => { f.pending(true); return reply("CONTINUE"); });
  await f.finish();
  assert.equal(f.sent.length, 0);
  f.pending(false);
  f.review(async () => {
    f.ctx.sessionManager.getSessionId = () => "new-session";
    return reply("CONTINUE");
  });
  await f.finish();
  assert.equal(f.sent.length, 0);
});

test("/keep-going off persists in the session and cancels an in-flight review", async (t) => {
  const f = await fixture(t);
  await f.command("status");
  assert.match(f.notifications.at(-1)[0], /on; reviewer test\/active-model/);
  f.review(() => new Promise(() => {}));
  const review = f.finish();
  await until(() => f.calls.length === 1);
  await f.command("off");
  await review;
  await f.finish();
  assert.equal(f.calls.length, 1);
  keepGoing(f.pi); // Reload restores enabled state from the branch, not memory.
  await f.finish();
  assert.equal(f.calls.length, 1);
  await f.command("on");
  f.review(async () => reply("CONTINUE"));
  await f.finish();
  assert.equal(f.sent.length, 1);
});

test("Pi reviewer has a hard timeout and accepts no late result", async (t) => {
  const f = await fixture(t);
  f.review(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return reply("CONTINUE");
  });
  await assert.rejects(reviewWithPi(f.ctx, f.ctx.model, { prompt: "test", timeoutMs: 5 }, f.abort.signal),
    { name: "TimeoutError" });
  assert.equal(f.calls[0][2].signal.aborted, true);
});

test("Pi core requires a valid native count and fails open without a native reviewer", async (t) => {
  await fixture(t);
  // An owner prompt is supplied so the input reaches the paths under test: an
  // owner-less "Done." now takes the stub skip instead.
  const input = { session_id: "s", turn_id: "u", last_assistant_message: "Done.", owner_prompt: "Calculate 2 + 2.", continuation_count: 0 };
  assert.match((await handleStop(input, "pi")).systemMessage, /native extension/);
  for (const count of [undefined, -1, 0.5, NaN]) {
    await assert.rejects(handleStop({ ...input, continuation_count: count }, "pi"), /continuation_count/);
  }
});

test("the Pi package ships a loadable, dependency-free extension", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/keep-going.js"]);
  assert.ok(manifest.files.includes("extensions"));
  const bundled = await import("../extensions/keep-going.js");
  assert.equal(typeof bundled.default, "function");
  const source = await readFile(new URL("../extensions/keep-going.js", import.meta.url), "utf8");
  const bareImports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)]
    .map((match) => match[1]).filter((specifier) => !specifier.startsWith("node:"));
  assert.deepEqual(bareImports, []);
});

test("the Pi review asks for a thinking level the model's catalog allows", () => {
  const map = (off) => ({ off, minimal: null, low: "low", medium: "medium", high: "high" });
  for (const [model, expected, why] of [
    [{ reasoning: false, api: "openai-responses" }, false, "no thinking to turn off"],
    [{ reasoning: true, api: "anthropic-messages" }, false, "off disables thinking and sends no level"],
    [{ reasoning: true, api: "anthropic-messages", thinkingLevelMap: map(null) }, "minimal", "thinking cannot be disabled"],
    [{ reasoning: true, api: "openai-codex-responses", thinkingLevelMap: map(null) }, "minimal", "off is unsupported; pi-ai clamps to the lowest listed level"],
    [{ reasoning: true, api: "openai-responses", thinkingLevelMap: map("none") }, false, "the catalog vouches for what off sends"],
    [{ reasoning: true, api: "openai-responses" }, "minimal", "no mapping: off would send a literal \"none\" the model may reject"],
    [{ reasoning: true, api: "openai-completions" }, "minimal", "same fallback on the completions API"],
    [{ reasoning: true, api: "google-generative-ai" }, false, "off disables thinking and sends no level"],
  ]) {
    assert.equal(reviewReasoning(model), expected, why);
  }
});
