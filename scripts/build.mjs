#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { HOSTS, hookEntry } from "./hosts.mjs";

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

// Both hosts run the same bundle, and the two files differ only in the root
// variable, the trailing runner word, and the events each host dispatches. Neither host substitutes the other's
// variable, so a copy-paste between them fails open on every stop of whichever
// host got the wrong one; writing both from here removes the copy-paste.
export const HOOK_FILES = {
  codex: { file: "plugins/keep-going/hooks/hooks.json", pluginRoot: "$PLUGIN_ROOT" },
  claude: { file: "plugins/keep-going/claude-hooks.json", pluginRoot: "${CLAUDE_PLUGIN_ROOT}" },
};

export function hookFile(runner) {
  const { pluginRoot } = HOOK_FILES[runner];
  const entry = [hookEntry(`node "${pluginRoot}/scripts/keep-going.mjs" ${runner}`)];
  const config = { hooks: Object.fromEntries(HOSTS[runner].events.map((event) => [event, entry])) };
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function emit() {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const relative of VERSIONED) {
    const file = path.join(root, relative);
    await writeFile(file, stampVersion(await readFile(file, "utf8"), version));
  }
  for (const runner of Object.keys(HOOK_FILES)) {
    await writeFile(path.join(root, HOOK_FILES[runner].file), hookFile(runner));
  }
}

// The test imports the definitions above to prove the committed files still
// match them, so building only happens when this file is the entrypoint.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "none",
  };
  await Promise.all([
    build({ ...options, entryPoints: [path.join(root, "src", "keep-going.mjs")], outfile: bundle }),
    build({ ...options, entryPoints: [path.join(root, "src", "pi.mjs")], outfile: path.join(root, "extensions", "keep-going.js") }),
  ]);
  await chmod(bundle, 0o755);
  await emit();
}
