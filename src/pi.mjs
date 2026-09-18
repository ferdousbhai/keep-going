import { handleStop } from "./keep-going.mjs";

const NUDGE = "keep-going";
const REVIEW = "keep-going-review";
const SETTINGS = "keep-going-settings";

const textOf = (message) => (message.content ?? [])
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("\n");

const lastAssistant = (branch) => branch.findLast((entry) =>
  entry.type === "message" && entry.message.role === "assistant");

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

export async function reviewWithPi(ctx, model, { prompt, timeoutMs }, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await abortable(() => ctx.modelRegistry.complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { signal: deadline, maxTokens: 2048, cacheRetention: "none" },
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
    const count = branch.slice(ownerIndex + 1).filter((entry) =>
      entry.type === "custom_message" && entry.customType === NUDGE).length;
    const controller = new AbortController();
    activeReview = controller;
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const model = reviewerModel(ctx);
      ctx.ui.setStatus(NUDGE, `keep-going: reviewing with ${model.provider}/${model.id}`);
      const result = await handleStop({
        session_id: sessionId,
        turn_id: owner.id,
        cwd: ctx.cwd,
        continuation_count: count,
        reviewer_model: `${model.provider}/${model.id}`,
        last_assistant_message: text,
      }, "pi", { runModel: (request) => reviewWithPi(ctx, model, request, signal) });

      // The user may have typed, aborted, navigated, or disabled the extension
      // during the review. A verdict is valid only for the branch we reviewed.
      if (signal.aborted || !enabled(ctx) || ctx.hasPendingMessages() ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          lastAssistant(ctx.sessionManager.getBranch())?.id !== assistant.id) return;
      if (result.systemMessage) ctx.ui.notify(result.systemMessage, "warning");
      if (result.decision === "block") {
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
