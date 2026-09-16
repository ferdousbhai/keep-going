# Unblock

A Stop hook for Codex, Claude Code, and Ghost that continues a turn when work
remains.

## Prerequisites

When the agent asks the user for input that more reasoning or research should
resolve, Unblock tells it to keep working instead of stopping.

Unblock permits at most 20 automatic continuations for one owner turn.
After the cap is reached, it accepts the next stop without another review. A
new owner prompt starts a fresh count.

- Node.js 22+
- `codex`, `claude`, or `ghostd` installed locally
- Ghost only: `ghostd hook-smol-complete` support

## Install

### Codex

```bash
codex plugin marketplace add ferdousbhai/unblock --ref v0.3.0
codex plugin add unblock@unblock
```

Start a new Codex session after installation.

### Claude Code

```bash
npx --yes github:ferdousbhai/unblock#v0.3.0 --claude
```

### Ghost

```bash
npx --yes github:ferdousbhai/unblock#v0.3.0 --ghost
```

## Environment variables

`UNBLOCK_CODEX_BIN`, `UNBLOCK_CLAUDE_BIN`, `UNBLOCK_GHOST_BIN`,
`UNBLOCK_CODEX_MODEL`, `UNBLOCK_CLAUDE_MODEL`, `UNBLOCK_AUDIT_LOG`, and
`UNBLOCK_HOME`.

The project was called Stop Review before 0.3.0. Every variable still resolves
under its old `STOP_REVIEW_*` name, and the bin overrides also still accept the
older `CODEX_STOP_REVIEW_*` spelling, so an existing install keeps working.
Installing 0.3.0 over an older one also removes the previous hook registration,
which named a different path.
