# keep going

A Stop hook for Codex, Claude Code, Muse Code, Ghost, and Grok, and a native Pi
extension, that tells the agent to keep going when work remains.

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

`CONTINUE` blocks the stop (in Pi, queues a follow-up) with a fixed line —
"Keep going." and three variations, rotated. The reviewer only decides; it
never writes to the agent. The agent has read far more than the reviewer, and
a reviewer that wrote its own line ended up arguing with it: restating the
owner's words against the agent's evidence, or claiming consent the owner never
gave.

A stop that follows a nudge with no tool call in between goes through
unreviewed: the agent weighed the nudge and still holds, and a second review
would only argue with it. Claude Code, Codex, and Pi show where the last nudge
fell; on the other hosts every stop is reviewed.

Everything else lets the stop through: a missing binary, a timeout, an
unparseable verdict, or a bare completion token (`Done.`) with no owner prompt
to weigh it against.

At most 100 continuations per owner turn; past the cap the stop is accepted
unreviewed. The count is a tally per session and turn under
`$XDG_STATE_HOME/keep-going` (the ghost home for Ghost). On Claude Code, whose
stop names no turn, it is read from the transcript; Pi counts follow-ups on the
session branch. Subagents on Claude Code and Muse are reviewed on the same
terms, each with its own count.

A fresh stop waits fifteen seconds first; if the owner's next message lands
in the transcript during that window they were already following up, and the
stop goes through. Only an owner message counts: the host's own writes, such
as Claude Code landing the final assistant message after Stop has fired, do
not. Subagent stops skip the wait, and so do Muse, which sends no transcript,
and Pi.

## Install

CLI hooks need Node.js 22+ and the host CLI (`codex`, `claude`, `muse`,
`ghostd` with `hook-smol-complete`, or `grok`). The Pi extension needs Pi
0.84.2+.

```bash
# Pi — then /reload or start a new session
pi install git:github.com/ferdousbhai/keep-going

# Codex — then start a new session
codex plugin marketplace add ferdousbhai/keep-going
codex plugin add keep-going@keep-going

# Claude Code — Stop and SubagentStop
claude plugin marketplace add ferdousbhai/keep-going
claude plugin install keep-going@keep-going

# Muse Code, Ghost, Grok Build, or Claude Code without the plugin
npx --yes github:ferdousbhai/keep-going --muse   # --ghost, --grok, --claude, --all
```

One route per host: a plugin and an `npx` hook together review every stop
twice. Inside a Ghost turn (`GHOST` set in the environment) the harness's own
copy stands down: Ghost reviews the turn once through its `session_stop` hook. `--all` writes a native file for Claude Code, Muse, Ghost, and Grok. Grok also
scans `~/.claude/settings.json`, so `--claude` alone covers it; with both
installed, keep-going ignores the Claude copy on Grok and the reviewer runs
once.

Installs track `main`. To pin, use a tag: `--ref v0.16.0` for Codex,
`#v0.16.0` for `npx`, `@v0.16.0` for Pi. The Claude plugin moves only on
`claude plugin update`. There is no npm package.

Installer flags:

- `--link` registers this checkout instead of copying it, for working on
  keep-going. Switching between `--link` and a copy replaces the registration.
- `--audit-log PATH` writes `KEEP_GOING_AUDIT_LOG` into each hook command,
  the only environment Muse passes to a hook. Reinstalling without it drops
  the setting. Codex's plugin and Pi read the variable from the shell instead.
- `--status` prints where keep-going is registered for the CLI hosts, any
  missing event, other hooks on the same stop, and any double review.
- `--uninstall` with a host flag removes it. The plugin: `claude plugin
  uninstall keep-going`.

## Pi

Pi runs keep-going as an extension. It reviews only a normal final text
response; tool turns, aborted responses, and turns with queued messages are
left alone. `CONTINUE` queues one visible follow-up. The reviewer is a
direct, tool-free call to Pi's active model — or `KEEP_GOING_PI_MODEL`, an
exact `provider/model-id` — with Pi's own authentication.

`/keep-going on|off|status` controls the current session; `off` also cancels a
review in progress. Escape cancels the review with the run; new input, a model
change, or session navigation discards an in-flight verdict. Provider errors
and timeouts accept the stop. A persisted marker prevents double reviews, even
with two copies of the extension loaded.

Local development: `npm run build`, `pi install /absolute/path/to/keep-going`,
`/reload`; install one source, not both. `npm run test:pi` runs end-to-end
tests against an installed Pi with a mock provider; `npm run check` runs the
build and unit tests without Pi.

## Environment variables

| Variable | Default |
| --- | --- |
| `KEEP_GOING_{CODEX,CLAUDE,MUSE,GHOST,GROK}_BIN` | `codex`, `claude`, `muse`, `ghostd`, `grok` |
| `KEEP_GOING_CODEX_MODEL` | `gpt-5.6-luna` |
| `KEEP_GOING_CLAUDE_MODEL` | `sonnet`; the latest Sonnet |
| `KEEP_GOING_{MUSE,GROK}_MODEL` | unset; the reviewer CLI picks its default |
| `KEEP_GOING_PI_MODEL` | unset; Pi's active model |
| `KEEP_GOING_QUIET_MS` | `15000`; the wait before a fresh stop is reviewed; `0` reviews at once |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision, with the reviewer's raw text and how the stop was decided |
| `KEEP_GOING_HOME` | OS home; the installer writes under it |

Reviewers run without tools — Muse, which has no such switch, without web
tools in a scratch directory — and with as little thinking as the host allows:
`low` on Codex, Claude, and Grok; Muse at its default; Pi at off where the
model's catalog allows it, else the lowest level the catalog lists. A one-word
verdict does not need a frontier model, so Codex defaults to `gpt-5.6-luna`
and Claude to `sonnet`, as Ghost reviews through `ghostd hook-smol-complete`;
Pi has no smaller tier to name and reviews on the active model. Codex runs
with `--ignore-user-config`, so `KEEP_GOING_CODEX_MODEL` is the only way to
choose its model, and its default names a release, not a family, so it is
bumped by hand when a newer Luna ships.
Muse reviews under a config overlay with no settings, so its own Stop hook does not
re-enter; a non-default `XDG_CONFIG_HOME` is unreachable from a hook, and the
review then fails open.
