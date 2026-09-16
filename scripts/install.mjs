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
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_HOOK = path.join(
  PACKAGE_ROOT,
  "plugins",
  "keep-going",
  "scripts",
  "keep-going.mjs",
);
const STATUS_MESSAGE = "Deciding whether to keep going";

function usage() {
  return `Install Keep Going for Claude Code, Ghost, and Grok Build.

Usage:
  keep-going --claude
  keep-going --ghost
  keep-going --grok
  keep-going --all
  keep-going --status
  keep-going --uninstall --claude|--ghost|--grok|--all

Codex installs through the repository marketplace; see README.md.`;
}

// The hosts this installer writes to, and where each keeps its hook config.
// Codex installs through the repository marketplace instead.
const TARGETS = {
  claude: {
    events: ["Stop"],
    settings: ({ userHome }) =>
      path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude"), "settings.json"),
  },
  ghost: {
    events: ["session_stop"],
    settings: ({ configHome }) => path.join(configHome, "ghost", "hooks.json"),
  },
  // Grok's Claude compatibility layer reads ~/.claude/settings.json and lists
  // a Stop hook found there as enabled — and never dispatches it. Only hooks
  // in Grok's own directory are dispatched, so that is where this one goes,
  // and a Claude install alone buys nothing under Grok.
  grok: {
    events: ["Stop"],
    settings: ({ userHome }) =>
      path.join(process.env.GROK_HOME || path.join(userHome, ".grok"), "hooks", "keep-going.json"),
  },
};

// Any keep-going registration, not just one this installer wrote: a hook wired
// by hand to a working tree counts, and so does a stale one left at a path the
// installer no longer uses. Matching the script name rather than a known path
// is the point.
function registrationsIn(config, event) {
  const groups = isJsonObject(config.hooks) ? config.hooks[event] : undefined;
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => (typeof hook?.command === "string" ? hook.command : ""))
    .filter((command) => command.includes("keep-going.mjs"))
    .map((command) => ({ command, runner: command.trimEnd().split(/\s+/).at(-1) }));
}

async function reportStatus(paths) {
  const rows = [];
  const warnings = [];
  const found = {};
  for (const [runner, { events, settings }] of Object.entries(TARGETS)) {
    const file = settings(paths);
    const config = await readJson(file, null);
    const hooks = config === null ? [] : events.flatMap((event) => registrationsIn(config, event));
    found[runner] = hooks;
    const wrong = hooks.find((hook) => hook.runner !== runner);
    rows.push([
      runner,
      hooks.length === 0 ? "not registered" : hooks.length > 1 ? `${hooks.length} registrations` : "registered",
      `${events.join("+")} in ${file}`,
    ]);
    if (hooks.length > events.length) {
      warnings.push(`${runner} has ${hooks.length} registrations for ${events.length} event(s) and reviews stops more than once`);
    }
    if (wrong) warnings.push(`${runner} is registered to run the ${wrong.runner} runtime`);
  }

  // Grok dispatches what it finds in Claude's settings, which is both why it
  // needs no hook of its own and why two hooks are one too many. Reporting the
  // file alone would call a covered Grok unregistered.
  if (found.claude?.length && found.grok?.length) {
    warnings.push("grok reads Claude's settings too, so it reviews every stop twice; drop the --grok hook");
  } else if (found.claude?.length && !found.grok?.length) {
    const grok = rows.find((row) => row[0] === "grok");
    grok[1] = "covered";
    grok[2] = "by Claude's settings, reviewed by claude";
  }

  // Codex is the one host this installer does not write to; leaving it out
  // would read as "not installed" rather than "installed elsewhere".
  const codexConfig = path.join(process.env.CODEX_HOME || path.join(paths.userHome, ".codex"), "config.toml");
  const codex = await readFile(codexConfig, "utf8").catch(() => "");
  const enabled = /\[plugins\."keep-going@[^"]+"\]\s*\nenabled\s*=\s*true/.test(codex);
  rows.push(["codex", enabled ? "registered" : "not registered", `plugin in ${codexConfig}`]);
  if (enabled && !/\bplugins\s*=\s*true/.test(codex)) {
    warnings.push("codex has [features] plugins disabled, so its plugin never loads");
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

function isInstalledHook(hook, hookFile, runner) {
  return typeof hook?.command === "string" &&
    hook.command.includes(shellQuote(hookFile)) &&
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
    const hooks = group.hooks.filter(
      (hook) => !hookFiles.some((file) => isInstalledHook(hook, file, runner)),
    );
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return kept;
}

function updateHookConfig(config, events, hookFile, runner, uninstall, legacyHookFiles) {
  const hooks = isJsonObject(config.hooks) ? { ...config.hooks } : {};
  for (const event of events) {
    // Earlier releases installed under different names. Strip those
    // registrations as well, or an upgrade leaves one beside the new one and
    // the reviewer runs twice on every stop.
    const groups = removeInstalledHooks(hooks[event], [hookFile, ...legacyHookFiles], runner);
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
  const userHomeEarly = process.env.KEEP_GOING_HOME || homedir();
  if (args.includes("--status")) {
    const configHomeEarly = process.env.XDG_CONFIG_HOME || path.join(userHomeEarly, ".config");
    process.stdout.write(`${await reportStatus({ userHome: userHomeEarly, configHome: configHomeEarly })}\n`);
    return;
  }

  const runtimes = selectedRuntimes(args);
  if (runtimes.length === 0) {
    throw new Error(`Select ${new Intl.ListFormat("en", { type: "disjunction" }).format([...Object.keys(TARGETS).map((name) => `--${name}`), "--all"])}.\n\n${usage()}`);
  }

  const uninstall = args.includes("--uninstall");
  const userHome = process.env.KEEP_GOING_HOME || homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(userHome, ".local", "share");
  const configHome = process.env.XDG_CONFIG_HOME || path.join(userHome, ".config");
  const hookFile = path.join(dataHome, "keep-going", "keep-going.mjs");
  const legacyHookFiles = [
    path.join(dataHome, "unblock", "unblock.mjs"),
    path.join(dataHome, "stop-review", "stop-review.mjs"),
  ];

  if (!uninstall) {
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
      updateHookConfig(config, events, hookFile, runner, uninstall, legacyHookFiles),
    );
    process.stdout.write(`${uninstall ? "Removed" : "Installed"} ${runner} hook in ${settingsFile}\n`);
  }

  if (!uninstall) process.stdout.write(`Reviewer installed at ${hookFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`keep-going: ${error.message}\n`);
  process.exitCode = 1;
});
