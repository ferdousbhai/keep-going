import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

// Every test here needs the same isolated home: six copies of this block said
// so. The paths are returned because tests assert against them.
async function installHome(label) {
  const root = await mkdtemp(path.join(tmpdir(), `keep-going-${label}-`));
  const home = path.join(root, "home");
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const grokHome = path.join(home, ".grok");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "config");
  // Every test writes or asserts against this file, and an empty directory is
  // not a settings file, so the "does not create one" assertion still holds.
  await mkdir(claudeHome, { recursive: true });
  return {
    home,
    claudeHome,
    codexHome,
    grokHome,
    dataHome,
    configHome,
    settings: path.join(claudeHome, "settings.json"),
    env: {
      KEEP_GOING_HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      GROK_HOME: grokHome,
      CODEX_HOME: codexHome,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

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
    const { settings, dataHome, env, cleanup } = await installHome("upgrade");
    try {
      const legacy = path.join(dataHome, legacyName, `${legacyName}.mjs`);
      await writeFile(settings, JSON.stringify({
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

      const claude = JSON.parse(await readFile(settings, "utf8"));
      const commands = claude.hooks.Stop.flatMap((group) => group.hooks.map((h) => h.command));
      assert.equal(commands.length, 1, `expected one Stop hook, got ${JSON.stringify(commands)}`);
      assert.match(commands[0], /keep-going\.mjs' claude$/);
    } finally {
      await cleanup();
    }
  });
}

test("installer adds, updates, and removes Claude Code, Ghost, and Grok hooks", async () => {
  const { settings, home, dataHome, configHome, env, cleanup } = await installHome("install");
  try {
    await writeFile(settings, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
      theme: "dark",
    }));

    // Named explicitly rather than --all: --all leaves Grok to Claude's
    // settings, and this test is about all three files being written.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runInstaller(["--claude", "--ghost", "--grok"], env);
      assert.equal(result.code, 0, result.stderr);
    }

    const installed = path.join(dataHome, "keep-going", "keep-going.mjs");
    await access(installed);
    const claude = JSON.parse(await readFile(settings, "utf8"));
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
    const removedClaude = JSON.parse(await readFile(settings, "utf8"));
    const removedGhost = JSON.parse(await readFile(path.join(configHome, "ghost", "hooks.json"), "utf8"));
    const removedGrok = JSON.parse(await readFile(path.join(home, ".grok", "hooks", "keep-going.json"), "utf8"));
    assert.deepEqual(removedClaude.hooks.Stop, []);
    assert.deepEqual(removedGhost.hooks.session_stop, []);
    assert.deepEqual(removedGrok.hooks.Stop, []);
    assert.equal(removedClaude.hooks.SessionStart[0].hooks[0].command, "keep-me");
  } finally {
    await cleanup();
  }
});

test("status sees plugin-registered hooks, ours and everyone else's", async () => {
  // A keep-going installed as a Claude plugin lives in no settings file, so
  // status called it unregistered; and this session found a second Stop hook
  // from another plugin that had been running on every stop unremarked.
  const { settings, claudeHome, env, cleanup } = await installHome("plugins");
  const plugins = path.join(claudeHome, "plugins");
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
    // The shipped plugin registers both of Claude's stop events; a plugin that
    // covered only one would report as missing the other, which it would be.
    const ourHook = [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/keep-going.mjs" claude' }] }];
    const oursDir = await install("kg", "hooks/hooks.json", { Stop: ourHook, SubagentStop: ourHook });
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
    assert.match(report.stdout, /claude\s+registered\s+plugin keep-going@keep-going/);
    // And the hook that is not ours is named rather than ignored.
    assert.match(report.stdout, /claude\s+also runs\s+Stop from plugin gate@somewhere/);

    // Installed both ways is the double review worth warning about.
    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const both = await runInstaller(["--status"], env);
    assert.match(both.stdout, /! claude has 2 hooks on Stop and reviews it 2 times/);
  } finally {
    await cleanup();
  }
});

test("--link registers the checkout, and switching modes replaces rather than adds", async () => {
  // Wiring a hook at a working tree by hand is what a maintainer wants and how
  // this machine drifted: the hand-written entry missed an event the installer
  // would have added. Linking is the same thing, managed.
  const { settings, dataHome, env, cleanup } = await installHome("link");
  const bundled = path.join(ROOT, "plugins", "keep-going", "scripts", "keep-going.mjs");
  const copied = path.join(dataHome, "keep-going", "keep-going.mjs");
  const commands = async () => {
    const config = JSON.parse(await readFile(settings, "utf8"));
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
    await cleanup();
  }
});

test("a registration naming the wrong runner is replaced, not preserved forever", async () => {
  // --status counted this as a duplicate while the installer, which required
  // the runner word to match, refused to strip it — so re-running the tool
  // could never fix what the tool was reporting.
  const { settings, env, cleanup } = await installHome("wrongrunner");
  try {
    await writeFile(settings, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/x/keep-going.mjs' ghost" }] }] },
    }));

    const before = await runInstaller(["--status"], env);
    assert.match(before.stdout, /! claude is registered to run the ghost runtime/);

    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const stop = JSON.parse(await readFile(settings, "utf8")).hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(stop.length, 1, JSON.stringify(stop));
    assert.match(stop[0].command, /keep-going\.mjs' claude$/);

    const after = await runInstaller(["--status"], env);
    assert.doesNotMatch(after.stdout, /ghost runtime/);
  } finally {
    await cleanup();
  }
});

test("a covered host is still checked against its own runner", async () => {
  // Grok is exempt from the wrong-runtime warning for one reason: a claude
  // hook reaching it through Claude's settings is correct. Writing that as
  // "never warn about grok" excused the mis-wiring in grok's own file too.
  const { grokHome, env, cleanup } = await installHome("coveredrunner");
  const grokHook = path.join(grokHome, "hooks", "keep-going.json");
  try {
    await mkdir(path.dirname(grokHook), { recursive: true });
    await writeFile(grokHook, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/x/keep-going.mjs' ghost" }] }] },
    }));

    const report = await runInstaller(["--status"], env);
    assert.match(report.stdout, /! grok is registered to run the ghost runtime/);

    // While the claude runner reaching grok through Claude's file is expected.
    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    assert.equal((await runInstaller(["--uninstall", "--grok"], env)).code, 0);
    const covered = await runInstaller(["--status"], env);
    assert.match(covered.stdout, /grok\s+registered\s+.*\(reviewed by claude\)/);
    assert.doesNotMatch(covered.stdout, /grok is registered to run/);
  } finally {
    await cleanup();
  }
});

test("--all leaves Grok to Claude's registration, but --uninstall --all still clears it", async () => {
  // Grok dispatches what it finds in Claude's settings, so installing both is
  // two reviews of every Grok stop — which --all itself used to produce and
  // --status then reported as a fault. Removal has to stay exhaustive, or an
  // --all uninstall leaves behind what an older --all install wrote.
  const { settings, grokHome, env, cleanup } = await installHome("all");
  const grokHook = path.join(grokHome, "hooks", "keep-going.json");
  try {
    assert.equal((await runInstaller(["--all"], env)).code, 0);
    await access(settings);
    await assert.rejects(access(grokHook), "--all must not register grok beside claude");

    const status = await runInstaller(["--status"], env);
    assert.match(status.stdout, /grok\s+registered\s+.*settings\.json \(reviewed by claude\)/);
    assert.doesNotMatch(status.stdout, /! grok has/);

    // Asking for both explicitly is allowed, and said out loud.
    const both = await runInstaller(["--claude", "--grok"], env);
    assert.match(both.stdout, /note: grok also dispatches claude's hooks/);
    await access(grokHook);

    assert.equal((await runInstaller(["--uninstall", "--all"], env)).code, 0);
    const grok = JSON.parse(await readFile(grokHook, "utf8"));
    assert.deepEqual(grok.hooks.Stop, []);
  } finally {
    await cleanup();
  }
});

test("installing strips a hand-wired hook wherever it points", async () => {
  // --status reported these as duplicates while the installer, which matched
  // exact paths it had written, could not remove them. The remedy was hand
  // editing, which is the thing this tool exists to avoid.
  const { settings, env, cleanup } = await installHome("handwired");
  try {
    await writeFile(settings, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "'/opt/node' '/somewhere/else/keep-going.mjs' claude" }] }],
      },
    }));

    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const config = JSON.parse(await readFile(settings, "utf8"));
    const stop = config.hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(stop.length, 1, JSON.stringify(stop));
    assert.doesNotMatch(stop[0].command, /somewhere\/else/);
  } finally {
    await cleanup();
  }
});

test("status reports every host, including the two it does not write", async () => {
  // Grok dispatching Claude's settings is what made a hook that was listed as
  // enabled do nothing at all for a day, so the report has to distinguish
  // "covered by another host's file" from both "registered" and "absent".
  const { settings, codexHome, env, cleanup } = await installHome("status");

  try {
    const bare = await runInstaller(["--status"], env);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /claude\s+not registered/);
    assert.match(bare.stdout, /codex\s+not registered/);

    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const covered = await runInstaller(["--status"], env);
    assert.match(covered.stdout, /claude\s+registered/);
    // Grok is reached through Claude's file, which is a source rather than a
    // special case — and it says whose runtime answers for it.
    assert.match(covered.stdout, /grok\s+registered\s+.*settings\.json \(reviewed by claude\)/);
    assert.doesNotMatch(covered.stdout, /! grok has/);

    assert.equal((await runInstaller(["--grok"], env)).code, 0);
    const both = await runInstaller(["--status"], env);
    assert.match(both.stdout, /grok\s+registered/);
    // Two sources carrying our hook is two reviews, counted not special-cased.
    assert.match(both.stdout, /! grok has 2 hooks on Stop and reviews it 2 times/);

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
    await cleanup();
  }
});

test("installer requires an explicit target", async () => {
  const result = await runInstaller([], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Select --claude, --ghost, --grok, or --all/);
});

test("uninstalling an absent hook does not create a settings file", async () => {
  const { settings, env, cleanup } = await installHome("uninstall");
  try {
    const result = await runInstaller(["--uninstall", "--claude"], env);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(settings), { code: "ENOENT" });
  } finally {
    await cleanup();
  }
});
