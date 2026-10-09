#!/usr/bin/env node

import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { STOP_EVENTS, hookEntry } from "./hosts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bundle = path.join(root, "plugins", "keep-going", "scripts", "keep-going.mjs");

// The manifests stay hand-written — description, keywords, category and the
// interface copy are human-facing text a generator would only flatten — so the
// build owns one field of each, so a release edits the version once.
export const VERSIONED = [
  "plugins/keep-going/.codex-plugin/plugin.json",
  "plugins/keep-going/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

// Every "version" in those files names the release. A manifest that ever needs
// some other kind of version has to come off VERSIONED first.
const VERSION_FIELD = /("version"\s*:\s*)"[^"]*"/g;

export function stampVersion(source, version) {
  if (source.search(VERSION_FIELD) < 0) throw new Error("manifest declares no version to stamp");
  return source.replace(VERSION_FIELD, (_, prefix) => `${prefix}"${version}"`);
}

// Both hosts run the same bundle, and their hooks differ only in the root
// variable, the trailing runner word, and the events each host dispatches. Neither host substitutes the other's
// variable, so a copy-paste between them fails open on every stop of whichever
// host got the wrong one; writing both from here removes the copy-paste.
//
// Neither may sit at hooks/hooks.json: Codex and Claude Code both load that
// file from every plugin, whatever the manifest names, so a hook there runs on
// both hosts. Codex's goes inline in its manifest, Claude's in the file its
// manifest names.
export const HOOK_FILES = {
  codex: { file: "plugins/keep-going/.codex-plugin/plugin.json", pluginRoot: "$PLUGIN_ROOT", inline: true },
  claude: { file: "plugins/keep-going/claude-hooks.json", pluginRoot: "${CLAUDE_PLUGIN_ROOT}" },
};

export function hookConfig(runner) {
  const { pluginRoot } = HOOK_FILES[runner];
  const entry = [hookEntry(`node "${pluginRoot}/scripts/keep-going.mjs" ${runner}`)];
  return { hooks: Object.fromEntries(STOP_EVENTS[runner].map((event) => [event, entry])) };
}

// The file's text with the runner's hooks in it: the whole file, or for an
// inline host its manifest (`current`) with the `hooks` field replaced.
export function hookFile(runner, current) {
  const config = HOOK_FILES[runner].inline ? { ...JSON.parse(current), hooks: hookConfig(runner) } : hookConfig(runner);
  return `${JSON.stringify(config, null, 2)}\n`;
}

// The test imports the definitions above to prove the committed files still
// match them, so building only happens when this file is the entrypoint.
if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  const outputs = { "keep-going": bundle, pi: "extensions/keep-going.js", opencode: "extensions/opencode.js", omp: "extensions/omp.js" };
  await Promise.all(Object.entries(outputs).map(([source, out]) => build({
    entryPoints: [path.join(root, "src", `${source}.mjs`)],
    outfile: path.resolve(root, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "none",
  })));
  await chmod(bundle, 0o755);
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const relative of VERSIONED) {
    const file = path.join(root, relative);
    await writeFile(file, stampVersion(await readFile(file, "utf8"), version));
  }
  for (const [runner, { file, inline }] of Object.entries(HOOK_FILES)) {
    const target = path.join(root, file);
    await writeFile(target, hookFile(runner, inline ? await readFile(target, "utf8") : undefined));
  }
}
