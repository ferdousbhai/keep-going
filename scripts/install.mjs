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

import { HOOK_TIMEOUT, HOSTS, STATUS_MESSAGE } from "./hosts.mjs";
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
    // A Stop registration is rewritten to SubagentStop only for hooks a session
    // registers at runtime, so a settings.json Stop hook never sees a subagent
    // and the event has to be asked for by name.
    events: HOSTS.claude.events,
    settings: ({ userHome }) => path.join(claudeConfigDir(userHome), "settings.json"),
  },
  ghost: {
    events: HOSTS.ghost.events,
    settings: ({ configHome }) => path.join(configHome, "ghost", "hooks.json"),
  },
  // Grok dispatches what it finds in ~/.claude/settings.json through its Claude
  // compatibility layer, so a Claude install already covers it — reviewed by
  // claude, which a Grok-only machine may not have. This registration is for
  // that machine, and installing both makes Grok review every stop twice.
  grok: {
    events: HOSTS.grok.events,
    settings: ({ userHome }) =>
      path.join(process.env.GROK_HOME || path.join(userHome, ".grok"), "hooks", "keep-going.json"),
  },
};

// Any keep-going registration, not just one this installer wrote: a hook wired
// by hand to a working tree counts, and so does a stale one left at a path the
// installer no longer uses. Matching the script name rather than a known path
// is the point.
const OURS = /keep-going\.mjs["']?\s+\S+\s*$/;

function registrationsIn(groups, event, where) {
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => (typeof hook?.command === "string" ? hook.command : ""))
    .filter(Boolean)
    .map((command) => ({
      event,
      where,
      command,
      ours: OURS.test(command),
      runner: command.trimEnd().split(/\s+/).at(-1),
    }));
}

// The events that end a turn. A hook on one of these shares the stop with
// ours, whoever wrote it, which is the only reason to report other people's.
const STOP_EVENTS = new Set(["Stop", "SubagentStop", "session_stop"]);

// Where a host looks for hooks. Mostly its own settings file — but Grok also
// dispatches Claude's, and Claude also dispatches its plugins' — so "who
// dispatches this stop" is a list per host rather than one path, and
// "covered by another host's file" stops being a special case.
function settingsSource(runner) {
  return async (paths) => {
    const file = TARGETS[runner].settings(paths);
    const config = await readJson(file, null);
    if (config === null) return [];
    return HOSTS[runner].events.flatMap((event) =>
      registrationsIn(isJsonObject(config.hooks) ? config.hooks[event] : undefined, event, file));
  };
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
        if (STOP_EVENTS.has(event)) found.push(...registrationsIn(groups, event, `plugin ${name}`));
      }
    }
  }
  return found;
}

// Codex installs through a marketplace, so its registration is a config entry
// rather than a hook command; it reports as one registration all the same.
async function codexSource(paths) {
  const file = path.join(process.env.CODEX_HOME || path.join(paths.userHome, ".codex"), "config.toml");
  const config = await readFile(file, "utf8").catch(() => "");
  if (!/\[plugins\."keep-going@[^"]+"\]\s*\nenabled\s*=\s*true/.test(config)) return [];
  // Only the [features] table decides this, and only when it says so: the key
  // is absent by default and the literal appears elsewhere in the file.
  const features = /^\[features\]$([\s\S]*?)(?=^\[|\Z)/m.exec(config)?.[1] ?? "";
  const loads = !/^\s*plugins\s*=\s*false/m.test(features);
  return [{ event: "Stop", where: `plugin in ${file}`, command: "", ours: true, runner: "codex", loads }];
}

const SOURCES = {
  claude: [settingsSource("claude"), claudePluginSource],
  ghost: [settingsSource("ghost")],
  grok: [settingsSource("grok"), settingsSource("claude")],
  codex: [codexSource],
};

async function reportStatus(paths) {
  const rows = [];
  const warnings = [];
  for (const [host, sources] of Object.entries(SOURCES)) {
    const all = (await Promise.all(sources.map((source) => source(paths)))).flat();
    const ours = all.filter((hook) => hook.ours);
    const events = HOSTS[host].events;
    const missing = events.filter((event) => !ours.some((hook) => hook.event === event));
    // A host reached through another host's file runs that host's runtime, so
    // the runner is worth naming exactly when it is not the obvious one.
    const where = [...new Set(ours.map((hook) =>
      hook.runner && hook.runner !== host ? `${hook.where} (reviewed by ${hook.runner})` : hook.where))].join(", ");

    rows.push([
      host,
      ours.length === 0 ? "not registered" : missing.length ? `missing ${missing.join(", ")}` : "registered",
      ours.length === 0 ? `${events.join(", ")} in ${TARGETS[host]?.settings(paths) ?? "its own config"}` : where,
    ]);

    for (const event of events) {
      const on = ours.filter((hook) => hook.event === event);
      if (on.length > 1) warnings.push(`${host} has ${on.length} hooks on ${event} and reviews it ${on.length} times`);
    }
    if (missing.length && ours.length) {
      warnings.push(`${host} is not registered for ${missing.join(", ")}; re-run the installer to add it`);
    }
    const wrong = ours.find((hook) => hook.runner !== host && hook.command);
    if (wrong && host !== "grok") warnings.push(`${host} is registered to run the ${wrong.runner} runtime`);
    if (ours.some((hook) => hook.loads === false)) {
      warnings.push(`${host} has [features] plugins disabled, so its plugin never loads`);
    }
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

function selectedRuntimes(args) {
  const all = args.includes("--all");
  return Object.keys(TARGETS).filter((name) => all || args.includes(`--${name}`));
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
function isInstalledHook(hook, scripts, runner) {
  return typeof hook?.command === "string" &&
    scripts.some((script) => hook.command.includes(script)) &&
    hook.command.trimEnd().endsWith(` ${runner}`);
}

function removeInstalledHooks(groups, hookFiles, runner) {
  if (!Array.isArray(groups)) return [];
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isInstalledHook(hook, hookFiles, runner));
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return kept;
}

function updateHookConfig(config, events, hookFile, runner, uninstall, knownScripts) {
  const hooks = isJsonObject(config.hooks) ? { ...config.hooks } : {};
  for (const event of events) {
    // Earlier releases installed under different names, and a hand-wired hook
    // points wherever its author chose. Strip them all, or an upgrade leaves
    // one beside the new one and the reviewer runs twice on every stop.
    const groups = removeInstalledHooks(hooks[event], knownScripts, runner);
    if (!uninstall) {
      groups.push({
        hooks: [{
          type: "command",
          command: installedCommand(hookFile, runner),
          timeout: 240,
          statusMessage: STATUS_MESSAGE,
        }],
      });
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

  const runtimes = selectedRuntimes(args);
  if (runtimes.length === 0) {
    throw new Error(`Select ${new Intl.ListFormat("en", { type: "disjunction" }).format([...Object.keys(TARGETS).map((name) => `--${name}`), "--all"])}.\n\n${usage()}`);
  }

  const uninstall = args.includes("--uninstall");
  // A checkout registered with --link runs whatever it currently holds, which
  // is what anyone developing the hook wants and what a user should never get
  // by accident. Both spellings are always stripped, so switching between them
  // replaces the registration instead of leaving both to review every stop.
  const link = args.includes("--link");
  const copiedHook = path.join(dataHome, "keep-going", "keep-going.mjs");
  const hookFile = link ? BUNDLED_HOOK : copiedHook;
  // Names rather than paths: one keep-going registration per host per event,
  // wherever it points — a copy, this checkout, or another one entirely.
  const knownScripts = ["keep-going.mjs", "unblock.mjs", "stop-review.mjs"];

  if (!uninstall && !link) {
    await mkdir(path.dirname(hookFile), { recursive: true });
    await copyFile(BUNDLED_HOOK, hookFile);
    await chmod(hookFile, 0o755);
  }

  for (const runner of runtimes) {
    const { events, settings } = TARGETS[runner];
    const settingsFile = settings({ userHome, configHome });
    const config = await readJson(settingsFile, uninstall ? null : {});
    if (config === null) {
      process.stdout.write(`Removed ${runner} hook in ${settingsFile}\n`);
      continue;
    }
    await writeJsonAtomic(
      settingsFile,
      updateHookConfig(config, events, hookFile, runner, uninstall, knownScripts),
    );
    process.stdout.write(`${uninstall ? "Removed" : "Installed"} ${runner} hook in ${settingsFile}\n`);
  }

  if (!uninstall) {
    process.stdout.write(`Reviewer ${link ? "linked from" : "installed at"} ${hookFile}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`keep-going: ${error.message}\n`);
  process.exitCode = 1;
});
