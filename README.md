# keep going

A Stop hook for Codex, Claude Code, Muse Code, Ghost, and Grok, and a native Pi
extension, that tells the agent to keep going when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

![Three stops, three verdicts: work left, a question it can answer itself, and
a turn that is genuinely done](docs/keep-going.gif)

## How it works

When the agent tries to end a turn, a reviewer model sees the last assistant
message and the owner's request — redacted and truncated — and answers:

- `CONTINUE` — work remains that the agent can do right now.
- `THINK` — it should reason this through instead of stopping or asking.
- `RESCAN` — it claims open-ended work is done; one more fresh pass first.
- `STOP` — it is genuinely done, genuinely blocked on the user, or waiting on
  a decision only the owner can make.

`RESCAN` is offered once per owner turn. The report of that scan is itself a
claim that the work is done, so on every later stop of the turn the reviewer is
told the scan was already asked for and chooses among the other three. A
`RESCAN` it gives anyway is not an answer the prompt offered, so the stop goes
through the way an unparseable verdict does, with a warning to the owner.

The first three block the stop (in Pi, queue a follow-up) with a line the
reviewer writes for the occasion. That line never speaks for the owner: the
reviewer is told not to state what they said, meant or approved, because the
agent sees the sentence and not the reading behind it, and a turn that ended on
a decision only the owner can make is `STOP` rather than something to push past. Everything else lets the stop through: a
missing binary, a timeout, an unparseable verdict, a final message that is the
exact reply the owner asked for, or a bare completion token (`Done.`) with no
owner prompt to weigh it against.

At most 100 continuations per owner turn; over the last 10 the reviewer is
asked for a line about landing what is in flight, and past the cap the stop is
accepted unreviewed. From the first continuation it is told how many the turn
has already had — earlier nudges are filtered out of the transcript it reads,
so a stop it keeps refusing would otherwise look like a first attempt. The count is a tally per session and turn under
`$XDG_STATE_HOME/keep-going` (the ghost home for Ghost). Where the stop names
no turn, as on Claude Code, it is read from the transcript; Pi counts
follow-ups on the session branch. Subagents on Claude Code and Muse are
reviewed on the same terms, each with its own count.

A fresh stop waits fifteen seconds first; if the owner's next message lands
in the transcript during that window they were already following up, and the
stop goes through. Only an owner message counts: the host's own writes, such
as Claude Code landing the final assistant message after Stop has fired, do
not. Subagent stops skip the wait. The reviewer may reply `TURN n` or
`TURN x-y` (up to five turns) to read earlier turns before verdicting, at most
twice per stop. Muse sends no transcript, so there the stop is reviewed at
once from the current turn alone.

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
twice. `--all` writes a native file per CLI host, Grok included. Grok also
scans `~/.claude/settings.json`, so `--claude` alone covers it; with both
installed, keep-going ignores the Claude copy on Grok and the reviewer runs
once.

Installs track `main`. To pin, use a tag: `--ref v0.14.0` for Codex,
`#v0.14.0` for `npx`, `@v0.14.0` for Pi. The Claude plugin moves only on
`claude plugin update`. There is no npm package.

Installer flags:

- `--link` registers this checkout instead of copying it, for working on
  keep-going. Switching between `--link` and a copy replaces the registration.
- `--audit-log PATH` writes `KEEP_GOING_AUDIT_LOG` into each hook command,
  the only environment Muse passes to a hook. Reinstalling without it drops
  the setting. Codex's plugin and Pi read the variable from the shell instead.
- `--status` prints where keep-going is registered for the CLI hosts, any
  missing event, other plugins on the same stop, and any double review.
- `--uninstall` with a host flag removes it. The plugin: `claude plugin
  uninstall keep-going`.

## Pi

Pi runs keep-going as an extension. It reviews only a normal final text
response; tool turns, aborted responses, and turns with queued messages are
left alone. A blocking verdict queues one visible follow-up. The reviewer is a
direct, tool-free call to Pi's active model — or `KEEP_GOING_PI_MODEL`, an
exact `provider/model-id` — with the provider's default inference settings and
Pi's own authentication.

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
| `KEEP_GOING_TURNS` | unset; `0` disables the past-turn index |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision, with the reviewer's raw text and how the stop was decided |
| `KEEP_GOING_HOME` | OS home; the installer writes under it |

Reviewers run without tools and with as little thinking as the host allows:
`low` on Codex, Claude, and Grok; Muse at its default; Pi at off where the
model's catalog allows it, else the lowest level the catalog lists. A one-word
verdict does not need a frontier model, so Codex defaults to `gpt-5.6-luna`
and Claude to `sonnet`, as Ghost reviews through `ghostd hook-smol-complete`;
Pi has no smaller tier to name and reviews on the active model. Codex runs
with `--ignore-user-config`, so `KEEP_GOING_CODEX_MODEL` is the only way to
choose its model, and its default names a release, not a family, so it moves
when a newer Luna ships.
Muse reviews under an empty config overlay so its own Stop hook does not
re-enter; a non-default `XDG_CONFIG_HOME` is unreachable from a hook, and the
review then fails open.

`UNBLOCK_*`, `STOP_REVIEW_*`, and `CODEX_STOP_REVIEW_*` stopped resolving in
0.4.0; the installer removes those registrations.
