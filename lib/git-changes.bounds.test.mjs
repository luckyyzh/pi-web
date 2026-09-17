import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const subject = await createJiti(import.meta.url).import("./git-changes.ts");
const { getGitStatus, getGitFileDiff, setGitChangesDepsForTests, GIT_STATUS_MAX_FILES, GIT_STATUS_MAX_BYTES } = subject;
const exec = promisify(execFile);

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-bounds-"));
  t.after(async () => { setGitChangesDepsForTests(null); await rm(temp, { recursive: true, force: true }); });
  const storage = { remoteBase: path.join(temp, "remote"), metadataDir: path.join(temp, "meta") };
  const { registerRemoteWorkspace, resolveRemoteWorkspace } = await import("./remote-workspace.ts");
  const workspace = registerRemoteWorkspace("bound.invalid", "/root", storage);
  const calls = [];
  let reads = 0;
  const deps = {
    resolveWorkspace: (p) => resolveRemoteWorkspace(p, storage),
    sshReadTextFile: async () => { reads++; throw new Error("metadata must not read remote contents"); },
    sshExec: async (_host, command) => { calls.push(command); if (command.includes("--show-toplevel")) return "/root\n"; throw new Error("unexpected command"); },
  };
  setGitChangesDepsForTests(deps);
  return { workspace, temp, calls, deps, get reads() { return reads; } };
}

function streamCommands(f, records) {
  let emitted = 0;
  setGitChangesDepsForTests({
    resolveWorkspace: () => f.workspace,
    sshReadTextFile: async () => { throw new Error("not a metadata operation"); },
    sshExec: async (_host, command, _timeout, options) => {
      f.calls.push(command);
      if (command.includes("--show-toplevel")) return "/root\n";
      assert.match(command, /'--porcelain=v1'/);
      assert.match(command, /'--untracked-files=all'/);
      let output = "";
      for (const record of records) {
        output += record;
        emitted++;
        if (!options.onStdout(Buffer.from(record))) break;
      }
      return output;
    },
  });
  return () => emitted;
}

test("stops after the relaxed ceiling and skips all subsequent content/statistics reads", async (t) => {
  const f = await fixture(t);
  const emitted = streamCommands(f, Array.from({ length: 18542 }, (_, i) => `?? file-${i}.txt\0`));
  const status = await getGitStatus(f.workspace.localRoot);
  assert.equal(emitted(), GIT_STATUS_MAX_FILES + 1);
  assert.equal(status.files.length, GIT_STATUS_MAX_FILES);
  assert.equal(status.truncated, true);
  assert.equal(status.lineStatsTruncated, true);
  assert.equal(f.calls.length, 2);
});

test("byte limit discards a cut-off path rather than fabricating a file", async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: Math.ceil(GIT_STATUS_MAX_BYTES / 3200) + 2 }, (_, i) => `?? ${"dir/".repeat(800)}name-${i}.txt\0`);
  const emitted = streamCommands(f, records);
  const status = await getGitStatus(f.workspace.localRoot);
  assert.ok(emitted() < records.length);
  assert.equal(status.truncated, true);
  assert.ok(status.files.length < GIT_STATUS_MAX_FILES);
  assert.ok(status.files.every((file) => /name-\d+\.txt$/.test(file.filePath)));
  assert.ok(Buffer.byteLength(records.slice(0, status.files.length).join("")) <= GIT_STATUS_MAX_BYTES);
  assert.equal(f.calls.length, 2);
});

test("a rename spanning two chunks counts as one entry at the limit", async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: GIT_STATUS_MAX_FILES - 1 }, (_, i) => ` M f-${i}\0`);
  records.push("R  new-name\0", "old-name\0", "?? must-not-read\0");
  const emitted = streamCommands(f, records);
  const status = await getGitStatus(f.workspace.localRoot);
  assert.equal(emitted(), GIT_STATUS_MAX_FILES + 2);
  assert.equal(status.files.length, GIT_STATUS_MAX_FILES);
  assert.equal(status.files.at(-1).status, "renamed");
});

test("remote .ssh uses a scoped literal pathspec and never fetches key contents", async (t) => {
  const f = await fixture(t);
  setGitChangesDepsForTests({ ...f.deps, sshExec: async (_host, command) => {
    f.calls.push(command);
    if (command.includes("--show-toplevel")) return "/root\n";
    assert.match(command, /'--literal-pathspecs'.*'--' '\.ssh'$/);
    return "?? .ssh/id_example\0?? .ssh/config\0";
  } });
  const result = await getGitStatus(path.join(f.workspace.localRoot, ".ssh"));
  assert.equal(result.files.length, 2);
  assert.equal(result.lineStatsTruncated, true);
  assert.equal(result.lineStatsIncompleteReason, "remote-untracked");
  assert.equal(Boolean(result.truncated), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.reads, 0);
});

test("ordinary changes and an exact ceiling fit both finish without a false list warning", async (t) => {
  const f = await fixture(t);
  for (const size of [750, GIT_STATUS_MAX_FILES]) {
    streamCommands(f, Array.from({ length: size }, (_, i) => `?? new-folder/file-${i}.ts\0`));
    const result = await getGitStatus(f.workspace.localRoot);
    assert.equal(result.files.length, size);
    assert.equal(Boolean(result.truncated), false);
    assert.equal(result.lineStatsIncompleteReason, "remote-untracked");
  }
});

test("cancelled requests stop at the active command and never start statistics", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  setGitChangesDepsForTests({ ...f.deps, sshExec: async (_host, command, _timeout, { signal }) => {
    f.calls.push(command);
    if (command.includes("--show-toplevel")) return "/root\n";
    const pending = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    controller.abort(new Error("request closed"));
    return pending;
  } });
  await assert.rejects(getGitStatus(f.workspace.localRoot, { signal: controller.signal }), /request closed/);
  assert.equal(f.calls.length, 2);
  await assert.rejects(getGitStatus(f.workspace.localRoot, { signal: controller.signal }), /request closed/);
  assert.equal(f.calls.length, 2);
});

test("explicit diff queries only its literal file, not the whole status tree", async (t) => {
  const f = await fixture(t);
  setGitChangesDepsForTests({ ...f.deps, sshExec: async (_host, command) => {
    f.calls.push(command);
    if (command.includes("--show-toplevel")) return "/root\n";
    assert.match(command, /'--literal-pathspecs'.*'--' 'a\[1\]\.txt'$/);
    return "";
  } });
  assert.deepEqual(await getGitFileDiff(f.workspace.localRoot, path.join(f.workspace.localRoot, "a[1].txt")), { supported: false });
  assert.equal(f.reads, 0);
});

test("71 ordinary files in a new local directory are fully listed and counted", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.temp, "repo");
  await mkdir(repo);
  await exec("git", ["init", repo]);
  await mkdir(path.join(repo, "new"));
  await Promise.all(Array.from({ length: 71 }, (_, i) => writeFile(path.join(repo, "new", `${String(i).padStart(3, "0")}.txt`), "one\n")));
  setGitChangesDepsForTests({ resolveWorkspace: () => null });
  const result = await getGitStatus(repo);
  assert.equal(result.files.length, 71);
  assert.equal(result.additions, 71);
  assert.ok(result.files.every((file) => !file.isDirectory));
  assert.equal(Boolean(result.truncated), false);
  assert.equal(Boolean(result.lineStatsTruncated), false);
});
