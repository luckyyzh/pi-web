import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  return import("./git-status.ts");
}

async function loadGitChanges() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./git-changes.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

// ============================================================================
// Remote workspace support (persisted binding, stubbed SSH — no real ssh)
// ============================================================================

/** Register a workspace fully inside a temp storage; never touches user config. */
async function makeRemoteFixture(t, { host = "dev@example.invalid", remoteCwd = "/home/dev/mono/app" } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-remote-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const storage = {
    remoteBase: path.join(temp, "remote"),
    metadataDir: path.join(temp, "meta"),
  };
  const { registerRemoteWorkspace, resolveRemoteWorkspace } = await import("./remote-workspace.ts");
  const workspace = registerRemoteWorkspace(host, remoteCwd, storage);
  return { temp, storage, workspace, resolve: (p) => resolveRemoteWorkspace(p, storage) };
}

/** Stub sshExec dispatching on command substrings; records every call. */
function makeSshExec(handlers) {
  const calls = [];
  const exec = async (host, command, timeoutMs, options = {}) => {
    calls.push({ host, command, timeoutMs, options });
    const handler = handlers.find(([match]) => command.includes(match));
    if (!handler) throw new Error(`Unexpected remote git command: ${command}`);
    const result = handler[1];
    if (result instanceof Error) throw result;
    options.onStdout?.(Buffer.from(result));
    return result;
  };
  return { exec, calls };
}

function mustNotRun() {
  return async () => { throw new Error("local fallback must not run"); };
}

test("getGitStatus: remote repo above the workspace shows only the workspace subtree", async (t) => {
  const { getGitStatus, setGitChangesDepsForTests } = await loadGitChanges();
  const fixture = await makeRemoteFixture(t);
  setGitChangesDepsForTests({
    resolveWorkspace: fixture.resolve,
    sshExec: makeSshExec([
      ["--show-toplevel", "/home/dev/mono\n"],
      ["'--numstat' 'HEAD' '--' 'app'", "10\t2\tapp/src/a.ts\n"],
      ["'--porcelain=v1'", " M app/src/a.ts\0?? app/new.txt\0 M docs/b.md\0D  app/old.ts\0"],
    ]).exec,
    sshReadTextFile: mustNotRun(),
  });
  t.after(() => setGitChangesDepsForTests(null));

  const cwd = fixture.workspace.localRoot;
  const status = await getGitStatus(cwd);

  assert.equal(status.isGitRepository, true);
  // The UI keeps seeing local (shadow) paths, rooted at the workspace.
  assert.equal(status.repositoryRoot, fixture.workspace.localRoot);
  assert.deepEqual(status.files.map((f) => f.filePath), [
    path.join(fixture.workspace.localRoot, "src", "a.ts"),
    path.join(fixture.workspace.localRoot, "new.txt"),
    path.join(fixture.workspace.localRoot, "old.ts"),
  ]);
  assert.deepEqual(status.files.map((f) => f.status), ["modified", "untracked", "deleted"]);
  // Remote status never downloads untracked contents to count lines.
  assert.equal(status.additions, 10);
  assert.equal(status.deletions, 2);
  assert.equal(status.lineStatsTruncated, true);
});

test("getGitStatus: every remote call uses the bound workspace and single-quoted POSIX paths", async (t) => {
  const { getGitStatus, setGitChangesDepsForTests } = await loadGitChanges();
  // A workspace path containing a single quote: naive JSON/quoting would let
  // the shell interpret the remainder of the command.
  const fixture = await makeRemoteFixture(t, { remoteCwd: "/home/dev/o'brien/app" });
  const ssh = makeSshExec([
    ["--show-toplevel", "/home/dev/o'brien/app\n"],
    ["'--porcelain=v1'", ""],
    ["'--numstat' 'HEAD'", ""],
  ]);
  setGitChangesDepsForTests({ resolveWorkspace: fixture.resolve, sshExec: ssh.exec });
  t.after(() => setGitChangesDepsForTests(null));

  const status = await getGitStatus(fixture.workspace.localRoot);
  assert.equal(status.isGitRepository, true);
  assert.deepEqual(status.files, []);
  assert.equal(ssh.calls[0].host, "dev@example.invalid");
  assert.equal(ssh.calls[0].command, "cd '/home/dev/o'\\''brien/app' && git rev-parse --show-toplevel");
  assert.equal(ssh.calls[1].command, "cd '/home/dev/o'\\''brien/app' && git '--literal-pathspecs' 'status' '--porcelain=v1' '-z' '--untracked-files=all' '--' '.'");
  assert.equal(ssh.calls.length, 2, "no diff scan for an empty status");
});

test("getGitStatus: unknown or orphaned shadows throw instead of falling back to local git", async (t) => {
  const { getGitStatus, setGitChangesDepsForTests } = await loadGitChanges();
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-remote-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const storage = { remoteBase: path.join(temp, "remote"), metadataDir: path.join(temp, "meta") };
  const { resolveRemoteWorkspace } = await import("./remote-workspace.ts");
  // Valid workspace id shape but no persisted metadata (orphaned shadow).
  const orphan = path.join(storage.remoteBase, "ghost_aaaabbbbcccc", "sub");
  await mkdir(orphan, { recursive: true });

  setGitChangesDepsForTests({
    resolveWorkspace: (p) => resolveRemoteWorkspace(p, storage),
    sshExec: mustNotRun(),
    sshReadTextFile: mustNotRun(),
  });
  t.after(() => setGitChangesDepsForTests(null));

  await assert.rejects(getGitStatus(orphan), /mapping is missing/);
  // Not a workspace id at all.
  await assert.rejects(getGitStatus(path.join(storage.remoteBase, "noid")), /Unknown remote workspace/);
});

test("getGitFileDiff: remote untracked and modified files; foreign paths rejected", async (t) => {
  const { getGitFileDiff, setGitChangesDepsForTests } = await loadGitChanges();
  const fixture = await makeRemoteFixture(t);
  const otherFixture = await makeRemoteFixture(t, { host: "other@example.invalid", remoteCwd: "/srv/other" });
  const readCalls = [];
  const ssh = makeSshExec([
    ["--show-toplevel", "/home/dev/mono\n"],
    ["'--porcelain=v1'", " M app/src/a.ts\0?? app/new.txt\0"],
    ["'--unified=3' 'HEAD' '--' 'app/src/a.ts'", [
      "diff --git a/app/src/a.ts b/app/src/a.ts",
      "index 1234567..89abcde 100644",
      "--- a/app/src/a.ts",
      "+++ b/app/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " ctx",
      "-a",
      "+b",
      "",
    ].join("\n")],
  ]);
  setGitChangesDepsForTests({
    resolveWorkspace: fixture.resolve,
    sshExec: ssh.exec,
    sshReadTextFile: async (host, file) => {
      readCalls.push({ host, file });
      assert.equal(host, "dev@example.invalid");
      if (file === "/home/dev/mono/app/new.txt") return { content: "hello\nworld", size: 11 };
      if (file === "/home/dev/mono/app/src/a.ts") return { content: "ctx\nb\n", size: 6 };
      throw new Error("Unexpected read: " + file);
    },
  });
  t.after(() => setGitChangesDepsForTests(null));

  const cwd = fixture.workspace.localRoot;

  // Untracked: patch synthesized from the remote file text.
  const untracked = await getGitFileDiff(cwd, path.join(cwd, "new.txt"));
  assert.equal(untracked.supported, true);
  assert.equal(untracked.status, "untracked");
  assert.ok(untracked.patch.includes("+hello"));
  assert.ok(untracked.patch.includes("+world"));
  assert.ok(untracked.patch.includes("\\ No newline at end of file"));

  // Modified: patch streamed from remote git, unmodified.
  const modified = await getGitFileDiff(cwd, path.join(cwd, "src", "a.ts"));
  assert.equal(modified.supported, true);
  assert.equal(modified.status, "modified");
  assert.ok(modified.patch.includes("@@ -1,3 +1,3 @@"));
  assert.ok(modified.patch.includes("-a"));
  assert.ok(modified.patch.includes("+b"));

  const callsBefore = ssh.calls.length;
  const readsBefore = readCalls.length;
  // A file outside the shadow root (`../` escape) and another workspace's
  // shadow path: rejected. Each request still does the same-cwd rev-parse
  // lookup, but nothing touching the rejected file (no status/diff/read).
  const escape = await getGitFileDiff(cwd, path.join(path.dirname(fixture.workspace.localRoot), "outside.txt"));
  assert.equal(escape.supported, false);
  assert.equal(ssh.calls.length, callsBefore + 1);
  assert.match(ssh.calls.at(-1).command, /rev-parse --show-toplevel$/);
  const foreign = await getGitFileDiff(cwd, path.join(otherFixture.workspace.localRoot, "x.txt"));
  assert.equal(foreign.supported, false);
  assert.equal(ssh.calls.length, callsBefore + 2);
  assert.match(ssh.calls.at(-1).command, /rev-parse --show-toplevel$/);
  assert.equal(readCalls.length, readsBefore);
});

test("getGitStatus/getGitFileDiff: local repository behavior unchanged", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-local-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  await execFileAsync("git", ["init", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Pi Web Test"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "pi-web-test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await writeFile(path.join(repo, "README.md"), "# test\nchanged\n");
  await writeFile(path.join(repo, "notes.txt"), "a\nb\n");

  const { getGitStatus, getGitFileDiff, setGitChangesDepsForTests } = await loadGitChanges();
  setGitChangesDepsForTests({ resolveWorkspace: () => null });
  t.after(() => setGitChangesDepsForTests(null));

  const status = await getGitStatus(repo);
  assert.equal(status.isGitRepository, true);
  // git prints POSIX-style roots; compare by final segment.
  assert.equal(status.repositoryRoot.split(/[\\/]/).pop(), "repo");
  assert.deepEqual(
    status.files.map((f) => [f.filePath, f.status]),
    [
      [path.join(repo, "README.md"), "modified"],
      [path.join(repo, "notes.txt"), "untracked"],
    ],
  );
  // 1 tracked added line + 2 untracked text lines.
  assert.equal(status.additions, 3);
  assert.equal(status.deletions, 0);

  const untracked = await getGitFileDiff(repo, path.join(repo, "notes.txt"));
  assert.equal(untracked.supported, true);
  assert.equal(untracked.status, "untracked");
  assert.ok(untracked.patch.includes("+a"));
  assert.ok(untracked.patch.includes("+b"));

  const outside = await getGitFileDiff(repo, path.join(temp, "elsewhere.txt"));
  assert.equal(outside.supported, false);
});

test("remote status respects a selected subdirectory and supports nested repositories", async (t) => {
  const { getGitStatus, setGitChangesDepsForTests } = await loadGitChanges();
  const fixture = await makeRemoteFixture(t);
  t.after(() => setGitChangesDepsForTests(null));
  const child = path.join(fixture.workspace.localRoot, "services");
  for (const nested of [false, true]) {
    setGitChangesDepsForTests({
      resolveWorkspace: fixture.resolve,
      sshExec: makeSshExec([
        ["--show-toplevel", nested ? "/home/dev/mono/app/services\n" : "/home/dev/mono\n"],
        ["'--numstat'", "1\t0\tfile.ts\n"],
        ["'--porcelain=v1'", nested ? " M file.ts\0" : " M app/services/file.ts\0 M app/sibling.ts\0"],
      ]).exec,
      sshReadTextFile: mustNotRun(),
    });
    const status = await getGitStatus(child);
    assert.equal(status.isGitRepository, true);
    assert.deepEqual(status.files.map((file) => file.filePath), [path.join(child, "file.ts")]);
  }
});
