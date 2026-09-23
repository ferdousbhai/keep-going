import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

// Every test here needs the same isolated home. The paths are returned
// because tests assert against them.
async function installHome(label) {
  const root = await mkdtemp(path.join(tmpdir(), `keep-going-${label}-`));
  const home = path.join(root, "home");
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const grokHome = path.join(home, ".grok");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "config");
  // Most tests write or assert against Claude's settings; an empty directory
  // is not a settings file, so the "does not create one" assertion holds.
  await mkdir(claudeHome, { recursive: true });
  return {
    home,
    claudeHome,
    codexHome,
    grokHome,
    dataHome,
    configHome,
    settings: path.join(claudeHome, "settings.json"),
    museSettings: path.join(configHome, "muse", "settings.json"),
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

test("installer adds, updates, and removes Claude Code, Ghost, and Grok hooks", async () => {
  const { settings, home, dataHome, configHome, env, cleanup } = await installHome("install");
  try {
    await writeFile(settings, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
      theme: "dark",
    }));

    // Named explicitly: this test is about all three files being written.
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

test("--audit-log writes the log path into each command and a plain reinstall drops it", async () => {
  const { settings, museSettings, home, env, cleanup } = await installHome("audit");
  try {
    const expected = path.join(home, "state", "audit.jsonl");
    const result = await runInstaller(["--claude", "--muse", "--audit-log", expected], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`Audit log at ${expected}\n`), result.stdout);
    const claude = JSON.parse(await readFile(settings, "utf8"));
    const muse = JSON.parse(await readFile(museSettings, "utf8"));
    for (const [config, event, runner] of [[claude, "Stop", "claude"], [claude, "SubagentStop", "claude"], [muse, "Stop", "muse"]]) {
      assert.equal(config.hooks[event].length, 1);
      const command = config.hooks[event][0].hooks[0].command;
      assert.ok(command.startsWith(`KEEP_GOING_AUDIT_LOG='${expected}' '`), command);
      assert.match(command, new RegExp(`keep-going\\.mjs' ${runner}$`));
    }

    const plain = await runInstaller(["--claude", "--muse"], env);
    assert.equal(plain.code, 0, plain.stderr);
    const reinstalled = JSON.parse(await readFile(museSettings, "utf8"));
    assert.equal(reinstalled.hooks.Stop.length, 1);
    assert.doesNotMatch(reinstalled.hooks.Stop[0].hooks[0].command, /KEEP_GOING_AUDIT_LOG/);

    const missing = await runInstaller(["--muse", "--audit-log"], env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--audit-log needs a path/);
  } finally {
    await cleanup();
  }
});

test("installer adds, updates, and removes Muse Code hooks", async () => {
  const { museSettings, dataHome, env, cleanup } = await installHome("muse");
  try {
    // A fresh install creates the file, and Muse fails every command without
    // schema_version — so the created file must include it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runInstaller(["--muse"], env);
      assert.equal(result.code, 0, result.stderr);
    }

    const installed = path.join(dataHome, "keep-going", "keep-going.mjs");
    await access(installed);
    const muse = JSON.parse(await readFile(museSettings, "utf8"));
    assert.equal(muse.schema_version, 1);
    for (const event of ["Stop", "SubagentStop"]) {
      assert.equal(muse.hooks[event].length, 1, JSON.stringify(muse.hooks[event]));
      assert.match(muse.hooks[event][0].hooks[0].command, /keep-going\.mjs' muse$/);
    }

    // A value already set is never overwritten, and unrelated keys survive.
    await writeFile(
      museSettings,
      JSON.stringify({ schema_version: 1, theme: "dark", hooks: muse.hooks }),
    );
    assert.equal((await runInstaller(["--muse"], env)).code, 0);
    const kept = JSON.parse(await readFile(museSettings, "utf8"));
    assert.equal(kept.schema_version, 1);
    assert.equal(kept.theme, "dark");
    assert.equal(kept.hooks.Stop.length, 1);

    const result = await runInstaller(["--uninstall", "--muse"], env);
    assert.equal(result.code, 0, result.stderr);
    const removed = JSON.parse(await readFile(museSettings, "utf8"));
    assert.deepEqual(removed.hooks.Stop, []);
    assert.deepEqual(removed.hooks.SubagentStop, []);
    assert.equal(removed.schema_version, 1);
  } finally {
    await cleanup();
  }
});

test("status sees plugin-registered hooks, ours and everyone else's", async () => {
  // A keep-going installed as a Claude plugin lives in no settings file, and
  // another plugin's Stop hook runs on every stop too; status reports both.
  const { claudeHome, env, cleanup } = await installHome("plugins");
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
  // Wiring a hook at a working tree is what a maintainer wants; linking does
  // it with every event the installer would add.
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
  // Any keep-going registration is ours whatever its runner word, so
  // re-running the installer fixes what --status reports.
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
  // A claude hook reaching Grok through Claude's settings is correct; one in
  // Grok's own file naming the wrong runner is still a warning.
  const { grokHome, env, cleanup } = await installHome("coveredrunner");
  const grokHook = path.join(grokHome, "hooks", "keep-going.json");
  try {
    await mkdir(path.dirname(grokHook), { recursive: true });
    await writeFile(grokHook, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/x/keep-going.mjs' ghost" }] }] },
    }));

    const report = await runInstaller(["--status"], env);
    assert.match(report.stdout, /! grok is registered to run the ghost runtime/);

    // A claude command reaching grok through Claude's settings is expected;
    // grok still reviews it, so status does not say "reviewed by claude".
    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    assert.equal((await runInstaller(["--uninstall", "--grok"], env)).code, 0);
    const covered = await runInstaller(["--status"], env);
    assert.match(covered.stdout, /grok\s+registered\s+.*settings\.json/);
    assert.doesNotMatch(covered.stdout, /reviewed by claude/);
    assert.doesNotMatch(covered.stdout, /grok is registered to run/);
  } finally {
    await cleanup();
  }
});

test("--all writes a native Grok hook beside Claude, and --uninstall --all still clears it", async () => {
  // Dual users need Grok's own file even though Grok also scans Claude's
  // settings. The borrowed copy yields, so --status must not call that a
  // double review. An --all uninstall removes every file --all writes.
  const { settings, grokHome, env, cleanup } = await installHome("all");
  const grokHook = path.join(grokHome, "hooks", "keep-going.json");
  try {
    const installed = await runInstaller(["--all"], env);
    assert.equal(installed.code, 0, installed.stderr);
    await access(settings);
    await access(grokHook);
    assert.match(installed.stdout, /note: grok also dispatches claude's hooks; grok's own hook reviews/);

    const status = await runInstaller(["--status"], env);
    assert.match(status.stdout, /grok\s+registered/);
    assert.doesNotMatch(status.stdout, /reviewed by claude/);
    assert.doesNotMatch(status.stdout, /! grok has/);
    assert.doesNotMatch(status.stdout, /covered only through Claude's settings/);

    assert.equal((await runInstaller(["--uninstall", "--all"], env)).code, 0);
    const grok = JSON.parse(await readFile(grokHook, "utf8"));
    assert.deepEqual(grok.hooks.Stop, []);
  } finally {
    await cleanup();
  }
});

test("status reports every host, including the one it does not write", async () => {
  // Grok dispatches Claude's settings, so the report distinguishes "covered by
  // another host's file" from both "registered" and "absent".
  const { codexHome, env, cleanup } = await installHome("status");

  try {
    const bare = await runInstaller(["--status"], env);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /claude\s+not registered/);
    assert.match(bare.stdout, /muse\s+not registered/);
    assert.match(bare.stdout, /codex\s+not registered/);

    assert.equal((await runInstaller(["--claude"], env)).code, 0);
    const covered = await runInstaller(["--status"], env);
    assert.match(covered.stdout, /claude\s+registered/);
    // Grok is reached through Claude's file, which is a source rather than a
    // special case. The reviewer is still grok, so status does not claim
    // claude answers for it — and it asks for a native hook.
    assert.match(covered.stdout, /grok\s+registered\s+.*settings\.json/);
    assert.doesNotMatch(covered.stdout, /reviewed by claude/);
    assert.doesNotMatch(covered.stdout, /! grok has \d+ hooks/);
    assert.match(covered.stdout, /covered only through Claude's settings/);

    assert.equal((await runInstaller(["--grok"], env)).code, 0);
    const both = await runInstaller(["--status"], env);
    assert.match(both.stdout, /grok\s+registered/);
    // Native plus borrowed is one review: the Claude copy yields on Grok.
    assert.doesNotMatch(both.stdout, /! grok has \d+ hooks/);
    assert.doesNotMatch(both.stdout, /covered only through Claude's settings/);

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

test("Codex status scopes feature flags to their table, including a final table", async (t) => {
  const { codexHome, env, cleanup } = await installHome("codex-features");
  t.after(cleanup);
  await mkdir(codexHome, { recursive: true });
  const plugin = '[plugins."keep-going@keep-going"]\nenabled = true\n';
  for (const [config, disabled] of [
    [`${plugin}\n[features]\nplugins = false`, true],
    [`${plugin}\n[features]\nplugins = false\n`, true],
    [`${plugin}\n[features]\nplugins = false\n`.replaceAll("\n", "\r\n"), true],
    [`${plugin}\n[features]\nplugins = true\n[other]\nplugins = false\n`, false],
    [`${plugin}\n[other]\nplugins = false\n`, false],
  ]) {
    await writeFile(path.join(codexHome, "config.toml"), config);
    const result = await runInstaller(["--status"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /codex\s+registered/);
    assert.equal(result.stdout.includes("plugins disabled"), disabled, config);
  }
});

test("installer requires an explicit target", async () => {
  const result = await runInstaller([], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Select --claude, --muse, --ghost, --grok, or --all/);
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
