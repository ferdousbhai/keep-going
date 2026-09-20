# keep going

A Stop hook for Codex, Claude Code, Muse Code, Ghost, and Grok, and a native Pi
extension, that tells the agent to keep going when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

![Three stops, three verdicts: work left, a question it can answer itself, and
a turn that is genuinely done](docs/keep-going.gif)

Those three lines are real reviewer output, not mock-ups; `scripts/render-demo.py`
redraws the image from them.

## How it works

When the agent tries to end a turn, keep-going shows the last assistant message
and the owner's request — redacted and truncated — to a reviewer model, which
answers with one of:

- `CONTINUE` — work remains that the agent can do right now.
- `THINK` — more reasoning is needed; it should think this through instead of
  stopping or asking the user.
- `RESCAN` — the agent claims open-ended work is finished, but a fresh pass
  could still surface more; it goes back in to scan again.
- `STOP` — it is genuinely done, or genuinely blocked on the user.

`CONTINUE` and `THINK` block the stop (or queue a follow-up in Pi) and send the
agent back in with a short line the reviewer writes for the occasion. Ghost
sends the owner's request on the stop payload; Claude, Codex, Grok, and Pi
recover it from the transcript or session. Muse's stop payload has no prompt
and no transcript, so that field is empty. Any failure
— missing binary, timeout, unparseable verdict — accepts the stop. So does a
stop with no owner prompt and a final message of a bare completion token
(`None`, `Done.`): there is nothing to judge, and no reviewer is run.

At most 100 continuations per owner turn, rescans included. Past the cap the
next stop is accepted without a review; over the last 10 the reviewer is asked
for a line about landing what is in flight rather than starting something new.
A new owner prompt starts a fresh count.

Continuations are counted from the stop payload wherever it says which turn it
belongs to: the hook keeps its own tally per session and turn under
`$XDG_STATE_HOME/keep-going`, or inside the ghost home for Ghost. So the cap
holds on a host whose transcript cannot be read — which is also why the hook
does something useful there at all. A plain Claude Code stop names no turn, so
there the count comes from the transcript, read for that and nothing else.
Pi counts follow-up entries on the active session branch instead.

A fresh stop waits fifteen seconds before review; a transcript that grows in
that window means the user was already following up, so the stop goes through
unreviewed. Retries skip the wait, and a host with no readable transcript is
reviewed at once. `KEEP_GOING_QUIET_MS` tunes the wait in milliseconds;
`0` reviews immediately.

The prompt covers the current turn, but the reviewer may reply `TURN n` (or
`TURN x-y`, at most five turns) to read earlier turns' prompts and finals
before verdicting. The hook fulfills from the transcript and re-asks, at most
twice per stop within one time budget; anything else fails open. Sources per
host: Claude/Codex transcripts, Grok's chat log, Ghost's pi session file,
Pi's branch — all redacted and truncated. Muse sends no transcript, so it
decides from the current turn alone. `KEEP_GOING_TURNS=0` disables the index.

On Claude Code it reviews subagents too, on the same terms: a subagent that
quits with work left is the failure this hook is named for. A subagent stop
names the agent it came from and carries its parent's session, so each subagent
gets its own count of 100 and spends none of the turn that launched it.

## Install

CLI hooks require Node.js 22+ and the host CLI (`codex`, `claude`, `muse`,
`ghostd`, or `grok`; Ghost also needs `ghostd hook-smol-complete`). The native
Pi extension requires Pi 0.84.2+ and uses Pi's model registry directly.

```bash
# Pi — then /reload or start a new session
pi install git:github.com/ferdousbhai/keep-going

# Codex — then start a new session
codex plugin marketplace add ferdousbhai/keep-going
codex plugin add keep-going@keep-going

# Claude Code — registers Stop and SubagentStop
claude plugin marketplace add ferdousbhai/keep-going
claude plugin install keep-going@keep-going

# Muse Code — registers Stop and SubagentStop in the settings `hooks` block
npx --yes github:ferdousbhai/keep-going --muse

# Ghost, Grok Build, or Claude Code without the plugin
npx --yes github:ferdousbhai/keep-going --ghost   # --claude, --grok, --all
```

`--all` covers the CLI hooks managed by the `npx` installer, not Pi or the
Codex plugin. It writes a native file per host, including Grok even when Claude
is already installed.

Claude Code and Grok Build together: install both (`--all`, or `--claude --grok`).
Grok still scans `~/.claude/settings.json`, but keep-going ignores that copy on
Grok when `~/.grok/hooks/keep-going.json` is present, so the reviewer runs once,
as `grok`. `--claude` alone still covers Grok through that scan (also reviewed
by `grok`) if you have not written a native Grok hook — and is the only Grok
coverage if you later turn Grok's Claude hook compat off, until you add `--grok`.

One route per host: the plugin and the `npx` installer each register their own
Stop hook, and a host with both runs the reviewer twice on every stop.

These track `main`, gated by `npm run check`. To pin instead, add a git tag —
`--ref v0.12.1` for Codex, `#v0.12.1` for `npx`, or `@v0.12.1` for Pi's Git source.
The Claude plugin moves only when you run `claude plugin update`. There is no
npm package.

Working on keep-going itself: `node scripts/install.mjs --claude --ghost --link`
registers this checkout rather than copying it, so edits take effect with no
reinstall. Switching between `--link` and a copy replaces the registration
instead of adding a second one.

`--audit-log PATH` writes `KEEP_GOING_AUDIT_LOG` into each registered command.
Muse passes a hook only the environment its settings spell out, so a shell
export never reaches it; the installer is where that setting lives. A reinstall
without the flag drops it. Codex's plugin and the Pi extension read the
variable from the shell environment instead.

`npx --yes github:ferdousbhai/keep-going --status` prints where keep-going is
registered on this machine for the CLI hook hosts — settings files and Claude
Code plugins alike — naming any event a host is missing, listing any other plugin
that also runs on the same stop, and warning when one host is wired to review
a stop twice.

Uninstall: `claude plugin uninstall keep-going`, or the same `npx` command with
`--uninstall`.

## Pi

Pi loads keep-going as an extension, not as a `hooks.json` command. It reviews
only a normal final text response, before Pi drains its follow-up queue.
Tool turns, aborted or failed responses, and turns with queued messages are
left alone. `CONTINUE` or `THINK` queues one visible custom follow-up; `STOP`
leaves the response alone. The reviewer is a direct, tool-free model call, so
it cannot recursively trigger the extension.

The reviewer uses Pi's active model by default, with the provider's default
inference settings, not the session's thinking level. To choose a different
reviewer, set `KEEP_GOING_PI_MODEL` to an exact `provider/model-id` before
starting Pi. Pi supplies authentication, including subscription credentials.
No other host CLI is needed.

- `/keep-going` or `/keep-going status` shows the enabled state and reviewer.
- `/keep-going off` disables reviews for the current session and cancels any
  review in progress; `/keep-going on` enables them again.
- Escape cancels the review along with the active run. New input, model changes,
  and session navigation discard an in-flight verdict rather than resume stale
  work. Provider errors and review timeouts accept the stop.

Pi counts keep-going follow-ups since the latest user message on the active
session branch. The 100-continuation cap survives reloads, respects branching,
and resets for a new user message. A persisted per-response marker prevents
double reviews, including when two copies of the extension are loaded.

For local development, run `npm run build`, then
`pi install /absolute/path/to/keep-going` and `/reload`. Install one source,
not both the local checkout and Git package. Remove it with `pi remove` using
the same source you installed. `npx ... --status` does not inspect Pi; use
`/keep-going status` there.

`npm run test:pi` runs end-to-end tests against an installed Pi using a local
mock provider, with no credentials or paid model calls. It covers continuation,
THINK, STOP, invalid output, reviewer overrides, duplicate installs, and the cap.
`npm run check` runs the build and unit tests without requiring Pi.

## Environment variables

| Variable | Default |
| --- | --- |
| `KEEP_GOING_CODEX_BIN` | `codex` |
| `KEEP_GOING_CLAUDE_BIN` | `claude` |
| `KEEP_GOING_MUSE_BIN` | `muse` |
| `KEEP_GOING_GHOST_BIN` | `ghostd` |
| `KEEP_GOING_GROK_BIN` | `grok` |
| `KEEP_GOING_CODEX_MODEL` | unset; Codex chooses its default without loading the user config |
| `KEEP_GOING_CLAUDE_MODEL` | unset; claude is run without `--model`, so it picks |
| `KEEP_GOING_MUSE_MODEL` | unset; muse is run without `--model`, so it picks |
| `KEEP_GOING_GROK_MODEL` | unset; grok is run without `--model`, so it picks |
| `KEEP_GOING_PI_MODEL` | unset; Pi's active model; override with exact `provider/model-id` |
| `KEEP_GOING_QUIET_MS` | `15000`; how long a fresh stop waits before review; `0` reviews immediately |
| `KEEP_GOING_TURNS` | unset; `0` disables the past-turn index reviewers can request |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision with the reviewer's raw text and which mechanism capped the turn; the installer's `--audit-log` sets it per host |
| `KEEP_GOING_HOME` | OS home; the installer writes under it |

keep-going does not select a small or low-cost model automatically. For CLI
reviewers, unless a `KEEP_GOING_*_MODEL` override is set, it omits `--model` and
lets the reviewer CLI choose. That need not be the session's active model,
and the default can change with CLI versions or provider defaults. Where the
host exposes it, reasoning is the lowest advertised level (`none` on Codex
and Pi, `low` on Grok and Claude — Grok's CLI has no `none`). Reviewers are
run without tools.

The Codex reviewer runs with `--ignore-user-config`, so it does not inherit
`model` or reasoning settings from `~/.codex/config.toml`. Set
`KEEP_GOING_CODEX_MODEL` explicitly to choose its reviewer model. Ghost's
reviewer model is selected by `ghostd hook-smol-complete`, not keep-going.

Muse reviews itself with `muse exec`, which fires Stop hooks — so the reviewer
runs under an empty config overlay carrying no hooks, with the default home's
`auth.json` restored into it. A non-default config home (`XDG_CONFIG_HOME`) is
unreachable from inside a hook command, so there the review fails open.

## Upgrading from Unblock or Stop Review

0.4.0 is a clean break: `UNBLOCK_*`, `STOP_REVIEW_*`, and `CODEX_STOP_REVIEW_*`
no longer resolve — use the `KEEP_GOING_*` name. Installing 0.4.0 removes the
old registrations, so no two reviewers run on one stop.
