import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createTerminal, getTerminalCwd, hasTerminal, killTerminal, subscribeTerminal, TERMINAL_RECONNECT_MS } = await jiti.import("./terminal-manager.ts");
const { GET } = await jiti.import("../app/api/terminal/[id]/events/route.ts");
const paths = await jiti.import("./paths.ts");
// The pure workspace modules run inside the vm sandbox so the remote command
// and the ssh arguments under test are the real implementations.
const remoteWorkspace = await jiti.import("./remote-workspace.ts");
const workspaceTarget = await jiti.import("./workspace-target.ts");

const require = createRequire(import.meta.url);
const managerSource = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(managerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

// Run the transpiled manager in an isolated context. `nodePty` replaces the
// native module and records spawn calls; `throwOnNodePty` simulates a missing
// binary. No real ssh process, host, or filesystem metadata is ever touched.
function runManager({ spawnCalls = [], nodePty = null, throwOnNodePty = false, env = process.env, platform = process.platform } = {}) {
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") {
      if (throwOnNodePty) throw new Error("Cannot find module pty.node");
      if (nodePty) return nodePty;
      return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    }
    if (id === "./paths") return paths;
    if (id === "./remote-workspace") return remoteWorkspace;
    if (id === "./workspace-target") return workspaceTarget;
    return require(id);
  };
  const exports = {};
  runInNewContext(transpiled, { exports, process: { ...process, env, once() {}, platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  return exports;
}

test("native module load failures are deferred until creation and include repair instructions", () => {
  const exports = runManager({ throwOnNodePty: true });
  assert.equal(exports.hasTerminal("missing"), false);
  assert.throws(() => exports.createTerminal(process.cwd(), 80, 24), (error) => {
    assert.match(error.message, /native terminal module/);
    assert.match(error.message, /npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts/);
    assert.match(error.message, /Cannot find module pty.node/);
    return true;
  });
});

test("shell environment defaults to UTF-8 locale when the host has none", () => {
  const spawnCalls = [];
  const envWithoutLocale = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["LANG", "LC_ALL", "LC_CTYPE"].includes(k)));
  const exports = runManager({ spawnCalls, env: envWithoutLocale });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.LANG, "C.UTF-8");
});

test("shell environment preserves a case-insensitive Windows locale", () => {
  const spawnCalls = [];
  const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["lang", "lc_all", "lc_ctype"].includes(key.toLowerCase())));
  rawEnv.lang = "zh_CN.UTF-8";
  const envWithLocale = new Proxy(rawEnv, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const match = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      return match ? target[match] : undefined;
    },
  });
  const exports = runManager({ spawnCalls, env: envWithLocale });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.lang, "zh_CN.UTF-8");
  assert.equal("LANG" in spawnCalls[0][2].env, false);
});

test("remote terminals spawn ssh from the local home directory with a forced TTY", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const localRoot = "/home/user/.pi/remote/user_example.com_a1b2c3d4e5f6/project";
  const target = { kind: "ssh", id: "user_example.com_a1b2c3d4e5f6", host: "user@example.com", cwd: "/home/user/project" };
  const id = "a".repeat(32);
  exports.createTerminal(localRoot, 120, 40, id, target);
  assert.equal(spawnCalls.length, 1);
  const [file, args, options] = spawnCalls[0];
  // Windows ConPTY spawn cannot resolve bare "ssh"; POSIX uses the PATH name.
  assert.equal(file, process.platform === "win32" ? "ssh.exe" : "ssh");
  assert.equal(args[0], "-tt", "remote sessions force a TTY so resize/TERM work naturally");
  const command = args[args.length - 1];
  assert.equal(command, "cd '/home/user/project' && exec \"${SHELL:-/bin/sh}\" -l");
  assert.deepEqual(args, remoteWorkspace.sshArguments("user@example.com", command, true));
  // The compatibility path of a remote subdirectory usually does not exist
  // locally, so the ssh client must run from the local home directory.
  assert.equal(options.cwd, homedir());
  assert.equal(options.env.TERM, "xterm-256color");
  assert.equal(exports.getTerminalCwd(id), localRoot, "the compatibility path stays the record cwd");
  assert.deepEqual(JSON.parse(JSON.stringify(exports.getTerminalTarget(id))), target);
  exports.killTerminal(id);
});

test("remote cwd goes through quoteShellArg so metacharacters stay inert", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const nasty = '/home/user/it\'s $(reboot) `id` "quoted"; rm -rf /';
  const target = { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: nasty };
  const id = "b".repeat(32);
  exports.createTerminal("/local/shadow", 80, 24, id, target);
  assert.equal(spawnCalls.length, 1);
  const args = spawnCalls[0][1];
  const command = args[args.length - 1];
  // quoteShellArg wraps in single quotes and escapes embedded single quotes.
  assert.equal(remoteWorkspace.quoteShellArg(nasty), `'${nasty.replace(/'/g, `'\\''`)}'`);
  assert.equal(command, "cd " + remoteWorkspace.quoteShellArg(nasty) + ' && exec "${SHELL:-/bin/sh}" -l');
  exports.killTerminal(id);
});

test("repeat creation is idempotent per cwd+target; a changed target is rejected", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const localRoot = "/local/shadow";
  const target = { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/a" };
  const id = "c".repeat(32);
  exports.createTerminal(localRoot, 80, 24, id, target);
  assert.equal(exports.createTerminal(localRoot, 100, 30, id, target), id);
  assert.equal(spawnCalls.length, 1, "a matching repeat must reuse the existing process");
  // Option changes may never retarget the terminal: different workspace id,
  // host, remote cwd, local cwd, or target kind all reject.
  assert.throws(() => exports.createTerminal(localRoot, 80, 24, id, { kind: "ssh", id: "h2_aabbccddeeff", host: "user@h1", cwd: "/remote/a" }), /different workspace/);
  assert.throws(() => exports.createTerminal(localRoot, 80, 24, id, { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h2", cwd: "/remote/a" }), /different workspace/);
  assert.throws(() => exports.createTerminal(localRoot, 80, 24, id, { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/b" }), /different workspace/);
  assert.throws(() => exports.createTerminal(localRoot + "/sub", 80, 24, id, target), /different workspace/);
  assert.throws(() => exports.createTerminal(localRoot, 80, 24, id, { kind: "local", cwd: localRoot }), /different workspace/);
  assert.equal(spawnCalls.length, 1, "rejected option changes must not retarget or respawn");
  assert.deepEqual(JSON.parse(JSON.stringify(exports.getTerminalTarget(id))), target, "the stored target is unchanged");
  exports.killTerminal(id);
});

test("registry targets are frozen copies of the caller's object", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const target = { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/a" };
  const id = "e".repeat(32);
  exports.createTerminal("/local/shadow", 80, 24, id, target);
  const stored = exports.getTerminalTarget(id);
  assert.ok(Object.isFrozen(stored), "the snapshot is frozen");
  target.cwd = "/mutated";
  target.host = "attacker";
  target.id = "h2_aabbccddeeff";
  assert.deepEqual(JSON.parse(JSON.stringify(exports.getTerminalTarget(id))), { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/a" }, "mutating the caller object does not change the snapshot");
  assert.throws(() => exports.createTerminal("/local/shadow", 80, 24, id, { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/a/" }), /different workspace/, "remote identity stays an exact snapshot");
  exports.killTerminal(id);
});

test("local terminals accept equivalent cwd spellings once samePath passes", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const id = "f".repeat(32);
  exports.createTerminal("/repo//a", 80, 24, id);
  assert.equal(exports.createTerminal("/repo/a", 80, 24, id), id, "separator spelling must not retarget a local terminal");
  if (process.platform === "win32") {
    const winId = "0".repeat(32);
    exports.createTerminal("C:\\repo\\a", 80, 24, winId);
    assert.equal(exports.createTerminal("c:/repo/A", 80, 24, winId), winId, "Windows case/spelling must not retarget a local terminal");
    exports.killTerminal(winId);
  }
  exports.killTerminal(id);
});

test("remote spawn picks the platform ssh binary while local shell selection is untouched", () => {
  // Remote: ssh.exe on Windows, ssh elsewhere (deterministic via platform override).
  for (const [platform, expectedSsh, id] of [["win32", "ssh.exe", "3".repeat(32)], ["linux", "ssh", "4".repeat(32)], ["darwin", "ssh", "5".repeat(32)]]) {
    const spawnCalls = [];
    const exports = runManager({ spawnCalls, platform });
    const target = { kind: "ssh", id: "h1_aabbccddeeff", host: "user@h1", cwd: "/remote/a" };
    exports.createTerminal("/local/shadow", 80, 24, id, target);
    assert.equal(spawnCalls.length, 1, platform);
    assert.equal(spawnCalls[0][0], expectedSsh, platform);
    assert.equal(spawnCalls[0][2].cwd, homedir(), `ssh client cwd stays the local home on ${platform}`);
    exports.killTerminal(id);
  }
  // Local: the existing shell/args selection is unchanged per platform.
  const winCalls = [];
  const win = runManager({ spawnCalls: winCalls, platform: "win32" });
  const winId = "6".repeat(32);
  win.createTerminal("/local/project", 80, 24, winId);
  assert.equal(winCalls[0][0], process.env.ComSpec ?? "cmd.exe");
  assert.deepEqual(JSON.parse(JSON.stringify(winCalls[0][1])), []);
  win.killTerminal(winId);
  const linuxCalls = [];
  const linux = runManager({ spawnCalls: linuxCalls, platform: "linux" });
  const linuxId = "7".repeat(32);
  linux.createTerminal("/local/project", 80, 24, linuxId);
  assert.equal(linuxCalls[0][0], process.env.SHELL || "/bin/sh");
  assert.deepEqual(JSON.parse(JSON.stringify(linuxCalls[0][1])), ["-l"]);
  linux.killTerminal(linuxId);
});

test("forced cleanup never sends unsupported POSIX signals to Windows PTYs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const platform of ["win32", "linux"]) {
    const kills = [];
    const pty = { onData() {}, onExit() {}, write() {}, resize() {}, kill(signal) {
      if (platform === "win32" && signal) throw new Error("Signals not supported on windows.");
      kills.push(signal);
    } };
    const manager = runManager({ platform, nodePty: { spawn: () => pty } });
    const expected = platform === "win32" ? undefined : "SIGKILL";
    manager.createTerminal("/local/project", 80, 24, "8".repeat(32));
    assert.equal(manager.killTerminal("8".repeat(32), true), true);
    assert.deepEqual(kills, [expected]);
    manager.createTerminal("/local/project", 80, 24, "9".repeat(32));
    manager.killTerminal("9".repeat(32));
    t.mock.timers.tick(2000);
    assert.deepEqual(kills, [expected, undefined, expected]);
  }
});

test("legacy local creation still spawns the local login shell with a local target", () => {
  const spawnCalls = [];
  const exports = runManager({ spawnCalls });
  const id = "d".repeat(32);
  exports.createTerminal("/local/project", 80, 24, id);
  assert.equal(spawnCalls.length, 1);
  const [file, args, options] = spawnCalls[0];
  const expectedShell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL || "/bin/sh");
  assert.equal(file, expectedShell);
  // JSON round-trip: the vm sandbox creates its own Array prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(args)), process.platform === "win32" ? [] : ["-l"]);
  assert.equal(options.cwd, "/local/project");
  // JSON round-trips: the default target is created in the vm sandbox realm.
  assert.deepEqual(JSON.parse(JSON.stringify(exports.getTerminalTarget(id))), { kind: "local", cwd: "/local/project" });
  assert.equal(exports.createTerminal("/local/project", 80, 24, id), id);
  assert.equal(spawnCalls.length, 1);
  exports.killTerminal(id);
});

test("native PTY starts after install and repeated creation reuses the same workspace process", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  // Windows ConPTY assigns the PID asynchronously. Wait for real shell output,
  // not a delay or an immediate pid=0 assertion.
  if (record.pty.pid === 0) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(new Error("Native PTY did not become ready"));
      }, 5000);
      const subscription = record.pty.onData(() => {
        if (record.pty.pid <= 0) return;
        clearTimeout(timeout);
        subscription.dispose();
        resolve();
      });
    });
  }
  assert.ok(record.pty.pid > 0);
  assert.equal(getTerminalCwd(id), process.cwd());
  assert.equal(createTerminal(process.cwd(), 100, 30, id), id);
  assert.strictEqual(globalThis.__piWebTerminals.get(id), record);
  assert.throws(() => createTerminal(process.cwd() + "/other", 80, 24, id), /different workspace/);
  assert.ok(record.cleanupTimer, "unclaimed creations have a lease");
});

test("connected terminals outlive the grace period; only the last disconnect starts expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createTerminal, killTerminal, subscribeTerminal, hasTerminal } = runManager();
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const first = subscribeTerminal(id, () => {});
  const second = subscribeTerminal(id, () => {});
  first.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS * 2);
  assert.ok(hasTerminal(id));
  second.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS - 1);
  assert.ok(hasTerminal(id));
  const resumed = subscribeTerminal(id, () => {});
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.ok(hasTerminal(id));
  resumed.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("unclaimed creations expire without requiring a browser cleanup request", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Lease semantics use the fake PTY; mock time must not also advance the
  // native ConPTY startup timers from a newly spawned process.
  const { createTerminal, killTerminal, hasTerminal } = runManager();
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("SSE resumes from Last-Event-ID and cancellation releases the connection lease", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "old\r\nnew\r\n";
  record.offset = record.backlog.length;
  const request = new Request("http://localhost/events?after=0", { headers: { "Last-Event-ID": "5" } });
  const response = await GET(request, { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  const replay = new TextDecoder().decode((await reader.read()).value);
  assert.match(replay, /id: 10\n/);
  assert.deepEqual(JSON.parse(replay.split("data: ")[1]), { type: "output", data: "new\r\n", offset: 10, reset: false });
  await reader.cancel();
  assert.equal(record.listeners.size, 0);
  assert.ok(record.cleanupTimer);
});

test("expired output cursors reset bounded history, while explicit close ends connected streams", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "tail";
  record.offset = 100;
  const subscription = subscribeTerminal(id, () => {}, 10);
  assert.deepEqual(subscription.output, { type: "output", data: "tail", offset: 100, reset: true });
  subscription.unsubscribe();
  const response = await GET(new Request("http://localhost/events"), { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  killTerminal(id);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"closed"/);
  assert.equal((await reader.read()).done, true);
  assert.equal(record.listeners.size, 0);
  assert.equal(hasTerminal(id), false);
});
