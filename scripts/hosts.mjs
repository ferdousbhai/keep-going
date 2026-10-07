// Which stop-style events each host dispatches, and the shape every
// registration of this hook shares. Two files write hooks — the build emits
// the plugin's, the installer writes the settings — and a host that dispatches
// two events has to be registered for both by whichever one a user chose.
export const STOP_EVENTS = {
  codex: ["Stop"],
  // A Stop registration is rewritten to SubagentStop only for hooks a session
  // registers at runtime, so a settings.json Stop hook never sees a subagent:
  // the event has to be asked for by name.
  claude: ["Stop", "SubagentStop"],
  muse: ["Stop", "SubagentStop"],
  ghost: ["session_stop"],
  grok: ["Stop"],
  // Cursor hands the prompt and the reply to hooks of their own; the stop
  // payload carries neither, so all three are registered.
  cursor: ["beforeSubmitPrompt", "afterAgentResponse", "stop"],
  copilot: ["agentStop"],
  agy: ["Stop"],
  // A plugin rather than a hook: it watches the session go idle.
  opencode: ["session.idle"],
};

// The hook waits on a reviewer model call, so it has to outlast one.
export const HOOK_TIMEOUT = 240;

// The shape itself, not just the constants in it: the build writes the
// plugin's registration and the installer writes the settings one, and they
// have to stay byte-identical. Written out twice, a field added to one is a
// field the other host never gets.
export const hookEntry = (command) => ({
  hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT, statusMessage: "Deciding whether to keep going" }],
});
