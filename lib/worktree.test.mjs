import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

// ============================================================================
// Remote workspace support (persisted binding, no SSH, no local git)
// ============================================================================

test("remote workspace: stable project root without SSH, worktree management rejected", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-remote-worktree-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const storage = { remoteBase: path.join(temp, "remote"), metadataDir: path.join(temp, "meta") };
  const { registerRemoteWorkspace, resolveRemoteWorkspace } = await import("./remote-workspace.ts");
  const workspace = registerRemoteWorkspace("dev@example.invalid", "/home/dev/proj", storage);

  const {
    resolveProject, addWorktree, removeWorktree, listWorktrees,
    invalidateProjectCache, setWorktreeDepsForTests,
  } = await loadSubject();
  setWorktreeDepsForTests({ resolveWorkspace: (p) => resolveRemoteWorkspace(p, storage) });
  t.after(() => setWorktreeDepsForTests(null));
  t.after(() => invalidateProjectCache());
  invalidateProjectCache();

  // A subdirectory cwd still resolves to the stable workspace identity, and
  // does so statically (session-list rendering must never trigger SSH).
  const cwd = path.join(workspace.localRoot, "sub");
  const info = await resolveProject(cwd);
  assert.equal(info.projectRoot, workspace.localRoot);
  assert.equal(info.branch, null);
  assert.equal(info.isWorktree, false);
  assert.equal(info.isTopLevel, false);
  assert.deepEqual(await resolveProject(cwd), info); // cached, no re-resolution

  // Worktree management is explicitly rejected and never lands on the local machine.
  await assert.rejects(addWorktree(cwd, "feature/new"), /remote workspace/i);
  await assert.rejects(removeWorktree(cwd, path.join(cwd, "x")), /remote workspace/i);
  await assert.rejects(listWorktrees(cwd), /remote workspace/i);
  assert.ok(!existsSync(`${cwd}-worktrees`));
  assert.ok(!existsSync(`${workspace.localRoot}-worktrees`));
});

test("remote workspace: orphaned shadow returns neutral info without local git", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-web-remote-worktree-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const storage = { remoteBase: path.join(temp, "remote"), metadataDir: path.join(temp, "meta") };
  const { resolveRemoteWorkspace } = await import("./remote-workspace.ts");
  // Valid workspace id shape but no persisted metadata.
  const orphan = path.join(storage.remoteBase, "ghost_aaaabbbbcccc");
  await mkdir(orphan, { recursive: true });

  const { resolveProject, invalidateProjectCache, setWorktreeDepsForTests } = await loadSubject();
  setWorktreeDepsForTests({ resolveWorkspace: (p) => resolveRemoteWorkspace(p, storage) });
  t.after(() => setWorktreeDepsForTests(null));
  t.after(() => invalidateProjectCache());
  invalidateProjectCache();

  const info = await resolveProject(orphan);
  assert.equal(info.projectRoot, orphan);
  assert.equal(info.branch, null);
  assert.equal(info.isWorktree, false);
  assert.equal(info.isTopLevel, false);
});
