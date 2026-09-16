#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024;
const CLASSIFIER_TIMEOUT_MS = 180_000;
// Continuations per owner turn before the hook accepts the stop unconditionally.
const CONTINUATION_CAP = 100;
// Continuations before the cap where the nudge stops inviting new work.
const LAST_STRETCH = 10;

// Everything that differs per host, keyed once: the inputs it must supply, the
// directories its transcripts may live in, how its continuations are counted,
// and how its reviewer is run. Function declarations hoist, so the counters and
// runners below are already bound when this is evaluated.
const RUNTIMES = {
  codex: {
    requires: ["turn_id", "session_id"],
    roots: () => {
      const home = process.env.CODEX_HOME || path.join(homedir(), ".codex");
      return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
    },
    count: codexContinuations,
    run: runCodexModel,
  },
  claude: {
    requires: ["session_id"],
    roots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")],
    count: claudeContinuations,
    run: runClaudeModel,
  },
  ghost: {
    requires: ["session_id"],
    roots: (input) => [input.ghost_home],
    count: ghostContinuations,
    run: runGhostModel,
  },
};

// Everything that differs per verdict, keyed once: how the prompt defines it,
// what the reviewer is told to write after it, and what the hook falls back to
// when the reviewer's own line is unusable. RUNTIMES does this for hosts; the
// verdict is the other axis this file turns on.
const VERDICTS = {
  CONTINUE: {
    blocks: true,
    describe: "required work remains that the agent can perform now.",
    directive: "push it onward",
    // Rotated rather than fixed: a hundred continuations carrying one identical
    // sentence read to the agent like a stuck loop instead of a push.
    fallbacks: [
      "Keep going.",
      "You've got this \u2014 keep going.",
      "Believe in yourself. Keep going.",
      "There is still work left here. Keep going.",
    ],
  },
  JUDGE: {
    blocks: true,
    describe: "it asks the user for input, but more reasoning or research should resolve it.",
    directive: "tell it not to ask the user yet",
    // Not CONTINUE's lines. The whole of JUDGE is "do not ask yet", and a
    // dropped reviewer line would otherwise answer a question the agent put to
    // the user with "keep going" — which is no reason not to ask it again.
    fallbacks: [
      "Do not ask yet \u2014 work it out first.",
      "You can answer this one yourself. Keep going.",
      "Research it before handing it back. Keep going.",
      "Settle this without the user. Keep going.",
    ],
  },
  STOP: {
    blocks: false,
    describe: "work is complete, or progress genuinely requires the user or an external state change.",
  },
};

const VERDICT_NAMES = Object.keys(VERDICTS);
const BLOCKING_VERDICTS = VERDICT_NAMES.filter((name) => VERDICTS[name].blocks);
const ENDING_VERDICTS = VERDICT_NAMES.filter((name) => !VERDICTS[name].blocks);
const listVerdicts = (names) => new Intl.ListFormat("en", { type: "disjunction" }).format(names);

// Validate the reviewer's tiny provider-independent protocol before translating
// it to the host-specific Stop-hook JSON.
const REVIEW_VERDICT_PATTERN = new RegExp(
  `^(${VERDICT_NAMES.join("|")})\\b[\\s:.\\u2013\\u2014-]*([\\s\\S]*)$`,
);

// A few words. The inspiration for this hook was a person typing "keep going"
// and "believe in yourself" for a day and a half, so a paragraph is the wrong
// register even when it is correct. A line over the limit is dropped rather
// than truncated, and the fallbacks are the same handful of words, so a drop
// costs tone, not much else.
const NUDGE_LIMIT = 60;

const REVIEW_PROMPT = `A coding agent just tried to end its turn. Its final message is
last_assistant_message. Decide whether the turn is really over.

${VERDICT_NAMES.map((name) => `${name} — ${VERDICTS[name].describe}`).join("\n")}

Prefer JUDGE over STOP when the request for input looks self-resolvable by the agent.
Do not default to any outcome or invent unstated work.

Reply with the verdict word alone on the first line: ${listVerdicts(VERDICT_NAMES)}.
For ${listVerdicts(ENDING_VERDICTS)}, stop there. For ${listVerdicts(BLOCKING_VERDICTS)}, add one more
line: it reaches the agent verbatim, as the whole reason its turn was not
allowed to end.

Use as few words as you can, under ${NUDGE_LIMIT} characters — "Keep going.",
"Believe in yourself.", "Don't ask yet — you can work this out." Speak to the
agent. Name no task, file, command, or requirement its message did not already
state. A longer line is discarded for a generic one.

${BLOCKING_VERDICTS.map((name) => `After ${name}, ${VERDICTS[name].directive}.`).join(" ")}`;

function redactSensitive(value) {
  return value
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function compactText(value, limit) {
  if (typeof value !== "string") return "";
  const redacted = redactSensitive(value);
  if (redacted.length <= limit) return redacted;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${redacted.slice(0, head)}\n...[truncated]...\n${redacted.slice(-tail)}`;
}

// Every reviewer is a child process that either exits 0 or explains itself on
// one of its two streams.
function assertExitOk(result, label) {
  if (result.code === 0) return result;
  const detail = compactText(
    [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n"),
    1200,
  );
  throw new Error(`${label} exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .filter((part) =>
      part &&
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function recordTurnId(record) {
  return (
    record?.payload?.turn_id ??
    record?.payload?.internal_chat_message_metadata_passthrough?.turn_id ??
    null
  );
}

function isInjectedContext(text) {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<recommended_plugins>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<permissions instructions>")
  );
}

async function* jsonLines(file) {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore incomplete or non-JSON transcript lines.
    }
  }
}

function turnStartIndex(items, ownerPrompt, ownerText) {
  if (ownerPrompt) {
    const matchingOwner = items.findLastIndex((item) => ownerText(item)?.trim() === ownerPrompt);
    if (matchingOwner >= 0) return matchingOwner;
  }
  return items.findLastIndex((item) => ownerText(item) !== null);
}

// Prompts the host injected on behalf of this hook. Claude Code records them as
// "Stop hook feedback: ..." meta user messages and Codex as <hook_prompt ...>
// user messages; ghost's transcripts hold nothing but hook continuations
// between owner prompts, so every one of them counts.
const HOOK_PROMPT_PATTERN = /^\s*(?:Stop hook feedback\b|<hook_prompt\b)/;

async function allowedTranscriptPath(input, runner) {
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    throw new Error("Stop input is missing transcript_path");
  }
  const candidate = await realpath(transcriptPath);

  for (const root of RUNTIMES[runner].roots(input)) {
    if (typeof root !== "string" || !root) continue;
    try {
      const resolvedRoot = await realpath(root);
      if (candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`)) return candidate;
    } catch {
      // A missing optional transcript root cannot contain the candidate.
    }
  }
  throw new Error(`transcript_path is outside the ${runner} transcript directories`);
}

async function codexContinuations(input) {
  const transcriptPath = await allowedTranscriptPath(input, "codex");
  let count = 0;
  for await (const record of jsonLines(transcriptPath)) {
    const payload = record?.payload;
    if (
      record?.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user" &&
      recordTurnId(record) === input.turn_id &&
      HOOK_PROMPT_PATTERN.test(messageText(payload))
    ) {
      count += 1;
    }
  }
  return count;
}

function claudeUserMessage(record) {
  if (record?.type !== "user" || record.message?.role !== "user") return null;

  const text = typeof record.message.content === "string"
    ? record.message.content
    : messageText(record.message);
  if (!text || isInjectedContext(text)) return null;
  return {
    text,
    genuine:
      record.origin?.kind !== "task-notification" &&
      record.promptSource !== "system" &&
      record.isMeta !== true,
  };
}

async function claudeContinuations(input, ownerPromptText = null) {
  const transcriptPath = await allowedTranscriptPath(input, "claude");
  const messages = [];
  for await (const record of jsonLines(transcriptPath)) {
    const message = claudeUserMessage(record);
    if (message) messages.push(message);
  }

  // The current turn starts at the last genuine user message. A host that
  // re-prompts with plain user messages (ghost's Claude Code runtime) supplies
  // the owner prompt so those continuations stay inside the turn — and every
  // user message after it counts as a continuation.
  const ownerPrompt = typeof ownerPromptText === "string" ? ownerPromptText.trim() : null;
  const turnStart = turnStartIndex(messages, ownerPrompt, (item) => (item.genuine ? item.text : null));
  if (turnStart < 0) return 0;
  if (ownerPrompt) return messages.length - turnStart - 1;
  let count = 0;
  for (let index = turnStart + 1; index < messages.length; index += 1) {
    if (HOOK_PROMPT_PATTERN.test(messages[index].text)) count += 1;
  }
  return count;
}

// Pi session files are trees: every entry carries id/parentId and the live
// conversation is the chain from the last written entry back to the root.
function piActiveBranch(records) {
  const byId = new Map();
  let leaf = null;
  for (const record of records) {
    if (typeof record?.id !== "string") continue;
    byId.set(record.id, record);
    leaf = record;
  }
  if (!leaf) return records;
  const branch = [];
  const seen = new Set();
  for (let cursor = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : null) {
    seen.add(cursor.id);
    branch.push(cursor);
  }
  return branch.reverse();
}

async function piContinuations(input, transcriptPath) {
  const records = [];
  for await (const record of jsonLines(transcriptPath)) records.push(record);

  // One timeline of owner prompts and hook continuations; everything after the
  // owner prompt that starts the current turn is a continuation.
  const prompts = [];
  for (const entry of piActiveBranch(records)) {
    if (entry?.type === "message" && entry.message?.role === "user") {
      const text = messageText(entry.message);
      if (text) prompts.push({ owner: true, text });
    } else if (
      entry?.type === "custom_message" &&
      entry.customType === "session-stop-continuation" &&
      typeof entry.content === "string" &&
      entry.content
    ) {
      prompts.push({ owner: false, text: entry.content });
    }
  }

  const ownerPrompt = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  const turnStart = turnStartIndex(prompts, ownerPrompt, (item) => (item.owner ? item.text : null));
  if (turnStart < 0) return 0;
  return prompts.length - turnStart - 1;
}

// Ghost hands over its runtime's native transcript when one exists: the Pi
// session file (OMP conversations) or the Claude Code SDK session file
// (Claude Code conversations). Without one, only the current pass is known.
async function ghostContinuations(input) {
  if (typeof input.owner_prompt !== "string" || !input.owner_prompt.trim()) {
    throw new Error("Ghost stop input is missing owner_prompt");
  }
  if (typeof input.transcript_path !== "string" || !input.transcript_path) return 0;
  if (input.conversation_runtime === "claude-code") {
    return claudeContinuations(input, input.owner_prompt);
  }
  const transcriptPath = await allowedTranscriptPath(input, "ghost");
  return piContinuations(input, transcriptPath);
}

async function countContinuations(input, runner = "codex") {
  return RUNTIMES[runner].count(input);
}

// The cap is the only thing between a stuck reviewer and a hundred turns of
// spend, and every count above reads a transcript in a format the host chose.
// A host we cannot parse — or one that sends no transcript at all — left the
// cap unenforceable, so the hook kept its own tally as well: blocks since this
// session last ended a turn, which is what a continuation is. It needs nothing
// from the host but the session id every runtime already requires.
const TALLY_FILE = () =>
  path.join(
    process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
    "keep-going",
    "continuations.json",
  );
// An interrupted turn never reaches the hook again to be cleared, so entries
// expire rather than counting against whatever the session does next.
const TALLY_IDLE_MS = 30 * 60_000;

async function readTally() {
  try {
    const parsed = JSON.parse(await readFile(TALLY_FILE(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const fresh = {};
    for (const [session, entry] of Object.entries(parsed)) {
      if (Number.isInteger(entry?.count) && Date.now() - entry.updated < TALLY_IDLE_MS) {
        fresh[session] = entry;
      }
    }
    return fresh;
  } catch {
    // No tally yet, or one we cannot read: the floor starts at zero.
    return {};
  }
}

async function writeTally(tally) {
  const file = TALLY_FILE();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(tally), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch {
    // Losing the tally costs accuracy on the next pass, never the decision.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// A turn ends when this hook lets a stop through, so clearing on STOP is what
// makes the tally mean "continuations in the current turn" without ever
// knowing what the owner typed.
async function recordTurnState(sessionId, blocked, exact = null) {
  if (typeof sessionId !== "string" || !sessionId) return;
  const tally = await readTally();
  if (!blocked) {
    delete tally[sessionId];
  } else {
    // Where the transcript was readable it is the truth, so the tally is set
    // from it rather than incremented past its own stale value — otherwise the
    // number the hook falls back to is one it has been drifting all turn.
    const from = exact ?? tally[sessionId]?.count ?? 0;
    tally[sessionId] = { count: from + 1, updated: Date.now() };
  }
  await writeTally(tally);
}

function stopCandidateText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  return messageText(input.last_assistant_message);
}

// setEncoding("utf8") guarantees a chunk never splits a code point, so summing
// per-chunk lengths is exact and avoids remeasuring the whole stream each time.
function streamCollector(limit, overflowMessage) {
  const parts = [];
  let bytes = 0;
  return {
    push(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) throw new Error(overflowMessage);
      parts.push(chunk);
    },
    text: () => parts.join(""),
  };
}

async function readStdin() {
  const collector = streamCollector(MAX_STDIN_BYTES, "Stop hook input exceeds 1 MB");
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) collector.push(chunk);
  const parsed = JSON.parse(collector.text());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stop hook input must be a JSON object");
  }
  return parsed;
}

function runProcess(command, args, input, timeoutMs, env = process.env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      // SIGKILL reaches the direct child only and "close" waits for every
      // inherited pipe, so a surviving grandchild would otherwise keep this
      // process alive after it has already failed open.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    const [out, err] = [child.stdout, child.stderr].map((stream) => {
      const collector = streamCollector(MODEL_OUTPUT_LIMIT, "child process output exceeded 2 MB");
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        try {
          collector.push(chunk);
        } catch (error) {
          fail(error);
        }
      });
      return collector;
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: out.text(), stderr: err.text() });
    });
    child.stdin.end(input);
  });
}

async function runCodexModel({ prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-keep-going-"));
  const outputPath = path.join(directory, "result.txt");
  try {
    const codex = process.env.KEEP_GOING_CODEX_BIN || "codex";
    const model = process.env.KEEP_GOING_CODEX_MODEL || "gpt-5.6-luna";
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "hooks",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      directory,
      "--model",
      model,
      "--config",
      'approval_policy="never"',
      "--output-last-message",
      outputPath,
      "-",
    ];
    assertExitOk(await runProcess(codex, args, prompt, timeoutMs), "codex exec");
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runClaudeModel({ prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-keep-going-"));
  try {
    const claude = process.env.KEEP_GOING_CLAUDE_BIN || "claude";
    const model = process.env.KEEP_GOING_CLAUDE_MODEL || "sonnet";
    // No tools and no --json-schema: a plain-text verdict completes in one turn,
    // whereas the StructuredOutput tool call was fumbled often enough to exhaust
    // --max-turns.
    const args = [
      "--print",
      "--safe-mode",
      "--tools",
      "",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--model",
      model,
      "--output-format",
      "json",
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const result = assertExitOk(
      await runProcess(claude, args, prompt, timeoutMs, env, directory),
      "claude",
    );
    let parsed;
    for (const line of result.stdout.trim().split("\n").reverse()) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        // Version managers may emit a status line before Claude's JSON result.
      }
    }
    if (!parsed) throw new Error("claude returned invalid JSON");
    if (parsed.is_error) {
      throw new Error(`claude reported an error: ${compactText(String(parsed.result ?? ""), 500)}`);
    }
    if (typeof parsed.result !== "string") throw new Error("claude returned no result text");
    return parsed.result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runGhostModel({ prompt, timeoutMs, ghostHome }) {
  if (typeof ghostHome !== "string" || !ghostHome) {
    throw new Error("Ghost stop input is missing ghost_home");
  }
  const ghostd = process.env.KEEP_GOING_GHOST_BIN || "ghostd";
  const result = assertExitOk(
    await runProcess(
      ghostd,
      ["hook-smol-complete"],
      JSON.stringify({ ghost_home: ghostHome, prompt }),
      timeoutMs,
    ),
    "ghostd",
  );
  const envelope = JSON.parse(result.stdout);
  if (typeof envelope?.text !== "string") throw new Error("ghostd returned no completion text");
  return envelope.text;
}

// The reviewer's own words carry into the agent's next turn, so they are
// redacted, flattened to one line, and dropped whole if they outgrow a sentence.
function sanitizeNudge(value) {
  const line = redactSensitive(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (!line || line.length > NUDGE_LIMIT) return "";
  return line;
}

function parseReviewVerdict(text) {
  const match = REVIEW_VERDICT_PATTERN.exec(String(text ?? "").trim());
  if (!match) {
    throw new Error(`Reviewer output must begin with ${listVerdicts(VERDICT_NAMES)}`);
  }
  return { verdict: match[1], nudge: sanitizeNudge(match[2]) };
}

// Near the cap the reviewer is told to write a different line, rather than
// having one appended to the line it wrote: hook-side facts reach it the one
// way NUDGE_LIMIT already does, and the message stays within the budget.
const LAST_STRETCH_NOTE =
  "This turn is near its limit: tell the agent to land what is in flight rather than start anything new.";

function reviewPrompt(continuations) {
  if (continuations < CONTINUATION_CAP - LAST_STRETCH) return REVIEW_PROMPT;
  return `${REVIEW_PROMPT}\n\n${LAST_STRETCH_NOTE}`;
}

// The reviewer writes the whole line for every blocking verdict. A fixed
// preamble could only repeat one guess about why the agent stopped, and the
// reviewer is the half that actually read the message. The fallback rotates so
// a hundred continuations do not carry one identical sentence.
function hookOutputForVerdict(verdict, continuations = 0, nudge = "") {
  const spec = VERDICTS[verdict];
  if (!spec?.blocks) return {};
  return { decision: "block", reason: nudge || spec.fallbacks[continuations % spec.fallbacks.length] };
}

async function recordReviewAudit(input, runner, { verdict, reason, error, countedBy }) {
  const auditPath = process.env.KEEP_GOING_AUDIT_LOG;
  if (!auditPath) return;
  const entry = {
    timestamp: new Date().toISOString(),
    runner,
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    cwd: typeof input?.cwd === "string" ? input.cwd : null,
    verdict: error ? "ERROR" : verdict,
    rationale: error ? compactText(String(error), 2_000) : reason ?? "",
    // Which mechanism capped the turn, on every stop rather than only on the
    // failure path. A host counted by the tally is a host without a RUNTIMES
    // entry, and the fields it sent are what one would be written from —
    // names only, since the values are the payload and one is the transcript.
    counted_by: countedBy,
    ...(countedBy === "tally" ? { stop_input_fields: Object.keys(input ?? {}).sort() } : {}),
  };
  try {
    await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging is best-effort and must never change the hook decision.
  }
}

async function recordedContinuations(sessionId) {
  const tally = await readTally();
  return tally[sessionId]?.count ?? 0;
}

async function handleStop(input, runner = "codex") {
  const runtime = RUNTIMES[runner];
  if (!runtime) throw new Error(`Unsupported keep-going runtime: ${runner}`);
  for (const key of runtime.requires) {
    if (typeof input[key] !== "string" || !input[key]) {
      throw new Error(`Stop input is missing ${key}`);
    }
  }
  // Every exit below that lets the stop through ends the turn, and ending a
  // turn is what clears the tally. Missing one is how the cap gets disarmed:
  // the count survives into a turn that never earned it.
  const lastAssistantMessage = compactText(stopCandidateText(input), 12_000);
  if (!lastAssistantMessage) {
    await recordTurnState(input.session_id, false);
    return {};
  }

  let review;
  // Kept after the cap check: the nudge changes tone as the turn nears the cap.
  let continuations = await recordedContinuations(input.session_id);
  let countedBy = "tally";
  try {
    // The transcript is used only to enforce the continuation cap. Its content
    // is never supplied to the reviewer. Where it can be read it is exact and
    // it replaces the tally, here and in what the tally is left holding.
    if (typeof input.transcript_path === "string" && input.transcript_path) {
      try {
        continuations = await countContinuations(input, runner);
        countedBy = "transcript";
      } catch {
        // A transcript in a shape or a place this runtime does not know is the
        // ordinary case on a host we have not taught it yet. The tally already
        // caps the turn, so the review still happens and the audit row says so.
      }
    }
    if (continuations >= CONTINUATION_CAP) {
      const capped = {
        systemMessage: `keep-going: continuation cap (${CONTINUATION_CAP}) reached for this turn; accepting the stop.`,
      };
      await recordTurnState(input.session_id, false);
      await recordReviewAudit(input, runner, { verdict: "CAP", reason: capped.systemMessage, countedBy });
      return capped;
    }

    review = parseReviewVerdict(
      await runtime.run({
        prompt: `${reviewPrompt(continuations)}\n\n${JSON.stringify({ last_assistant_message: lastAssistantMessage })}`,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        ghostHome: input.ghost_home,
      }),
    );
  } catch (error) {
    // Failing open lets the stop through, so it ends the turn like any other
    // accepted stop. This is the path a reviewer timeout takes — the stuck
    // case the cap exists for — and leaving the count behind would spend it
    // against whatever the session does next.
    await recordTurnState(input.session_id, false);
    await recordReviewAudit(input, runner, { error: error.message, countedBy });
    return { systemMessage: `keep-going was skipped: ${compactText(error.message, 500)}` };
  }

  const output = hookOutputForVerdict(review.verdict, continuations, review.nudge);
  await recordTurnState(
    input.session_id,
    output.decision === "block",
    countedBy === "transcript" ? continuations : null,
  );
  await recordReviewAudit(input, runner, { verdict: review.verdict, reason: output.reason, countedBy });
  return output;
}

async function main() {
  try {
    const runner = process.argv[2] || "codex";
    const input = await readStdin();
    const output = await handleStop(input, runner);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `keep-going failed open: ${compactText(error.message, 500)}` })}\n`,
    );
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) await main();

export {
  BLOCKING_VERDICTS,
  CONTINUATION_CAP,
  REVIEW_PROMPT,
  VERDICTS,
  NUDGE_LIMIT,
  LAST_STRETCH,
  countContinuations,
  recordedContinuations,
  reviewPrompt,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
};
