import { handleStop, NUDGES } from "./keep-going.mjs";

const isKeepGoingNudge = (text) => NUDGES.includes(text);

// The text a message shows: its text parts, not reasoning, tools, or text the
// host inserted itself.
const shownText = (message) =>
  (message?.parts ?? []).filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join("").trim();

/**
 * OpenCode has no stop hook: a session goes idle when the agent finishes, and
 * a plugin can then send the next message itself. The review is keep-going's
 * own; a CONTINUE becomes that next message.
 */
export const KeepGoing = async ({ client, directory }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    const id = event.properties?.sessionID;
    if (!id) return;
    try {
      // A subagent's session reports to its parent, whose own stop is reviewed.
      if ((await client.session.get({ path: { id } })).data?.parentID) return;
      const messages = (await client.session.messages({ path: { id } })).data ?? [];
      const last = messages.at(-1);
      // An aborted or failed reply is not the agent choosing to stop.
      if (last?.info?.role !== "assistant" || last.info.error) return;
      const request = messages.findLast((message) => message.info?.role === "user" && !isKeepGoingNudge(shownText(message)));
      const stop = await handleStop({
        session_id: id,
        // The owner's message names the turn, so its nudges count against it.
        turn_id: request?.info?.id ?? "",
        owner_prompt: shownText(request),
        last_assistant_message: shownText(last),
        cwd: directory,
      }, "opencode");
      if (stop.decision === "block") {
        await client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text: stop.reason }] } });
      }
    } catch {
      // A failed review lets the stop stand, as every host's does.
    }
  },
});


