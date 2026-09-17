import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { registerRemoteWorkspace, resolveRemoteWorkspace, resolveWorkspaceTarget, listRemoteWorkspaceRoots, remotePathFor, localPathFor, quoteShellArg, sshArguments } = await jiti.import("./remote-workspace.ts");

function storage(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { remoteBase: path.join(root, "remote"), metadataDir: path.join(root, "metadata") };
}

test("remote targets remain bound independently of the currently selected host or directory", (t) => {
  const files = storage(t);
  const first = registerRemoteWorkspace("alice@server-a", "/home/alice/project", files);
  const second = registerRemoteWorkspace("server-b", "/srv/project", files);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(new Set(listRemoteWorkspaceRoots(files)), new Set([first.localRoot, second.localRoot]));
  assert.deepEqual(resolveRemoteWorkspace(first.localRoot, files), first);
  assert.deepEqual(resolveWorkspaceTarget(path.join(first.localRoot, "src"), files), {
    kind: "ssh", id: first.id, host: "alice@server-a", cwd: "/home/alice/project/src",
  });
  assert.deepEqual(registerRemoteWorkspace("alice@server-a", "/home/alice/project", files), first);
  assert.equal(resolveRemoteWorkspace(path.join(files.remoteBase, "..", "local"), files), null);
});

test("unknown legacy remote directories never become local workspaces", (t) => {
  const files = storage(t);
  const orphan = path.join(files.remoteBase, "old-host_0123456789ab");
  mkdirSync(orphan, { recursive: true });
  assert.throws(() => resolveWorkspaceTarget(orphan, files), /mapping is missing/);
  assert.throws(() => resolveWorkspaceTarget(files.remoteBase, files), /Unknown remote workspace/);
});

test("remote paths use POSIX separators and cache mapping cannot escape its root", (t) => {
  const files = storage(t);
  const workspace = registerRemoteWorkspace("server", "/projects/a directory", files);
  assert.equal(remotePathFor(workspace, path.join(workspace.localRoot, "src", "app.ts")), "/projects/a directory/src/app.ts");
  assert.equal(localPathFor(workspace, "/projects/a directory/src/app.ts"), path.join(workspace.localRoot, "src", "app.ts"));
  assert.equal(localPathFor(workspace, "/projects/other/secrets"), null);
  assert.throws(() => remotePathFor(workspace, `${workspace.localRoot}-other`), /does not belong/);
  assert.throws(() => registerRemoteWorkspace("server", "~/unresolved", files), /absolute POSIX/);
});

test("SSH destinations cannot be options and remote arguments are shell quoted", () => {
  assert.throws(() => sshArguments("-oProxyCommand=bad", "pwd"), /Invalid SSH host/);
  assert.equal(quoteShellArg("a'$(touch x)`id`"), "'a'\\''$(touch x)`id`'");
  const args = sshArguments("user@alias", "pwd", true);
  assert.equal(args[0], "-tt");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.deepEqual(args.slice(-2), ["user@alias", "pwd"]);
  assert.throws(() => quoteShellArg("bad\0name"), /NUL/);
});
