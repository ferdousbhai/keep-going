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

for (const legacyName of ["unblock", "stop-review"]) {
  test(`installing over a ${legacyName} hook replaces it instead of doubling up`, async () => {
    // Each rename moved the hook to <data>/<name>/<name>.mjs and the registration
    // names that path. removeInstalledHooks matches on the path, so without
    // stripping the old one an upgrade leaves both registered and the reviewer
    // runs twice on every stop.
    const root = await mkdtemp(path.join(tmpdir(), "keep-going-upgrade-"));
    const dataHome = path.join(root, "data");
    const claudeHome = path.join(root, "claude");
    const env = {
      KEEP_GOING_HOME: path.join(root, "home"),
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(root, "config"),
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    try {
      const legacy = path.join(dataHome, legacyName, `${legacyName}.mjs`);
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
      assert.match(commands[0], /keep-going\.mjs' claude$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("installer adds, updates, and removes Claude Code, Ghost, and Grok hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-install-"));
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "config");
  const claudeHome = path.join(root, "claude");
  const env = {
    KEEP_GOING_HOME: home,
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

    const installed = path.join(dataHome, "keep-going", "keep-going.mjs");
    await access(installed);
    const claude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    const ghost = JSON.parse(await readFile(path.join(configHome, "ghost", "hooks.json"), "utf8"));
    const grok = JSON.parse(await readFile(path.join(home, ".grok", "hooks", "keep-going.json"), "utf8"));
    assert.equal(claude.theme, "dark");
    assert.equal(claude.hooks.SessionStart[0].hooks[0].command, "keep-me");
    assert.equal(claude.hooks.Stop.length, 1);
    assert.match(claude.hooks.Stop[0].hooks[0].command, /keep-going\.mjs' claude$/);
    assert.equal(ghost.hooks.session_stop.length, 1);
    assert.match(ghost.hooks.session_stop[0].hooks[0].command, /keep-going\.mjs' ghost$/);
    assert.equal(grok.hooks.Stop.length, 1);
    assert.match(grok.hooks.Stop[0].hooks[0].command, /keep-going\.mjs' grok$/);

    const result = await runInstaller(["--uninstall", "--all"], env);
    assert.equal(result.code, 0, result.stderr);
    const removedClaude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    const removedGhost = JSON.parse(await readFile(path.join(configHome, "ghost", "hooks.json"), "utf8"));
    const removedGrok = JSON.parse(await readFile(path.join(home, ".grok", "hooks", "keep-going.json"), "utf8"));
    assert.deepEqual(removedClaude.hooks.Stop, []);
    assert.deepEqual(removedGhost.hooks.session_stop, []);
    assert.deepEqual(removedGrok.hooks.Stop, []);
    assert.equal(removedClaude.hooks.SessionStart[0].hooks[0].command, "keep-me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status sees plugin-registered hooks, ours and everyone else's", async () => {
  // A keep-going installed as a Claude plugin lives in no settings file, so
  // status called it unregistered; and this session found a second Stop hook
  // from another plugin that had been running on every stop unremarked.
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-plugins-"));
  const claudeHome = path.join(root, "claude");
  const plugins = path.join(claudeHome, "plugins");
  const env = {
    KEEP_GOING_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  const install = async (name, file, hooks) => {
    const dir = path.join(plugins, "cache", name);
    await mkdir(path.join(dir, path.dirname(file)), { recursive: true });
    await writeFile(path.join(dir, file), JSON.stringify({ hooks }));
    return dir;
  };
  try {
    const otherDir = await install("other", "hooks/hooks.json", {
      Stop: [{ hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/gate.sh"' }] }],
    });
    const oursDir = await install("kg", "hooks/hooks.json", {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/keep-going.mjs" claude' }] }],
    });
    await writeFile(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "gate@somewhere": [{ scope: "user", installPath: otherDir }],
          "keep-going@keep-going": [{ scope: "user", installPath: oursDir }],
        },
      }),
    );

    const report = await runInstaller(["--status"], env);
    assert.equal(report.code, 0, report.stderr);
    // Ours counts as registered even with an empty settings.json.
    assert.match(report.stdout, /claude\s+plugin\s+Stop from keep-going@keep-going/);
    // And the hook that is not ours is named rather than ignored.
    assert.match(report.stdout, /claude\s+also runs\s+Stop from plugin gate@somewhere/);

    // Installed both ways is the double review worth warning about.
    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const both = await runInstaller(["--status"], env);
    assert.match(both.stdout, /! claude is registered in settings and as the plugin keep-going@keep-going/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--link registers the checkout, and switching modes replaces rather than adds", async () => {
  // Wiring a hook at a working tree by hand is what a maintainer wants and how
  // this machine drifted: the hand-written entry missed an event the installer
  // would have added. Linking is the same thing, managed.
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-link-"));
  const claudeHome = path.join(root, "claude");
  const dataHome = path.join(root, "data");
  const env = {
    KEEP_GOING_HOME: path.join(root, "home"),
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  const bundled = path.join(process.cwd(), "plugins", "keep-going", "scripts", "keep-going.mjs");
  const copied = path.join(dataHome, "keep-going", "keep-going.mjs");
  const commands = async () => {
    const config = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    return Object.values(config.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  };
  try {
    assert.equal((await runInstaller(["--claude", "--link"], env)).code, 0);
    const linked = await commands();
    assert.equal(linked.length, 2, JSON.stringify(linked));
    assert.ok(linked.every((command) => command.includes(bundled)));
    await assert.rejects(access(copied), "linking must not leave a copy behind");

    // Switching to a copied install strips the linked registration.
    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const copiedCommands = await commands();
    assert.equal(copiedCommands.length, 2, JSON.stringify(copiedCommands));
    assert.ok(copiedCommands.every((command) => command.includes(copied)));
    await access(copied);

    // And back again, still two.
    assert.equal((await runInstaller(["--claude", "--link"], env)).code, 0);
    const relinked = await commands();
    assert.equal(relinked.length, 2, JSON.stringify(relinked));
    assert.ok(relinked.every((command) => command.includes(bundled)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reports every host, including the two it does not write", async () => {
  // Grok dispatching Claude's settings is what made a hook that was listed as
  // enabled do nothing at all for a day, so the report has to distinguish
  // "covered by another host's file" from both "registered" and "absent".
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-status-"));
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex");
  const env = {
    KEEP_GOING_HOME: home,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: codexHome,
    GROK_HOME: path.join(home, ".grok"),
  };
  try {
    const bare = await runInstaller(["--status"], env);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /claude\s+not registered/);
    assert.match(bare.stdout, /codex\s+not registered/);

    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const covered = await runInstaller(["--status"], env);
    assert.match(covered.stdout, /claude\s+registered/);
    assert.match(covered.stdout, /grok\s+covered\s+by Claude's settings/);
    assert.doesNotMatch(covered.stdout, /reviews every stop twice/);

    assert.equal((await runInstaller(["--grok"], env)).code, 0);
    const both = await runInstaller(["--status"], env);
    assert.match(both.stdout, /grok\s+registered/);
    assert.match(both.stdout, /! grok reads Claude's settings too/);

    // Codex is registered in its own config, and a disabled plugin feature is
    // the difference between installed and actually loading.
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "config.toml"),
      '[features]\nplugins = false\n\n[plugins."keep-going@keep-going"]\nenabled = true\n',
    );
    const codex = await runInstaller(["--status"], env);
    assert.match(codex.stdout, /codex\s+registered/);
    assert.match(codex.stdout, /! codex has \[features\] plugins disabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer requires an explicit target", async () => {
  const result = await runInstaller([], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Select --claude, --ghost, --grok, or --all/);
});

test("uninstalling an absent hook does not create a settings file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keep-going-uninstall-"));
  const settings = path.join(root, "claude", "settings.json");
  try {
    const result = await runInstaller(["--uninstall", "--claude"], {
      KEEP_GOING_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      CLAUDE_CONFIG_DIR: path.dirname(settings),
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(settings), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
