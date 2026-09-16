#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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

const RUNTIMES = {
  codex: { provider: "codex", model: "gpt-5.6-luna", modelEnv: "KEEP_GOING_CODEX_MODEL" },
  claude: { provider: "claude", model: "sonnet", modelEnv: "KEEP_GOING_CLAUDE_MODEL" },
  ghost: { provider: "ghost" },
};

// Validate the reviewer's tiny provider-independent protocol before translating
// it to the host-specific Stop-hook JSON.
const REVIEW_VERDICTS = new Set(["CONTINUE", "JUDGE", "STOP"]);
const REVIEW_VERDICT_PATTERN = new RegExp(`^(${[...REVIEW_VERDICTS].join("|")})\\b([\\s\\S]*)$`);
// One sentence. A longer reply is dropped rather than truncated: the reviewer
// never sees the transcript, so a rambling line is guesswork, not context.
const NUDGE_LIMIT = 200;

const REVIEW_PROMPT = `Classify last_assistant_message:

CONTINUE — required work remains that the agent can perform now.
JUDGE — it asks the user for input, but more reasoning or research should resolve it.
STOP — work is complete, or progress genuinely requires the user or an external state change.

Prefer JUDGE over STOP when the request for input looks self-resolvable by the agent.
Do not default to any outcome or invent unstated work.

Reply with the verdict word alone on the first line: CONTINUE, JUDGE, or STOP.
After CONTINUE or JUDGE, add one short line of encouragement addressed to the
agent, grounded in what last_assistant_message was actually doing. Encourage
only: name no new task, file, command, or requirement the message did not
already state, and give no instruction of your own.`;

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

function compactText(value, limit = 6000) {
  if (typeof value !== "string") return "";
  const redacted = redactSensitive(value);
  if (redacted.length <= limit) return redacted;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${redacted.slice(0, head)}\n...[truncated]...\n${redacted.slice(-tail)}`;
}

function processFailureDetail(result) {
  return compactText(
    [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n"),
    1200,
  );
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

async function allowedTranscriptPath(transcriptPath, runner = "codex", roots) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    throw new Error("Stop input is missing transcript_path");
  }
  const candidate = await realpath(transcriptPath);
  const allowedRoots = roots ?? (runner === "claude"
    ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")]
    : [
        path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"),
        path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "archived_sessions"),
      ]);

  for (const root of allowedRoots) {
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
  const transcriptPath = await allowedTranscriptPath(input.transcript_path, "codex");
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

async function claudeContinuations(input, options = {}) {
  const transcriptPath = options.transcriptPath ?? await allowedTranscriptPath(input.transcript_path, "claude");
  const messages = [];
  for await (const record of jsonLines(transcriptPath)) {
    const message = claudeUserMessage(record);
    if (message) messages.push(message);
  }

  // The current turn starts at the last genuine user message. A host that
  // re-prompts with plain user messages (ghost's Claude Code runtime) supplies
  // the owner prompt so those continuations stay inside the turn — and every
  // user message after it counts as a continuation.
  const ownerPrompt = typeof options.ownerPrompt === "string" ? options.ownerPrompt.trim() : null;
  const turnStart = turnStartIndex(messages, ownerPrompt, (item) => (item.genuine ? item.text : null));
  if (turnStart < 0) return 0;
  const inTurn = messages.slice(turnStart + 1);
  if (ownerPrompt) return inTurn.length;
  return inTurn.filter((item) => HOOK_PROMPT_PATTERN.test(item.text)).length;
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
    const transcriptPath = await allowedTranscriptPath(input.transcript_path, "claude");
    return claudeContinuations(input, { transcriptPath, ownerPrompt: input.owner_prompt });
  }
  const transcriptPath = await allowedTranscriptPath(input.transcript_path, "ghost", [input.ghost_home]);
  return piContinuations(input, transcriptPath);
}

async function countContinuations(input, runner = "codex") {
  if (runner === "claude") return claudeContinuations(input);
  if (runner === "ghost") return ghostContinuations(input);
  return codexContinuations(input);
}

function stopCandidateText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  return messageText(input.last_assistant_message);
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > MAX_STDIN_BYTES) {
      throw new Error("Stop hook input exceeds 1 MB");
    }
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stop hook input must be a JSON object");
  }
  return parsed;
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next) > MODEL_OUTPUT_LIMIT) {
    throw new Error("child process output exceeded 2 MB");
  }
  return next;
}

function runProcess(command, args, input, timeoutMs, env = process.env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

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
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendLimited(stdout, chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendLimited(stderr, chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function runCodexModel({ model, prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-keep-going-"));
  const outputPath = path.join(directory, "result.txt");
  try {
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
      "--model",
      model,
      "--config",
      'approval_policy="never"',
      "--output-last-message",
      outputPath,
      "-",
    ];
    const result = await runProcess(codex, args, prompt, timeoutMs);
    if (result.code !== 0) {
      const detail = processFailureDetail(result);
      throw new Error(`codex exec exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runClaudeModel({ model, prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-keep-going-"));
  try {
    const claude = process.env.KEEP_GOING_CLAUDE_BIN || "claude";
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
    const result = await runProcess(claude, args, prompt, timeoutMs, env, directory);
    if (result.code !== 0) {
      const detail = processFailureDetail(result);
      throw new Error(`claude exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
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
  const result = await runProcess(
    ghostd,
    ["hook-smol-complete"],
    JSON.stringify({ ghost_home: ghostHome, prompt }),
    timeoutMs,
  );
  if (result.code !== 0) {
    const detail = processFailureDetail(result);
    throw new Error(`ghostd exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  const envelope = JSON.parse(result.stdout);
  if (typeof envelope?.text !== "string") throw new Error("ghostd returned no completion text");
  return envelope.text;
}

async function runReviewModel(options) {
  if (options.provider === "claude") return runClaudeModel(options);
  if (options.provider === "ghost") return runGhostModel(options);
  return runCodexModel(options);
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
    throw new Error("Reviewer output must begin with CONTINUE, JUDGE, or STOP");
  }
  return { verdict: match[1], nudge: sanitizeNudge(match[2].replace(/^[\s:.\u2013\u2014-]+/, "")) };
}

// The fallback when the reviewer supplies no usable line of its own. Rotated
// rather than fixed: a hundred continuations carrying one identical sentence
// read to the agent like a stuck loop instead of a push.
const ENCOURAGEMENTS = [
  "Keep going.",
  "You've got this \u2014 keep going.",
  "Believe in yourself. Keep going.",
  "There is still work left here. Keep going.",
];

const LAST_STRETCH_NOTE =
  "This turn is near its continuation limit, so land what is already in flight rather than starting something new.";

function encouragement(continuations, nudge) {
  const index = Number.isInteger(continuations) && continuations > 0 ? continuations : 0;
  const line = nudge || ENCOURAGEMENTS[index % ENCOURAGEMENTS.length];
  // Only this side knows the cap, so the closing note is never the model's.
  return index >= CONTINUATION_CAP - LAST_STRETCH ? `${line} ${LAST_STRETCH_NOTE}` : line;
}

function hookOutputForVerdict(verdict, continuations = 0, nudge = "") {
  if (verdict === "CONTINUE") {
    return { decision: "block", reason: encouragement(continuations, nudge) };
  }
  if (verdict === "JUDGE") {
    // The instruction stays ours; the reviewer only contributes the nudge.
    return {
      decision: "block",
      reason: `Do not ask the user yet. Apply more reasoning or research to get yourself unstuck; only stop if genuinely blocked. ${encouragement(continuations, nudge)}`,
    };
  }
  return {};
}


async function recordReviewAudit(input, runner, { verdict, reason, error } = {}) {
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
  };
  try {
    await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging is best-effort and must never change the hook decision.
  }
}

async function handleStop(input, runner = "codex") {
  const runtime = RUNTIMES[runner];
  if (!runtime) throw new Error(`Unsupported keep-going runtime: ${runner}`);
  if (runner === "codex" && (typeof input.turn_id !== "string" || !input.turn_id)) {
    throw new Error("Stop input is missing turn_id");
  }
  if (typeof input.session_id !== "string" || !input.session_id) {
    throw new Error("Stop input is missing session_id");
  }
  const lastAssistantMessage = compactText(stopCandidateText(input), 12_000);
  if (!lastAssistantMessage) return {};

  let review;
  // Kept after the cap check: the nudge changes tone as the turn nears the cap.
  let continuations = 0;
  try {
    // The transcript is used only to enforce the continuation cap. Its content
    // is never supplied to the reviewer.
    if (typeof input.transcript_path === "string" && input.transcript_path) {
      continuations = await countContinuations(input, runner);
      if (continuations >= CONTINUATION_CAP) {
        return {
          systemMessage: `keep-going: continuation cap (${CONTINUATION_CAP}) reached for this turn; accepting the stop.`,
        };
      }
    }

    review = parseReviewVerdict(
      await runReviewModel({
        provider: runtime.provider,
        model: (runtime.modelEnv ? process.env[runtime.modelEnv] : undefined) || runtime.model,
        prompt: `${REVIEW_PROMPT}\n\n${JSON.stringify({ last_assistant_message: lastAssistantMessage })}`,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        ghostHome: runner === "ghost" ? input.ghost_home : undefined,
      }),
    );
  } catch (error) {
    await recordReviewAudit(input, runner, { error: error.message });
    return { systemMessage: `keep-going was skipped: ${compactText(error.message, 500)}` };
  }

  const output = hookOutputForVerdict(review.verdict, continuations, review.nudge);
  await recordReviewAudit(input, runner, { verdict: review.verdict, reason: output.reason });
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
  CONTINUATION_CAP,
  ENCOURAGEMENTS,
  NUDGE_LIMIT,
  LAST_STRETCH,
  REVIEW_PROMPT,
  countContinuations,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
};
