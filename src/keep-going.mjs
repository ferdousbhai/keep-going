#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
// How long the hook holds a fresh stop before reviewing it. A user who was
// already typing a follow-up should not pay for a review of a turn they were
// about to extend: an owner message that lands in the transcript during the
// wait is that follow-up, and the stop is let through unreviewed.
const QUIET_DELAY_MS = 15_000;

function quietDelayMs() {
  const raw = process.env.KEEP_GOING_QUIET_MS;
  if (raw === undefined || raw === "") return QUIET_DELAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return QUIET_DELAY_MS;
  return Math.floor(parsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

// Hold a fresh stop before reviewing it, so a follow-up the user was already
// typing lets the stop through unreviewed. True only when the owner's log
// gained a record that opens a turn — the host writes to the same file while
// the hook runs: Claude Code lands the final assistant message itself, then
// hook summaries and housekeeping records, after Stop has fired, so growth
// alone said "follow-up" on most stops and let them through unreviewed. A
// retry already waited once, a subagent's owner is the parent that is waiting
// on it, and a host with no owner log to watch cannot show a follow-up, so
// all three skip the wait.
async function followedUpDuringQuietWait(input, runtime, delay) {
  const quietMs = quietDelayMs();
  if (quietMs <= 0 || input.stop_hook_active || input.stopHookActive || input.agent_id) return false;
  const watch = runtime.followUp;
  if (!watch) return false;
  const file = watch.file(input);
  const before = await fileSize(file);
  if (before === null) return false;
  await (delay ?? sleep)(quietMs);
  const after = await fileSize(file);
  if (after === null || after <= before) return false;
  // A line cut by either boundary fails to parse and is skipped; a message
  // the owner sent is always a whole line of its own.
  try {
    for await (const record of jsonLines(file, { start: before, end: after - 1 })) {
      if (watch.turn(record)?.open) return true;
    }
  } catch {
    // An unreadable range shows no follow-up; the stop is reviewed as usual.
  }
  return false;
}

const ownTranscript = (input) => input.transcript_path;

// Everything that differs per host, keyed once: the inputs it must supply, the
// directory its state belongs under, the directories its transcripts may live
// in, how its continuations are counted, and how its reviewer is run. A host
// whose stop payload already identifies the turn needs no counter — the tally
// is keyed on that identity. Function declarations hoist, so the counter and
// the runners below are already bound when this is evaluated.
const RUNTIMES = {
  // Pi supplies a model call from its authenticated registry and counts nudges
  // on the active session branch. No subprocess or separate tally is needed.
  pi: {
    requires: ["session_id", "turn_id"],
    count: (input) => {
      if (!Number.isSafeInteger(input.continuation_count) || input.continuation_count < 0) {
        throw new Error("Pi stop input is missing a valid continuation_count");
      }
      return input.continuation_count;
    },
  },
  codex: {
    requires: ["turn_id", "session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")],
    ownerPrompt: codexOwnerPrompt,
    run: runCodexModel,
    followUp: { file: ownTranscript, turn: codexTurn },
  },
  claude: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")],
    count: claudeContinuations,
    ownerPrompt: claudeOwnerPrompt,
    run: runClaudeModel,
    followUp: { file: ownTranscript, turn: claudeTurn },
  },
  ghost: {
    requires: ["session_id", "owner_prompt", "ghost_home"],
    state: (input) => input.ghost_home,
    run: runGhostModel,
    followUp: { file: ownTranscript, turn: ghostTurn },
  },
  // Muse names its turn, so the tally keys on it wherever it is sent. Only
  // session_id is required: the hook contract is unpublished and a stop that
  // stopped naming its turn should still be reviewed and capped per session,
  // not refused outright.
  muse: {
    requires: ["session_id"],
    state: xdgStateHome,
    run: runMuseModel,
  },
  // Grok dispatches hooks it finds in ~/.claude/settings.json as well as its
  // own. A Claude install's command still ends in `claude`, so resolveRunner
  // remaps to this runtime whenever GROK_HOOK_EVENT is set — unless a native
  // Grok hook is present, in which case the Claude copy yields. Dual install
  // writes ~/.grok/hooks/keep-going.json so Grok is covered even if that scan
  // is off; grok picks its own default model.
  // Its transcript is a log of session/update frames in which a blocked turn's
  // nudge lands inside the agent's own reasoning, leaving no continuation to
  // count; the tally counts them instead.
  grok: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.GROK_HOME || path.join(homedir(), ".grok"), "sessions")],
    ownerPrompt: grokOwnerPrompt,
    run: runGrokModel,
    followUp: {
      file: (input) => (typeof input.transcript_path === "string" ? grokChatHistory(input.transcript_path) : null),
      turn: grokTurn,
    },
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
    // Rotated rather than fixed: a hundred continuations carrying one identical
    // sentence read to the agent like a stuck loop instead of a push.
    fallbacks: [
      "Keep going.",
      "You've got this \u2014 keep going.",
      "Believe in yourself. Keep going.",
      "There is still work left here. Keep going.",
    ],
  },
  THINK: {
    blocks: true,
    describe: "more reasoning is needed; it should think this through instead of stopping or asking the user.",
    // Not CONTINUE's lines. THINK is "reason further", and a dropped reviewer
    // line would otherwise answer a question the agent put to the user with
    // "keep going" — which is no reason not to ask it again.
    fallbacks: [
      "Think it through. Keep going.",
      "Do not ask yet \u2014 work it out first.",
      "You can answer this one yourself. Keep going.",
      "Research it before handing it back. Keep going.",
    ],
  },
  // Offered once per turn. A report that the scan found nothing is itself a
  // claim that open-ended work is done, so a reviewer left to its own reading
  // asked for the same scan again and again; the hook remembers the first ask
  // and withdraws RESCAN after it (see reviewPrompt), and a RESCAN answered
  // anyway fails open like any other reply the prompt did not offer.
  RESCAN: {
    blocks: true,
    describe: "the agent claims open-ended work is done, but a fresh pass could still surface more.",
    // A rescan nudge names the one remaining move: look again, then report.
    // It never restates the task, so a dropped line still reads as a push.
    fallbacks: [
      "Do a fresh scan for anything left.",
      "Scan once more before you finish.",
      "One more full pass, then report.",
      "Look again with fresh eyes.",
    ],
  },
  // Waiting on the owner's say-so is named here rather than left to the THINK
  // preference below. Consent is the one thing no amount of reasoning
  // produces, and a reviewer with no word for it reads a pending
  // authorization as a question the agent could have answered itself.
  STOP: {
    blocks: false,
    describe:
      "work is complete, progress genuinely requires the user or an external state change, or the agent is waiting on a decision only the owner has standing to make \u2014 consent to deploy, publish, send, spend, or delete.",
  },
};

const VERDICT_NAMES = Object.keys(VERDICTS);
const BLOCKING_VERDICTS = VERDICT_NAMES.filter((name) => VERDICTS[name].blocks);
const ENDING_VERDICTS = VERDICT_NAMES.filter((name) => !VERDICTS[name].blocks);
const listVerdicts = (names) => new Intl.ListFormat("en", { type: "disjunction" }).format(names);

// Validate the reviewer's tiny provider-independent protocol before translating
// it to the host-specific Stop-hook JSON.
const VERDICT_ALTERNATION = VERDICT_NAMES.join("|");
const VERDICT_SEPARATOR = "[\\s:.\\u2013\\u2014-]*";
// A verdict ends where a non-word character does, or where another verdict
// begins. A small reviewer often answers twice — "CONTINUECONTINUE" — and
// requiring a word boundary there threw away an answer it had actually given.
const REVIEW_VERDICT_PATTERN = new RegExp(
  `^(${VERDICT_ALTERNATION})(?=$|[^A-Za-z_]|${VERDICT_ALTERNATION})${VERDICT_SEPARATOR}([\\s\\S]*)$`,
);
// A repeat of the verdict is not a nudge. Left in, the agent is sent back with
// "CONTINUE." as its encouragement.
const VERDICT_ECHO = new RegExp(`^(?:${VERDICT_ALTERNATION})${VERDICT_SEPARATOR}`);

// The reviewer's line reaches the agent verbatim, so it is bounded — but
// truncated, not dropped, so a pointed line keeps its point.
const NUDGE_LIMIT = 500;

// History lookup the reviewer can request before verdicting. The reviewer
// stays tool-free: it replies TURN n (or TURN x-y) and the hook fulfills the
// request from its own transcript readers, then asks again. Past turns only —
// the current turn is already in the prompt — numbered 1 for the oldest, with
// -1 meaning the previous turn.
const TURN_INDEX_LIMIT = 20;
const TURN_INDEX_CHARS = 100;
const TURNS_PER_REQUEST = 5;
const TURN_REQUESTS_MAX = 2;
const TURN_OWNER_CHARS = 2_000;
const TURN_FINAL_CHARS = 4_000;
// The whole loop shares one budget so two slow reviewers cannot stack past
// the hook timeout that hosts enforce above this process.
const REVIEW_BUDGET_MS = 200_000;
const REVIEW_CALL_FLOOR_MS = 15_000;

function turnsEnabled() {
  return process.env.KEEP_GOING_TURNS !== "0";
}

const RESCAN_GUIDANCE = `Prefer RESCAN over STOP when the message claims open-ended work is done —
finding every issue, fixing them all, cleaning up — and a fresh pass could
surface more. Tell it to scan once more and report what the scan found. STOP
when the message already reports such a rescan with nothing left, or when the
work is complete on any other terms.`;

// The reviewer that asked for the scan does not see this turn again; the one
// that reads the report has to be told the scan was already asked for, or a
// report of nothing found reads as one more claim of done and earns one more
// scan. With RESCAN gone from its choices, the honest verdicts remain.
const RESCAN_SPENT_GUIDANCE = `A fresh scan was already asked for this turn, so RESCAN is not on offer.
STOP when the message reports that scan, whatever it found and whether or not
it fixed anything. CONTINUE only if the agent skipped the scan it was asked for.`;

function composeReviewPrompt(names, rescanGuidance) {
  const blocking = names.filter((name) => VERDICTS[name].blocks);
  const ending = names.filter((name) => !VERDICTS[name].blocks);
  return `An agent just tried to end its turn. Its final message is
last_assistant_message. Decide whether the turn is really over.

${names.map((name) => `${name} — ${VERDICTS[name].describe}`).join("\n")}

Prefer THINK over STOP when the request for input looks self-resolvable by the agent.
Do not default to any outcome or invent unstated work.

Never state or imply what the owner said, meant, approved, confirmed or wants.
The agent cannot tell your reading of the owner's words from the owner's own,
so such a line reads to it as permission it never received. A turn that ended
on a decision only the owner can make is STOP, not something to argue past.

${rescanGuidance}

owner_prompt is the owner's request this turn. STOP if last_assistant_message
already fulfills it.

Reply with the verdict word alone on the first line: ${listVerdicts(names)}.
For ${listVerdicts(ending)}, stop there. For ${listVerdicts(blocking)}, add one more
line: it reaches the agent verbatim, as the whole reason its turn was not
allowed to end.

Write one short sentence — "Keep going.", "Believe in yourself.", "Don't
ask yet — you can work this out." Speak to the agent. Name no task, file,
command, or requirement its message did not already state. A longer line is
truncated at ${NUDGE_LIMIT} characters.`;
}

const REVIEW_PROMPT = composeReviewPrompt(VERDICT_NAMES, RESCAN_GUIDANCE);
const RESCAN_SPENT_VERDICTS = VERDICT_NAMES.filter((name) => name !== "RESCAN");
const RESCAN_SPENT_PROMPT = composeReviewPrompt(RESCAN_SPENT_VERDICTS, RESCAN_SPENT_GUIDANCE);

// The review is a one-word verdict, so the host's frontier default is more
// model than it needs. Codex and Claude name a smaller tier the way Ghost's
// smol bridge does; Muse and Grok have no such tier to name, so the flag is
// absent unless the variable names one. Claude's alias tracks the latest
// Sonnet; Codex has no family alias, so its default is an exact release.
const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
const CLAUDE_DEFAULT_MODEL = "sonnet";

function modelArgs(variable, fallback) {
  const model = process.env[variable] || fallback;
  return model ? ["--model", model] : [];
}

// Grok dispatches ~/.claude/settings.json, so a Claude install's command still
// ends in `claude`. The host actually running the agent is the reviewer:
// GROK_HOOK_EVENT is set only by Grok's hook runner, never by Claude Code.
function resolveRunner(requested) {
  if (process.env.GROK_HOOK_EVENT) return "grok";
  return requested;
}

function grokNativeHookFile() {
  return path.join(process.env.GROK_HOME || path.join(homedir(), ".grok"), "hooks", "keep-going.json");
}

// Dual install writes Grok's own file and still leaves the Claude-settings copy
// for Claude Code. Grok would dispatch both; the borrowed copy yields so the
// native grok hook is the one review.
async function grokNativeKeepGoingPresent() {
  try {
    const config = JSON.parse(await readFile(grokNativeHookFile(), "utf8"));
    const groups = config?.hooks?.Stop;
    if (!Array.isArray(groups)) return false;
    return groups.some((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).some((hook) => {
        const command = hook?.command;
        if (typeof command !== "string") return false;
        if (!/(?:keep-going|unblock|stop-review)\.mjs\b/.test(command)) return false;
        return command.trimEnd().split(/\s+/).at(-1) === "grok";
      }),
    );
  } catch {
    return false;
  }
}

async function yieldsToGrokNative(requested) {
  if (!process.env.GROK_HOOK_EVENT || requested === "grok") return false;
  return grokNativeKeepGoingPresent();
}

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

// CLI reviewers must exit successfully before their output is parsed.
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

async function* jsonLines(file, range = {}) {
  const stream = createReadStream(file, { encoding: "utf8", ...range });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore incomplete or non-JSON transcript lines.
    }
  }
}

// Prompts the host injected on behalf of this hook: Claude Code records them as
// "Stop hook feedback: ..." meta user messages.
const HOOK_PROMPT_PATTERN = /^\s*Stop hook feedback\b/;

async function allowedTranscriptPath(input, runner) {
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    throw new Error("Stop input is missing transcript_path");
  }
  const candidate = await realpath(transcriptPath);

  for (const root of RUNTIMES[runner].roots()) {
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

// Claude's stop payload names the session and nothing else, so where one owner
// turn ends and the next begins is information only the transcript has: the
// turn starts at the last genuine user message, and the hook prompts after it
// are this turn's continuations.
async function claudeContinuations(input) {
  const transcriptPath = await allowedTranscriptPath(input, "claude");
  let count = 0;
  let hasOwner = false;
  for await (const record of jsonLines(transcriptPath)) {
    const message = claudeUserMessage(record);
    if (message?.genuine) {
      hasOwner = true;
      count = 0;
    } else if (hasOwner && message && HOOK_PROMPT_PATTERN.test(message.text)) {
      count += 1;
    }
  }
  return count;
}

function lastGenuinePrompt(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || isInjectedContext(trimmed) || HOOK_PROMPT_PATTERN.test(trimmed)) return "";
  return trimmed;
}

// Each owner-prompt reader keeps the last genuine prompt in its transcript;
// records that match nothing contribute nothing.
async function lastTranscriptMatch(transcriptPath, pick) {
  let last = "";
  for await (const record of jsonLines(transcriptPath)) {
    const text = pick(record);
    if (text) last = text;
  }
  return last;
}

async function claudeOwnerPrompt(input) {
  return lastTranscriptMatch(await allowedTranscriptPath(input, "claude"), (record) => {
    const message = claudeUserMessage(record);
    return message?.genuine ? lastGenuinePrompt(message.text) : "";
  });
}

async function codexOwnerPrompt(input) {
  const turnId = input.turn_id;
  return lastTranscriptMatch(await allowedTranscriptPath(input, "codex"), (record) => {
    const payload = record?.payload;
    if (record?.type !== "response_item" || payload?.type !== "message" || payload?.role !== "user") return "";
    if (turnId && payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId) return "";
    return lastGenuinePrompt(messageText(payload));
  });
}

// The stop names the updates log; what the owner typed lands in the chat
// history beside it.
const grokChatHistory = (updates) => path.join(path.dirname(updates), "chat_history.jsonl");

function grokQueryText(record) {
  const raw = messageText(record);
  const tagged = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return lastGenuinePrompt(tagged ? tagged[1] : raw);
}

async function grokOwnerPrompt(input) {
  const updates = await allowedTranscriptPath(input, "grok");
  const sessionDir = path.dirname(updates);
  const cwdDir = path.dirname(sessionDir);
  const sessionId = input.session_id;
  try {
    const last = await lastTranscriptMatch(path.join(cwdDir, "prompt_history.jsonl"), (record) => {
      if (record?.is_bash) return "";
      if (sessionId && record?.session_id && record.session_id !== sessionId) return "";
      return typeof record?.prompt === "string" ? record.prompt.trim() : "";
    });
    if (last) return last;
  } catch {
    // prompt_history is the typed prompt; chat_history is the fallback wrap.
  }
  try {
    return await lastTranscriptMatch(grokChatHistory(updates), (record) =>
      record?.type !== "user" || record.synthetic_reason ? "" : grokQueryText(record));
  } catch {
    return "";
  }
}

async function resolveOwnerPrompt(input, runner) {
  const fromPayload = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  if (fromPayload) return fromPayload;
  // A subagent stop carries the parent's transcript; that is the parent's request.
  const recover = RUNTIMES[runner].ownerPrompt;
  if (!recover || input.agent_id) return "";
  try {
    return (await recover(input)).trim();
  } catch {
    return "";
  }
}

// Past turns per harness, oldest first, current turn excluded. Every reader
// is best-effort: what it cannot parse is a turn the reviewer never hears
// about. Only the owner's prompt and the turn's final assistant text are
// kept — tool calls, reasoning, and hook feedback never leave the file.
async function readTurns(file, classify) {
  const segments = [];
  let current = null;
  for await (const record of jsonLines(file)) {
    const turn = classify(record);
    if (!turn) continue;
    if (turn.open === undefined) {
      if (current && turn.final) current.final = turn.final;
    } else if (current && !current.owner && turn.open) {
      // A turn_context marker opens an empty head; its user message fills
      // it, so the marker and the message stay one turn.
      current.owner = turn.open;
    } else {
      current = { owner: turn.open, final: "" };
      if (turn.id !== undefined) current.id = turn.id;
      segments.push(current);
    }
  }
  return segments;
}

function claudeTurn(record) {
  if (record?.type === "assistant" && record.message?.role === "assistant") {
    const text = messageText(record.message).trim();
    return text ? { final: text } : null;
  }
  const message = claudeUserMessage(record);
  if (!message?.genuine) return null;
  const owner = lastGenuinePrompt(message.text);
  return owner ? { open: owner } : null;
}

function grokTurn(record) {
  if (record?.type === "user" && !record.synthetic_reason) {
    const text = grokQueryText(record);
    // Prompt recovery falls back to prompt_history; the chat log's injected
    // blocks (<user_info> and friends) carry no request to index.
    return text && !text.startsWith("<") ? { open: text } : null;
  }
  if (record?.type === "assistant") {
    const raw = record.content;
    const text = (typeof raw === "string" ? raw : messageText(record)).trim();
    return text ? { final: text } : null;
  }
  return null;
}

function ghostTurn(record) {
  // Turns segment the way the daemon itself does: user-role messages open
  // them (agent echoes excluded). Custom entries — hook context, nudges,
  // imports — never open a turn.
  if (record?.type !== "message") return null;
  const message = record.message;
  if (message?.role === "user" && message.attribution !== "agent") {
    const text = lastGenuinePrompt(messageText(message));
    return text && !HOOK_PROMPT_PATTERN.test(text) ? { open: text } : null;
  }
  if (message?.role === "assistant" && message.stopReason !== "toolUse") {
    const text = messageText(message).trim();
    return text ? { final: text } : null;
  }
  return null;
}

async function claudePastTurns(input) {
  // A subagent stop carries the parent's transcript, not the subagent's turns.
  if (input.agent_id) return [];
  const segments = await readTurns(await allowedTranscriptPath(input, "claude"), claudeTurn);
  return segments.slice(0, -1);
}

function codexTurn(record) {
  if (record?.type === "turn_context" && typeof record.payload?.turn_id === "string") {
    return { open: "", id: record.payload.turn_id };
  }
  const payload = record?.type === "response_item" ? record.payload : null;
  if (payload?.type !== "message") return null;
  if (payload.role === "user") {
    const text = lastGenuinePrompt(messageText(payload));
    // A past continuation's hook feedback would otherwise overwrite the
    // turn's real request; it is feedback, not a prompt.
    return text && !HOOK_PROMPT_PATTERN.test(text) ? { open: text } : null;
  }
  if (payload.role === "assistant") {
    const text = messageText(payload).trim();
    return text ? { final: text } : null;
  }
  return null;
}

async function codexPastTurns(input) {
  const segments = await readTurns(await allowedTranscriptPath(input, "codex"), codexTurn);
  const named = segments.filter((segment) => segment.owner);
  let currentIndex = named.length - 1;
  if (typeof input.turn_id === "string" && input.turn_id) {
    const found = named.findLastIndex((segment) => segment.id === input.turn_id);
    if (found >= 0) currentIndex = found;
  }
  return named.slice(0, currentIndex).map(({ owner, final }) => ({ owner, final }));
}

async function grokPastTurns(input) {
  const updates = await allowedTranscriptPath(input, "grok");
  const segments = await readTurns(grokChatHistory(updates), grokTurn);
  return segments.slice(0, -1);
}

async function ghostPastTurns(input) {
  // Ghost hands the hook the runtime's own pi session file as the transcript.
  if (typeof input.transcript_path !== "string" || !input.transcript_path) return [];
  let file;
  try {
    file = await realpath(input.transcript_path);
  } catch {
    return [];
  }
  const segments = await readTurns(file, ghostTurn);
  return segments.slice(0, -1);
}

function piPastTurns(input) {
  // The extension owns the branch, so it sends the turns down with the stop
  // instead of the hook re-reading a file it cannot see.
  if (!Array.isArray(input.past_turns)) return [];
  return input.past_turns
    .filter((turn) =>
      turn && typeof turn.owner_prompt === "string" && turn.owner_prompt.trim() &&
      typeof turn.final_response === "string",
    )
    .map((turn) => ({ owner: turn.owner_prompt, final: turn.final_response }))
    .slice(-TURN_INDEX_LIMIT);
}

async function listPastTurns(input, runner) {
  if (!turnsEnabled()) return [];
  try {
    switch (runner) {
      case "claude":
        return (await claudePastTurns(input)).slice(-TURN_INDEX_LIMIT);
      case "codex":
        return (await codexPastTurns(input)).slice(-TURN_INDEX_LIMIT);
      case "grok":
        return (await grokPastTurns(input)).slice(-TURN_INDEX_LIMIT);
      case "ghost":
        return (await ghostPastTurns(input)).slice(-TURN_INDEX_LIMIT);
      case "pi":
        return piPastTurns(input);
      default:
        // Muse sends no transcript, so there is nothing to index: the review
        // runs exactly as it did before turns existed.
        return [];
    }
  } catch {
    return [];
  }
}

// The cap is the only thing between a stuck reviewer and a hundred turns of
// spend, and counting from a transcript costs a parser per host and works only
// where the host's format is one this file knows. So the hook keeps its own
// tally instead, from what the stop payload already carries: blocks recorded
// against the turn they belong to.
function xdgStateHome() {
  return process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
}

const tallyFile = (input, runner) =>
  path.join(RUNTIMES[runner].state(input), "keep-going", "continuations.json");

// The session plus whatever the host sends that tells one owner turn from the
// next, so that a new key is a new turn. Codex sends a turn id and Ghost the
// owner's prompt, digested because a file on disk has no business holding what
// the user typed. Claude sends neither, and so has one key per session.
//
// A subagent stop carries the *parent* session id, so agent_id comes first:
// without it a subagent's continuations are spent out of the turn that
// launched it, and enough subagents would cap a turn that had barely started.
function payloadTurn(input) {
  const named = [input.agent_id, input.turn_id].find((value) => typeof value === "string" && value);
  if (named) return named;
  const ownerPrompt = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  return ownerPrompt ? createHash("sha256").update(ownerPrompt).digest("hex").slice(0, 16) : "";
}

function turnKey(input) {
  return `${input.session_id}\u0000${payloadTurn(input)}`;
}

// Garbage collection rather than scoping, now that the key says which turn a
// count belongs to: an interrupted turn never comes back for its entry to be
// cleared, and the file would otherwise keep one per turn forever.
const TALLY_IDLE_MS = 30 * 60_000;

async function readTally(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const fresh = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (Number.isInteger(entry?.count) && Date.now() - entry.updated < TALLY_IDLE_MS) {
        fresh[key] = entry;
      }
    }
    return fresh;
  } catch {
    // No tally yet, or one we cannot read: the floor starts at zero.
    return {};
  }
}

async function writeTally(file, tally) {
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

// The key scopes the count to a turn wherever the host names one, but Claude
// names none, and an owner who repeats a prompt word for word re-derives the
// key of the turn before. Ending a turn where the hook lets the stop through is
// what keeps a finished turn's count from being spent on the next one in both.
//
// The entry also remembers whether a RESCAN was issued this turn, so the one
// fresh pass the verdict asks for is asked for once. Like the count, it is
// cleared when a stop goes through.
async function recordTurnState(input, runner, blocked, exact = null, rescan = false) {
  if (!RUNTIMES[runner].state) return;
  const file = tallyFile(input, runner);
  const key = turnKey(input);
  const tally = await readTally(file);
  if (!blocked) {
    delete tally[key];
  } else {
    // Where the transcript was readable it is the truth, so the tally is set
    // from it rather than incremented past its own stale value — otherwise the
    // number the hook falls back to is one it has been drifting all turn.
    const from = exact ?? tally[key]?.count ?? 0;
    const rescanned = tally[key]?.rescanned === true || rescan;
    tally[key] = { count: from + 1, updated: Date.now(), ...(rescanned ? { rescanned } : {}) };
  }
  await writeTally(file, tally);
}

// Whether this turn has already had its one RESCAN. A tally-backed host reads
// it from the turn's entry; Pi keeps no tally and says so in its stop input.
async function recordedRescan(input, runner) {
  if (!RUNTIMES[runner].state) return input.rescanned === true;
  const tally = await readTally(tallyFile(input, runner));
  return tally[turnKey(input)]?.rescanned === true;
}

function stopCandidateText(input) {
  // Grok spells this one key in camelCase while sending session_id and
  // transcript_path in snake_case; an unread message is an accepted stop, so
  // the difference would silently disable the hook there.
  const candidate = input.last_assistant_message ?? input.lastAssistantMessage;
  if (typeof candidate === "string") return candidate;
  return messageText(candidate);
}

function normalizeReply(text) {
  return String(text)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

// A final message that asserts nothing beyond completion in a single token —
// the shape internal observer subagents stop with ("None", "Done."). With no
// owner prompt to match it against, a reviewer could only ever verdict STOP,
// so the model call is skipped and the stop accepted.
const VACUOUS_COMPLETIONS = new Set(["none", "done", "ok", "okay", "finished", "complete", "completed"]);

// Stops that need no reviewer: the reply the owner asked for verbatim, or a
// bare completion token with no prompt to weigh it against. Each rule names
// the audit mechanism that accepted the stop.
function reviewlessStop(ownerPrompt, lastMessage) {
  if (ownerPrompt) {
    return lastMessageFulfillsOwnerPrompt(ownerPrompt, lastMessage)
      ? { reason: "last message fulfills owner_prompt", countedBy: "owner_prompt" }
      : null;
  }
  return VACUOUS_COMPLETIONS.has(normalizeReply(lastMessage).toLowerCase())
    ? { reason: "nothing to review", countedBy: "stub" }
    : null;
}

function exactReplyCandidates(ownerPrompt) {
  const prompt = ownerPrompt.trim();
  const found = [];
  for (const re of [/"([^"\n]+)"/g, /'([^'\n]+)'/g, /`([^`\n]+)`/g]) {
    for (const match of prompt.matchAll(re)) found.push(match[1]);
  }
  const after = prompt.match(
    /\b(?:reply(?:\s+with)?(?:\s+exactly)?|exactly(?:\s+this(?:\s+one)?\s+line(?:\s+and\s+nothing\s+else)?)?)\s*:\s*(.+)\s*$/i,
  );
  if (after) found.push(after[1]);
  const onlyWord = prompt.match(/\breply\s+with\s+only(?:\s+the\s+word)?\s+([^\s.:,]+)/i);
  if (onlyWord) found.push(onlyWord[1]);
  const onlyColon = prompt.match(/\breply\s+with\s+only\s*:\s*(.+?)(?:\s+and\s+then\s+stop|\s*$)/i);
  if (onlyColon) found.push(onlyColon[1]);
  return [...new Set(found.map(normalizeReply).filter(Boolean))];
}

// Ghost's smol reviewer treats a one-line exact reply as unfinished. If the
// owner asked for a specific line and the agent said that line, the turn is over.
function lastMessageFulfillsOwnerPrompt(ownerPrompt, lastMessage) {
  const last = normalizeReply(lastMessage);
  if (!last) return false;
  return exactReplyCandidates(ownerPrompt).some((wanted) => wanted === last);
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

    child.on("error", fail);
    child.stdin.on("error", fail);
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

async function inTemporaryDirectory(runner, work) {
  const directory = await mkdtemp(path.join(tmpdir(), `${runner}-keep-going-`));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCodexModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("codex", async (directory) => {
    const outputPath = path.join(directory, "result.txt");
    const codex = process.env.KEEP_GOING_CODEX_BIN || "codex";
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
      "--config",
      'approval_policy="never"',
      // Codex rejects a level its model does not list. Every model it offers
      // lists "low"; the default review model lists no "none".
      "--config",
      'model_reasoning_effort="low"',
      "--output-last-message",
      outputPath,
      ...modelArgs("KEEP_GOING_CODEX_MODEL", CODEX_DEFAULT_MODEL),
      "-",
    ];
    assertExitOk(await runProcess(codex, args, prompt, timeoutMs), "codex exec");
    return readFile(outputPath, "utf8");
  });
}

async function runClaudeModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("claude", async (directory) => {
    const claude = process.env.KEEP_GOING_CLAUDE_BIN || "claude";
    // No tools and no --json-schema: a plain-text verdict, not a StructuredOutput
    // tool call. Claude's lowest advertised effort is low (it has no none).
    const args = [
      "--print",
      "--safe-mode",
      "--tools",
      "",
      "--effort",
      "low",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
      ...modelArgs("KEEP_GOING_CLAUDE_MODEL", CLAUDE_DEFAULT_MODEL),
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
  });
}

// Grok's default system prompt is a coding agent. Without this, --single
// writes analysis before STOP and the hook fails open.
// The verdicts on offer this stop, so the system prompt never lists one the
// user prompt has withdrawn.
const grokClassifierPrompt = (verdicts) =>
  `Reply with exactly one of ${listVerdicts(verdicts)} as the first line. No preamble, no analysis.`;

function grokReviewerEnv(overlayHome) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GROK_")) delete env[key];
  }
  env.GROK_HOME = overlayHome;
  return env;
}

// Nested `grok --single` otherwise inherits the parent session's home: MCP
// servers, plugins, high reasoning, and the coding agent. That is a full
// turn, and it times out the classifier. The overlay carries auth only, so
// grok picks its own default model with no tools and --effort low (the lowest
// level this CLI advertises; it has no none). --single
// still dispatches no stop hook, so the reviewer cannot trip the hook that
// spawned it.
async function runGrokModel({ prompt, timeoutMs, verdicts = VERDICT_NAMES }) {
  return inTemporaryDirectory("grok", async (directory) => {
    const overlayHome = path.join(directory, "home");
    await mkdir(path.join(overlayHome, "hooks"), { recursive: true });
    const sourceHome = process.env.GROK_HOME || path.join(homedir(), ".grok");
    try {
      const auth = path.join(overlayHome, "auth.json");
      await copyFile(path.join(sourceHome, "auth.json"), auth);
      await chmod(auth, 0o600);
    } catch {
      // Same as Muse: a missing credential fails the review open below.
    }
    // Grok still scans ~/.claude and ~/.cursor when GROK_HOME has no config.
    // That would re-enter this hook from inside the reviewer.
    await writeFile(
      path.join(overlayHome, "config.toml"),
      [
        "[compat.claude]",
        "hooks = false",
        "mcps = false",
        "skills = false",
        "agents = false",
        "rules = false",
        "[compat.cursor]",
        "hooks = false",
        "mcps = false",
        "skills = false",
        "agents = false",
        "rules = false",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const grok = process.env.KEEP_GOING_GROK_BIN || "grok";
    const args = [
      "--single",
      prompt,
      "--output-format",
      "plain",
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--no-auto-update",
      "--verbatim",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--effort",
      "low",
      "--system-prompt-override",
      grokClassifierPrompt(verdicts),
      "--cwd",
      directory,
      ...modelArgs("KEEP_GOING_GROK_MODEL"),
    ];
    const result = assertExitOk(
      await runProcess(grok, args, "", timeoutMs, grokReviewerEnv(overlayHome), directory),
      "grok",
    );
    return result.stdout;
  });
}

// A headless run fires Stop hooks, so without an overlay the reviewer would
// re-enter this hook: each nested review is a fresh session, and the tally
// that caps one turn cannot cap the regress. The overlay carries no settings
// file and therefore no hooks. XDG_CONFIG_HOME is stripped from hook commands,
// so the default home's auth is restored into the overlay best-effort — a
// non-default config home is unreachable from here and the review then fails
// open.
async function runMuseModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("muse", async (root) => {
    const muse = process.env.KEEP_GOING_MUSE_BIN || "muse";
    const directory = path.join(root, "work");
    const configHome = path.join(root, "config");
    await mkdir(directory, { recursive: true });
    try {
      const authTarget = path.join(configHome, "muse", "auth.json");
      await mkdir(path.dirname(authTarget), { recursive: true });
      await copyFile(path.join(homedir(), ".config", "muse", "auth.json"), authTarget);
      await chmod(authTarget, 0o600);
    } catch {
      // No credentials to restore: the reviewer fails open below.
    }
    const promptPath = path.join(directory, "prompt.txt");
    await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    const args = [
      "exec",
      "--no-session-log",
      "--disable-approval",
      "--disable-web-tools",
      "--no-foreign-personal-context",
      "--prompt-file",
      promptPath,
      ...modelArgs("KEEP_GOING_MUSE_MODEL"),
    ];
    const result = assertExitOk(
      await runProcess(muse, args, "", timeoutMs, { ...process.env, XDG_CONFIG_HOME: configHome }, directory),
      "muse",
    );
    return result.stdout;
  });
}

async function runGhostModel({ prompt, timeoutMs, ghostHome }) {
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
// redacted, flattened to one line, and truncated to the budget. An empty
// line still falls back to a generic one.
function sanitizeNudge(value) {
  return oneLine(value, NUDGE_LIMIT).trimEnd();
}

const TURN_REQUEST_PATTERN = /^TURN\s+(-?\d+)(?:\s*-\s*(-?\d+))?\s*$/i;

// A history request names past turns 1-based, oldest first; negative counts
// back from the previous turn, so -1 is the turn just before this one. Out
// of range, backwards beyond a swap, or wider than the per-request cap is
// not a request at all: the output fails open as a bad verdict instead.
function parseTurnRequest(text, count) {
  const match = TURN_REQUEST_PATTERN.exec(String(text ?? "").trim());
  if (!match) return null;
  const at = (n) => (n < 0 ? count + n + 1 : n);
  let start = at(Number(match[1]));
  let end = match[2] === undefined ? start : at(Number(match[2]));
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start > end) [start, end] = [end, start];
  if (start < 1 || end > count || end - start + 1 > TURNS_PER_REQUEST) return null;
  return { start, end };
}

function oneLine(value, limit) {
  const line = redactSensitive(String(value ?? "")).replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : line.slice(0, limit);
}

function turnIndexSection(turns) {
  const lines = turns.map((turn, index) =>
    `${index + 1}: ${oneLine(turn.owner, TURN_INDEX_CHARS) || "(no prompt recorded)"}`);
  return [
    `Past turns, oldest first. To read full text before verdicting, reply TURN n or TURN x-y (at most ${TURNS_PER_REQUEST} turns), e.g. TURN ${turns.length}. Then verdict as usual.`,
    ...lines,
  ].join("\n");
}

function formatTurns(turns, { start, end }) {
  return turns.slice(start - 1, end).map((turn, index) => [
    `Turn ${start + index}`,
    `owner_prompt: ${compactText(turn.owner, TURN_OWNER_CHARS)}`,
    `final_response: ${compactText(turn.final, TURN_FINAL_CHARS) || "(none)"}`,
  ].join("\n")).join("\n\n");
}

function parseReviewVerdict(text, offered = VERDICT_NAMES) {
  const body = String(text ?? "").trim();
  const match = REVIEW_VERDICT_PATTERN.exec(body)
    ?? verdictAfterPreamble(body)
    ?? trailingVerdict(body);
  if (!match) {
    throw new Error(`Reviewer output must begin with ${listVerdicts(offered)}`);
  }
  // Every verdict word is still recognised, so an echo of a withdrawn one is
  // stripped like any other; but a withdrawn one as the answer is no answer.
  if (!offered.includes(match[1])) {
    throw new Error(`Reviewer answered ${match[1]}, which was not offered on this stop; expected ${listVerdicts(offered)}`);
  }
  let rest = match[2];
  while (VERDICT_ECHO.test(rest)) rest = rest.replace(VERDICT_ECHO, "");
  return { verdict: match[1], nudge: sanitizeNudge(rest) };
}

// Grok's default agent writes a sentence before the verdict. The first line
// that is a verdict is the answer; preamble is discarded.
function verdictAfterPreamble(body) {
  const lines = body.split(/\n/);
  for (let i = 1; i < lines.length; i++) {
    const rest = lines.slice(i).join("\n").trim();
    const match = REVIEW_VERDICT_PATTERN.exec(rest);
    if (match) return match;
  }
  return null;
}

// Same agent often glues the word on: "I'll inspect the workspace.STOP"
function trailingVerdict(body) {
  const match = new RegExp(
    `(?:^|[^A-Za-z_])(${VERDICT_ALTERNATION})(?:${VERDICT_SEPARATOR})*$`,
  ).exec(body);
  return match ? [match[0], match[1], ""] : null;
}

// Near the cap the reviewer is told to write a different line, rather than
// having one appended to the line it wrote: hook-side facts reach it the one
// way NUDGE_LIMIT already does, and the message stays within the budget.
const LAST_STRETCH_NOTE =
  "This turn is near its limit: tell the agent to land what is in flight rather than start anything new.";

// Earlier nudges are filtered out of the transcript the reviewer reads, so
// without this every firing looks like the first. The agent meanwhile grows
// more insistent about why it stopped, and a reviewer that cannot see its own
// refused attempts reads that insistence as resistance to push harder against.
// The count is the only way it learns it is being refused rather than ignored.
const refusalNote = (continuations) =>
  `This turn has already been continued ${continuations} time${continuations === 1 ? "" : "s"}. `
  + "If the agent is holding for the same stated reason as before, that reason is a real blocker — STOP.";

function reviewPrompt(continuations, rescanned = false) {
  const base = rescanned ? RESCAN_SPENT_PROMPT : REVIEW_PROMPT;
  const notes = [];
  if (continuations > 0) notes.push(refusalNote(continuations));
  if (continuations >= CONTINUATION_CAP - LAST_STRETCH) notes.push(LAST_STRETCH_NOTE);
  return notes.length ? `${base}\n\n${notes.join("\n\n")}` : base;
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

async function recordReviewAudit(input, runner, { verdict, reason, error, countedBy, reviewerOutput }) {
  const auditPath = process.env.KEEP_GOING_AUDIT_LOG;
  if (!auditPath) return;
  const entry = {
    timestamp: new Date().toISOString(),
    runner,
    ...(typeof input?.reviewer_model === "string" ? { reviewer_model: input.reviewer_model } : {}),
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    cwd: typeof input?.cwd === "string" ? input.cwd : null,
    verdict: error ? "ERROR" : verdict,
    rationale: error ? compactText(String(error), 2_000) : reason ?? "",
    // The reviewer's own words, kept whole where the rationale keeps only the
    // nudge: a STOP row would otherwise say nothing about why the turn ended.
    ...(reviewerOutput !== undefined ? { reviewer_output: compactText(reviewerOutput, 2_000) } : {}),
    // Record how the turn was counted. For tally-backed hosts, include field
    // names to help diagnose their payload format without logging its values.
    counted_by: countedBy,
    ...(countedBy === "tally" ? { stop_input_fields: Object.keys(input ?? {}).sort() } : {}),
  };
  try {
    await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging is best-effort and must never change the hook decision.
  }
}

// Every exit of handleStop makes the same two writes: the turn state, which
// a stop let through clears and a block advances, and the audit row. One
// helper makes both so no exit can forget either. Forgetting the first is how
// the cap gets disarmed, the count surviving into a turn that never earned
// it; forgetting the second is how a whole path vanished from the log.
async function settleStop(input, runner, output, audit, exact = null, rescan = false) {
  const blocked = output.decision === "block";
  await recordTurnState(input, runner, blocked, exact, rescan);
  await recordReviewAudit(input, runner, { verdict: blocked ? "CONTINUE" : "STOP", reason: output.reason, ...audit });
  return output;
}

async function recordedContinuations(input, runner) {
  if (!RUNTIMES[runner].state) return RUNTIMES[runner].count(input);
  const tally = await readTally(tallyFile(input, runner));
  return tally[turnKey(input)]?.count ?? 0;
}

async function handleStop(input, runner = "codex", { runModel, delay, onVerdict } = {}) {
  if (await yieldsToGrokNative(runner)) return {};
  runner = resolveRunner(runner);
  const runtime = RUNTIMES[runner];
  if (!runtime) throw new Error(`Unsupported keep-going runtime: ${runner}`);
  for (const key of runtime.requires) {
    if (typeof input[key] !== "string" || !input[key]) {
      throw new Error(`Stop input is missing ${key}`);
    }
  }
  if (await followedUpDuringQuietWait(input, runtime, delay)) {
    return settleStop(input, runner, {}, { reason: "user followed up during quiet wait", countedBy: "quiet-wait" });
  }
  const lastAssistantMessage = compactText(stopCandidateText(input), 12_000);
  if (!lastAssistantMessage) {
    // Grok can fire Stop with no lastAssistantMessage. Accepting that stop
    // disables the hook. Block once; if the next stop is still empty, let it end.
    if (input.stop_hook_active || input.stopHookActive) {
      return settleStop(input, runner, {}, { reason: "no last message on retry", countedBy: "empty" });
    }
    return settleStop(input, runner, {
      decision: "block",
      reason: "The stop hook did not see your last message. If work remains, continue it; if you are done, say so in one sentence.",
    }, { countedBy: "empty" });
  }

  const ownerPrompt = await resolveOwnerPrompt(input, runner);
  const settled = reviewlessStop(ownerPrompt, lastAssistantMessage);
  if (settled) return settleStop(input, runner, {}, settled);

  let review;
  let continuations = await recordedContinuations(input, runner);
  const rescanned = await recordedRescan(input, runner);
  const offered = rescanned ? RESCAN_SPENT_VERDICTS : VERDICT_NAMES;
  let countedBy = runtime.state ? "tally" : "session";
  const named = payloadTurn(input);
  // The last reviewer response, whatever it parses as: an unparseable reply
  // is the debugging evidence, so the audit row keeps it on the fail-open
  // path as well as the verdict one.
  let rawReview;
  try {
    // A transcript is read to count when the payload leaves the turn unnamed,
    // and to recover owner_prompt when the host does not send it. A subagent
    // names its turn, and its parent's transcript holds the parent's messages.
    if (!named && runtime.count && typeof input.transcript_path === "string" && input.transcript_path) {
      try {
        continuations = await runtime.count(input);
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
      return settleStop(input, runner, capped, { verdict: "CAP", reason: capped.systemMessage, countedBy });
    }

    const run = runModel ?? runtime.run;
    if (!run) throw new Error(`${runner} review requires its native extension`);
    // Past turns ride along only when there are any: the index tells the
    // reviewer what it may ask for, and a harness with no readable history
    // reviews exactly as before.
    const pastTurns = await listPastTurns(input, runner);
    let reviewerPrompt = `${reviewPrompt(continuations, rescanned)}\n\n${JSON.stringify({
      last_assistant_message: lastAssistantMessage,
      owner_prompt: compactText(ownerPrompt, 12_000),
    })}`;
    if (pastTurns.length) reviewerPrompt += `\n\n${turnIndexSection(pastTurns)}`;
    const loopStart = Date.now();
    let turnRequests = 0;
    for (;;) {
      const remaining = REVIEW_BUDGET_MS - (Date.now() - loopStart);
      if (remaining < REVIEW_CALL_FLOOR_MS) {
        throw new Error(`review budget (${REVIEW_BUDGET_MS} ms) spent before a verdict`);
      }
      rawReview = await run({
        prompt: reviewerPrompt,
        timeoutMs: Math.min(CLASSIFIER_TIMEOUT_MS, remaining),
        ghostHome: input.ghost_home,
        verdicts: offered,
      });
      try {
        review = parseReviewVerdict(rawReview, offered);
        break;
      } catch (verdictError) {
        // Not a verdict: the one other legal move is asking for history. Ways
        // of asking that name nothing readable fail open as a bad verdict.
        const request = pastTurns.length && turnRequests < TURN_REQUESTS_MAX
          ? parseTurnRequest(rawReview, pastTurns.length)
          : null;
        if (!request) throw verdictError;
        reviewerPrompt += `\n\n${formatTurns(pastTurns, request)}\n\nVerdict now, with the turns above in mind.`;
        turnRequests += 1;
      }
    }
  } catch (error) {
    // Failing open lets the stop through, so it ends the turn like any other
    // accepted stop. This is the path a reviewer timeout takes — the stuck
    // case the cap exists for — and leaving the count behind would spend it
    // against whatever the session does next.
    return settleStop(
      input,
      runner,
      { systemMessage: `keep-going was skipped: ${compactText(error.message, 500)}` },
      { error: error.message, countedBy, reviewerOutput: rawReview },
    );
  }

  onVerdict?.(review.verdict);
  return settleStop(
    input,
    runner,
    hookOutputForVerdict(review.verdict, continuations, review.nudge),
    { verdict: review.verdict, countedBy, reviewerOutput: rawReview },
    countedBy === "transcript" ? continuations : null,
    review.verdict === "RESCAN",
  );
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
  TURN_INDEX_LIMIT,
  QUIET_DELAY_MS,
  quietDelayMs,
  REVIEW_PROMPT,
  RESCAN_SPENT_PROMPT,
  RESCAN_SPENT_VERDICTS,
  VERDICTS,
  NUDGE_LIMIT,
  LAST_STRETCH,
  claudeContinuations,
  recordedContinuations,
  recordedRescan,
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
  lastMessageFulfillsOwnerPrompt,
  resolveOwnerPrompt,
};
