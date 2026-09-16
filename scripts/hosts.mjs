// Which stop-style events each host dispatches, and the shape every
// registration of this hook shares. Two files write hooks — the build emits
// the plugin's, the installer writes the settings — and a host that dispatches
// two events has to be registered for both by whichever one a user chose.
// Adding SubagentStop took two edits in two commits before this existed.
export const HOSTS = {
  codex: { events: ["Stop"] },
  // A Stop registration is rewritten to SubagentStop only for hooks a session
  // registers at runtime, so a settings.json Stop hook never sees a subagent:
  // the event has to be asked for by name.
  claude: { events: ["Stop", "SubagentStop"] },
  ghost: { events: ["session_stop"] },
  grok: { events: ["Stop"] },
};

// The hook waits on a reviewer model call, so it has to outlast one.
export const HOOK_TIMEOUT = 240;
export const STATUS_MESSAGE = "Deciding whether to keep going";
