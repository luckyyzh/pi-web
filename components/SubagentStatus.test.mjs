import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { SubagentStatus } = await jiti.import("./SubagentStatus.tsx");
const { subscribeSubagentStatus } = await jiti.import("../lib/subagent-status-poller.ts");
const run = (extra = {}) => ({ kind: "pi-web-subagent", sessionId: "child", parentToolCallId: "call", profile: "explore", description: "Inspect", status: "running", runInBackground: true, createdAt: "2026-01-01T00:00:00Z", ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (value) => ({ ok: true, status: 200, json: async () => ({ run: value }) });

function render(extra = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SubagentStatus, { details: run(extra) })));
}

test("renders dependency wait, provisional checkpoint and backend-only budget warnings", () => {
  const html = render({ status: "queued", waitingFor: ["alpha"], progress: { summary: "Interface defined", remaining: "Implement query", blocked: "Need input", updatedAt: "now" } });
  assert.match(html, /data-subagent-status="queued"/);
  assert.match(html, /Queued/);
  assert.match(html, /Waiting for: alpha/);
  assert.match(html, /unverified, not completion/);
  assert.match(html, /Interface defined/);
  assert.match(html, /Remaining: Implement query/);
  assert.match(html, /Blocked: Need input/);
  assert.doesNotMatch(html, /Soft budget exceeded/);
  assert.match(render({ budgetExceededAt: "now" }), /Soft budget exceeded/);
  assert.match(render({ status: "completed" }), /Completed/);
});

test("status polling starts immediately, uses 5s intervals, and stops at a terminal state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const snapshots = [];
  const stop = subscribeSubagentStatus({ sessionId: "child", parentToolCallId: "call", onRun: (value) => snapshots.push(value), onUnavailable: () => assert.fail("unexpected unavailable"), fetcher: async () => response(run({ status: ++calls === 1 ? "queued" : "completed" })) });
  t.after(stop);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(snapshots.at(-1).status, "completed");
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls, 2);
});

test("polling rejects a resumed task on the same session and caps consecutive errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let unavailable = 0, calls = 0;
  const stop = subscribeSubagentStatus({ sessionId: "child", parentToolCallId: "old-call", onRun: () => assert.fail("must not show new task on historical card"), onUnavailable: () => unavailable++, fetcher: async () => response(run()) });
  t.after(stop);
  await flush();
  assert.equal(unavailable, 1);
  const stopErrors = subscribeSubagentStatus({ sessionId: "child", onRun: () => assert.fail("unexpected success"), onUnavailable: () => unavailable++, fetcher: async () => { calls++; throw new Error("offline"); } });
  t.after(stopErrors);
  await flush();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(5000); await flush(); }
  assert.equal(calls, 3);
  assert.equal(unavailable, 2);
});

test("unmount aborts the request and ignores its late response; hidden tabs skip fetching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release, signal, calls = 0, visible = false;
  const stop = subscribeSubagentStatus({ sessionId: "child", onRun: () => assert.fail("late response"), onUnavailable: () => assert.fail("stopped"), isVisible: () => visible, fetcher: async (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  t.after(stop);
  assert.equal(calls, 0);
  visible = true;
  t.mock.timers.tick(5000);
  assert.equal(calls, 1);
  t.mock.timers.tick(5000);
  assert.equal(calls, 1); // no overlapping request
  stop();
  assert.equal(signal.aborted, true);
  release(response(run()));
  await flush();
});

test("all supported locales contain the new coordination keys and matching placeholders", async () => {
  const { getSupportedLocales, getLocalePlugin } = await jiti.import("../lib/i18n/registry.ts");
  const keys = ["agentSwitcher.status.queued", "subagent.waitingFor", "subagent.checkpoint", "subagent.remaining", "subagent.blocked", "subagent.budgetExceeded", "subagent.statusUnavailable"];
  const english = getLocalePlugin("en").messages;
  const placeholders = (text) => [...text.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  for (const locale of getSupportedLocales()) {
    const messages = getLocalePlugin(locale).messages;
    for (const key of keys) {
      assert.equal(typeof messages[key], "string", `${locale}: ${key}`);
      assert.deepEqual(placeholders(messages[key]), placeholders(english[key]), `${locale}: ${key}`);
    }
  }
});

test("MessageView shows status outside the expandable tool body", async () => {
  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.match(source, /\{subagent && <SubagentStatus details=\{subagent\} \/>\}/);
  assert.ok(source.indexOf("<SubagentStatus details={subagent}") < source.indexOf("Expanded: input args"));
});
