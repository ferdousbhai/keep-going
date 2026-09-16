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
  return `Install Keep Going for Claude Code and Ghost.

Usage:
  keep-going --claude
  keep-going --ghost
  keep-going --all
  keep-going --uninstall --claude|--ghost|--all

Codex installs through the repository marketplace; see README.md.`;
}

// The hosts this installer writes to, and where each keeps its hook config.
// Codex installs through the repository marketplace instead.
const TARGETS = {
  claude: {
    event: "Stop",
    settings: ({ userHome }) =>
      path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude"), "settings.json"),
  },
  ghost: {
    event: "session_stop",
    settings: ({ configHome }) => path.join(configHome, "ghost", "hooks.json"),
  },
};

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

function updateHookConfig(config, event, hookFile, runner, uninstall, legacyHookFiles) {
  const hooks = isJsonObject(config.hooks) ? { ...config.hooks } : {};
  // Earlier releases installed under different names. Strip those registrations
  // as well, or an upgrade leaves one beside the new one and the reviewer runs
  // twice on every stop.
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
  return { ...config, hooks };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const runtimes = selectedRuntimes(args);
  if (runtimes.length === 0) throw new Error(`Select --claude, --ghost, or --all.\n\n${usage()}`);

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
    const { event, settings } = TARGETS[runner];
    const settingsFile = settings({ userHome, configHome });
    const config = await readJson(settingsFile, uninstall ? null : {});
    if (config === null) {
      process.stdout.write(`Removed ${runner} hook in ${settingsFile}\n`);
      continue;
    }
    await writeJsonAtomic(
      settingsFile,
      updateHookConfig(config, event, hookFile, runner, uninstall, legacyHookFiles),
    );
    process.stdout.write(`${uninstall ? "Removed" : "Installed"} ${runner} hook in ${settingsFile}\n`);
  }

  if (!uninstall) process.stdout.write(`Reviewer installed at ${hookFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`keep-going: ${error.message}\n`);
  process.exitCode = 1;
});
