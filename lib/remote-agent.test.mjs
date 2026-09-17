/**
 * lib/remote-agent.test.mjs
 *
 * Targeted tests for the built-in local-agent + remote-project adaptation.
 * No real SSH: the transport is injected (fake command handler), and the
 * transport itself is tested with a fake child process.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const {
  REMOTE_AGENT_EXTENSION_PATH,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  createRemoteAgentExtension,
  createRemoteAgentPathMapping,
  createRemoteAgentTransport,
  createRemoteBashOperations,
  filterLegacySshExtension,
  isLegacySshExtension,
  preferRemoteWorkspaceExtension,
  remoteEnvironmentPrompt,
} = await createJiti(import.meta.url).import("./remote-agent.ts");
const { quoteShellArg } = await createJiti(import.meta.url).import("./remote-workspace.ts");

const IS_WIN = process.platform === "win32";
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Fixtures
// ============================================================================

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-remote-agent-"));
  tempDirs.push(dir);
  const localRoot = path.join(dir, "localroot");
  fs.mkdirSync(localRoot, { recursive: true });
  return { dir, localRoot };
}

function makeWorkspace(localRoot, overrides = {}) {
  return {
    kind: "ssh",
    id: "proj_0123456789ab",
    host: "user@example.com",
    cwd: "/home/user/project",
    localRoot,
    ...overrides,
  };
}

/** Fake transport: routes commands to a handler, records every call. */
function makeFakeTransport({ handler } = {}) {
  const calls = [];
  const streams = [];
  const run = (list, command, opts) => {
    const record = { command, stdin: opts.stdin };
    list.push(record);
    const result = handler ? handler(command, opts) : { stdout: "", exitCode: 0 };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return {
    calls,
    streams,
    async exec(command, opts = {}) {
      return run(calls, command, opts);
    },
    async stream(command, opts = {}) {
      const result = run(streams, command, opts);
      if (result.stdout) opts.onData?.(Buffer.from(result.stdout, "utf8"));
      if (result.stderr) opts.onData?.(Buffer.from(result.stderr, "utf8"));
      return result.exitCode;
    },
  };
}

/** Minimal pi harness: collects registered tools and event handlers. */
function buildExtension({ workspace, sessionCwd, transport, localReadRoots }) {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(tool) {
      assert.ok(!tools.has(tool.name), `duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const extension = createRemoteAgentExtension(workspace, sessionCwd, { transport, localReadRoots });
  assert.equal(extension.name, "pi-web-remote-agent");
  assert.equal(extension.hidden, true);
  extension.factory(pi);
  const ctx = { cwd: sessionCwd };
  const exec = (name, params, signal) => tools.get(name).execute("call-1", params, signal, undefined, ctx);
  const fire = (event, payload) => Promise.all((handlers.get(event) ?? []).map((h) => h(payload, ctx)));
  return { pi, tools, handlers, extension, exec, fire };
}

function systemPromptEvent(sessionCwd, { systemPrompt, skills = [], contextFiles = [] } = {}) {
  return {
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: systemPrompt ?? `You are an agent.\nCurrent working directory: ${sessionCwd.replace(/\\/g, "/")}\n`,
    systemPromptOptions: { cwd: sessionCwd, skills, contextFiles },
  };
}

const unquote = (s) => s.replace(/^'/, "").replace(/'$/, "");

// Fake child process for direct transport tests.
function makeFakeChild({ hang = false, exitCode = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let stdinEnded = null;
  const stdin = new PassThrough();
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = (chunk, ...rest) => {
    if (chunk !== undefined && chunk !== null) {
      stdinEnded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    return originalEnd(chunk, ...rest);
  };
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (hang) setImmediate(() => child.emit("close", 130));
    return true;
  };
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
  });
  if (!hang) setImmediate(() => setImmediate(() => child.emit("close", exitCode)));
  return { child, getStdin: () => stdinEnded };
}

// ============================================================================
// Path mapping
// ============================================================================

test("path mapping is bound to the fixed workspace (no global config)", () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const mapping = createRemoteAgentPathMapping(ws, localRoot);
  assert.equal(mapping.localBase, localRoot);
  assert.equal(mapping.remoteBase, "/home/user/project");
  // relative paths resolve against the fixed workspace cwd
  assert.equal(mapping.toRemotePath("src/a.ts"), "/home/user/project/src/a.ts");
  assert.equal(mapping.toRemotePath("./src/../b.ts"), "/home/user/project/b.ts");
  // absolute remote paths must stay under the project root
  assert.equal(mapping.toRemotePath("/home/user/project/src/a.ts"), "/home/user/project/src/a.ts");
  assert.equal(mapping.toRemotePath("/home/other/project/src/a.ts"), null);
  assert.equal(mapping.toRemotePath("/etc/passwd"), null);
  // remote paths never contain host separators
  assert.ok(!mapping.toRemotePath("a/b/c.txt").includes("\\"));
  // round-trip through the virtual host path
  const virtual = mapping.virtualHostPath("/home/user/project/a/b.ts");
  assert.ok(virtual.startsWith(localRoot));
  assert.equal(mapping.fromVirtualHostPath(virtual), "/home/user/project/a/b.ts");
  // escaping the virtual base is rejected
  assert.throws(() => mapping.fromVirtualHostPath(path.join(localRoot, "..", "evil")), /does not belong/);
});

test("legacy shadow/cache host paths map back to remote; unknown host paths rejected", () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const mapping = createRemoteAgentPathMapping(ws, localRoot);
  const shadow = path.join(localRoot, "src", "old.ts");
  assert.equal(mapping.toRemotePath(shadow), "/home/user/project/src/old.ts");
  assert.equal(mapping.fromWorkspaceHostPath(shadow), "/home/user/project/src/old.ts");
  assert.equal(mapping.fromWorkspaceHostPath(path.join(localRoot, "..", "nope.ts")), null);
  assert.equal(mapping.toRemotePath("C:\\Windows\\system32\\evil.ts"), null);
  if (!IS_WIN) assert.equal(mapping.toRemotePath("/etc/passwd"), null);
  else assert.equal(mapping.toRemotePath("D:\\stuff\\x.ts"), null);
});

test("windows: shadow paths use host separators, remote side stays posix", {
  skip: IS_WIN ? false : "win32 only",
}, () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const mapping = createRemoteAgentPathMapping(ws, localRoot);
  const shadow = path.join(localRoot, "src", "old.ts");
  assert.ok(shadow.includes("\\"));
  assert.equal(mapping.toRemotePath(shadow), "/home/user/project/src/old.ts");
  const virtual = mapping.virtualHostPath("/home/user/project/x.ts");
  assert.ok(virtual.includes("\\"));
  assert.equal(mapping.fromVirtualHostPath(virtual), "/home/user/project/x.ts");
});

// ============================================================================
// Tool completeness
// ============================================================================

test("registers all project tools with original schemas; powershell is rejected", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const transport = makeFakeTransport();
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]) {
    assert.ok(h.tools.has(name), `missing tool: ${name}`);
    assert.ok(h.tools.get(name).parameters, `missing parameters: ${name}`);
    assert.equal(h.tools.get(name).name, name);
  }
  const readProps = h.tools.get("read").parameters.properties;
  for (const key of ["path", "offset", "limit"]) assert.ok(readProps[key], `read.${key}`);
  const grepProps = h.tools.get("grep").parameters.properties;
  for (const key of ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]) {
    assert.ok(grepProps[key], `grep.${key}`);
  }
  assert.ok(h.tools.get("write").parameters.properties.path && h.tools.get("write").parameters.properties.content);
  assert.ok(h.tools.get("edit").parameters.properties.path && h.tools.get("edit").parameters.properties.edits);
  assert.ok(h.tools.get("bash").parameters.properties.command && h.tools.get("bash").parameters.properties.timeout);
  assert.ok(h.tools.get("find").parameters.properties.pattern && h.tools.get("find").parameters.properties.limit);
  assert.ok(h.tools.get("ls").parameters.properties.path && h.tools.get("ls").parameters.properties.limit);
  const psProps = h.tools.get("powershell").parameters.properties;
  assert.ok(psProps.command && psProps.timeout);

  // powershell never executes — neither remotely nor locally
  const before = transport.calls.length + transport.streams.length;
  await assert.rejects(h.exec("powershell", { command: "Get-ChildItem" }), (error) =>
    /not available for this remote SSH workspace/i.test(error.message) && /bash/i.test(error.message),
  );
  assert.equal(transport.calls.length + transport.streams.length, before);
});

// ============================================================================
// read / write / edit
// ============================================================================

test("read executes on the remote workspace and reports remote paths", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const files = new Map([["/home/user/project/src/a.ts", "line one\nline two\nline three\n"]]);
  const transport = makeFakeTransport({
    handler(command) {
      if (command.startsWith("[ -r ")) {
        const target = unquote(command.slice("[ -r ".length, -" ]".length));
        return files.has(target) ? { stdout: "", exitCode: 0 } : { stdout: "", stderr: "no", exitCode: 1 };
      }
      if (command.startsWith("cat -- ")) {
        const target = unquote(command.slice("cat -- ".length).trim());
        return files.has(target)
          ? { stdout: files.get(target), exitCode: 0 }
          : { stdout: "", stderr: `cat: ${target}: No such file or directory\n`, exitCode: 1 };
      }
      if (command.startsWith("head -c 256")) return { stdout: "plain text\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    },
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const result = await h.exec("read", { path: "src/a.ts" });
  // three remote calls (access, image sniff, cat) with quoted remote paths
  assert.deepEqual(transport.calls.map((c) => c.command), [
    "[ -r '/home/user/project/src/a.ts' ]",
    "head -c 256 -- '/home/user/project/src/a.ts'",
    "cat -- '/home/user/project/src/a.ts'",
  ]);
  assert.ok(result.content[0].text.includes("line two"), result.content[0].text);
  assert.ok(!result.content[0].text.includes(localRoot));
  // offset/limit semantics preserved
  const page = await h.exec("read", { path: "src/a.ts", offset: 2, limit: 1 });
  assert.ok(page.content[0].text.includes("line two"));
  // missing remote file → explicit error naming the remote path
  await assert.rejects(h.exec("read", { path: "missing.ts" }), /missing\.ts/);
});

test("write targets the remote via stdin, never the local host", async () => {
  const { localRoot, dir } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const transport = makeFakeTransport();
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const content = "x".repeat(200_000) + "\n";
  const result = await h.exec("write", { path: "src/new dir/notes.txt", content });
  // one SSH stream: `cat > 'remote path'`, payload on stdin (never argv)
  assert.equal(transport.streams.length, 1);
  assert.equal(transport.streams[0].command, "cat > '/home/user/project/src/new dir/notes.txt'");
  assert.equal(transport.streams[0].stdin, content);
  assert.ok(!transport.streams[0].command.includes("xxxx"));
  // parent directory created on the remote
  assert.ok(transport.calls.some((c) => c.command === "mkdir -p '/home/user/project/src/new dir'"));
  // result text shows the remote path, not the internal virtual one
  const text = result.content[0].text;
  assert.ok(text.includes("/home/user/project/src/new dir/notes.txt"), text);
  assert.ok(!text.includes(localRoot));
  // nothing was created on the host
  assert.equal(fs.existsSync(path.join(localRoot, "home", "user", "project")), false);
  assert.equal(fs.existsSync(path.join(dir, "src")), false);
  // host path → explicit rejection, nothing local written
  const hostFile = path.join(dir, "evil.ts");
  await assert.rejects(h.exec("write", { path: hostFile, content: "no" }), /not a remote project path/);
  assert.equal(fs.existsSync(hostFile), false);
});

test("edit reads/writes on the remote and rejects host paths", async () => {
  const { localRoot, dir } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const files = new Map([["/home/user/project/src/a.ts", "old text here\n"]]);
  let written = null;
  const transport = makeFakeTransport({
    handler(command, opts) {
      if (command.includes("[ -r ") && command.includes("[ -w ")) return { stdout: "", exitCode: 0 };
      if (command.startsWith("cat -- ")) {
        const target = unquote(command.slice("cat -- ".length).trim());
        return files.has(target) ? { stdout: files.get(target), exitCode: 0 } : { stdout: "", stderr: "no", exitCode: 1 };
      }
      if (command.startsWith("cat > ")) {
        written = { target: unquote(command.slice("cat > ".length).trim()), stdin: opts.stdin };
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    },
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const result = await h.exec("edit", {
    path: "src/a.ts",
    edits: [{ oldText: "old text here", newText: "new text here" }],
  });
  assert.equal(written?.target, "/home/user/project/src/a.ts");
  assert.equal(written?.stdin, "new text here\n");
  // details (diff/patch) show the remote path, not the internal virtual one
  assert.ok(result.details.diff.includes("new text here"), result.details.diff);
  assert.ok(result.details.patch.includes("/home/user/project/src/a.ts"), result.details.patch);
  assert.ok(!result.details.patch.includes(localRoot));
  assert.ok(result.content[0].text.includes("/home/user/project/src/a.ts"));
  // host path → explicit rejection
  await assert.rejects(
    h.exec("edit", { path: path.join(dir, "local.ts"), edits: [{ oldText: "a", newText: "b" }] }),
    /not a remote project path/,
  );
});

// ============================================================================
// bash / user_bash
// ============================================================================

test("bash runs remotely via explicit bash -c with safe cd-or-exit", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const transport = makeFakeTransport({
    handler: (command) => (command.includes("echo done") ? { stdout: "done\n", exitCode: 0 } : { stdout: "", exitCode: 0 }),
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const result = await h.exec("bash", { command: "echo done" });
  assert.ok(result.content[0].text.includes("done"));
  // explicit bash -c with the cd-or-exit line before the user command
  assert.equal(
    transport.streams.at(-1).command,
    `bash -c ${quoteShellArg("cd '/home/user/project' || exit\necho done")}`,
  );
  // multi-statement command: nothing can run before cd-or-exit
  await h.exec("bash", { command: "true; echo leaked" });
  assert.equal(
    transport.streams.at(-1).command,
    `bash -c ${quoteShellArg("cd '/home/user/project' || exit\ntrue; echo leaked")}`,
  );
  // non-zero exit → SDK-formatted error
  const failH = buildExtension({
    workspace: ws,
    sessionCwd: localRoot,
    transport: makeFakeTransport({ handler: () => ({ stdout: "boom\n", exitCode: 3 }) }),
  });
  await assert.rejects(failH.exec("bash", { command: "false" }), /exited with code 3/);
});

test("user_bash (!/!!) and exported bash operations use the same remote routing", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const transport = makeFakeTransport();
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const userBashHandlers = h.handlers.get("user_bash") ?? [];
  assert.equal(userBashHandlers.length, 1);
  const returned = userBashHandlers[0]({ type: "user_bash", command: "echo from-user-bash" });
  assert.ok(returned?.operations, "user_bash must return remote operations");
  const { exitCode } = await returned.operations.exec("echo from-user-bash", localRoot, { onData: () => {} });
  assert.equal(exitCode, 0);
  assert.equal(
    transport.streams.at(-1).command,
    `bash -c ${quoteShellArg("cd '/home/user/project' || exit\necho from-user-bash")}`,
  );
  // exported createRemoteBashOperations (used by rpc-manager for `!` commands)
  const ops = createRemoteBashOperations(ws, localRoot, { transport });
  await ops.exec("pwd", localRoot, { onData: () => {} });
  assert.ok(transport.streams.at(-1).command.startsWith("bash -c "));
});

// ============================================================================
// grep
// ============================================================================

function makeGrepTransport({ rgStdout, remoteFiles = new Map(), noRg = false } = {}) {
  return makeFakeTransport({
    handler(command) {
      if (noRg) return { stdout: "", stderr: "PIWEB_REMOTE_NO_RG\n", exitCode: 71 };
      if (command.includes("rg --json")) return { stdout: rgStdout ?? "", exitCode: 0 };
      if (command.startsWith("cd '/home/user/project' || exit 1\nfor f in")) {
        const marker = command.match(/printf '%s:%s\\n' "([A-Za-z0-9_]+)"/)?.[1];
        const fileSpec = command.match(/for f in (.+); do/)?.[1] ?? "";
        const files = fileSpec.split(" ").map((s) => unquote(s));
        let out = "";
        for (const file of files) out += `${marker}:${file}\n${remoteFiles.get(file) ?? ""}`;
        return { stdout: out, exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    },
  });
}

test("grep runs remote ripgrep with the original parameter semantics", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const rgStdout = [
    { type: "match", data: { path: { text: "src/a.ts" }, line_number: 2, lines: { text: "hello world\n" } } },
    { type: "match", data: { path: { text: "src/b.ts" }, line_number: 7, lines: { text: "say hello\n" } } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  const transport = makeGrepTransport({ rgStdout });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });

  const result = await h.exec("grep", { pattern: "hello" });
  assert.ok(result.content[0].text.includes("src/a.ts:2: hello world"), result.content[0].text);
  assert.ok(result.content[0].text.includes("src/b.ts:7: say hello"), result.content[0].text);
  const cmd = transport.calls.at(-1).command;
  assert.ok(cmd.includes("cd '/home/user/project' || exit 1"), cmd);
  assert.ok(cmd.includes("rg --json --line-number --color=never --hidden"), cmd);
  assert.ok(cmd.endsWith(`-- 'hello' '.'`), cmd);

  // subdirectory target
  await h.exec("grep", { pattern: "hello", path: "src" });
  assert.ok(transport.calls.at(-1).command.endsWith(`-- 'hello' 'src'`));
  // literal / ignoreCase / glob flag semantics
  await h.exec("grep", { pattern: "a.c", literal: true, ignoreCase: true, glob: "*.ts" });
  const flagsCmd = transport.calls.at(-1).command;
  assert.ok(flagsCmd.includes("--ignore-case"), flagsCmd);
  assert.ok(flagsCmd.includes("--fixed-strings"), flagsCmd);
  assert.ok(flagsCmd.includes("--glob '*.ts'"), flagsCmd);

  // match limit → details + notice
  const limited = await h.exec("grep", { pattern: "hello", limit: 1 });
  assert.equal(limited.details.matchLimitReached, 1);
  assert.ok(limited.content[0].text.includes("1 matches limit reached"));

  // no matches
  const none = buildExtension({
    workspace: ws,
    sessionCwd: localRoot,
    transport: makeGrepTransport({ rgStdout: "" }),
  });
  assert.ok((await none.exec("grep", { pattern: "zzz" })).content[0].text.includes("No matches found"));

  // missing rg → explicit error, never installed
  const noRg = buildExtension({ workspace: ws, sessionCwd: localRoot, transport: makeGrepTransport({ noRg: true }) });
  await assert.rejects(noRg.exec("grep", { pattern: "x" }), /ripgrep \(rg\) is not installed/);
  // invalid path → explicit rejection
  await assert.rejects(h.exec("grep", { pattern: "x", path: "/etc" }), /not a remote project path/);
});

test("grep context lines are fetched remotely in one batched call", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const rgStdout =
    JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 2, lines: { text: "l2\n" } } }) + "\n";
  const transport = makeGrepTransport({ rgStdout, remoteFiles: new Map([["src/a.ts", "l1\nl2\nl3\n"]]) });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const result = await h.exec("grep", { pattern: "l2", context: 1, path: "src/a.ts" });
  const text = result.content[0].text;
  assert.ok(text.includes("a.ts-1- l1"), text);
  assert.ok(text.includes("a.ts:2: l2"), text);
  assert.ok(text.includes("a.ts-3- l3"), text);
  const fetchCalls = transport.calls.filter((c) => c.command.startsWith("cd '/home/user/project' || exit 1\nfor f in"));
  assert.equal(fetchCalls.length, 1);
});

// ============================================================================
// find / ls
// ============================================================================

test("find globs on the remote (fd or find fallback) and rejects invalid paths", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const transport = makeFakeTransport({
    handler(command) {
      if (command.startsWith("[ -e ")) {
        const target = unquote(command.slice("[ -e ".length, -" ]".length));
        return target.endsWith("src/missing") ? { stdout: "", exitCode: 1 } : { stdout: "", exitCode: 0 };
      }
      if (command.includes("find . -type f -name")) return { stdout: "src/a.ts\nsrc/sub/b.ts\n", exitCode: 0 };
      if (command.includes("fd --glob")) return { stdout: "src/a.ts\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    },
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  const result = await h.exec("find", { pattern: "*.ts" });
  assert.ok(result.content[0].text.includes("src/a.ts"));
  assert.ok(result.content[0].text.includes("src/sub/b.ts"));
  const cmd = transport.calls.at(-1).command;
  assert.ok(cmd.includes(`find . -type f -name '*.ts' | head -n`), cmd);
  // path patterns use fd with --full-path
  await h.exec("find", { pattern: "src/**/*.ts" });
  const fdCmd = transport.calls.at(-1).command;
  assert.ok(fdCmd.includes("fd --glob"), fdCmd);
  assert.ok(fdCmd.includes("--full-path"), fdCmd);
  assert.ok(fdCmd.includes("'**/src/**/*.ts'"), fdCmd);
  // missing remote path → explicit "Path not found" with the remote path
  await assert.rejects(h.exec("find", { pattern: "*.ts", path: "src/missing" }), /Path not found: \/home\/user\/project\/src\/missing/);
  // invalid path (outside the workspace) → explicit rejection, no host fallback
  await assert.rejects(h.exec("find", { pattern: "*.ts", path: "/etc/hosts" }), /not a remote project path/);
  // path pattern without fd on the remote → explicit error, never installed
  const noFd = buildExtension({
    workspace: ws,
    sessionCwd: localRoot,
    transport: makeFakeTransport({
      handler(command) {
        if (command.startsWith("[ -e ")) return { stdout: "", exitCode: 0 };
        return { stdout: "", stderr: "PIWEB_REMOTE_FIND_NEEDS_FD\n", exitCode: 2 };
      },
    }),
  });
  await assert.rejects(noFd.exec("find", { pattern: "src/**/*.ts" }), /fd is not installed/);
});

test("ls lists the remote directory in one call", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const listing = makeFakeTransport({
    handler: () => ({ stdout: "f\tAlpha.ts\nd\tsub\nf\tzeta.ts\n", exitCode: 0 }),
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport: listing });
  const result = await h.exec("ls", {});
  assert.equal(result.content[0].text, "Alpha.ts\nsub/\nzeta.ts");
  const cmd = listing.calls.at(-1).command;
  // bashisms (shopt) must not depend on the remote login shell
  assert.ok(cmd.startsWith("bash -c "), cmd);
  assert.ok(cmd.includes("shopt -s nullglob dotglob"), cmd);
  // limit
  const limited = await h.exec("ls", { limit: 2 });
  assert.ok(limited.content[0].text.startsWith("Alpha.ts\nsub/\n"), limited.content[0].text);
  assert.equal(limited.details.entryLimitReached, 2);
  assert.ok(limited.content[0].text.includes("2 entries limit reached"));
  // missing / not-a-directory
  const missing = buildExtension({
    workspace: ws,
    sessionCwd: localRoot,
    transport: makeFakeTransport({ handler: () => ({ stdout: "MISSING\n", exitCode: 1 }) }),
  });
  await assert.rejects(missing.exec("ls", {}), /Path not found: \/home\/user\/project/);
  const notDir = buildExtension({
    workspace: ws,
    sessionCwd: localRoot,
    transport: makeFakeTransport({ handler: () => ({ stdout: "NOTDIR\n", exitCode: 1 }) }),
  });
  await assert.rejects(notDir.exec("ls", { path: "src/a.ts" }), /Not a directory: \/home\/user\/project\/src\/a\.ts/);
  // invalid path → explicit rejection
  await assert.rejects(h.exec("ls", { path: "C:\\nope" }), /not a remote project path/);
});

// ============================================================================
// Local resource reads
// ============================================================================

test("read serves exact local resource paths (no SSH) and marks them local host files", async () => {
  const { localRoot, dir } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const skillDir = path.join(dir, "skills", "my-skill");
  fs.mkdirSync(path.join(skillDir, "notes"), { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, "# My Skill\nlocal body\n");
  const nestedFile = path.join(skillDir, "notes", "detail.md");
  fs.writeFileSync(nestedFile, "nested detail\n");
  const contextFile = path.join(dir, "context.md");
  fs.writeFileSync(contextFile, "context body\n");

  const transport = makeFakeTransport({
    handler(command) {
      if (command === "cat -- '/home/user/project/SKILL.md'") return { stdout: "remote skill\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    },
  });
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  await h.fire("before_agent_start", systemPromptEvent(localRoot, {
    skills: [{ name: "my-skill", description: "d", filePath: skillFile, baseDir: skillDir, disableModelInvocation: false }],
    contextFiles: [{ path: contextFile }],
  }));

  // skill file + nested file: local, no SSH
  const skillResult = await h.exec("read", { path: skillFile });
  assert.ok(skillResult.content[0].text.startsWith("[local host file:"), skillResult.content[0].text);
  assert.ok(skillResult.content[0].text.includes("local body"));
  const nestedResult = await h.exec("read", { path: nestedFile });
  assert.ok(nestedResult.content[0].text.includes("nested detail"));
  // context file: local
  const ctxResult = await h.exec("read", { path: contextFile });
  assert.ok(ctxResult.content[0].text.includes("context body"));
  // still zero remote calls
  assert.equal(transport.calls.length, 0);
  assert.equal(transport.streams.length, 0);

  // remote paths still win over any local interpretation
  await h.exec("read", { path: "SKILL.md" });
  assert.ok(transport.calls.some((c) => c.command === "[ -r '/home/user/project/SKILL.md' ]"));
  assert.ok(transport.calls.some((c) => c.command === "cat -- '/home/user/project/SKILL.md'"));
  const callsAfterRemote = transport.calls.length;

  // a remote POSIX context path is NOT a host path: rejected, no local read
  await h.fire("before_agent_start", systemPromptEvent(localRoot, {
    contextFiles: [{ path: "/nonexistent-pi-web-remote/AGENTS.md" }],
  }));
  await assert.rejects(h.exec("read", { path: "/nonexistent-pi-web-remote/AGENTS.md" }), /not a remote project path/);
  assert.equal(transport.calls.length, callsAfterRemote);

  // unregistered host file → rejected (no agent-dir fallback)
  const randomFile = path.join(os.tmpdir(), `pi-web-remote-agent-unknown-${process.pid}.md`);
  fs.writeFileSync(randomFile, "nope\n");
  await assert.rejects(h.exec("read", { path: randomFile }), /not a remote project path/);
  fs.rmSync(randomFile, { force: true });
});

test("symlinked skill resources cannot escape the registered root", {
  skip: process.platform === "win32" ? "posix only" : false,
}, async () => {
  const { localRoot, dir } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const outsideDir = path.join(dir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "secret.md"), "secret content\n");
  const skillDir = path.join(dir, "skills2", "s");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, "ok\n");
  fs.symlinkSync(outsideDir, path.join(skillDir, "escape"));

  const transport = makeFakeTransport();
  const h = buildExtension({ workspace: ws, sessionCwd: localRoot, transport });
  await h.fire("before_agent_start", systemPromptEvent(localRoot, {
    skills: [{ name: "s", description: "d", filePath: skillFile, baseDir: skillDir, disableModelInvocation: false }],
  }));
  const ok = await h.exec("read", { path: skillFile });
  assert.ok(ok.content[0].text.includes("ok"));
  await assert.rejects(h.exec("read", { path: path.join(skillDir, "escape", "secret.md") }), /not a remote project path/);
  assert.equal(transport.calls.length, 0);
});

// ============================================================================
// System prompt
// ============================================================================

test("before_agent_start replaces the session cwd with the effective remote directory", async () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const sessionCwd = path.join(localRoot, "sub");
  fs.mkdirSync(sessionCwd, { recursive: true });
  const transport = makeFakeTransport();
  const h = buildExtension({ workspace: ws, sessionCwd, transport });
  const [result] = await h.fire("before_agent_start", systemPromptEvent(sessionCwd));
  const prompt = result.systemPrompt;
  // exactly one cwd line, pointing at the remote session directory (not the root)
  const cwdLines = prompt.match(/^Current working directory: .*$/gm) ?? [];
  assert.equal(cwdLines.length, 1, prompt);
  assert.equal(cwdLines[0], "Current working directory: /home/user/project/sub (remote workspace via SSH: user@example.com)");
  // original body preserved, environment section appended
  assert.ok(prompt.startsWith("You are an agent."));
  assert.ok(prompt.includes("# Execution environment (pi-web remote workspace)"));
  assert.ok(prompt.includes("Current remote working directory: /home/user/project/sub"));
  assert.ok(prompt.includes("workspace root: /home/user/project"));
  assert.ok(prompt.includes("NOT automatically remote"));
  assert.ok(prompt.includes("Windows paths"));
});

test("remoteEnvironmentPrompt documents the execution identity", () => {
  const { localRoot } = makeTempRoot();
  const ws = makeWorkspace(localRoot);
  const prompt = remoteEnvironmentPrompt(ws, path.join(localRoot, "sub"));
  assert.ok(prompt.includes("Agent host: local"));
  assert.ok(prompt.includes("host: user@example.com, workspace root: /home/user/project"));
  assert.ok(prompt.includes("Current remote working directory: /home/user/project/sub"));
  assert.ok(prompt.includes("Relative paths resolve against /home/user/project/sub"));
  assert.ok(prompt.includes("read may open exact local resource files"));
  assert.ok(prompt.includes("bash, non-login, non-interactive"));
});

// ============================================================================
// Extension preference / legacy SSH filtering
// ============================================================================

function fakeExtension({ name, path: extPath, tools = [], handlers = [], flags = [] }) {
  return {
    name,
    path: extPath,
    resolvedPath: extPath,
    hidden: false,
    sourceInfo: { source: "user", scope: "global", origin: "user" },
    tools: new Map(tools.map((t) => [t, { name: t }])),
    handlers: new Map(handlers.map((h) => [h, []])),
    flags: new Map(flags.map((f) => [f, {}])),
  };
}

test("preferRemoteWorkspaceExtension: legacy filtered, remote host owns project tools", () => {
  assert.equal(REMOTE_AGENT_EXTENSION_PATH, "<inline:pi-web-remote-agent>");
  const legacy = fakeExtension({
    name: "ssh",
    path: "/agent/ssh/extensions/ssh.ts",
    tools: ["read", "write", "edit", "bash", "ls", "grep", "find"],
    handlers: ["user_bash", "before_agent_start"],
    flags: ["ssh"],
  });
  const unrelated = fakeExtension({
    name: "ssh-tools",
    path: "/agent/ssh-tools/extension.ts",
    tools: ["ssh_helper"],
    handlers: ["user_bash", "before_agent_start"],
  });
  const other = fakeExtension({
    name: "other",
    path: "/agent/other/extension.ts",
    tools: ["bash", "custom"],
    handlers: ["tool_call"],
  });
  const host = fakeExtension({
    name: "pi-web-remote-agent",
    path: REMOTE_AGENT_EXTENSION_PATH,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"],
  });
  const base = {
    extensions: [legacy, unrelated, other, host],
    diagnostics: [],
    errors: [
      { path: REMOTE_AGENT_EXTENSION_PATH, error: 'Tool "bash" conflicts with /agent/other/extension.ts' },
      { path: other.path, error: "unrelated error" },
    ],
  };

  // detection: only the trusted legacy signature (name alone is not enough)
  assert.equal(isLegacySshExtension(legacy), true);
  assert.equal(isLegacySshExtension(unrelated), false);
  assert.equal(isLegacySshExtension(other), false);
  assert.equal(isLegacySshExtension(fakeExtension({ name: "ssh", path: "C:\\agent\\ssh\\extensions\\ssh.ts" })), true);

  // remote: host first, legacy gone, unrelated kept, stale conflict cleaned
  const remote = preferRemoteWorkspaceExtension(base, true);
  assert.deepEqual(remote.extensions.map((e) => e.name), ["pi-web-remote-agent", "ssh-tools", "other"]);
  assert.equal(remote.errors.length, 1);
  assert.equal(remote.errors[0].path, other.path);
  // other extensions' tools are preserved (they just lose the name race)
  assert.ok(remote.extensions[2].tools.has("bash"));

  // local: legacy filtered, order otherwise untouched
  const local = preferRemoteWorkspaceExtension(base, false);
  assert.deepEqual(local.extensions.map((e) => e.name), ["ssh-tools", "other", "pi-web-remote-agent"]);
  assert.equal(local.errors.length, 2);

  // no legacy → no copy
  const clean = { extensions: [unrelated], diagnostics: [], errors: [] };
  assert.equal(filterLegacySshExtension(clean), clean);
  assert.equal(preferRemoteWorkspaceExtension(clean, false), clean);
});

// ============================================================================
// Transport (fake child process, no real SSH)
// ============================================================================

test("transport: exec collects output; defaults are bounded", async () => {
  assert.equal(REMOTE_EXEC_DEFAULT_TIMEOUT_MS, 30_000);
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: () => makeFakeChild({ stdout: "out\n", stderr: "err\n", exitCode: 2 }).child,
  });
  const result = await transport.exec("cmd");
  assert.equal(result.stdout.toString("utf8"), "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.exitCode, 2);
});

test("transport: exec timeout kills the ssh process and rejects timeout:<s>", async () => {
  let made;
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: () => {
      made = makeFakeChild({ hang: true });
      return made.child;
    },
  });
  const t0 = Date.now();
  await assert.rejects(transport.exec("sleep 999", { timeoutMs: 40 }), /timeout:0\.04/);
  assert.equal(made.child.killed, true);
  assert.ok(Date.now() - t0 < 2000);
});

test("transport: abort kills the ssh process", async () => {
  const ac = new AbortController();
  let made;
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: () => {
      made = makeFakeChild({ hang: true });
      return made.child;
    },
  });
  const promise = transport.exec("sleep 999", { signal: ac.signal, timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(promise, /aborted/);
  assert.equal(made.child.killed, true);
});

test("transport: output beyond the cap is rejected and killed", async () => {
  let made;
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: () => {
      made = makeFakeChild({ stdout: "x".repeat(4096) });
      return made.child;
    },
    maxOutputBytes: 1024,
  });
  await assert.rejects(transport.exec("yes | head -c 4096"), /output limit exceeded/);
  assert.equal(made.child.killed, true);
});

test("transport: stream timeout rejects timeout:<seconds> (bash semantics)", async () => {
  let made;
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: () => {
      made = makeFakeChild({ hang: true });
      return made.child;
    },
  });
  await assert.rejects(transport.stream("sleep 999", { onData: () => {}, timeout: 0.02 }), /timeout:0\.02/);
  assert.equal(made.child.killed, true);
});

test("transport: ssh is key-only; large payloads go through stdin, never argv", async () => {
  let seen;
  let made;
  const transport = createRemoteAgentTransport("user@example.com", {
    spawn: (command, args, useStdin) => {
      seen = { command, args, useStdin };
      made = makeFakeChild({ exitCode: 0 });
      return made.child;
    },
  });
  const payload = "P".repeat(100_000);
  const exitCode = await transport.stream("cat > '/big/file.txt'", { onData: () => {}, stdin: payload, timeout: 300 });
  assert.equal(exitCode, 0);
  assert.equal(seen.command, "ssh");
  assert.ok(seen.args.includes("BatchMode=yes"));
  assert.ok(seen.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(seen.args.includes("ConnectTimeout=10"));
  assert.equal(seen.args[seen.args.length - 2], "user@example.com");
  assert.equal(seen.args[seen.args.length - 1], "cat > '/big/file.txt'");
  assert.equal(seen.useStdin, true);
  assert.ok(!seen.args.some((arg) => arg.includes("P".repeat(50))), "payload must not be in argv");
  assert.equal(made.getStdin().toString("utf8"), payload);
});

test("file tools pass each call's cancellation signal through every SSH operation", async () => {
  const { localRoot } = makeTempRoot();
  const workspace = makeWorkspace(localRoot);
  const seen = [];
  const transport = {
    async exec(_command, options) {
      seen.push(options?.signal);
      return { stdout: Buffer.from("before\n"), stderr: "", exitCode: 0 };
    },
    async stream(_command, options) {
      seen.push(options?.signal);
      return 0;
    },
  };
  const h = buildExtension({ workspace, sessionCwd: localRoot, transport });
  for (const [name, params] of [
    ["read", { path: "file.txt" }],
    ["write", { path: "file.txt", content: "after\n" }],
    ["edit", { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] }],
    ["find", { pattern: "*.txt" }],
  ]) {
    seen.length = 0;
    const controller = new AbortController();
    await h.exec(name, params, controller.signal);
    assert.ok(seen.length > 0, name);
    assert.ok(seen.every((signal) => signal === controller.signal), name);
  }
});

test("transport cancellation and deadlines settle even when killed SSH emits no close", async () => {
  for (const abort of [false, true]) {
    const { child } = makeFakeChild({ hang: true });
    child.kill = () => { child.killed = true; return true; };
    const transport = createRemoteAgentTransport("dev@example.invalid", { spawn: () => child });
    const controller = new AbortController();
    const result = transport.exec("true", { signal: controller.signal, timeoutMs: 10 });
    if (abort) controller.abort();
    await assert.rejects(result, abort ? /aborted/ : /timeout:/);
    assert.equal(child.killed, true);
  }
});

test("a subdirectory session resolves relative files but retains the full workspace boundary", () => {
  const { localRoot } = makeTempRoot();
  const workspace = makeWorkspace(localRoot);
  const mapping = createRemoteAgentPathMapping(workspace, path.join(localRoot, "src"));
  assert.equal(mapping.remoteBase, "/home/user/project/src");
  assert.equal(mapping.toRemotePath("index.ts"), "/home/user/project/src/index.ts");
  assert.equal(mapping.toRemotePath("../README.md"), "/home/user/project/README.md");
  assert.equal(mapping.toRemotePath("/home/user/project/README.md"), "/home/user/project/README.md");
  assert.equal(mapping.toRemotePath("../../secret"), null);
  const virtual = mapping.virtualHostPath("/home/user/project/README.md");
  assert.equal(virtual, path.join(localRoot, "README.md"));
  assert.equal(mapping.fromVirtualHostPath(virtual), "/home/user/project/README.md");
});

test("fd flags stay before the argument terminator outside a Git root", async () => {
  const { buildRemoteFindCommand } = await createJiti(import.meta.url).import("./remote-agent-transport.ts");
  const command = buildRemoteFindCommand("/project/src", "*.ts", 10);
  const branch = command.split("\n").find((line) => line.includes("--no-require-git"));
  assert.ok(branch.indexOf("--no-require-git") < branch.indexOf(" -- "));
});
