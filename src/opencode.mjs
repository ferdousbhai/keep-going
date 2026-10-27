import { handleStop, isNudge, runOpencodeV2Model } from "./keep-going.mjs";

// The text a V1 message shows: its text parts, not reasoning, tools, or text
// the host inserted itself.
const shownText = (message) =>
  (message?.parts ?? []).filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join("").trim();

// Both API generations reduced to what the review reads: who spoke, what they
// said, and whether the reply failed.
const fromV1 = (messages) =>
  messages.map((message) => ({ id: message.info?.id, role: message.info?.role, text: shownText(message), failed: Boolean(message.info?.error) }));

// V2 keeps host-inserted text in its own "synthetic" messages, so a "user"
// message is the owner's (or a nudge). An "idle" record closes each run; one
// that did not succeed fails the reply before it.
function fromV2(messages) {
  const shown = [];
  for (const message of messages) {
    if (message.type === "user") shown.push({ id: message.id, role: "user", text: (message.text ?? "").trim() });
    else if (message.type === "assistant") {
      const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      shown.push({ id: message.id, role: "assistant", text, failed: Boolean(message.error) });
    } else if (message.type === "idle" && message.outcome !== "succeeded" && shown.at(-1)?.role === "assistant") {
      shown.at(-1).failed = true;
    }
  }
  return shown;
}

/**
 * OpenCode has no stop hook: a session goes idle when the agent finishes, and
 * a plugin can then send the next message itself. The review is keep-going's
 * own; a CONTINUE becomes that next message. `host` adapts one API generation.
 */
async function reviewIdle(id, directory, host) {
  try {
    // A subagent's session reports to its parent, whose own stop is reviewed.
    if (await host.parentID(id)) return;
    const messages = await host.messages(id);
    const last = messages.at(-1);
    // An aborted or failed reply is not the agent choosing to stop.
    if (last?.role !== "assistant" || last.failed) return;
    const asked = messages.findLastIndex((message) => message.role === "user" && !isNudge(message.text));
    const request = messages[asked];
    const stop = await handleStop({
      session_id: id,
      // The owner's message names the turn, so its nudges count against it.
      turn_id: request?.id ?? "",
      owner_prompt: request?.text ?? "",
      owner_replied_to: messages.slice(0, Math.max(asked, 0)).findLast((message) => message.role === "assistant" && message.text)?.text ?? "",
      // The latest message being a nudge means this stop answers one.
      stop_hook_active: request !== messages.findLast((message) => message.role === "user"),
      last_assistant_message: last.text,
      cwd: directory,
    }, "opencode", { runModel: host.runModel });
    // The review can take a while; a verdict holds only while the reviewed
    // reply is still the session's last message.
    if (stop.decision === "block") {
      if ((await host.messages(id)).at(-1)?.id !== last.id) return;
      await host.prompt(id, stop.reason);
    }
  } catch {
    // A failed review lets the stop stand, as every host's does.
  }
}

// OpenCode 1.x: a function of { client, directory } returning hooks.
export const KeepGoing = async ({ client, directory }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    const id = event.properties?.sessionID;
    if (!id) return;
    await reviewIdle(id, directory, {
      parentID: async (id) => (await client.session.get({ path: { id } })).data?.parentID,
      messages: async (id) => fromV1((await client.session.messages({ path: { id } })).data ?? []),
      prompt: (id, text) => client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } }),
    });
  },
});

// OpenCode 2.x: setup(ctx) subscribes to the event stream until cleanup. A
// run ends in session.execution.succeeded, .failed or .interrupted; only a
// success is the agent choosing to stop. (2.x sends no session.idle.)
function setup(ctx) {
  const stop = new AbortController();
  const host = {
    parentID: async (sessionID) => (await ctx.session.get({ sessionID }))?.parentID,
    messages: async (sessionID) => fromV2((await ctx.session.context({ sessionID })) ?? []),
    prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
    runModel: runOpencodeV2Model,
  };
  (async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      const id = event?.type === "session.execution.succeeded" ? event.data?.sessionID : undefined;
      // Reviews run beside the stream, so one slow reviewer holds up no other session.
      if (id) void reviewIdle(id, ctx.location?.directory, host);
    }
  })().catch(() => {});
  return () => stop.abort();
}

// OpenCode 1.x reads `server` from a default export that has an id; 2.x reads
// `setup`. Each ignores the other's field.
export default { id: "keep-going", server: KeepGoing, setup };
