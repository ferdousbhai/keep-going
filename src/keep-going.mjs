#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
    run: runCodexModel,
  },
  claude: {
    requires: ["session_id"],
    state: xdgStateHome,
    roots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")],
    count: claudeContinuations,
    run: runClaudeModel,
  },
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
    run: runGrokModel,
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

When owner_prompt is present, it is the owner's request this turn. STOP if
last_assistant_message already fulfills it.

Reply with the verdict word alone on the first line: ${listVerdicts(VERDICT_NAMES)}.
For ${listVerdicts(ENDING_VERDICTS)}, stop there. For ${listVerdicts(BLOCKING_VERDICTS)}, add one more
line: it reaches the agent verbatim, as the whole reason its turn was not
allowed to end.

Use as few words as you can, under ${NUDGE_LIMIT} characters — "Keep going.",
"Believe in yourself.", "Don't ask yet — you can work this out." Speak to the
agent. Name no task, file, command, or requirement its message did not already
state. A longer line is discarded for a generic one.

${BLOCKING_VERDICTS.map((name) => `After ${name}, ${VERDICTS[name].directive}.`).join(" ")}`;

// No host is given a model it did not choose, so the flag is absent unless the
// variable names one.
function modelArgs(variable) {
  const model = process.env[variable];
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
      "--config",
      'model_reasoning_effort="none"',
      "--output-last-message",
      outputPath,
      ...modelArgs("KEEP_GOING_CODEX_MODEL"),
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
      ...modelArgs("KEEP_GOING_CLAUDE_MODEL"),
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
const GROK_CLASSIFIER_PROMPT =
  `Reply with exactly one of ${listVerdicts(VERDICT_NAMES)} as the first line. No preamble, no analysis.`;

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
      GROK_CLASSIFIER_PROMPT,
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
// redacted, flattened to one line, and dropped whole if they outgrow a sentence.
function sanitizeNudge(value) {
  const line = redactSensitive(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (!line || line.length > NUDGE_LIMIT) return "";
  return line;
}

function parseReviewVerdict(text) {
  const body = String(text ?? "").trim();
  const match = REVIEW_VERDICT_PATTERN.exec(body)
    ?? verdictAfterPreamble(body)
    ?? trailingVerdict(body);
  if (!match) {
    throw new Error(`Reviewer output must begin with ${listVerdicts(VERDICT_NAMES)}`);
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
    ...(typeof input?.reviewer_model === "string" ? { reviewer_model: input.reviewer_model } : {}),
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    cwd: typeof input?.cwd === "string" ? input.cwd : null,
    verdict: error ? "ERROR" : verdict,
    rationale: error ? compactText(String(error), 2_000) : reason ?? "",
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

async function recordedContinuations(input, runner) {
  if (!RUNTIMES[runner].state) return RUNTIMES[runner].count(input);
  const tally = await readTally(tallyFile(input, runner));
  return tally[turnKey(input)]?.count ?? 0;
}

async function handleStop(input, runner = "codex", { runModel } = {}) {
  if (await yieldsToGrokNative(runner)) return {};
  runner = resolveRunner(runner);
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
    // Grok can fire Stop with no lastAssistantMessage. Accepting that stop
    // disables the hook. Block once; if the next stop is still empty, let it end.
    if (input.stop_hook_active || input.stopHookActive) {
      await recordTurnState(input, runner, false);
      return {};
    }
    await recordTurnState(input, runner, true);
    return {
      decision: "block",
      reason: "The stop hook did not see your last message. If work remains, continue it; if you are done, say so in one sentence.",
    };
  }

  const ownerPrompt = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  if (ownerPrompt && lastMessageFulfillsOwnerPrompt(ownerPrompt, lastAssistantMessage)) {
    await recordTurnState(input, runner, false);
    await recordReviewAudit(input, runner, {
      verdict: "STOP",
      reason: "last message fulfills owner_prompt",
      countedBy: "owner_prompt",
    });
    return {};
  }

  let review;
  let continuations = await recordedContinuations(input, runner);
  let countedBy = runtime.state ? "tally" : "session";
  const named = payloadTurn(input);
  try {
    // A transcript is read only by a host whose payload leaves the turn
    // unidentified, and then only to count: its content never reaches the
    // reviewer. Where it is read it is exact, so it replaces the tally both
    // here and in what the tally is left holding. A subagent names its turn,
    // and its parent's transcript holds the parent's messages regardless.
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
      await recordTurnState(input, runner, false);
      await recordReviewAudit(input, runner, { verdict: "CAP", reason: capped.systemMessage, countedBy });
      return capped;
    }

    const run = runModel ?? runtime.run;
    if (!run) throw new Error(`${runner} review requires its native extension`);
    review = parseReviewVerdict(
      await run({
        prompt: `${reviewPrompt(continuations)}\n\n${JSON.stringify({
          last_assistant_message: lastAssistantMessage,
          ...(ownerPrompt ? { owner_prompt: compactText(ownerPrompt, 12_000) } : {}),
        })}`,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        ghostHome: input.ghost_home,
      }),
    );
  } catch (error) {
    // Failing open lets the stop through, so it ends the turn like any other
    // accepted stop. This is the path a reviewer timeout takes — the stuck
    // case the cap exists for — and leaving the count behind would spend it
    // against whatever the session does next.
    await recordTurnState(input, runner, false);
    await recordReviewAudit(input, runner, { error: error.message, countedBy });
    return { systemMessage: `keep-going was skipped: ${compactText(error.message, 500)}` };
  }

  const output = hookOutputForVerdict(review.verdict, continuations, review.nudge);
  await recordTurnState(
    input,
    runner,
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
  claudeContinuations,
  recordedContinuations,
  reviewPrompt,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
  resolveRunner,
  yieldsToGrokNative,
  lastMessageFulfillsOwnerPrompt,
};
