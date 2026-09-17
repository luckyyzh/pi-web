import assert from "node:assert/strict";
import test from "node:test";
import { newTerminalTab, nextExpectedTarget, parseWorkspaceTarget, restoreTerminalTabs, targetIdentityMatches, verifyServerTarget } from "./terminal-tab-state.ts";

test("restored workspace tabs retain terminal identity and never request a new shell", () => {
  const first = newTerminalTab("/repo/worktree-a");
  const second = newTerminalTab("/repo/worktree-b");
  assert.notEqual(first.id, second.id);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("storage corruption cannot create invalid or duplicate terminal tabs", () => {
  assert.deepEqual(restoreTerminalTabs("broken"), { tabs: [], activeId: null, open: false });
  assert.deepEqual(restoreTerminalTabs(null), { tabs: [], activeId: null, open: false });
  const tab = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [null, {}, tab, tab, { ...tab, id: "../../bad" }, { ...tab, cwd: null }],
    activeId: "missing",
  }));
  assert.deepEqual(saved, { tabs: [{ ...tab, restored: true }], activeId: null, open: false });
});

test("new tabs may carry the server-resolved target for display and restart", () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  const tab = newTerminalTab("/local/shadow/root", target);
  assert.match(tab.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(tab, { id: tab.id, cwd: "/local/shadow/root", target });
  assert.equal("target" in newTerminalTab("/local/shadow/root"), false, "pre-resolution tabs carry no target");
});

test("restored tabs keep a valid saved target; legacy storage without one still reads", () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  const first = newTerminalTab("/local/shadow/root", target);
  const second = newTerminalTab("/local/other");
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ id: first.id, cwd: "/local/shadow/root", target, restored: true }, { id: second.id, cwd: "/local/other", restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("invalid or forged saved targets are dropped while the tab survives", () => {
  const tab = newTerminalTab("/local/shadow/root");
  const forged = ["ssh", null, {}, { kind: "ssh" }, { kind: "ssh", id: "x", host: "h" }, { kind: "ssh", id: "x", host: "h", cwd: "" }, { kind: "weird", cwd: "/x" }, { kind: "local", cwd: "  " }];
  for (const target of forged) {
    const saved = restoreTerminalTabs(JSON.stringify({ tabs: [{ ...tab, target }] }));
    assert.deepEqual(saved.tabs, [{ id: tab.id, cwd: "/local/shadow/root", restored: true }], `forged target: ${JSON.stringify(target)}`);
  }
});

test("parseWorkspaceTarget accepts only well-formed local and ssh identities", () => {
  assert.deepEqual(parseWorkspaceTarget({ kind: "local", cwd: "/a" }), { kind: "local", cwd: "/a" });
  const ssh = { kind: "ssh", id: "i", host: "h", cwd: "/c" };
  assert.deepEqual(parseWorkspaceTarget({ ...ssh, extra: 1 }), ssh, "unknown fields are dropped, never forwarded");
  for (const value of [undefined, null, "ssh", 42, { kind: "ssh", id: "i", host: "h" }, { kind: "local" }, { kind: "local", cwd: 7 }]) {
    assert.equal(parseWorkspaceTarget(value), null, JSON.stringify(value));
  }
});

test("target identity comparison is strict for ssh, case-sensitive for POSIX", () => {
  const ssh = { kind: "ssh", id: "i", host: "h", cwd: "/remote" };
  assert.ok(targetIdentityMatches(ssh, { ...ssh }));
  assert.ok(!targetIdentityMatches(ssh, { ...ssh, id: "other" }));
  assert.ok(!targetIdentityMatches(ssh, { ...ssh, host: "h2" }));
  assert.ok(!targetIdentityMatches(ssh, { ...ssh, cwd: "/remote/" }));
  assert.ok(!targetIdentityMatches(ssh, { kind: "local", cwd: "/remote" }));
  // Local cwds: separators/trailing slashes are canonicalized, but POSIX
  // case must stay significant.
  assert.ok(targetIdentityMatches({ kind: "local", cwd: "/repo/a" }, { kind: "local", cwd: "/repo/a/" }));
  assert.ok(targetIdentityMatches({ kind: "local", cwd: "/repo//a" }, { kind: "local", cwd: "/repo/a" }));
  assert.ok(!targetIdentityMatches({ kind: "local", cwd: "/repo/a" }, { kind: "local", cwd: "/repo/A" }), "POSIX paths stay case-sensitive");
  assert.ok(!targetIdentityMatches({ kind: "local", cwd: "/repo/a" }, { kind: "local", cwd: "/repo/b" }));
  assert.ok(!targetIdentityMatches({ kind: "local", cwd: "/repo" }, { kind: "ssh", id: "i", host: "h", cwd: "/repo" }));
  // Only recognizable Windows drive/UNC paths fold case.
  assert.ok(targetIdentityMatches({ kind: "local", cwd: "C:\\repo\\a" }, { kind: "local", cwd: "c:/repo/A" }), "drive paths are case-insensitive");
  assert.ok(targetIdentityMatches({ kind: "local", cwd: "\\\\server\\share" }, { kind: "local", cwd: "//SERVER/Share" }), "UNC paths are case-insensitive");
  assert.ok(!targetIdentityMatches({ kind: "local", cwd: "C:\\repo\\a" }, { kind: "local", cwd: "c:/repo/b" }));
});

test("server target verification and first-identity remembering", () => {
  const ssh = { kind: "ssh", id: "i", host: "h", cwd: "/remote" };
  assert.equal(verifyServerTarget(null, ssh), null, "old storage without an expected identity accepts the server target");
  assert.equal(verifyServerTarget(ssh, { ...ssh }), null);
  assert.match(verifyServerTarget(ssh, { ...ssh, host: "h2" }), /does not match this workspace/);
  assert.match(verifyServerTarget(ssh, null), /does not match this workspace/, "a missing server target is a mismatch when expected");
  assert.equal(nextExpectedTarget(null, ssh), ssh, "the first server target is remembered");
  const kept = nextExpectedTarget(ssh, null);
  assert.equal(kept, ssh, "the remembered identity is kept");
});
