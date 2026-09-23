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

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLED_HOOK = path.join(
  PACKAGE_ROOT,
  "plugins",
  "keep-going",
  "scripts",
  "keep-going.mjs",
);

function usage() {
  return `Install Keep Going for Claude Code, Muse Code, Ghost, and Grok Build.

Usage:
  keep-going --claude
  keep-going --muse
  keep-going --ghost
  keep-going --grok
  keep-going --all
  keep-going --claude --link
  keep-going --all --audit-log ~/.local/state/keep-going/audit.jsonl
  keep-going --status
  keep-going --uninstall --claude|--muse|--ghost|--grok|--all

--link registers this checkout's hook instead of copying it, so edits to the
working tree take effect with no reinstall. Switching between --link and a
copy replaces the old registration rather than adding to it.

--audit-log PATH writes KEEP_GOING_AUDIT_LOG into each registered command, so
the hook appends a JSON line per decision there on hosts that scrub the
shell's environment. Reinstalling without it removes the setting.

Codex installs through the repository marketplace; see README.md.`;
}

const claudeConfigDir = (userHome) => process.env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude");

// The hosts this installer writes to, and where each keeps its hook config.
// Codex installs through the repository marketplace instead.
const TARGETS = {
  claude: ({ userHome }) => path.join(claudeConfigDir(userHome), "settings.json"),
  // Muse reads its hooks from the same settings file: a `hooks` block beside
  // schema_version. The project-level .muse/hooks.json is documented but the
  // shipping build ignores it, and managed_hooks_path names exactly one file
  // another tool may already claim — so the settings block is the install.
  muse: ({ configHome }) => path.join(configHome, "muse", "settings.json"),
  ghost: ({ configHome }) => path.join(configHome, "ghost", "hooks.json"),
  // Grok also dispatches ~/.claude/settings.json. Dual install still writes this
  // file so Grok has a native hook if that scan is off; the Claude-settings copy
  // yields on Grok when this file is present, so the reviewer runs once.
  grok: ({ userHome }) =>
    path.join(process.env.GROK_HOME || path.join(userHome, ".grok"), "hooks", "keep-going.json"),
};

// One test for "this registration is ours", shared by the report and by the
// installer that has to strip it: any command naming keep-going.mjs, not just
// one this installer wrote — a hook wired by hand to a working tree counts, and
// so does a stale one at a path the installer no longer uses. The runner is
// read off the command rather than being part of the identity, because inside
// a file this installer owns, any keep-going registration is one of ours.
function ourRunner(command) {
  if (typeof command !== "string" || !command.includes("keep-going.mjs")) return null;
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

function settingsSource(runner) {
  const read = async (paths) => {
    const file = TARGETS[runner](paths);
    const config = await readJson(file, null);
    if (config === null) return [];
    return HOSTS[runner].events.flatMap((event) =>
      registrationsIn(isJsonObject(config.hooks) ? config.hooks[event] : undefined, event, file));
  };
  read.host = runner;
  read.where = TARGETS[runner];
  return read;
}

// Claude Code plugins register hooks from their own install directory, which
// no settings file mentions, so the plugins' own manifests are read too.
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
  const features = config.split(/^\[features\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const row = { event: "Stop", where: `plugin in ${file}`, ours: true, runner: "codex" };
  if (/^\s*plugins\s*=\s*false/m.test(features)) {
    row.note = "has [features] plugins disabled, so its plugin never loads";
  }
  return [row];
}

claudePluginSource.host = "claude";
codexSource.host = "codex";
codexSource.where = codexConfig;

// Who dispatches a host's stops. Mostly its own file; Grok also dispatches
// Claude's, and Claude also dispatches its plugins'. A host whose list names
// another host is covered by it, which is the one fact --all, the note it
// prints, and the wrong-runtime warning all need.
const SOURCES = {
  claude: [settingsSource("claude"), claudePluginSource],
  muse: [settingsSource("muse")],
  ghost: [settingsSource("ghost")],
  grok: [settingsSource("grok"), settingsSource("claude")],
  codex: [codexSource],
};

// A host reached through another host's file usually runs that file's runtime,
// so the runner is worth naming when it is not the host. Grok is the exception:
// it dispatches Claude's settings but reviews with grok.
function describeWhere(ours, host) {
  return [...new Set(ours.map((hook) => {
    const reviewer = host === "grok" && hook.runner === "claude" ? "grok" : hook.runner;
    return reviewer !== host ? `${hook.where} (reviewed by ${hook.runner})` : hook.where;
  }))].join(", ");
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
        ? ["not registered", `${events.join(", ")} in ${sources.find((source) => source.host === host).where(paths)}`]
        : [missing.length ? `missing ${missing.join(", ")}` : "registered", describeWhere(ours, host)]),
    ]);

    for (const event of events) {
      const on = ours.filter((hook) => hook.event === event);
      // Grok scanning Claude's file is expected when both are installed: that
      // copy yields, so it is coverage, not a second review.
      const reviewing = on.filter((hook) =>
        !(host === "grok" && hook.runner === "claude" && on.some((other) => other.runner === "grok")));
      if (reviewing.length > 1) {
        warnings.push(`${host} has ${reviewing.length} hooks on ${event} and reviews it ${reviewing.length} times`);
      }
    }
    if (host === "grok" && ours.some((hook) => hook.runner === "claude") && !ours.some((hook) => hook.runner === "grok")) {
      warnings.push("grok is covered only through Claude's settings; --grok writes a native hook");
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

function selectedRuntimes(args) {
  const all = args.includes("--all");
  // --all includes grok even beside claude: its native file is what reviews on
  // Grok, and the Claude-settings copy yields there.
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

function installedCommand(hookFile, runner, auditLog) {
  const prefix = auditLog ? `KEEP_GOING_AUDIT_LOG=${shellQuote(auditLog)} ` : "";
  return `${prefix}${shellQuote(process.execPath)} ${shellQuote(hookFile)} ${runner}`;
}

function auditLogOption(args) {
  const index = args.indexOf("--audit-log");
  if (index === -1) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--audit-log needs a path.\n\n${usage()}`);
  // Absolute in the command: a relative path would resolve against whatever
  // directory each host runs its hooks from.
  return path.resolve(value);
}

function removeInstalledHooks(groups) {
  if (!Array.isArray(groups)) return [];
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => ourRunner(hook?.command) === null);
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return kept;
}

function updateHookConfig(config, events, command, runner, uninstall) {
  const hooks = isJsonObject(config.hooks) ? { ...config.hooks } : {};
  for (const event of events) {
    // A copy at an old path or a hand-wired hook points wherever it was put.
    // Strip them all, or the new one lands beside it and every stop is
    // reviewed twice.
    const groups = removeInstalledHooks(hooks[event]);
    if (!uninstall) {
      groups.push(hookEntry(command));
    }
    hooks[event] = groups;
  }
  const updated = { ...config, hooks };
  // Muse fails every command when schema_version is absent, so a file this
  // install creates must include it; a value already set is never overwritten.
  if (runner === "muse" && !uninstall && updated.schema_version === undefined) {
    return { schema_version: 1, ...updated };
  }
  return updated;
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
  const runtimes = selectedRuntimes(args);
  if (runtimes.length === 0) {
    throw new Error(`Select ${new Intl.ListFormat("en", { type: "disjunction" }).format([...Object.keys(TARGETS).map((name) => `--${name}`), "--all"])}.\n\n${usage()}`);
  }

  // A checkout registered with --link runs whatever it currently holds, which
  // is what anyone developing the hook wants and what a user should never get
  // by accident. Both spellings are always stripped, so switching between them
  // replaces the registration instead of leaving both to review every stop.
  const link = args.includes("--link");
  const auditLog = auditLogOption(args);
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
      process.stdout.write(
        `note: ${host} also dispatches ${coverer}'s hooks; ${host}'s own hook reviews, and the ${coverer} copy is ignored there\n`,
      );
    }
  }

  for (const runner of runtimes) {
    const settingsFile = TARGETS[runner]({ userHome, configHome });
    const config = await readJson(settingsFile, uninstall ? null : {});
    if (config === null) {
      process.stdout.write(`Removed ${runner} hook in ${settingsFile}\n`);
      continue;
    }
    await writeJsonAtomic(
      settingsFile,
      updateHookConfig(config, HOSTS[runner].events, installedCommand(hookFile, runner, auditLog), runner, uninstall),
    );
    process.stdout.write(`${uninstall ? "Removed" : "Installed"} ${runner} hook in ${settingsFile}\n`);
  }

  if (!uninstall) {
    process.stdout.write(`Reviewer ${link ? "linked from" : "installed at"} ${hookFile}\n`);
    if (auditLog) process.stdout.write(`Audit log at ${auditLog}\n`);
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
