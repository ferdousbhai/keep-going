#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024;
const CLASSIFIER_TIMEOUT_MS = 180_000;
// Continuations per owner turn before the hook accepts the stop unconditionally.
const CONTINUATION_CAP = 100;
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
// hook summaries and housekeeping records, after Stop has fired. A
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
      if (watch.opens(record)) return true;
    }
  } catch {
    // An unreadable range shows no follow-up; the stop is reviewed as usual.
  }
  return false;
}

const ownTranscript = (input) => input.transcript_path;

// Everything that differs per host, keyed once: the inputs it must supply, the
// directory its state belongs under, the directories its transcripts may live
// in, how its nudges are read, how its owner prompt is read, how its reviewer
// is run, and which log shows a follow-up. A host whose stop payload already
// identifies the turn keeps its count in the tally, keyed on that identity.
// Function declarations hoist, so the readers and the runners below are
// already bound when this is evaluated.
const RUNTIMES = {
  // Pi supplies a model call from its authenticated registry and reads its
  // nudges off the active session branch. No subprocess or tally is needed.
  pi: {
    requires: ["session_id", "turn_id"],
    nudges: (input) => ({ continuations: input.continuation_count, held: input.held_after_nudge === true }),
  },
  codex: {
    requires: ["turn_id", "session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")],
    nudges: codexNudges,
    ownerPrompt: codexOwnerPrompt,
    run: runCodexModel,
    followUp: { file: ownTranscript, opens: codexOpensTurn },
  },
  claude: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")],
    nudges: claudeNudges,
    ownerPrompt: claudeOwnerPrompt,
    run: runClaudeModel,
    followUp: { file: ownTranscript, opens: claudeOpensTurn },
  },
  // Ghost needs no quiet wait: it asks no stop hook while the owner's queued
  // follow-up waits and drops a continuation one arrives during.
  ghost: {
    requires: ["session_id", "owner_prompt", "ghost_home"],
    state: (input) => input.ghost_home,
    run: runGhostModel,
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
  // own. A Claude install's command still ends in `claude`, so handleStop
  // remaps to this runtime whenever GROK_HOOK_EVENT is set — unless a native
  // Grok hook is present, in which case the Claude copy yields. Dual install
  // writes ~/.grok/hooks/keep-going.json so Grok is covered even if that scan
  // is off; grok picks its own default model.
  // Its transcript is a log of session/update frames in which a blocked turn's
  // nudge lands inside the agent's own reasoning, leaving nothing to read
  // nudges from; the tally counts them instead.
  grok: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.GROK_HOME || path.join(homedir(), ".grok"), "sessions")],
    ownerPrompt: grokOwnerPrompt,
    run: runGrokModel,
    followUp: {
      file: (input) => (typeof input.transcript_path === "string" ? grokChatHistory(input.transcript_path) : null),
      opens: grokOpensTurn,
    },
  },
  // Copilot, Antigravity and Cursor send a stop that names neither the reply nor the request.
  // `payload` reads both from what the host keeps (null: not a stop to review)
  // and `answer` speaks the host's own continue. Their reviewers are the host's
  // own CLI; where its stop hooks have no off switch, KEEP_GOING_REVIEWING
  // keeps a reviewer's stop from being reviewed in turn.
  copilot: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state")],
    payload: copilotPayload,
    run: runCopilotModel,
  },
  // Antigravity sends its nudge in as a system message, so the last owner
  // prompt in its transcript stays the turn's request across continuations.
  agy: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(homedir(), ".gemini", "antigravity-cli", "brain")],
    payload: agyPayload,
    answer: (output) => (output.decision === "block" ? { decision: "continue", reason: output.reason } : {}),
    run: runAgyModel,
  },
  // Cursor keeps a transcript in no documented shape, but hands its hooks the
  // prompt (beforeSubmitPrompt) and the reply (afterAgentResponse); the same
  // command records both and reviews at stop. Cursor caps its own follow-ups.
  cursor: {
    requires: ["session_id"],
    state: xdgStateHome,
    payload: cursorPayload,
    answer: (output) => (output.decision === "block" ? { followup_message: output.reason } : {}),
    run: runCursorModel,
  },
  // OpenCode runs keep-going as an in-process plugin (src/opencode.mjs) that
  // sends the nudge itself; its reviewer is `opencode run --pure`, which loads
  // no plugins.
  opencode: {
    requires: ["session_id"],
    state: xdgStateHome,
    run: runOpencodeModel,
  },
  // Oh My Pi loads src/omp.mjs (package.json `omp.extensions`, which it
  // prefers over Pi's) on its session_stop hook; its reviewer runs with no
  // extensions, so keep-going does not review the review.
  omp: {
    requires: ["session_id"],
    state: xdgStateHome,
    run: runOmpModel,
  },
};

// The reviewer only decides whether the turn is over; what the agent hears is
// fixed. The agent has read far more than the reviewer, so a reviewer that
// writes the line ends up arguing with it: restating the owner's words
// against the agent's evidence, or claiming consent the owner never gave.
// Rotated rather than fixed: a hundred continuations carrying one identical
// sentence read to the agent like a stuck loop instead of a push.
const EMPTY_STOP_NUDGE =
  "The stop hook did not see your last message. If work remains, continue it; if you are done, say so in one sentence.";

const NUDGES = [
  "Keep going.",
  "You've got this \u2014 keep going.",
  "Believe in yourself. Keep going.",
  "There is still work left here. Keep going.",
];

// Waiting on the owner is spelled out because it is the one stop no amount
// of the agent's own work resolves: consent, an answer only the owner has,
// or which reading of their words they meant. A reviewer that reads only
// the words picks the literal reading, and a typo becomes an instruction.
const REVIEW_PROMPT = `An agent just tried to end its turn. owner_prompt is the owner's request
this turn and last_assistant_message is the agent's final message. Decide
whether the turn is over.

CONTINUE — the agent stopped with work left that it can do now: it announced a
step and did not take it, stopped partway through the request, or asked
permission for an obvious next step within it.
STOP — the request is done, the agent reports a real blocker, or it is waiting
on something only the owner can give: consent to deploy, publish, send, spend,
or delete, an answer only the owner has, or which reading of their words they
meant.

The agent has read far more than you have. Do not second-guess its findings or
its reading of the owner; judge only whether it stopped with work in hand.

Reply with CONTINUE or STOP and nothing else.`;

// The review is a one-word verdict, so the host's frontier default is more
// model than it needs. Codex and Claude name a smaller tier the way Ghost's
// smol bridge does; the other CLIs have no such tier to name, so the flag is
// absent unless the variable names one. Claude's alias tracks the latest
// Sonnet; Codex has no family alias, so its default is an exact release.
const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
const CLAUDE_DEFAULT_MODEL = "sonnet";

function modelArgs(variable, fallback) {
  const model = process.env[variable] || fallback;
  return model ? ["--model", model] : [];
}

// With a native Grok hook installed, the Claude-settings copy Grok also
// dispatches yields, so the stop is reviewed once.
async function yieldsToGrokNative(requested) {
  if (!process.env.GROK_HOOK_EVENT || requested === "grok") return false;
  try {
    const file = path.join(process.env.GROK_HOME || path.join(homedir(), ".grok"), "hooks", "keep-going.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    const groups = config?.hooks?.Stop;
    if (!Array.isArray(groups)) return false;
    return groups.some((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).some((hook) => {
        const command = hook?.command;
        if (!/keep-going\.mjs\b/.test(command)) return false;
        return command.trimEnd().split(/\s+/).at(-1) === "grok";
      }),
    );
  } catch {
    return false;
  }
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

// Whole records the harness writes when a turn ends early. Unlike the context
// it injects, a marker carries none of the flags that give a record away as
// the harness's own — no isMeta, no promptSource, no origin — so left unnamed
// it reads as something the owner typed: the reviewer is handed one as the
// turn's request, and the continuation count starts over as though a new turn
// had begun, which is the opposite of what an interruption means.
//
// Matched whole and never as a prefix. The same text leads the message an
// owner types after interrupting, and everything past it is theirs.
const HARNESS_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

// Wrappers the harness puts around text that is not a request: context it
// prepends to a turn, and the echo and output of a command the owner ran from
// the prompt. Running `!ls` mid-turn is not asking the agent for anything, and
// its output is even less so, but both land as user-role records carrying the
// same flags a typed prompt carries.
//
// A slash command is deliberately absent. `<command-name>` and
// `<command-message>` wrap something the owner invoked on purpose, and the
// skills among them are the whole of what the turn was asked for.
const INJECTED_PREFIXES = [
  "<environment_context>",
  "<recommended_plugins>",
  "# AGENTS.md instructions",
  "<skills_instructions>",
  "<permissions instructions>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  // Codex's own bookkeeping. <turn_aborted> is its interruption marker, the
  // counterpart to the one in HARNESS_MARKERS; the rest name themselves.
  "<turn_aborted>",
  "<codex_internal_context>",
  "<in-app-browser-context>",
  "<task-notification>",
  // A finished subagent reporting back. Codex has no flag for it the way
  // Claude's task notifications do, so only this keeps it from opening turns.
  "<subagent_notification>",
  // This hook's own nudge, as Codex records it: a user message in the turn it
  // continues. Read as the owner's, it became the request the next stop was
  // judged against.
  "<hook_prompt",
];

function isInjectedContext(text) {
  const trimmed = text.trimStart();
  if (HARNESS_MARKERS.has(text.trim())) return true;
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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
  const candidate = await realpath(input.transcript_path);

  for (const root of RUNTIMES[runner].roots()) {
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
  // A compaction summary says so in a field of its own. It recaps the session
  // in the owner's place, so counting it would restart the turn and handing it
  // to the reviewer would offer a recap of past work as the request to judge
  // the last message against — which nothing can fulfill.
  if (!text || record.isCompactSummary === true || isInjectedContext(text)) return null;
  return {
    text,
    genuine:
      record.origin?.kind !== "task-notification" &&
      record.promptSource !== "system" &&
      record.isMeta !== true,
  };
}

// Where this turn stands on nudges, read from a transcript: how many the turn
// has had since the owner's last prompt, and whether the agent stopped again
// after the latest one without running a tool. That is an agent that weighed
// the nudge and still holds, and a second review would only argue with it.
// classify names each record "owner", "nudge", "tool", or nothing.
async function transcriptNudges(file, classify) {
  let continuations = 0;
  let worked = false;
  let hasOwner = false;
  for await (const record of jsonLines(file)) {
    const kind = classify(record);
    if (kind === "owner") {
      hasOwner = true;
      continuations = 0;
      worked = false;
    } else if (kind === "nudge" && hasOwner) {
      continuations += 1;
      worked = false;
    } else if (kind === "tool") {
      worked = true;
    }
  }
  return { continuations, held: continuations > 0 && !worked };
}

// Claude's stop payload names the session and nothing else, so where one owner
// turn ends and the next begins is information only the transcript has: the
// turn starts at the last genuine user message, and the hook prompts after it
// are this turn's continuations.
function claudeRecordKind(record) {
  if (record?.type === "assistant") {
    return record.message?.content?.some?.((part) => part?.type === "tool_use") ? "tool" : null;
  }
  const message = claudeUserMessage(record);
  if (message?.genuine) return "owner";
  return message && HOOK_PROMPT_PATTERN.test(message.text) ? "nudge" : null;
}

async function claudeNudges(input) {
  return transcriptNudges(await allowedTranscriptPath(input, "claude"), claudeRecordKind);
}

// Codex records its nudge as a user message and every tool as a *_call item.
function codexRecordKind(record) {
  const payload = record?.type === "response_item" ? record.payload : null;
  if (typeof payload?.type === "string" && payload.type.endsWith("_call")) return "tool";
  if (payload?.type !== "message" || payload.role !== "user") return null;
  const text = messageText(payload);
  if (text.trimStart().startsWith("<hook_prompt")) return "nudge";
  return lastGenuinePrompt(text) ? "owner" : null;
}

async function codexNudges(input) {
  return transcriptNudges(await allowedTranscriptPath(input, "codex"), codexRecordKind);
}

function lastGenuinePrompt(text) {
  const trimmed = text.trim();
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
    if (payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId) return "";
    return lastGenuinePrompt(messageText(payload));
  });
}

// The stop names the updates log; what the owner typed lands in the chat
// history beside it.
const grokChatHistory = (updates) => path.join(path.dirname(updates), "chat_history.jsonl");

function grokQueryText(record) {
  const raw = messageText(record);
  const tagged = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (tagged) return lastGenuinePrompt(tagged[1]);
  // What the owner typed is tagged. An untagged block is one the log wrapped
  // for its own purposes — <user_info> and friends — and carries no request.
  // The guard lives here rather than at one call site, so prompt recovery and
  // turn segmentation cannot disagree about what counts as a prompt.
  return raw.trimStart().startsWith("<") ? "" : lastGenuinePrompt(raw);
}

async function grokOwnerPrompt(input) {
  const updates = await allowedTranscriptPath(input, "grok");
  const sessionDir = path.dirname(updates);
  const cwdDir = path.dirname(sessionDir);
  const sessionId = input.session_id;
  try {
    const last = await lastTranscriptMatch(path.join(cwdDir, "prompt_history.jsonl"), (record) => {
      if (record?.is_bash) return "";
      if (record?.session_id && record.session_id !== sessionId) return "";
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

// A nudge comes back to some hosts as the next user message; it is never the
// owner's request.
const isNudge = (text) => NUDGES.includes(text) || text === EMPTY_STOP_NUDGE;

// A host may start its stop hook before it has recorded the reply that ended
// the turn, so the reply to the latest message is waited for, briefly.
const REPLY_FLUSH_POLLS = 30;
const REPLY_FLUSH_POLL_MS = 100;

async function untilReply(read) {
  for (let attempt = 0; ; attempt += 1) {
    const turn = await read();
    if (turn.reply || attempt >= REPLY_FLUSH_POLLS) return turn;
    await sleep(REPLY_FLUSH_POLL_MS);
  }
}

async function copilotPayload(input) {
  if (input.stopReason !== undefined && input.stopReason !== "end_turn") return null;
  const stop = {
    ...input,
    session_id: input.sessionId ?? input.session_id,
    transcript_path: input.transcriptPath ?? input.transcript_path,
  };
  if (typeof stop.transcript_path !== "string") return stop;
  const file = await allowedTranscriptPath(stop, "copilot");
  // Copilot fires agentStop before its last lines reach events.jsonl.
  const turn = await untilReply(async () => {
    let prompt = "";
    let reply = "";
    for await (const record of jsonLines(file)) {
      const content = typeof record?.data?.content === "string" ? record.data.content.trim() : "";
      if (record?.type === "user.message" && content) {
        if (!isNudge(content)) prompt = content;
        reply = "";
      } else if (record?.type === "assistant.message" && content) {
        // Text alongside a tool call announces a step; the reply is a message that ends the turn.
        reply = record.data.toolRequests?.length ? "" : content;
      }
    }
    return { prompt, reply };
  });
  return { ...stop, owner_prompt: turn.prompt, last_assistant_message: turn.reply };
}

function agyRequest(content) {
  return content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)?.[1] ?? content.trim();
}

async function agyPayload(input) {
  // Only the model choosing to stop is a stop; an error or the step limit is not.
  if (String(input.terminationReason ?? "").toLowerCase() !== "model_stop") return null;
  const stop = {
    ...input,
    session_id: input.conversationId,
    transcript_path: input.transcriptPath,
    cwd: Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined,
  };
  if (typeof stop.transcript_path !== "string") return stop;
  let request = "";
  let reply = "";
  for await (const record of jsonLines(await allowedTranscriptPath(stop, "agy"))) {
    const content = typeof record?.content === "string" ? record.content.trim() : "";
    if (!content) continue;
    if (record.type === "USER_INPUT" && record.source === "USER_EXPLICIT") {
      request = agyRequest(content);
      reply = "";
    } else if (record.type === "PLANNER_RESPONSE") {
      reply = content;
    }
  }
  return { ...stop, owner_prompt: request, last_assistant_message: reply };
}

const cursorRecord = (conversation) =>
  path.join(xdgStateHome(), "keep-going", "cursor", `${createHash("sha256").update(conversation).digest("hex").slice(0, 32)}.json`);

async function cursorPayload(input) {
  const conversation = typeof input.conversation_id === "string" ? input.conversation_id : "";
  if (!conversation) return null;
  const file = cursorRecord(conversation);
  const read = () => readFile(file, "utf8").then(JSON.parse, () => ({}));
  const save = async (turn) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(turn), { encoding: "utf8", mode: 0o600 });
  };
  const event = input.hook_event_name;
  if (event === "beforeSubmitPrompt" || event === "afterAgentResponse") {
    const saved = await read();
    const text = String((event === "beforeSubmitPrompt" ? input.prompt : input.text) ?? "").trim();
    // A nudge keeps the owner's request; any prompt starts a reply afresh.
    await save(event === "afterAgentResponse" ? { ...saved, reply: text } : { prompt: isNudge(text) ? saved.prompt : text, reply: "" });
    return null;
  }
  if (input.status !== undefined && input.status !== "completed") return null;
  // Cursor starts the stop hook alongside afterAgentResponse. A stop uses up
  // the reply it reads, so the next stop waits for the reply after it.
  const turn = await untilReply(read);
  await save({ ...turn, reply: "" });
  return {
    ...input,
    session_id: conversation,
    owner_prompt: turn.prompt ?? "",
    last_assistant_message: turn.reply ?? "",
    // Cursor counts the follow-ups this loop has sent.
    stop_hook_active: input.loop_count > 0,
  };
}

async function resolveOwnerPrompt(input, runner) {
  const fromPayload = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  if (fromPayload) return fromPayload;
  // A subagent stop carries the parent's transcript; that is the parent's request.
  const recover = RUNTIMES[runner].ownerPrompt;
  if (!recover || input.agent_id) return "";
  try {
    return await recover(input);
  } catch {
    return "";
  }
}

// Whether a record is the owner opening a turn, per host, for the quiet wait.
function claudeOpensTurn(record) {
  const message = claudeUserMessage(record);
  return Boolean(message?.genuine && lastGenuinePrompt(message.text));
}

function grokOpensTurn(record) {
  return record?.type === "user" && !record.synthetic_reason && Boolean(grokQueryText(record));
}

function codexOpensTurn(record) {
  const payload = record?.type === "response_item" ? record.payload : null;
  return payload?.type === "message" && payload.role === "user" && Boolean(lastGenuinePrompt(messageText(payload)));
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

// Garbage collection: an interrupted turn never comes back for its entry to be
// cleared, and the file would otherwise keep one per turn forever.
const TALLY_IDLE_MS = 30 * 60_000;

async function readTally(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
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
async function recordTurnState(input, runner, blocked, exact = null) {
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
    tally[key] = { count: from + 1, updated: Date.now() };
  }
  await writeTally(file, tally);
}

function stopCandidateText(input) {
  // Grok spells this key and stopHookActive in camelCase while sending
  // session_id and transcript_path in snake_case; an unread message is an
  // accepted stop, so the difference would silently disable the hook there.
  const candidate = input.last_assistant_message ?? input.lastAssistantMessage;
  if (typeof candidate === "string") return candidate;
  return messageText(candidate);
}

// A final message that asserts nothing beyond completion in a single token —
// the shape internal observer subagents stop with ("None", "Done."). With no
// owner prompt to match it against, a reviewer could only ever verdict STOP,
// so the model call is skipped and the stop accepted.
const VACUOUS_COMPLETIONS = new Set(["none", "done", "ok", "okay", "finished", "complete", "completed"]);

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
    // A reviewer given its prompt as an argument may exit without reading
    // stdin; its exit status, not the closed pipe, says how it went.
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
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

// Grok's default system prompt is a coding agent; this one keeps --single to
// the verdict.
const GROK_SYSTEM_PROMPT = "Reply with exactly CONTINUE or STOP. No preamble, no analysis.";

// Nested `grok --single` otherwise inherits the parent session's home: MCP
// servers, plugins, high reasoning, and the coding agent. That is a full
// turn, and it times out the classifier. The overlay carries auth and a
// config that turns off the Claude and Cursor scans; the flags run it with no
// tools and --effort low (the lowest level this CLI advertises; it has no
// none). --single dispatches no stop hook, so the reviewer cannot trip the
// hook that spawned it.
async function runGrokModel({ prompt, timeoutMs }) {
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
    // Grok still scans ~/.claude and ~/.cursor when GROK_HOME has no config,
    // loading their hooks, MCP servers, skills, agents, and rules into the
    // reviewer.
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
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GROK_")));
    env.GROK_HOME = overlayHome;
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
      GROK_SYSTEM_PROMPT,
      "--cwd",
      directory,
      ...modelArgs("KEEP_GOING_GROK_MODEL"),
    ];
    const result = assertExitOk(
      await runProcess(grok, args, "", timeoutMs, env, directory),
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

// Copilot and Antigravity have no switch for their own hooks, so their
// reviewer's stop is marked instead (see handleStop). Cursor's print mode
// runs no hooks.
const reviewerEnv = () => ({ ...process.env, KEEP_GOING_REVIEWING: "1" });

async function runCopilotModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("copilot", async (directory) => {
    const copilot = process.env.KEEP_GOING_COPILOT_BIN || "copilot";
    const args = [
      "-p", prompt, "--silent", "--stream", "off", "--available-tools", "",
      "--no-custom-instructions", "--disable-builtin-mcps", "--no-ask-user", "--no-auto-update",
      ...modelArgs("KEEP_GOING_COPILOT_MODEL"),
    ];
    return assertExitOk(await runProcess(copilot, args, "", timeoutMs, reviewerEnv(), directory), "copilot").stdout;
  });
}

async function runAgyModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("agy", async (directory) => {
    const agy = process.env.KEEP_GOING_AGY_BIN || "agy";
    // Plan mode and no auto-approval: a reviewer that tried a tool would be refused.
    const args = ["-p", prompt, "--output-format", "text", "--mode", "plan", "--disable-slash-commands", ...modelArgs("KEEP_GOING_AGY_MODEL")];
    return assertExitOk(await runProcess(agy, args, "", timeoutMs, reviewerEnv(), directory), "agy").stdout;
  });
}

async function runOpencodeModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("opencode", async (directory) => {
    const opencode = process.env.KEEP_GOING_OPENCODE_BIN || "opencode";
    const args = ["run", "--pure", ...modelArgs("KEEP_GOING_OPENCODE_MODEL"), prompt];
    return assertExitOk(await runProcess(opencode, args, "", timeoutMs, process.env, directory), "opencode").stdout;
  });
}

async function runOmpModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("omp", async (directory) => {
    const omp = process.env.KEEP_GOING_OMP_BIN || "omp";
    const args = ["-p", "--no-extensions", ...modelArgs("KEEP_GOING_OMP_MODEL"), prompt];
    return assertExitOk(await runProcess(omp, args, "", timeoutMs, process.env, directory), "omp").stdout;
  });
}

async function runCursorModel({ prompt, timeoutMs }) {
  return inTemporaryDirectory("cursor", async (directory) => {
    const cursor = process.env.KEEP_GOING_CURSOR_BIN || "cursor-agent";
    // Ask mode answers without editing anything.
    const args = ["-p", "--mode", "ask", "--output-format", "text", "--trust", ...modelArgs("KEEP_GOING_CURSOR_MODEL"), prompt];
    return assertExitOk(await runProcess(cursor, args, "", timeoutMs, process.env, directory), "cursor-agent").stdout;
  });
}

// The verdict is the first CONTINUE or STOP standing as a word of its own,
// wherever the reviewer put it: small reviewers write a sentence first, glue
// the verdict onto it ("...finished.STOP"), or answer twice
// ("CONTINUECONTINUE").
const VERDICT_PATTERN = /(?<![A-Za-z_])(CONTINUE|STOP)(?=$|[^A-Za-z_]|CONTINUE|STOP)/;

function parseReviewVerdict(text) {
  const match = VERDICT_PATTERN.exec(String(text ?? ""));
  if (!match) throw new Error("Reviewer output must be CONTINUE or STOP");
  return match[1];
}

function hookOutputForVerdict(verdict, continuations = 0) {
  if (verdict !== "CONTINUE") return {};
  return { decision: "block", reason: NUDGES[continuations % NUDGES.length] };
}

async function recordReviewAudit(input, runner, { verdict, reason, error, countedBy, reviewerOutput }) {
  const auditPath = process.env.KEEP_GOING_AUDIT_LOG;
  if (!auditPath) return;
  const entry = {
    timestamp: new Date().toISOString(),
    runner,
    ...(typeof input.reviewer_model === "string" ? { reviewer_model: input.reviewer_model } : {}),
    session_id: input.session_id ?? null,
    turn_id: input.turn_id ?? null,
    cwd: typeof input.cwd === "string" ? input.cwd : null,
    verdict: error ? "ERROR" : verdict,
    rationale: error ? compactText(String(error), 2_000) : reason ?? "",
    // What the reviewer actually wrote: an unparseable reply is the debugging
    // evidence when the stop fails open.
    ...(reviewerOutput !== undefined ? { reviewer_output: compactText(reviewerOutput, 2_000) } : {}),
    counted_by: countedBy,
  };
  try {
    await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging is best-effort and must never change the hook decision.
  }
}

// Every settled stop makes the same two writes: the turn state, which
// a stop let through clears and a block advances, and the audit row. One
// helper makes both so no exit can forget either: a forgotten first write
// carries a count into a turn that never earned it, disarming the cap.
async function settleStop(input, runner, output, audit, exact = null) {
  const blocked = output.decision === "block";
  await recordTurnState(input, runner, blocked, exact);
  await recordReviewAudit(input, runner, { verdict: blocked ? "CONTINUE" : "STOP", reason: output.reason, ...audit });
  return output;
}

async function recordedContinuations(input, runner) {
  const tally = await readTally(tallyFile(input, runner));
  return tally[turnKey(input)]?.count ?? 0;
}

/**
 * Ghost reviews its own turns through its session_stop hook, so a harness
 * running one stands down. GHOST is set in that turn's environment; Muse
 * passes a hook no environment, but the turn runs in its Ghost conversation's
 * directory, which holds the conversation log.
 */
async function inGhostTurn(input) {
  if (process.env.GHOST) return true;
  if (typeof input.cwd !== "string" || !input.cwd) return false;
  return stat(path.join(input.cwd, ".conversation.jsonl")).then(() => true, () => false);
}

async function handleStop(input, runner = "codex", { runModel, delay } = {}) {
  // A reviewer's own stop (see reviewerEnv) is not a turn to review.
  if (process.env.KEEP_GOING_REVIEWING) return {};
  if (runner !== "ghost" && await inGhostTurn(input)) return {};
  // Cursor also dispatches Claude's settings hooks, with its own payload and
  // none of the events its review needs; only a native Cursor hook reviews it.
  if (runner === "claude" && input.cursor_version) return {};
  if (RUNTIMES[runner]?.payload) {
    const stop = await RUNTIMES[runner].payload(input);
    if (!stop) return {};
    input = stop;
  }
  if (await yieldsToGrokNative(runner)) return {};
  // GROK_HOOK_EVENT is set only by Grok's hook runner, never by Claude Code.
  if (process.env.GROK_HOOK_EVENT) runner = "grok";
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
  // A subagent stop carries its parent's transcript, whose nudges are the
  // parent's, so it is read only for the agent that owns it.
  let nudges = null;
  if (runtime.nudges && !input.agent_id) {
    try {
      nudges = await runtime.nudges(input);
    } catch {
      // A transcript in a shape or a place this runtime does not know is the
      // ordinary case on a host we have not taught it yet. The tally still
      // caps the turn, and the stop is reviewed.
    }
  }
  // A turn the payload names is counted by the tally keyed on it; one it
  // leaves unnamed (Claude's) by the transcript, where that was readable.
  // Pi, which keeps no tally, counts from the session it already read.
  const fromTranscript = Boolean(nudges && (!runtime.state || !payloadTurn(input)));
  const continuations = fromTranscript ? nudges.continuations : await recordedContinuations(input, runner);
  const countedBy = !runtime.state ? "session" : fromTranscript ? "transcript" : "tally";
  if (continuations >= CONTINUATION_CAP) {
    const capped = {
      systemMessage: `keep-going: continuation cap (${CONTINUATION_CAP}) reached for this turn; accepting the stop.`,
    };
    return settleStop(input, runner, capped, { verdict: "CAP", reason: capped.systemMessage, countedBy });
  }
  // After the cap, which bounds this nudge too on hosts that never say a stop
  // answers one.
  if (!lastAssistantMessage) {
    // Grok can fire Stop with no lastAssistantMessage. Accepting that stop
    // disables the hook. Block once; if the next stop is still empty, let it end.
    if (input.stop_hook_active || input.stopHookActive) {
      return settleStop(input, runner, {}, { reason: "no last message on retry", countedBy: "empty" });
    }
    return settleStop(input, runner, { decision: "block", reason: EMPTY_STOP_NUDGE }, { countedBy: "empty" });
  }

  const ownerPrompt = await resolveOwnerPrompt(input, runner);
  if (!ownerPrompt && VACUOUS_COMPLETIONS.has(lastAssistantMessage.trim().replace(/[.!]+$/, "").toLowerCase())) {
    return settleStop(input, runner, {}, { reason: "nothing to review", countedBy: "stub" });
  }

  if (nudges?.held) {
    return settleStop(input, runner, {}, { verdict: "HELD", reason: "stopped again after a nudge without running a tool", countedBy });
  }

  let rawReview;
  let verdict;
  try {
    const run = runModel ?? runtime.run;
    if (!run) throw new Error(`${runner} review requires its native extension`);
    rawReview = await run({
      prompt: `${REVIEW_PROMPT}\n\n${JSON.stringify({
        last_assistant_message: lastAssistantMessage,
        owner_prompt: compactText(ownerPrompt, 12_000),
      })}`,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
      ghostHome: input.ghost_home,
    });
    verdict = parseReviewVerdict(rawReview);
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

  return settleStop(
    input,
    runner,
    hookOutputForVerdict(verdict, continuations),
    { verdict, countedBy, reviewerOutput: rawReview },
    fromTranscript ? continuations : null,
  );
}

async function main() {
  try {
    const runner = process.argv[2] || "codex";
    const input = await readStdin();
    const output = await handleStop(input, runner);
    const answer = RUNTIMES[runner]?.answer;
    process.stdout.write(`${JSON.stringify(answer ? answer(output) : output)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `keep-going failed open: ${compactText(error.message, 500)}` })}\n`,
    );
  }
}

// Node runs the main module from its real path, so argv[1] is compared the
// same way: a symlinked hook path would otherwise run nothing and exit 0,
// which every host reads as an accepted stop.
const entry = process.argv[1] ? pathToFileURL(await realpath(process.argv[1]).catch(() => "")).href : "";
if (import.meta.url === entry) await main();

export {
  isNudge,
  CONTINUATION_CAP,
  NUDGES,
  REVIEW_PROMPT,
  quietDelayMs,
  claudeNudges,
  codexNudges,
  recordedContinuations,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
  yieldsToGrokNative,
  resolveOwnerPrompt,
};
