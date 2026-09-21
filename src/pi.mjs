import { handleStop, TURN_INDEX_LIMIT } from "./keep-going.mjs";

const NUDGE = "keep-going";
const REVIEW = "keep-going-review";
// Marks the turn's one RESCAN, so the hook can take it off the table after.
const RESCAN = "keep-going-rescan";
const SETTINGS = "keep-going-settings";

const textOf = (message) => (message.content ?? [])
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("\n");

const lastAssistant = (branch) => branch.findLast((entry) =>
  entry.type === "message" && entry.message.role === "assistant");

const HOOK_FEEDBACK_PATTERN = /^\s*Stop hook feedback\b/;

// Turns before the one under review, oldest first, for the reviewer's TURN
// requests. Segments open at user messages; tool-only assistant traffic has
// no text and never becomes a final. Hook feedback is a continuation of its
// turn, never a turn of its own.
function pastTurnsFromBranch(branch, ownerIndex) {
  const turns = [];
  let current = null;
  for (const entry of branch.slice(0, ownerIndex)) {
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "user") {
      const owner = textOf(entry.message).trim();
      if (!owner || HOOK_FEEDBACK_PATTERN.test(owner)) continue;
      current = { owner_prompt: owner, final_response: "" };
      turns.push(current);
    } else if (entry.message?.role === "assistant" && current) {
      const text = textOf(entry.message).trim();
      if (text) current.final_response = text;
    }
  }
  return turns.slice(-TURN_INDEX_LIMIT);
}

function enabled(ctx) {
  const setting = ctx.sessionManager.getBranch().findLast((entry) =>
    entry.type === "custom" && entry.customType === SETTINGS);
  return setting?.data?.enabled !== false;
}

export function reviewerModel(ctx) {
  const override = process.env.KEEP_GOING_PI_MODEL;
  if (!override) {
    if (!ctx.model) throw new Error("No Pi model selected");
    return ctx.model;
  }
  // Require an exact provider/id rather than guessing across providers. Model
  // IDs can themselves contain slashes, so only the first slash is a separator.
  const slash = override.indexOf("/");
  if (slash < 1 || slash === override.length - 1) {
    throw new Error("KEEP_GOING_PI_MODEL must be provider/model-id");
  }
  const model = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
  if (!model) throw new Error(`Unknown Pi reviewer model: ${override}`);
  return model;
}

// A provider should honor AbortSignal, but a broken one must not keep the
// extension waiting forever. The race also releases Pi promptly on Escape.
async function abortable(work, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Review cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// The review wants the least thinking the model allows. `false` is Pi's "off"
// level. Anthropic and Google APIs then send no level at all, but OpenAI-style
// APIs send the catalog's off mapping, or a literal "none" when there is no
// mapping, which a model that lists no such level rejects. Off is requested
// only where it sends nothing or a value the catalog vouches for; otherwise
// "minimal", which pi-ai clamps up to the lowest level the catalog allows.
const NONE_FALLBACK_APIS = new Set([
  "openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions",
]);

export function reviewReasoning(model) {
  if (!model.reasoning) return false;
  const off = model.thinkingLevelMap?.off;
  if (typeof off === "string") return false;
  if (off === null || NONE_FALLBACK_APIS.has(model.api)) return "minimal";
  return false;
}

export async function reviewWithPi(ctx, model, { prompt, timeoutMs }, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await abortable(() => ctx.modelRegistry.complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { signal: deadline, maxTokens: 2048, cacheRetention: "none", reasoning: reviewReasoning(model) },
  ), deadline);
  deadline.throwIfAborted();
  if (response.stopReason !== "stop") {
    throw new Error(`Pi reviewer did not finish (${response.stopReason})`);
  }
  return textOf(response);
}

export default function keepGoing(pi) {
  let activeReview;
  let disposed = false;
  const cancel = () => activeReview?.abort(new Error("Review cancelled"));

  // Input arrives even while an async review is running. Never let an old
  // verdict race a new request, a model switch, or a session replacement.
  for (const event of ["input", "model_select", "session_before_switch", "session_before_fork", "session_before_tree"]) {
    pi.on(event, cancel);
  }
  pi.on("session_shutdown", () => { disposed = true; cancel(); });

  pi.registerCommand("keep-going", {
    description: "Keep Going: on, off, or status (current session)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        if (action === "off") cancel();
        pi.appendEntry(SETTINGS, { enabled: action === "on" });
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /keep-going [on|off|status]", "warning");
        return;
      }
      try {
        const model = reviewerModel(ctx);
        ctx.ui.notify(`keep-going: ${enabled(ctx) ? "on" : "off"}; reviewer ${model.provider}/${model.id}`, "info");
      } catch (error) {
        ctx.ui.notify(`keep-going: ${error.message}`, "warning");
      }
    },
  });

  // Pi awaits turn_end while the run's abort signal is still live and before
  // draining follow-ups. agent_end is too late for that loop's follow-up poll;
  // agent_settled is idle and no longer has a cancellable agent signal.
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop" ||
        message.content.some((part) => part.type === "toolCall") ||
        event.toolResults.length ||
        !ctx.signal || ctx.signal.aborted || ctx.hasPendingMessages() || !enabled(ctx)) return;
    const text = textOf(message);
    if (!text.trim()) return;

    const branch = ctx.sessionManager.getBranch();
    const assistant = lastAssistant(branch);
    const ownerIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    if (!assistant || ownerIndex < 0) return;
    // This marker also deduplicates two copies of the extension: Pi awaits
    // handlers in load order, so the second copy sees the first one's marker.
    if (branch.some((entry) => entry.type === "custom" && entry.customType === REVIEW &&
        entry.data?.assistantId === assistant.id)) return;
    pi.appendEntry(REVIEW, { assistantId: assistant.id });

    const owner = branch[ownerIndex];
    const thisTurn = branch.slice(ownerIndex + 1);
    const count = thisTurn.filter((entry) =>
      entry.type === "custom_message" && entry.customType === NUDGE).length;
    const rescanned = thisTurn.some((entry) => entry.type === "custom" && entry.customType === RESCAN);
    const controller = new AbortController();
    activeReview = controller;
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const model = reviewerModel(ctx);
      ctx.ui.setStatus(NUDGE, `keep-going: reviewing with ${model.provider}/${model.id}`);
      let verdict;
      const result = await handleStop({
        session_id: sessionId,
        turn_id: owner.id,
        cwd: ctx.cwd,
        continuation_count: count,
        rescanned,
        reviewer_model: `${model.provider}/${model.id}`,
        last_assistant_message: text,
        owner_prompt: textOf(owner.message),
        past_turns: pastTurnsFromBranch(branch, ownerIndex),
      }, "pi", {
        runModel: (request) => reviewWithPi(ctx, model, request, signal),
        onVerdict: (value) => { verdict = value; },
      });

      // The user may have typed, aborted, navigated, or disabled the extension
      // during the review. A verdict is valid only for the branch we reviewed.
      if (signal.aborted || !enabled(ctx) || ctx.hasPendingMessages() ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          lastAssistant(ctx.sessionManager.getBranch())?.id !== assistant.id) return;
      if (result.systemMessage) ctx.ui.notify(result.systemMessage, "warning");
      if (result.decision === "block") {
        if (verdict === "RESCAN") pi.appendEntry(RESCAN, { assistantId: assistant.id });
        pi.sendMessage({ customType: NUDGE, content: result.reason, display: true },
          { deliverAs: "followUp", triggerTurn: true });
      }
    } catch (error) {
      if (!signal.aborted) ctx.ui.notify(`keep-going was skipped: ${error.message}`, "warning");
    } finally {
      if (activeReview === controller) {
        activeReview = undefined;
        // Session replacement invalidates ctx. Do not use it after shutdown.
        if (!disposed) ctx.ui.setStatus(NUDGE, undefined);
      }
    }
  });
}
