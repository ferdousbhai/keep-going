# Stop Review

A Stop hook for Codex, Claude Code, and Ghost that continues a turn when work
remains.

## Prerequisites

When the agent asks the user for input that more reasoning or research should
unblock, Stop Review tells it to keep working instead of stopping.

Stop Review permits at most 20 automatic continuations for one owner turn.
After the cap is reached, it accepts the next stop without another review. A
new owner prompt starts a fresh count.

- Node.js 22+
- `codex`, `claude`, or `ghostd` installed locally
- Ghost only: `ghostd hook-smol-complete` support

## Install

### Codex

```bash
codex plugin marketplace add ferdousbhai/stop-review --ref v0.1.1
codex plugin add stop-review@stop-review
```

Start a new Codex session after installation.

### Claude Code

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.1 --claude
```

### Ghost

```bash
npx --yes github:ferdousbhai/stop-review#v0.1.1 --ghost
```
