import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const fetchOffset = source.indexOf("fetchGitStatus(cwd, controller.signal)");
const effectStart = source.lastIndexOf("  useEffect(() => {", fetchOffset) + "  useEffect(() => {".length;
const effectEnd = source.indexOf("  }, [cwd, refreshKey, treeRefreshKey]);", fetchOffset);
assert.ok(fetchOffset > 0 && effectEnd > effectStart);
// Exercise the real effect body without introducing a DOM/React renderer harness.
const effect = new Function("cwd", "fetchGitStatus", "setGitFiles", "setGitLineStats", "setGitTruncated", "setGitLineStatsTruncated", "setGitLineStatsIncompleteReason", "AbortController", source.slice(effectStart, effectEnd));

function harness() {
  const state = { files: ["stale"], stats: { additions: 62, deletions: 1 }, truncated: true, partial: true, reason: "remote-untracked" };
  const requests = [];
  const load = (cwd, signal) => new Promise((resolve, reject) => requests.push({ cwd, signal, resolve, reject }));
  return { state, requests, run: (cwd) => effect(cwd, load,
    (v) => { state.files = v; }, (v) => { state.stats = v; },
    (v) => { state.truncated = v; }, (v) => { state.partial = v; }, (v) => { state.reason = v; }, AbortController) };
}

test("workspace refresh clears stale counts; cleanup aborts and stale responses are ignored", async () => {
  const h = harness();
  const cleanupOld = h.run("old-cwd");
  assert.deepEqual(h.state.files, []);
  assert.deepEqual(h.state.stats, { additions: 0, deletions: 0 });
  assert.equal(h.state.reason, undefined);
  cleanupOld();
  assert.equal(h.requests[0].signal.aborted, true);
  const cleanupNew = h.run("new-cwd");
  h.requests[0].resolve({ isGitRepository: true, files: ["stale remote"], additions: 99, deletions: 0, lineStatsTruncated: true, lineStatsIncompleteReason: "remote-untracked" });
  await Promise.resolve();
  assert.deepEqual(h.state.files, []);
  h.requests[1].resolve({ isGitRepository: true, files: ["new"], additions: 1, deletions: 0, truncated: true, lineStatsTruncated: true });
  await Promise.resolve();
  assert.deepEqual(h.state.files, ["new"]);
  assert.equal(h.state.truncated, true);
  assert.equal(h.state.partial, true);
  assert.equal(h.state.reason, undefined);
  cleanupNew();
  assert.equal(h.requests[1].signal.aborted, true);
});

test("failed status leaves cleared counts and fetch receives the abort signal", async () => {
  const h = harness();
  const cleanup = h.run("cwd");
  h.requests[0].reject(new Error("offline"));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.state.files, []);
  assert.equal(h.state.partial, false);
  assert.equal(h.state.reason, undefined);
  cleanup();
  assert.match(source, /fetch\(`\/api\/git\/status\?\$\{params\.toString\(\)\}`, \{ signal \}\)/);
});

test("partial notices are independent of collapsed/empty rows and directories cannot open a diff", () => {
  const noticeStart = source.indexOf("{(gitTruncated || gitLineStatsWarning) && (");
  const rowStart = source.indexOf("{!changesCollapsed && gitFiles.length > 0 && (", noticeStart);
  assert.ok(noticeStart > 0 && rowStart > noticeStart);
  const notice = source.slice(noticeStart, rowStart);
  assert.match(notice, /files\.listTruncated/);
  assert.match(notice, /files\.lineStatsIncomplete/);
  assert.doesNotMatch(notice, /changesCollapsed|gitFiles\.length/);
  assert.match(source, /onClick=\{isDirectory \? undefined : \(\) => onOpenFile/);
  assert.match(source, /gitTruncated \? "files.changedCountTruncated" : "files.changedCount"/);
});

test("remote-only statistics use a small hint; limits and legacy responses retain warnings", async () => {
  const trackedExpression = source.match(/const gitTrackedOnly = (.*);/)[1];
  const warningExpression = source.match(/const gitLineStatsWarning = (.*);/)[1];
  const flags = new Function("gitLineStatsTruncated", "gitLineStatsIncompleteReason", `return [${trackedExpression}, ${warningExpression}];`);
  for (const [reason, expected] of [["remote-untracked", [true, false]], ["limit-or-error", [false, true]], [undefined, [false, true]]]) {
    const h = harness();
    const cleanup = h.run("cwd");
    h.requests[0].resolve({ isGitRepository: true, files: Array(71).fill("file"), additions: 3, deletions: 1, lineStatsTruncated: true, lineStatsIncompleteReason: reason });
    await Promise.resolve();
    assert.equal(h.state.reason, reason);
    assert.equal(h.state.truncated, false);
    assert.equal(h.state.files.length, 71);
    assert.deepEqual(flags(h.state.partial, h.state.reason), expected);
    assert.deepEqual(flags(false, reason), [false, false]);
    cleanup();
    const cleanupRefresh = h.run("cwd");
    assert.equal(h.state.reason, undefined);
    assert.equal(h.state.partial, false);
    cleanupRefresh();
  }
  assert.match(source, /\{gitLineStatsWarning && \(/);
  assert.match(source, /gitTrackedOnly \? t\("files\.trackedOnlyTooltip"\)/);
  assert.match(source, /gitTrackedOnly && <span style=\{\{ color: "var\(--text-dim\)", fontSize: 10 \}\}>/);
});

test("all supported locales define the new partial-result messages", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["files.listTruncated", "files.lineStatsIncomplete", "files.changedCountTruncated", "files.trackedOnly", "files.trackedOnlyTooltip"]) {
      assert.ok(messages.includes(`"${key}":`), `${locale}: ${key}`);
    }
  }
});
