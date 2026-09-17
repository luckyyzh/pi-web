import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { readSubagentRun, readSubagentSessionResources } = await jiti.import("./subagents.ts");
const { subagentDependencyIds, subagentSoftBudget, startSubagentBudget } = await jiti.import("./subagent-coordination.ts");
const { createSubagentProgressExtension } = await jiti.import("./subagent-progress-extension.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness() {
  const sessions = new Map();
  const notices = [];
  const parent = {
    cwd: "/tmp", sessionFile: "/tmp/parent.jsonl", isAlive: () => true, isRunning: () => false,
    waitUntilReady: async () => {},
    inner: { sessionManager: { getSessionId: () => "coord-parent" }, sendCustomMessage: async (...args) => { notices.push(args); } },
  };
  sessions.set("coord-parent", parent);
  function child(id, work = async () => {}) {
    const entries = [{ type: "custom", customType: "pi-web:subagent", data: {
      version: 1, parentSessionId: "coord-parent", parentSessionPath: parent.sessionFile,
      parentToolCallId: "old", profile: "explore", description: "old", task: "old",
      runInBackground: true, createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: ["read", "report_subagent_progress"], loadSkills: false, loadExtensions: false },
    } }, { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:00:01.000Z", result: "old",
    } }];
    const calls = [], steering = [], listeners = new Set();
    let running = false, aborts = 0;
    const inner = {
      sessionId: id, sessionFile: `/tmp/${id}.jsonl`,
      sessionManager: { getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
      prompt: async (task) => { running = true; calls.push(task); try { await work(); } finally { running = false; } },
      getLastAssistantText: () => `${id} findings`,
      steer: async (text) => { steering.push(text); },
      abort: async () => { aborts++; }, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    sessions.set(id, { inner, sessionFile: inner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => running, waitUntilReady: async () => {} });
    return { entries, calls, steering, emit: (event) => { for (const listener of listeners) listener(event); }, get aborts() { return aborts; } };
  }
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id), registerSession: () => {},
    reopenSession: async (id) => sessions.get(id), resolveSessionPath: async () => null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  const resume = (id, extra = {}) => controller.extensionRuntime.resume({
    parentContext: parent.inner, parentToolCallId: `new-${id}`, sessionId: id,
    task: `Task ${id}`, description: `Describe ${id}`, runInBackground: true,
    softBudgetSeconds: 0, ...extra,
  });
  return { child, controller, resume, notices };
}

test("dependency wait does not block independent work; successful output is passed downstream", async () => {
  const h = harness(), gate = deferred();
  h.child("coord-a", () => gate.promise);
  const b = h.child("coord-b"), c = h.child("coord-c");
  const first = await h.resume("coord-a");
  const second = await h.resume("coord-b", { dependsOn: ["coord-a"] });
  assert.equal(second.run.status, "queued");
  assert.deepEqual(second.run.waitingFor, ["coord-a"]);
  assert.equal(second.run.startedAt, undefined);
  const independent = await h.resume("coord-c");
  assert.equal((await independent.completion).status, "completed");
  assert.equal(c.calls.length, 1);
  assert.equal(b.calls.length, 0);
  assert.deepEqual((await h.controller.extensionRuntime.list("coord-parent")).map((run) => run.sessionId).sort(), ["coord-a", "coord-b"]);
  assert.deepEqual(await h.controller.extensionRuntime.list("other-parent"), []);
  gate.resolve();
  await first.completion;
  const result = await second.completion;
  assert.equal(result.status, "completed");
  assert.match(b.calls[0], /coord-a findings/);
  assert.deepEqual(result.waitingFor, []);
});

test("failed dependency prevents model execution and queued cancellation releases its task", async () => {
  const h = harness(), gate = deferred();
  h.child("coord-fail", () => gate.promise);
  const dependent = h.child("coord-dependent"), cancelled = h.child("coord-cancelled");
  const first = await h.resume("coord-fail");
  const second = await h.resume("coord-dependent", { dependsOn: ["coord-fail"] });
  const third = await h.resume("coord-cancelled", { dependsOn: ["coord-fail"] });
  await h.controller.abort("coord-cancelled");
  assert.equal((await third.completion).status, "aborted");
  gate.reject(new Error("upstream failed"));
  await first.completion;
  const result = await second.completion;
  assert.equal(result.status, "failed");
  assert.match(result.error, /Dependency coord-fail failed/);
  assert.equal(dependent.calls.length, 0);
  assert.equal(cancelled.calls.length, 0);
});

test("SDK error/abort messages cannot release dependent work as a success", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const h = harness(), gate = deferred();
    const firstChild = h.child(`coord-sdk-${stopReason}`, () => gate.promise);
    const secondChild = h.child(`coord-sdk-dependent-${stopReason}`);
    const first = await h.resume(`coord-sdk-${stopReason}`);
    const second = await h.resume(`coord-sdk-dependent-${stopReason}`, { dependsOn: [`coord-sdk-${stopReason}`] });
    firstChild.emit({ type: "message_end", message: { role: "assistant", stopReason, errorMessage: "provider stopped" } });
    gate.resolve();
    assert.equal((await first.completion).status, stopReason === "aborted" ? "aborted" : "failed");
    assert.equal((await second.completion).status, "failed");
    assert.equal(secondChild.calls.length, 0);
  }
});

test("dependency validation rejects unknown, self, foreign and interrupted sessions", async () => {
  const h = harness();
  h.child("coord-validation");
  const foreign = h.child("coord-foreign");
  foreign.entries[0].data.parentSessionId = "someone-else";
  const removed = h.child("coord-removed");
  removed.entries[0].data.worktreePath = "/nonexistent/pi-web-coordination-removed-worktree";
  await assert.rejects(h.resume("coord-removed"), /worktree was removed/);
  const orphan = h.child("coord-orphan");
  orphan.entries.push({ type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "queued" } });
  for (const [ids, pattern] of [
    [["unknown"], /not a subagent/], [["coord-validation"], /itself/],
    [["coord-foreign"], /not a subagent/], [["coord-orphan"], /interrupted/],
  ]) await assert.rejects(h.resume("coord-validation", { dependsOn: ids }), pattern);
});

test("soft budget requests a checkpoint once, never aborts, and is cleared on completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(), gate = deferred();
  const child = h.child("coord-budget", () => gate.promise);
  const execution = await h.resume("coord-budget", { softBudgetSeconds: 5 });
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(child.aborts, 0);
  assert.equal(child.steering.length, 1);
  assert.match(child.steering[0], /not a stop instruction/);
  assert.ok((await h.controller.get("coord-budget")).budgetExceededAt);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1].deliverAs, "steer");
  t.mock.timers.tick(5000);
  assert.equal(child.steering.length, 1);
  gate.resolve();
  const result = await execution.completion;
  assert.equal(result.status, "completed");
  const restored = readSubagentRun(child.entries, "coord-budget", "/tmp/child.jsonl");
  assert.equal(restored.budgetExceededAt, result.budgetExceededAt);
  t.mock.timers.tick(60_000);
  assert.equal(child.steering.length, 1);
  t.mock.timers.reset();
});

test("queued time is excluded from the soft budget and progress persists without implying completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(), upstream = deferred(), downstream = deferred();
  h.child("coord-upstream", () => upstream.promise);
  const child = h.child("coord-progress", () => downstream.promise);
  const first = await h.resume("coord-upstream");
  const second = await h.resume("coord-progress", { dependsOn: ["coord-upstream"], softBudgetSeconds: 5 });
  t.mock.timers.tick(30_000);
  assert.equal(child.steering.length, 0);
  upstream.resolve();
  await first.completion;
  // Dependency completion wakes the queue synchronously in the promise callback.
  await Promise.resolve();
  h.controller.reportProgress("coord-progress", { summary: "Interface agreed", remaining: "Implementation", blocked: "" });
  const current = await h.controller.get("coord-progress");
  assert.equal(current.status, "running");
  assert.equal(current.progress.summary, "Interface agreed");
  assert.equal(current.budgetExceededAt, undefined);
  assert.throws(() => h.controller.reportProgress("coord-progress", { summary: " " }), /non-empty/);
  downstream.resolve();
  await second.completion;
  const restored = readSubagentRun(child.entries, "coord-progress", "/tmp/child.jsonl");
  assert.equal(restored.progress.summary, "Interface agreed");
  const next = await h.resume("coord-progress");
  await next.completion;
  assert.equal(readSubagentRun(child.entries, "coord-progress", "/tmp/child.jsonl").progress, undefined);
  t.mock.timers.reset();
});

test("coordination inputs are bounded and read-only profiles can restore the progress-only tool", async () => {
  assert.equal(subagentSoftBudget(), 300);
  assert.equal(subagentSoftBudget(0), 0);
  for (const value of [-1, 1.5, Infinity, 86401]) assert.throws(() => subagentSoftBudget(value));
  assert.deepEqual(subagentDependencyIds([" a ", "a"]), ["a"]);
  assert.throws(() => subagentDependencyIds([""]));
  const h = harness(), child = h.child("coord-tools");
  assert.deepEqual(readSubagentSessionResources(child.entries).tools, ["read", "report_subagent_progress"]);
  child.entries[0].data.resourceSnapshot.tools = ["powershell", "report_subagent_progress"];
  assert.deepEqual(readSubagentSessionResources(child.entries).tools, ["powershell", "report_subagent_progress"]);
  let tool, report;
  await createSubagentProgressExtension((...args) => { report = args; }).factory({ registerTool: (value) => { tool = value; } });
  await tool.execute("call", { summary: "Found API", remaining: "Review" }, undefined, undefined, { sessionManager: { getSessionId: () => "child" } });
  assert.deepEqual(report, ["child", { summary: "Found API", remaining: "Review" }]);
  const stop = startSubagentBudget(0, () => { throw new Error("disabled"); });
  stop();
});
