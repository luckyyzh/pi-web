import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { SubagentQueue } = await createJiti(import.meta.url).import("./subagent-queue.ts");

test("runs FIFO with a per-parent concurrency limit and drains after completion", async () => {
  const queue = new SubagentQueue();
  const events = [];
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = () => resolve("first"); }), (state) => events.push(["first", state]));
  const second = queue.enqueue("parent", 1, async () => "second", (state) => events.push(["second", state]));
  assert.deepEqual(events, [["first", "queued"], ["first", "running"], ["second", "queued"]]);
  release();
  assert.equal(await first.promise, "first");
  assert.equal(await second.promise, "second");
  assert.deepEqual(events, [
    ["first", "queued"], ["first", "running"], ["second", "queued"], ["second", "running"],
  ]);
});

test("cancels queued work without starting it", async () => {
  const queue = new SubagentQueue();
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = resolve; }), () => {});
  let started = false;
  let cancelled = false;
  const second = queue.enqueue("parent", 1, async () => { started = true; return "bad"; }, () => {}, () => { cancelled = true; });
  assert.equal(second.cancel(), true);
  assert.equal(cancelled, true);
  release();
  await first.promise;
  assert.equal(await second.promise, undefined);
  assert.equal(started, false);
});

test("an unready head does not block or occupy slots for later tasks", async () => {
  const queue = new SubagentQueue();
  let headReady = false;
  const events = [];
  const first = queue.enqueue("p", 2, async () => "first", (state) => events.push(["first", state]), undefined, { ready: () => headReady });
  const second = queue.enqueue("p", 2, async () => "second", (state) => events.push(["second", state]));
  const third = queue.enqueue("p", 2, async () => "third", (state) => events.push(["third", state]));
  assert.deepEqual(events, [
    ["first", "queued"],
    ["second", "queued"], ["second", "running"],
    ["third", "queued"], ["third", "running"],
  ]);
  assert.equal(await second.promise, "second");
  assert.equal(await third.promise, "third");
  assert.ok(!events.some(([name, state]) => name === "first" && state === "running"));
  headReady = true;
  queue.wake("p");
  assert.equal(await first.promise, "first");
  assert.deepEqual(events[events.length - 1], ["first", "running"]);
});

test("wake starts a blocked task once its dependency becomes ready", async () => {
  const queue = new SubagentQueue();
  let ready = false;
  let release;
  const events = [];
  const gate = queue.enqueue("p", 1, () => new Promise((resolve) => { release = resolve; }), () => {});
  const blocked = queue.enqueue("p", 1, async () => "done", (state) => events.push(state), undefined, { ready: () => ready });
  assert.deepEqual(events, ["queued"]);
  release("gate");
  await gate.promise;
  await Promise.resolve(); // let the finished task's slot release settle
  assert.deepEqual(events, ["queued"]); // slot free, but no auto-start (no polling)
  ready = true;
  queue.wake("p");
  assert.equal(await blocked.promise, "done");
  assert.deepEqual(events, ["queued", "running"]);
});

test("cancels a blocked queued task without starting it", async () => {
  const queue = new SubagentQueue();
  let started = false;
  let cancelled = false;
  const first = queue.enqueue("p", 1, async () => { started = true; return "first"; }, () => {}, () => { cancelled = true; }, { ready: () => false });
  const second = queue.enqueue("p", 1, async () => "second", () => {});
  assert.equal(await second.promise, "second");
  assert.equal(first.cancel(), true);
  assert.equal(cancelled, true);
  assert.equal(first.cancel(), false);
  assert.equal(started, false);
  assert.equal(await first.promise, undefined);
  queue.wake("p"); // no-op on a drained queue, must not throw
});

test("a throwing ready callback rejects that task without blocking later tasks", async () => {
  const queue = new SubagentQueue();
  const events = [];
  const bad = queue.enqueue("p", 1, async () => "never", (state) => events.push(["bad", state]), undefined, { ready: () => { throw new Error("boom"); } });
  const later = queue.enqueue("p", 1, async () => "later", (state) => events.push(["later", state]));
  await assert.rejects(bad.promise, { message: "boom" });
  assert.equal(await later.promise, "later");
  assert.ok(!events.some(([name, state]) => name === "bad" && state === "running"));
  assert.ok(events.some(([name, state]) => name === "later" && state === "running"));
});

test("a run that throws synchronously rejects and releases its slot", async () => {
  const queue = new SubagentQueue();
  const events = [];
  const bad = queue.enqueue("p", 1, () => { throw new Error("sync boom"); }, (state) => events.push(["bad", state]));
  const later = queue.enqueue("p", 1, async () => "later", (state) => events.push(["later", state]));
  await assert.rejects(bad.promise, { message: "sync boom" });
  assert.equal(await later.promise, "later");
  assert.deepEqual(events, [
    ["bad", "queued"], ["bad", "running"],
    ["later", "queued"], ["later", "running"],
  ]);
});
