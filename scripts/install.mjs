#!/usr/bin/env node

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { HOSTS, hookEntry } from "./hosts.mjs";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_HOOK = path.join(
  PACKAGE_ROOT,
  "plugins",
  "keep-going",
  "scripts",
  "keep-going.mjs",
);

function usage() {
  return `Install Keep Going for Claude Code, Ghost, and Grok Build.

Usage:
  keep-going --claude
  keep-going --ghost
  keep-going --grok
  keep-going --all
  keep-going --claude --link
  keep-going --status
  keep-going --uninstall --claude|--ghost|--grok|--all

--link registers this checkout's hook instead of copying it, so edits to the
working tree take effect with no reinstall. Switching between --link and a
copy replaces the old registration rather than adding to it.

Codex installs through the repository marketplace; see README.md.`;
}

const claudeConfigDir = (userHome) => process.env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude");

// The hosts this installer writes to, and where each keeps its hook config.
// Codex installs through the repository marketplace instead.
const TARGETS = {
  claude: {
    settings: ({ userHome }) => path.join(claudeConfigDir(userHome), "settings.json"),
  },
  ghost: {
    settings: ({ configHome }) => path.join(configHome, "ghost", "hooks.json"),
  },
  // Grok dispatches what it finds in ~/.claude/settings.json through its Claude
  // compatibility layer, so a Claude install already covers it — reviewed by
  // claude, which a Grok-only machine may not have. This registration is for
  // that machine, and installing both makes Grok review every stop twice.
  grok: {
    settings: ({ userHome }) =>
      path.join(process.env.GROK_HOME || path.join(userHome, ".grok"), "hooks", "keep-going.json"),
  },
};

// Any keep-going registration, not just one this installer wrote: a hook wired
// by hand to a working tree counts, and so does a stale one left at a path the
// installer no longer uses. Matching the script name rather than a known path
// is the point.
const OUR_SCRIPTS = ["keep-going.mjs", "unblock.mjs", "stop-review.mjs"];

// One test for "this registration is ours", shared by the report and by the
// installer that has to strip it. They were two expressions that agreed by
// coincidence and then stopped: a hook left pointing at the wrong runner was
// counted as a duplicate by one and preserved forever by the other, and a
// hook under an older script name was filed as somebody else's. The runner is
// read off the command rather than being part of the identity, because inside
// a file this installer owns, any keep-going registration is one of ours.
function ourRunner(command) {
  if (typeof command !== "string" || !OUR_SCRIPTS.some((script) => command.includes(script))) return null;
  return command.trimEnd().split(/\s+/).at(-1);
}

function registrationsIn(groups, event, where) {
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => (typeof hook?.command === "string" ? hook.command : ""))
    .filter(Boolean)
    .map((command) => {
      const runner = ourRunner(command);
      return { event, where, command, ours: runner !== null, runner };
    });
}

// Where a host looks for hooks. Mostly its own settings file — but Grok also
// dispatches Claude's, and Claude also dispatches its plugins' — so "who
// dispatches this stop" is a list per host rather than one path, and
// "covered by another host's file" stops being a special case.
function settingsSource(runner) {
  const read = async (paths) => {
    const file = TARGETS[runner].settings(paths);
    const config = await readJson(file, null);
    if (config === null) return [];
    return HOSTS[runner].events.flatMap((event) =>
      registrationsIn(isJsonObject(config.hooks) ? config.hooks[event] : undefined, event, file));
  };
  read.host = runner;
  read.where = (paths) => TARGETS[runner].settings(paths);
  return read;
}

// Claude Code plugins register hooks from their own install directory, which
// no settings file mentions — so a keep-going installed that way looked
// unregistered, and every other plugin's Stop hook was invisible.
async function claudePluginSource(paths) {
  const root = path.join(claudeConfigDir(paths.userHome), "plugins");
  const installed = await readJson(path.join(root, "installed_plugins.json"), null);
  if (!isJsonObject(installed?.plugins)) return [];
  const found = [];
  for (const [name, entries] of Object.entries(installed.plugins)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.installPath !== "string") continue;
      const manifest = await readJson(path.join(entry.installPath, ".claude-plugin", "plugin.json"), {});
      const declared = typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json";
      const config = await readJson(path.join(entry.installPath, declared), null);
      if (!isJsonObject(config?.hooks)) continue;
      for (const [event, groups] of Object.entries(config.hooks)) {
        // A plugin's hooks are Claude's, so Claude's events are the ones that
        // share a stop with ours.
        if (HOSTS.claude.events.includes(event)) found.push(...registrationsIn(groups, event, `plugin ${name}`));
      }
    }
  }
  return found;
}

// Codex installs through a marketplace, so its registration is a config entry
// rather than a hook command; it reports as one registration all the same.
const codexConfig = (paths) =>
  path.join(process.env.CODEX_HOME || path.join(paths.userHome, ".codex"), "config.toml");

async function codexSource(paths) {
  const file = codexConfig(paths);
  const config = await readFile(file, "utf8").catch(() => "");
  if (!/\[plugins\."keep-going@[^"]+"\]\s*\nenabled\s*=\s*true/.test(config)) return [];
  // Only the [features] table decides this, and only when it says so: the key
  // is absent by default and the literal appears elsewhere in the file.
  const features = /^\[features\]$([\s\S]*?)(?=^\[|\Z)/m.exec(config)?.[1] ?? "";
  const row = { event: "Stop", where: `plugin in ${file}`, ours: true, runner: "codex" };
  if (/^\s*plugins\s*=\s*false/m.test(features)) {
    row.note = "has [features] plugins disabled, so its plugin never loads";
  }
  return [row];
}

claudePluginSource.host = "claude";
claudePluginSource.where = (paths) => path.join(claudeConfigDir(paths.userHome), "plugins");
codexSource.host = "codex";
codexSource.where = (paths) => codexConfig(paths);

// Who dispatches a host's stops. Mostly its own file; Grok also dispatches
// Claude's, and Claude also dispatches its plugins'. A host whose list names
// another host is covered by it, which is the one fact --all, the note it
// prints, and the wrong-runtime warning all need.
const SOURCES = {
  claude: [settingsSource("claude"), claudePluginSource],
  ghost: [settingsSource("ghost")],
  grok: [settingsSource("grok"), settingsSource("claude")],
  codex: [codexSource],
};

// A host reached through another host's file runs that host's runtime, so the
// runner is worth naming exactly when it is not the obvious one.
function describeWhere(ours, host) {
  return [...new Set(ours.map((hook) =>
    hook.runner && hook.runner !== host ? `${hook.where} (reviewed by ${hook.runner})` : hook.where))].join(", ");
}

async function reportStatus(paths) {
  const rows = [];
  const warnings = [];
  for (const [host, sources] of Object.entries(SOURCES)) {
    const all = (await Promise.all(sources.map((source) => source(paths)))).flat();
    const ours = all.filter((hook) => hook.ours);
    const events = HOSTS[host].events;
    const missing = events.filter((event) => !ours.some((hook) => hook.event === event));
    rows.push([
      host,
      ...(ours.length === 0
        ? ["not registered", `${events.join(", ")} in ${SOURCES[host].find((source) => source.host === host).where(paths)}`]
        : [missing.length ? `missing ${missing.join(", ")}` : "registered", describeWhere(ours, host)]),
    ]);

    for (const event of events) {
      const on = ours.filter((hook) => hook.event === event);
      if (on.length > 1) warnings.push(`${host} has ${on.length} hooks on ${event} and reviews it ${on.length} times`);
    }
    if (missing.length && ours.length) {
      warnings.push(`${host} is not registered for ${missing.join(", ")}; re-run the installer to add it`);
    }
    const wrong = ours.find((hook) => hook.runner !== host && hook.runner !== coveredBy(host));
    if (wrong) warnings.push(`${host} is registered to run the ${wrong.runner} runtime`);
    for (const hook of ours) if (hook.note) warnings.push(`${host} ${hook.note}`);
    // Everything else on the same stop, named under the host that runs it.
    for (const hook of all.filter((hook) => !hook.ours)) {
      rows.push([host, "also runs", `${hook.event} from ${hook.where}`]);
    }
  }

  const width = Math.max(...rows.map((row) => row[1].length));
  return [
    ...rows.map(([host, state, where]) => `  ${host.padEnd(7)}${state.padEnd(width + 2)}${where}`),
    ...warnings.map((warning) => `  ! ${warning}`),
  ].join("\n");
}

const coveredBy = (host) => SOURCES[host].find((source) => source.host !== host)?.host ?? null;

function selectedRuntimes(args, uninstall) {
  const all = args.includes("--all");
  const chosen = Object.keys(TARGETS).filter((name) => all || args.includes(`--${name}`));
  // A host another host already dispatches for needs no hook of its own, and
  // registering both reviews every stop twice — which --all used to produce
  // and --status then reported as a fault. Removal still means all of them: an
  // --all uninstall has to reach a hook an older --all install wrote.
  if (!all || uninstall) return chosen;
  return chosen.filter((host) => !chosen.includes(coveredBy(host)));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!isJsonObject(value)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function installedCommand(hookFile, runner) {
  return `${shellQuote(process.execPath)} ${shellQuote(hookFile)} ${runner}`;
}

// --status counts any command naming this hook; the installer used to strip
// only the exact paths it knew, so a hand-wired hook at another checkout was
// reported as a duplicate the tool could not remove. Same predicate now.
function isInstalledHook(hook) {
  return ourRunner(hook?.command) !== null;
}

function removeInstalledHooks(groups) {
  if (!Array.isArray(groups)) return [];
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isInstalledHook(hook));
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return kept;
}

function updateHookConfig(config, events, hookFile, runner, uninstall) {
  const hooks = isJsonObject(config.hooks) ? { ...config.hooks } : {};
  for (const event of events) {
    // Earlier releases installed under different names, and a hand-wired hook
    // points wherever its author chose. Strip them all, or an upgrade leaves
    // one beside the new one and the reviewer runs twice on every stop.
    const groups = removeInstalledHooks(hooks[event]);
    if (!uninstall) {
      groups.push(hookEntry(installedCommand(hookFile, runner)));
    }
    hooks[event] = groups;
  }
  return { ...config, hooks };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const userHome = process.env.KEEP_GOING_HOME || homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(userHome, ".local", "share");
  const configHome = process.env.XDG_CONFIG_HOME || path.join(userHome, ".config");
  if (args.includes("--status")) {
    process.stdout.write(`${await reportStatus({ userHome, configHome })}\n`);
    return;
  }

  const uninstall = args.includes("--uninstall");
  const runtimes = selectedRuntimes(args, uninstall);
  if (runtimes.length === 0) {
    throw new Error(`Select ${new Intl.ListFormat("en", { type: "disjunction" }).format([...Object.keys(TARGETS).map((name) => `--${name}`), "--all"])}.\n\n${usage()}`);
  }

  // A checkout registered with --link runs whatever it currently holds, which
  // is what anyone developing the hook wants and what a user should never get
  // by accident. Both spellings are always stripped, so switching between them
  // replaces the registration instead of leaving both to review every stop.
  const link = args.includes("--link");
  const copiedHook = path.join(dataHome, "keep-going", "keep-going.mjs");
  const hookFile = link ? BUNDLED_HOOK : copiedHook;

  if (!uninstall && !link) {
    await mkdir(path.dirname(hookFile), { recursive: true });
    await copyFile(BUNDLED_HOOK, hookFile);
    await chmod(hookFile, 0o755);
  }

  for (const host of uninstall ? [] : runtimes) {
    const coverer = coveredBy(host);
    if (runtimes.includes(coverer)) {
      process.stdout.write(`note: ${host} also dispatches ${coverer}'s hooks, so it will review every stop twice\n`);
    }
  }

  for (const runner of runtimes) {
    const { settings } = TARGETS[runner];
    const settingsFile = settings({ userHome, configHome });
    const config = await readJson(settingsFile, uninstall ? null : {});
    if (config === null) {
      process.stdout.write(`Removed ${runner} hook in ${settingsFile}\n`);
      continue;
    }
    await writeJsonAtomic(
      settingsFile,
      updateHookConfig(config, HOSTS[runner].events, hookFile, runner, uninstall),
    );
    process.stdout.write(`${uninstall ? "Removed" : "Installed"} ${runner} hook in ${settingsFile}\n`);
  }

  if (!uninstall) {
    process.stdout.write(`Reviewer ${link ? "linked from" : "installed at"} ${hookFile}\n`);
  }
}

// Piping this into head closes stdout early; a CLI reporting where it wrote
// hooks should not answer that with a stack trace.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

main().catch((error) => {
  process.stderr.write(`keep-going: ${error.message}\n`);
  process.exitCode = 1;
});
