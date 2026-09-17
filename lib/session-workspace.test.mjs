import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { bindSessionWorkspace } = await jiti.import("./session-workspace.ts");
const { registerRemoteWorkspace } = await jiti.import("./remote-workspace.ts");

test("remote session metadata is written once and checked when resumed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-session-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = { remoteBase: path.join(root, "remote"), metadataDir: path.join(root, "metadata") };
  const workspace = registerRemoteWorkspace("server", "/srv/project", storage);
  const entries = [];
  const manager = {
    getCwd: () => workspace.localRoot,
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  assert.deepEqual(bindSessionWorkspace(manager, storage), workspace);
  assert.deepEqual(bindSessionWorkspace(manager, storage), workspace);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.target.cwd, "/srv/project");
  entries[0].data.target.host = "other-server";
  assert.throws(() => bindSessionWorkspace(manager, storage), /different remote workspace/);
});

test("ordinary local sessions need no new metadata", () => {
  const manager = { getCwd: () => process.cwd(), appendCustomEntry: () => assert.fail("local session must stay compatible") };
  assert.equal(bindSessionWorkspace(manager), null);
});
