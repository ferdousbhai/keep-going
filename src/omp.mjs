import { handleStop, isNudge } from "./keep-going.mjs";

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
};

/**
 * Oh My Pi awaits `session_stop` before a main-session turn settles and takes
 * the Claude-style `{ decision: "block", reason }` as a continuation; it never
 * fires for subagents. The review is keep-going's own, whose cap bounds what
 * OMP leaves uncapped.
 */
export default function keepGoing(pi) {
  pi.on("session_stop", async (event, ctx) => {
    if (event.signal?.aborted) return undefined;
    const messages = event.messages ?? [];
    const asked = messages.findLastIndex((message) => message.role === "user" && !isNudge(textOf(message)));
    const stop = await handleStop({
      session_id: event.session_id,
      owner_prompt: textOf(messages[asked]),
      owner_replied_to: textOf(messages.slice(0, Math.max(asked, 0)).findLast((message) => message.role === "assistant" && textOf(message))),
      last_assistant_message: textOf(event.last_assistant_message),
      stop_hook_active: event.stop_hook_active,
      cwd: ctx?.cwd,
    }, "omp");
    return stop.decision === "block" ? { decision: "block", reason: stop.reason } : undefined;
  });
}
