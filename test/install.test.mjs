import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

function runInstaller(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("installing over a pre-rename hook replaces it instead of doubling up", async () => {
  // Before 0.3.0 the hook lived at <data>/stop-review/stop-review.mjs and the
  // registration named that path. removeInstalledHooks matches on the path, so
  // without stripping the old one an upgrade would leave both registered and the
  // reviewer would run twice on every stop.
  const root = await mkdtemp(path.join(tmpdir(), "unblock-upgrade-"));
  const dataHome = path.join(root, "data");
  const claudeHome = path.join(root, "claude");
  const env = {
    UNBLOCK_HOME: path.join(root, "home"),
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  try {
    const legacy = path.join(dataHome, "stop-review", "stop-review.mjs");
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: `'${process.execPath}' '${legacy}' claude`,
          }],
        }],
      },
    }));

    const result = await runInstaller(["--claude"], env);
    assert.equal(result.code, 0, result.stderr);

    const claude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    const commands = claude.hooks.Stop.flatMap((group) => group.hooks.map((h) => h.command));
    assert.equal(commands.length, 1, `expected one Stop hook, got ${JSON.stringify(commands)}`);
    assert.match(commands[0], /unblock\.mjs' claude$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer adds, updates, and removes Claude Code and Ghost hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unblock-install-"));
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "config");
  const claudeHome = path.join(root, "claude");
  const env = {
    UNBLOCK_HOME: home,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  try {
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
      theme: "dark",
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runInstaller(["--all"], env);
      assert.equal(result.code, 0, result.stderr);
    }

    const installed = path.join(dataHome, "unblock", "unblock.mjs");
    await access(installed);
    const claude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    const ghost = JSON.parse(await readFile(path.join(configHome, "ghost", "hooks.json"), "utf8"));
    assert.equal(claude.theme, "dark");
    assert.equal(claude.hooks.SessionStart[0].hooks[0].command, "keep-me");
    assert.equal(claude.hooks.Stop.length, 1);
    assert.match(claude.hooks.Stop[0].hooks[0].command, /unblock\.mjs' claude$/);
    assert.equal(ghost.hooks.session_stop.length, 1);
    assert.match(ghost.hooks.session_stop[0].hooks[0].command, /unblock\.mjs' ghost$/);

    const result = await runInstaller(["--uninstall", "--all"], env);
    assert.equal(result.code, 0, result.stderr);
    const removedClaude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    const removedGhost = JSON.parse(await readFile(path.join(configHome, "ghost", "hooks.json"), "utf8"));
    assert.deepEqual(removedClaude.hooks.Stop, []);
    assert.deepEqual(removedGhost.hooks.session_stop, []);
    assert.equal(removedClaude.hooks.SessionStart[0].hooks[0].command, "keep-me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer requires an explicit target", async () => {
  const result = await runInstaller([], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Select --claude, --ghost, or --all/);
});

test("uninstalling an absent hook does not create a settings file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unblock-uninstall-"));
  const settings = path.join(root, "claude", "settings.json");
  try {
    const result = await runInstaller(["--uninstall", "--claude"], {
      UNBLOCK_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      CLAUDE_CONFIG_DIR: path.dirname(settings),
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(settings), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
