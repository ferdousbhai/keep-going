# keep going

A Stop hook for Codex, Claude Code, Muse Code, Ghost, Grok, Cursor CLI, GitHub
Copilot CLI, and Antigravity, and a native plugin for Pi, Oh My Pi, and
OpenCode, that tells the agent to keep going when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

![Three stops: work left, a question only the owner can answer, and a turn
that is done](docs/keep-going.gif)

## How it works

When the agent tries to end a turn, a reviewer model sees the last assistant
message and the owner's request — redacted and truncated — and answers:

- `CONTINUE` — the agent stopped with work in hand: it announced a step and
  did not take it, stopped partway, or asked permission for an obvious next
  step.
- `STOP` — the request is done, the agent is blocked, or it is waiting on
  something only the owner can give: consent to deploy, publish, send, spend,
  or delete, an answer only the owner has, or which reading of their words
  they meant.

`CONTINUE` blocks the stop with a fixed line — "Keep going." and three
variations, rotated. The reviewer only decides; a reviewer that wrote its own
line ended up arguing with an agent that had read far more than it.

Everything else lets the stop through: a missing binary, a timeout, an
unparseable verdict, a bare completion token (`Done.`) with no owner prompt to
weigh it against, or — on Claude Code, Codex, and Pi, which show where the
last nudge fell — a stop after a nudge with no tool call in between: the agent
weighed the nudge and holds.

At most 100 continuations per owner turn; past the cap the stop is accepted
unreviewed. The count is a tally per session and turn under
`$XDG_STATE_HOME/keep-going` (the ghost home for Ghost); Claude Code, whose
stop names no turn, counts from its transcript, and Pi from the session
branch. Subagents on Claude Code and Muse are reviewed on the same terms, each
with its own count.

On Codex, Claude Code, and Grok a fresh main-agent stop waits fifteen seconds
first; an owner message landing in the transcript meanwhile lets the stop
through. The host's own writes, such as Claude Code recording the final
message after Stop fires, do not count.

## Install

CLI hooks need Node.js 22+ and the host CLI (`codex`, `claude`, `muse`,
`ghostd` with `hook-complete`, `grok`, `cursor-agent`, `copilot`, `agy`,
or `opencode`). The Pi extension needs Pi 0.84.2+.

```bash
# Pi — then /reload or start a new session
pi install git:github.com/ferdousbhai/keep-going

# Codex — then start a new session
codex plugin marketplace add ferdousbhai/keep-going
codex plugin add keep-going@keep-going

# Claude Code — Stop and SubagentStop
claude plugin marketplace add ferdousbhai/keep-going
claude plugin install keep-going@keep-going

# Oh My Pi — loads this package's omp extension, not Pi's
omp plugin install github:ferdousbhai/keep-going

# Muse Code, Ghost, Grok Build, Cursor CLI, Copilot CLI, Antigravity, OpenCode,
# or Claude Code without the plugin
npx --yes github:ferdousbhai/keep-going --muse   # --ghost, --grok, --cursor, --copilot, --agy, --opencode, --claude, --all
```

One route per host: a plugin and an `npx` hook together review every stop
twice. `--all` covers Claude Code, Muse, Ghost, and Grok. Grok also runs
`~/.claude/settings.json` hooks, so `--claude` alone covers it; with both
installed, the Claude copy stands down on Grok. Inside a Ghost turn — `GHOST`
in the environment, or for Muse a Ghost conversation directory — every other
copy stands down and Ghost reviews through its own `session_stop` hook.

Installs track `main`. To pin, use a tag: `--ref v0.17.0` for Codex,
`#v0.17.0` for `npx`, `@v0.17.0` for Pi. The Claude plugin moves only on
`claude plugin update`. There is no npm package.

Installer flags:

- `--link` registers this checkout instead of a copy; switching either way
  replaces the registration.
- `--audit-log PATH` writes `KEEP_GOING_AUDIT_LOG` into each hook command, for
  Muse, which passes a hook no environment; reinstalling without it drops it.
- `--status` shows each host's registration, missing events, other hooks on
  the same stop, and double reviews.
- `--uninstall` with host flags removes them; the Claude plugin goes with
  `claude plugin uninstall keep-going`.

## Hosts

- **Cursor CLI** sends neither the reply nor the request at stop, so the hook
  also runs on `beforeSubmitPrompt` and `afterAgentResponse` to note them, and
  answers a stop with `followup_message`. Its run of Claude's settings hooks
  stands down. Cursor caps follow-ups at 5 a loop, and its print mode
  (`cursor-agent -p`) runs no hooks.
- **Copilot CLI** reads the turn from its `events.jsonl`; the block reason is
  sent as the next prompt, and Copilot ends a turn after 8 blocks in a row.
- **Antigravity** reads the turn from its transcript and answers
  `{"decision":"continue"}`; the nudge arrives as a system message.
- **OpenCode** has no stop hook: the plugin
  (`~/.config/opencode/plugins/keep-going.js`) reviews when a session goes idle
  and sends the nudge as the next message, so a one-shot `opencode run`, which
  exits at that idle, never continues.
- **Oh My Pi** blocks on its `session_stop` hook.
- **Pi** reviews only a normal final text response; tool turns, aborted
  responses, and turns with queued messages are left alone. `CONTINUE` queues
  one visible follow-up. `/keep-going on|off|status` controls the session;
  `off` also cancels a review in progress. Escape cancels the review with the
  run; new input, a model change, or session navigation discards an in-flight
  verdict. A persisted marker prevents double reviews, even with two copies of
  the extension loaded.

Not supported: Crush (its only hook runs before a tool call), Ori's own agent
(`ori code`, no documented turn-end hook; `ori claude`, `ori codex`, and the
other launchers run the real CLI and its hook), and Hermes and OpenClaw, which
can only queue a follow-up message or revise a turn a few times.

## Reviewers

Each reviews on the host's own model: Codex on the session's, which its stop
names; Pi on its active model, with Pi's authentication; Ghost through
`ghostd hook-complete`; Muse and Grok, whose reviewers run without the owner's
config, on their CLI's built-in default; every other host on its CLI's
configured default. Thinking is as low as the host allows: `low` on Codex,
Claude, and Grok; Pi off where the model's catalog allows it, else its lowest
listed level; every other host at its CLI's default.

Reviewers run without tools — Codex with its shell in a read-only sandbox;
Muse, which has no such switch, without web tools in a scratch directory;
Cursor in ask mode and Antigravity in plan mode, read-only in a scratch
directory; OpenCode and Oh My Pi with their own tools in a scratch directory,
since OpenCode's free tier refuses a reduced tool set and Oh My Pi's switch is
unconfirmed.

No reviewer re-enters keep-going: Codex runs with hooks disabled, Claude in
safe mode, Grok in single-prompt mode, Cursor in print mode, OpenCode with
`--pure`, Oh My Pi with `--no-extensions`, and Muse under a config overlay with no settings — a
non-default `XDG_CONFIG_HOME` is unreachable from a hook, and its review then
fails open. Copilot, Antigravity, and Ghost run the owner's own CLI, whose
hooks cannot be switched off for one run, so `KEEP_GOING_REVIEWING` marks the
reviewer's process and its stop goes unreviewed.

## Environment variables

| Variable | Default |
| --- | --- |
| `KEEP_GOING_{CODEX,CLAUDE,MUSE,GHOST,GROK}_BIN` | `codex`, `claude`, `muse`, `ghostd`, `grok` |
| `KEEP_GOING_{CURSOR,COPILOT,AGY,OPENCODE,OMP}_BIN` | `cursor-agent`, `copilot`, `agy`, `opencode`, `omp` |
| `KEEP_GOING_QUIET_MS` | `15000`; the wait before a fresh stop is reviewed; `0` reviews at once |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision, with the reviewer's raw text and how the stop was decided |

## Development

`npm run check` builds the bundles and runs the unit tests; `npm run test:pi`
runs end-to-end tests against an installed Pi with a mock provider. To try the
Pi extension: `npm run build`, `pi install /absolute/path/to/keep-going`,
`/reload`; install one source, not both.
