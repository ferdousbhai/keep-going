# keep going

A Stop hook for Codex, Claude Code, and Ghost that tells the agent to keep going
when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

## How it works

When the agent tries to end a turn, keep-going shows the last assistant message
— redacted, truncated, and nothing else — to a small reviewer model, which
answers with one of:

- `CONTINUE` — work remains that the agent can do right now.
- `JUDGE` — it is asking the user for something more reasoning or research
  should resolve.
- `STOP` — it is genuinely done, or genuinely blocked on the user.

`CONTINUE` and `JUDGE` block the stop and send the agent back in with a few
words the reviewer writes for the occasion. The transcript is read only to
count continuations, never shown to the reviewer. Any failure — missing binary,
timeout, unparseable verdict — accepts the stop.

At most 100 continuations per owner turn. Past the cap the next stop is accepted
without a review; over the last 10 the reviewer is asked for a line about
landing what is in flight rather than starting something new. A new owner
prompt starts a fresh count.

Continuations are counted from the transcript where the host's format is known,
and otherwise from a tally the hook keeps itself under
`$XDG_STATE_HOME/keep-going`, cleared whenever a stop is allowed through. So the
cap holds on a host whose transcript cannot be read — which is also why the hook
does something useful there at all.

## Install

Requires Node.js 22+ and the host CLI (`codex`, `claude`, or `ghostd`; Ghost
also needs `ghostd hook-smol-complete`).

```bash
# Codex — then start a new session
codex plugin marketplace add ferdousbhai/keep-going
codex plugin add keep-going@keep-going

# Claude Code
claude plugin marketplace add ferdousbhai/keep-going
claude plugin install keep-going@keep-going

# Ghost, or Claude Code without the plugin: --claude, --ghost, --all
npx --yes github:ferdousbhai/keep-going --ghost
```

One route per host: the plugin and the `npx` installer each register their own
Stop hook, and a host with both runs the reviewer twice on every stop.

These track `main`, gated by `npm run check`. To pin instead, add a tag —
`--ref v0.4.0` for Codex, `#v0.4.0` for `npx`; the Claude plugin moves only when
you run `claude plugin update`.

Uninstall: `claude plugin uninstall keep-going`, or the same `npx` command with
`--uninstall`.

## Environment variables

| Variable | Default |
| --- | --- |
| `KEEP_GOING_CODEX_BIN` | `codex` |
| `KEEP_GOING_CLAUDE_BIN` | `claude` |
| `KEEP_GOING_GHOST_BIN` | `ghostd` |
| `KEEP_GOING_CODEX_MODEL` | `gpt-5.6-luna` |
| `KEEP_GOING_CLAUDE_MODEL` | `sonnet` |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision |
| `KEEP_GOING_HOME` | OS home; the installer writes under it |

Ghost's reviewer model is ghostd's, not ours.

## Upgrading from Unblock or Stop Review

0.4.0 is a clean break: `UNBLOCK_*`, `STOP_REVIEW_*`, and `CODEX_STOP_REVIEW_*`
no longer resolve — use the `KEEP_GOING_*` name. Installing 0.4.0 removes the
old registrations, so no two reviewers run on one stop.
