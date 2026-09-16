# keep going

A Stop hook for Codex, Claude Code, and Ghost that tells the agent to keep going
when work remains.

Jarred Sumner's input, through a day and a half of Claude subagents chasing the
Riemann hypothesis, was mostly variants of "keep going" and "believe in
yourself." This is that, on a hook.

## How it works

When the agent tries to end a turn, keep-going shows the last assistant message
— and nothing else — to a small reviewer model, which answers with one of:

- `CONTINUE` — work remains that the agent can do right now.
- `JUDGE` — it is asking the user for something more reasoning or research
  should resolve.
- `STOP` — it is genuinely done, or genuinely blocked on the user.

`CONTINUE` and `JUDGE` block the stop and send the agent back in with a line of
encouragement the reviewer writes for the occasion. The transcript is read only
to count continuations, never shown to the reviewer.

keep-going allows at most 100 continuations per owner turn. Past the cap it
accepts the next stop without a review, and over the last 10 the nudge asks the
agent to land what is in flight rather than start something new. A new owner
prompt starts a fresh count.

## Prerequisites

- Node.js 22+
- `codex`, `claude`, or `ghostd` installed locally
- Ghost only: `ghostd hook-smol-complete` support

## Install

### Codex

```bash
codex plugin marketplace add ferdousbhai/keep-going --ref v0.4.0
codex plugin add keep-going@keep-going
```

Start a new Codex session after installation.

### Claude Code

```bash
npx --yes github:ferdousbhai/keep-going#v0.4.0 --claude
```

### Ghost

```bash
npx --yes github:ferdousbhai/keep-going#v0.4.0 --ghost
```

## Environment variables

`KEEP_GOING_CODEX_BIN`, `KEEP_GOING_CLAUDE_BIN`, `KEEP_GOING_GHOST_BIN`,
`KEEP_GOING_CODEX_MODEL`, `KEEP_GOING_CLAUDE_MODEL`, `KEEP_GOING_AUDIT_LOG`, and
`KEEP_GOING_HOME`.

## Upgrading from Unblock or Stop Review

0.4.0 is a clean break. The `UNBLOCK_*`, `STOP_REVIEW_*`, and
`CODEX_STOP_REVIEW_*` variables no longer resolve — set the `KEEP_GOING_*` name
instead. Installing 0.4.0 still removes the hook registrations the earlier
names left behind, so an upgrade does not leave two reviewers running on every
stop.
