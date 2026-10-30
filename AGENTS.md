# keep-going

A Stop hook (Codex, Claude Code, Muse, Ghost, Grok, Cursor CLI, Copilot CLI, Antigravity) and
native plugin (Pi, Oh My Pi, OpenCode) that asks a reviewer model whether a stopping agent has
work left, and answers `CONTINUE` with "Keep going." Node 22+, ESM, no runtime dependencies.

## Code index

- `src/keep-going.mjs` — the hook for every CLI host: reads the host's stop payload from stdin
  (argv[2] names the runner: `claude`, `codex`, `cursor`, ...), recovers the owner prompt from the
  host's transcript, runs the reviewer (`run*Model`, with hooks disabled so it never re-enters),
  parses the verdict, keeps the per-turn tally under `$XDG_STATE_HOME/keep-going`, writes the
  optional audit log. `REVIEW_PROMPT` is the reviewer's instructions.
- `src/pi.mjs`, `src/omp.mjs`, `src/opencode.mjs` — the Pi, Oh My Pi and OpenCode plugins.
- `scripts/hosts.mjs` — shared registration facts: `STOP_EVENTS` per host, `HOOK_TIMEOUT`,
  `hookEntry` (both the build and the installer must emit identical hook entries).
- `scripts/install.mjs` — the `npx github:ferdousbhai/keep-going --<host>` installer
  (`--link`, `--audit-log`, `--status`, `--uninstall`, `--help`); writes each host's settings file.
  Under the Arch package (a `system-package` marker beside `scripts/`) it registers the packaged
  hook in place, as `--link` does, and adds `--migrate` (re-point npx-copy hooks).
- Arch package: `packaging/aur/keep-going/PKGBUILD` (arch=any, installs the committed bundles to
  `/usr/lib/keep-going` and `/usr/bin/keep-going`; `pkgver` stamped by the build).
  `packaging/repo/` — the signed-repo `install.sh` (its `add_signed_repo` is shared byte-for-byte
  with the other products and hash-pinned) and its tests. `bin/build-package` (native, unsigned),
  `bin/arch-run` (disposable Arch chroot for CI), `bin/release` (maintainer-only signing and
  publishing), `bin/verify-release`.
- `scripts/eval.mjs` — labels the stops in local Claude Code transcripts by outcome (nudge acted
  on or declined, owner's "continue"/"yes" after a let-through stop) and, with `--replay N`,
  re-reviews a sample with the current `REVIEW_PROMPT`. Run it before and after a prompt change.
- `scripts/build.mjs` — esbuild bundles `src/*.mjs` into the shipped files, stamps
  `package.json`'s version into the plugin manifests, and writes the Codex/Claude hook configs.
- Generated, committed, do not hand-edit: `plugins/keep-going/scripts/keep-going.mjs`,
  `extensions/{keep-going,omp,opencode}.js`, `plugins/keep-going/claude-hooks.json`, the `hooks`
  field of `plugins/keep-going/.codex-plugin/plugin.json`, and the `version` fields of the
  manifests. Edit `src/` or `scripts/` and run the build.
- Manifests: `.claude-plugin/marketplace.json` + `plugins/keep-going/.claude-plugin/plugin.json`
  (Claude Code), `.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` (Codex),
  `package.json` `pi`/`omp` fields (Pi / Oh My Pi).
- `test/*.test.mjs` — unit tests (`node --test`); `test/pi.integration.mjs` needs an installed Pi.

## Commands

```sh
npm ci
npm run check      # build, then unit tests — what CI runs
npm test           # unit tests only
npm run test:pi    # end-to-end against an installed Pi with a mock provider
bash packaging/repo/test.sh && python3 packaging/repo/test_arch.py   # installer + release scripts
bin/build-package                        # the Arch package from HEAD, as a regular Arch user
```

CI (`.github/workflows/test.yml`) fails if `npm run check` leaves a diff in `extensions/`,
`plugins/keep-going/`, `.claude-plugin/marketplace.json` or the PKGBUILD: always commit the build output
together with the source change. A release tag runs that check once, from `release.yml`, and
the release is created only after it passes.

## Conventions and gotchas

- Fail open: any error, timeout, missing binary or unparseable verdict must let the stop through.
  The reviewer only decides; the nudge text is fixed.
- Never put hooks at `plugins/keep-going/hooks/hooks.json`: Codex and Claude Code both load that
  path from every plugin, so one host's hook would run on the other.
- Adding a host means: its events in `STOP_EVENTS`, a payload/transcript reader and reviewer in
  `src/keep-going.mjs`, installer support, tests, and the README's host notes.
- Release: bump `version` in `package.json`, `npm run check` (stamps the manifests), update the
  pinned-version examples in README.md, commit "Release X.Y.Z", then push an annotated tag made
  with `git tag -a --cleanup=verbatim vX.Y.Z -F notes.md` (without `--cleanup=verbatim` git
  strips the `##` headings). `.github/workflows/release.yml` tests, builds the Arch package and
  drafts the GitHub release from the tag; then `bin/release X.Y.Z` (signing key only in the
  maintainer's keyring, never CI) uploads the signed repository and `install.sh` and publishes,
  which runs `verify-release.yml`. The draft keeps `releases/latest` (the repository's Server)
  on a release that has a database. There is no npm package (`"private": true`). Do not tag,
  push or run release scripts unless asked.
