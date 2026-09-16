# keep going

A Stop hook for Codex, Claude Code, Ghost, and Grok that tells the agent to keep
going when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

![Three stops, three verdicts: work left, a question it can answer itself, and
a turn that is genuinely done](docs/keep-going.gif)

Those three lines are real reviewer output, not mock-ups; `scripts/render-demo.py`
redraws the image from them.

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

Continuations are counted from the stop payload wherever it says which turn it
belongs to: the hook keeps its own tally per session and turn under
`$XDG_STATE_HOME/keep-going`, or inside the ghost home for Ghost. So the cap
holds on a host whose transcript cannot be read — which is also why the hook
does something useful there at all. A plain Claude Code stop names no turn, so
there the count comes from the transcript, read for that and nothing else.

On Claude Code it reviews subagents too, on the same terms: a subagent that
quits with work left is the failure this hook is named for. A subagent stop
names the agent it came from and carries its parent's session, so each subagent
gets its own count of 100 and spends none of the turn that launched it.

## Install

Requires Node.js 22+ and the host CLI (`codex`, `claude`, `ghostd`, or `grok`;
Ghost also needs `ghostd hook-smol-complete`).

```bash
# Codex — then start a new session
codex plugin marketplace add ferdousbhai/keep-going
codex plugin add keep-going@keep-going

# Claude Code — registers Stop and SubagentStop
claude plugin marketplace add ferdousbhai/keep-going
claude plugin install keep-going@keep-going

# Ghost, Grok Build, or Claude Code without the plugin
npx --yes github:ferdousbhai/keep-going --ghost   # --claude, --grok, --all
```

`--all` covers every host that needs a hook of its own, which leaves Grok out
when Claude is installed: Grok dispatches Claude's settings, so registering
both reviews every Grok stop twice. Asking for `--grok` explicitly still does
it, and says so.

Grok Build needs `--grok` **only** if keep-going is not already in
`~/.claude/settings.json`. Grok reads that file and dispatches what it finds
there, so a Claude Code install already covers Grok — reviewed by `claude`,
which a Grok-only machine may not have. `--grok` writes a hook to
`~/.grok/hooks/keep-going.json` that is reviewed by `grok --single` instead.
Install both and Grok runs the reviewer twice on every stop.

One route per host: the plugin and the `npx` installer each register their own
Stop hook, and a host with both runs the reviewer twice on every stop.

These track `main`, gated by `npm run check`. To pin instead, add a git tag —
`--ref v0.4.0` for Codex, `#v0.4.0` for `npx`; the Claude plugin moves only when
you run `claude plugin update`. There is no npm package.

Working on keep-going itself: `node scripts/install.mjs --claude --ghost --link`
registers this checkout rather than copying it, so edits take effect with no
reinstall. Switching between `--link` and a copy replaces the registration
instead of adding a second one.

`npx --yes github:ferdousbhai/keep-going --status` prints where keep-going is
registered on this machine, for all four hosts — settings files and Claude Code
plugins alike — naming any event a host is missing, listing any other plugin
that also runs on the same stop, and warning when one host is wired to review
a stop twice.

Uninstall: `claude plugin uninstall keep-going`, or the same `npx` command with
`--uninstall`.

## Environment variables

| Variable | Default |
| --- | --- |
| `KEEP_GOING_CODEX_BIN` | `codex` |
| `KEEP_GOING_CLAUDE_BIN` | `claude` |
| `KEEP_GOING_GHOST_BIN` | `ghostd` |
| `KEEP_GOING_GROK_BIN` | `grok` |
| `KEEP_GOING_CODEX_MODEL` | unset; codex is run without `--model`, so it picks |
| `KEEP_GOING_CLAUDE_MODEL` | unset; claude is run without `--model`, so it picks |
| `KEEP_GOING_GROK_MODEL` | unset; grok is run without `--model`, so it picks |
| `KEEP_GOING_AUDIT_LOG` | unset; a path appends one JSON line per decision, saying which mechanism capped the turn |
| `KEEP_GOING_HOME` | OS home; the installer writes under it |

No host is given a model it did not choose: the reviewer runs on whatever
that CLI is configured to use unless the variable above names one. Ghost's
reviewer model is ghostd's, not ours.

## Upgrading from Unblock or Stop Review

0.4.0 is a clean break: `UNBLOCK_*`, `STOP_REVIEW_*`, and `CODEX_STOP_REVIEW_*`
no longer resolve — use the `KEEP_GOING_*` name. Installing 0.4.0 removes the
old registrations, so no two reviewers run on one stop.
