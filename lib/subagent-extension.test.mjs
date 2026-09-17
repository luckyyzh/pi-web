import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createSubagentExtension,
  preferPiWebSubagentExtension,
} = await createJiti(import.meta.url).import("./subagent-extension.ts");

async function loadTools(runtime, getProfiles = () => [], isEnabled = () => true) {
  const tools = new Map();
  const sent = [];
  const extension = createSubagentExtension(runtime, getProfiles, isEnabled);
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  return { tools, sent };
}

function run(overrides = {}) {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "explore",
    description: "Find parser",
    task: "Find the parser",
    runInBackground: false,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("integrated extension exposes the legacy-compatible tool names", async () => {
  const tools = new Map();
  const extension = createSubagentExtension({
    async start(request) {
      const running = {
        sessionId: "child-session",
        sessionPath: "/tmp/child.jsonl",
        parentSessionId: "parent-session",
        parentToolCallId: request.parentToolCallId,
        profile: request.profile,
        description: request.description,
        task: request.task,
        runInBackground: true,
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      return {
        run: running,
        completion: Promise.resolve({
          ...running,
          status: "completed",
          completedAt: "2026-01-01T00:01:00.000Z",
          result: "Done",
        }),
      };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
    async notifyParent() {},
  }, () => []);
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage() {},
  });

  assert.deepEqual([...tools.keys()], ["Agent", "get_subagent_result", "steer_subagent", "list_subagents"]);
  const result = await tools.get("Agent").execute(
    "tool-call",
    {
      subagent_type: "explore",
      prompt: "Find the parser",
      input_files: ["docs/parser.md"],
      description: "Find parser",
      run_in_background: true,
    },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(result.details.kind, "pi-web-subagent");
  assert.equal(result.details.sessionId, "child-session");
});

test("integrated extension registers no tools while its feature is disabled", async () => {
  let enabled = false;
  const runtime = {
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
    async notifyParent() {},
  };
  const extension = createSubagentExtension(runtime, () => [], () => enabled);
  const disabledTools = new Map();
  await extension.factory({ registerTool(tool) { disabledTools.set(tool.name, tool); } });
  assert.deepEqual([...disabledTools], []);

  enabled = true;
  const enabledTools = new Map();
  await extension.factory({ registerTool(tool) { enabledTools.set(tool.name, tool); } });
  assert.deepEqual([...enabledTools.keys()], ["Agent", "get_subagent_result", "steer_subagent", "list_subagents"]);
});

test("Agent tool description lists enabled effective profiles and refreshes when its factory reloads", async () => {
  const runtime = {
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
    async notifyParent() {},
  };
  let profiles = [
    {
      name: "explore",
      displayName: "Explore",
      description: "Inspect the codebase",
      systemPrompt: "Explore",
      tools: ["read", "grep"],
      inheritContext: false,
      runInBackground: false,
      enabled: true,
      scope: "builtin",
    },
    {
      name: "disabled-agent",
      displayName: "Disabled agent",
      description: "Must stay hidden",
      systemPrompt: "Disabled",
      tools: [],
      model: "provider/hidden",
      inheritContext: false,
      runInBackground: false,
      enabled: false,
      scope: "project",
    },
  ];
  const extension = createSubagentExtension(runtime, () => profiles);

  const firstTools = new Map();
  await extension.factory({ registerTool(tool) { firstTools.set(tool.name, tool); }, sendMessage() {} });
  const first = firstTools.get("Agent");
  assert.match(first.description, /- explore: Inspect the codebase \(Tools: read, grep\)/);
  assert.doesNotMatch(first.description, /disabled-agent|Must stay hidden/);
  assert.match(first.parameters.properties.subagent_type.description, /Available types: explore/);

  profiles = [{
    name: "reviewer",
    displayName: "Reviewer",
    description: "Review a change",
    systemPrompt: "Review",
    tools: [],
    model: "provider/review-model",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "project",
  }];
  const reloadedTools = new Map();
  await extension.factory({ registerTool(tool) { reloadedTools.set(tool.name, tool); }, sendMessage() {} });
  const reloaded = reloadedTools.get("Agent");
  assert.match(reloaded.description, /- reviewer: Review a change \(Tools: none; Model: provider\/review-model\)/);
  assert.doesNotMatch(reloaded.description, /explore/);
  assert.match(reloaded.parameters.properties.subagent_type.description, /Available types: reviewer/);
});

test("Agent schema exposes bounded scheduling parameters and forwards them on start and resume", async () => {
  let started;
  let resumed;
  const { tools } = await loadTools({
    async start(request) {
      started = request;
      return {
        run: run(),
        completion: Promise.resolve(run({
          status: "completed",
          result: "ok",
          dependsOn: ["dep-a"],
          softBudgetSeconds: 600,
        })),
      };
    },
    async resume(request) {
      resumed = request;
      return { run: run({ sessionId: "existing" }), completion: Promise.resolve(run({ sessionId: "existing", status: "completed", result: "continued" })) };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const agent = tools.get("Agent");
  assert.equal(agent.parameters.properties.depends_on.maxItems, 32);
  assert.equal(agent.parameters.properties.soft_budget_seconds.minimum, 0);
  assert.equal(agent.parameters.properties.soft_budget_seconds.maximum, 86400);

  const startResult = await agent.execute(
    "tool-call",
    {
      prompt: "task",
      description: "desc",
      depends_on: ["dep-a", "dep-b"],
      soft_budget_seconds: 600,
    },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.deepEqual(started.dependsOn, ["dep-a", "dep-b"]);
  assert.equal(started.softBudgetSeconds, 600);
  assert.deepEqual(startResult.details.dependsOn, ["dep-a"]);
  assert.equal(startResult.details.softBudgetSeconds, 600);

  await agent.execute(
    "tool-call",
    { resume: "existing", prompt: "next task", description: "desc", depends_on: ["dep-a"], soft_budget_seconds: 0 },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.deepEqual(resumed.dependsOn, ["dep-a"]);
  assert.equal(resumed.softBudgetSeconds, 0);
});

test("integrated extension removes a legacy extension that owns the same tools", () => {
  const host = {
    path: "<inline:pi-web-subagents>",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  const legacy = {
    path: "/tmp/pi-subagents/index.ts",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  const other = { path: "/tmp/other.ts", tools: new Map([["search", {}]]) };
  const lookalike = {
    path: "/tmp/unrelated/index.ts",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}], ["custom", {}]]),
  };
  const result = preferPiWebSubagentExtension({
    extensions: [legacy, lookalike, host, other],
    errors: [{ path: legacy.path, error: "duplicate" }, { path: other.path, error: "other" }],
  });

  assert.deepEqual(result.extensions.map((extension) => extension.path), [lookalike.path, host.path, other.path]);
  assert.deepEqual(result.errors.map((error) => error.path), [other.path]);
});

test("integrated extension removes recognized legacy extensions with any reserved tool", () => {
  const host = {
    path: "<inline:pi-web-subagents>",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  for (const toolName of ["Agent", "get_subagent_result", "steer_subagent"]) {
    const legacy = {
      path: "/tmp/pi-subagents/index.ts",
      tools: new Map([[toolName, {}], ["other", {}]]),
    };
    const result = preferPiWebSubagentExtension({
      extensions: [legacy, host],
      errors: [{
        path: host.path,
        error: `Tool "${toolName}" conflicts with ${legacy.path}`,
      }],
    });
    assert.deepEqual(result.extensions, [host]);
    assert.deepEqual(result.errors, []);
  }
});

test("foreground Agent streams updates and returns the completed result", async () => {
  const updates = [];
  let request;
  const { tools } = await loadTools({
    async start(value) {
      request = value;
      value.onUpdate(run({ status: "running" }));
      return {
        run: run(),
        completion: Promise.resolve(run({
          status: "completed",
          completedAt: "2026-01-01T00:01:00.000Z",
          result: "Parser is in lib/parser.ts",
        })),
      };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    {
      subagent_type: "explore",
      prompt: "Find the parser",
      input_files: ["docs/parser.md"],
      description: "Find parser",
    },
    undefined,
    (update) => updates.push(update),
    { sessionManager: { getSessionId: () => "parent-session" } },
  );

  assert.equal(request.parentToolCallId, "tool-call");
  assert.equal(request.task, "Find the parser");
  assert.deepEqual(request.inputFiles, ["docs/parser.md"]);
  assert.equal(updates[0].details.status, "running");
  assert.equal(result.content[0].text, "Parser is in lib/parser.ts");
  assert.equal(result.details.status, "completed");
  assert.equal(result.isError, undefined);
});

test("foreground Agent reports startup and execution failures as tool errors", async () => {
  const { tools: startFailureTools } = await loadTools({
    async start() { throw new Error("profile missing"); },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const startup = await startFailureTools.get("Agent").execute(
    "tool-call",
    { prompt: "task", description: "desc" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(startup.isError, true);
  assert.equal(startup.content[0].text, "profile missing");

  const { tools: runFailureTools } = await loadTools({
    async start() {
      return {
        run: run(),
        completion: Promise.resolve(run({ status: "failed", error: "model failed" })),
      };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const failure = await runFailureTools.get("Agent").execute(
    "tool-call",
    { prompt: "task", description: "desc" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /model failed/);
});

test("Agent resume routes the prompt to the existing-session runtime", async () => {
  let resumed;
  const { tools } = await loadTools({
    async start() { throw new Error("must use resume"); },
    async resume(request) {
      resumed = request;
      return { run: run({ sessionId: "existing", runInBackground: false }), completion: Promise.resolve(run({ sessionId: "existing", status: "completed", result: "continued" })) };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    { resume: "existing", prompt: "Continue the review", description: "Continue review" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(resumed.sessionId, "existing");
  assert.equal(resumed.task, "Continue the review");
  assert.equal(result.content[0].text, "continued");
});

test("background Agent returns immediately and delegates one completion notification", async () => {
  let finish;
  const notifications = [];
  const completion = new Promise((resolve) => { finish = resolve; });
  const { tools, sent } = await loadTools({
    async start() {
      return { run: run({ runInBackground: true }), completion };
    },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
    async notifyParent(completed) { notifications.push(completed); },
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    { prompt: "task", description: "desc", run_in_background: true },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.match(result.content[0].text, /started in background/);
  assert.equal(sent.length, 0);

  finish(run({ runInBackground: true, status: "completed", result: "done" }));
  await completion;
  await Promise.resolve();
  assert.equal(sent.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].result, "done");
});

test("get_subagent_result covers missing, running, completed, failed, and aborted runs", async () => {
  let current = null;
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return current; },
    async list() { return []; },
    async steer() {},
  });
  const tool = tools.get("get_subagent_result");

  let result = await tool.execute("call", { agent_id: "missing" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);

  current = run();
  result = await tool.execute("call", { agent_id: "child-session" });
  assert.equal(result.details.status, "running");
  assert.equal(result.content[0].text, "Subagent child-session is running.");

  current = run({ status: "completed", result: "done" });
  result = await tool.execute("call", { agent_id: "child-session" });
  assert.equal(result.content[0].text, "done");

  current = run({ status: "failed", error: "boom" });
  result = await tool.execute("call", { agent_id: "child-session" });
  assert.match(result.content[0].text, /boom/);
  assert.equal(result.isError, true);

  current = run({ status: "aborted" });
  result = await tool.execute("call", { agent_id: "child-session" });
  assert.match(result.content[0].text, /was stopped/);

  current = run({ status: "interrupted" });
  result = await tool.execute("call", { agent_id: "child-session" });
  assert.match(result.content[0].text, /interrupted before completion/);
});

test("get_subagent_result treats queued as active, not failed, and copies scheduling details", async () => {
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() {
      return run({
        status: "queued",
        dependsOn: ["dep-a"],
        waitingFor: ["dep-a"],
        softBudgetSeconds: 300,
      });
    },
    async list() { return []; },
    async steer() {},
  });
  // timeout_seconds 0 returns an immediate snapshot instead of hanging on the queued run.
  const result = await tools.get("get_subagent_result").execute("call", { agent_id: "child-session", wait: true, timeout_seconds: 0 });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "queued");
  assert.equal(
    result.content[0].text,
    "Subagent child-session is queued.\nWaiting for dependencies: dep-a. Waiting does not occupy a concurrency slot.",
  );
  assert.deepEqual(result.details.dependsOn, ["dep-a"]);
  assert.deepEqual(result.details.waitingFor, ["dep-a"]);
  assert.equal(result.details.softBudgetSeconds, 300);
});

test("get_subagent_result wait covers queued runs and stops at the first terminal state", async () => {
  let current = run({ status: "queued" });
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return current; },
    async list() { return []; },
    async steer() {},
  });
  const pending = tools.get("get_subagent_result").execute("call", { agent_id: "child-session", wait: true });
  setTimeout(() => { current = run({ status: "completed", result: "done" }); }, 700);
  const result = await pending;
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "completed");
  assert.equal(result.content[0].text, "done");
});

test("get_subagent_result bounded wait returns the current state without cancelling", async () => {
  let polls = 0;
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() {
      polls += 1;
      return run({ status: polls <= 1 ? "queued" : "running" });
    },
    async list() { return []; },
    async steer() {},
  });
  const started = Date.now();
  const result = await tools.get("get_subagent_result").execute("call", {
    agent_id: "child-session",
    wait: true,
    timeout_seconds: 1,
  });
  assert.ok(Date.now() - started < 3000, "wait should stop at the timeout, not run forever");
  assert.ok(polls >= 2, "wait should poll for updates");
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "running");
  assert.equal(result.content[0].text, "Subagent child-session is running.");
});

test("get_subagent_result wait honors abort signals", async () => {
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return run(); },
    async list() { return []; },
    async steer() {},
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tools.get("get_subagent_result").execute("call", { agent_id: "child-session", wait: true }, controller.signal),
    /Result wait aborted/,
  );
});

test("steer_subagent returns success and runtime failures", async () => {
  const calls = [];
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list() { return []; },
    async steer(id, message) {
      calls.push([id, message]);
      if (message === "fail") throw new Error("not running");
    },
  });
  const tool = tools.get("steer_subagent");
  const success = await tool.execute("call", { agent_id: "child-session", message: "focus" });
  assert.deepEqual(calls[0], ["child-session", "focus"]);
  assert.match(success.content[0].text, /sent/);

  const failure = await tool.execute("call", { agent_id: "child-session", message: "fail" });
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, "not running");
});

test("list_subagents lists only this parent's active runs as bounded text", async () => {
  const listCalls = [];
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list(parentSessionId) {
      listCalls.push(parentSessionId);
      return [
        run({
          sessionId: "active-1",
          status: "running",
          dependsOn: ["dep-a"],
          waitingFor: ["dep-a"],
          startedAt: "2026-01-01T00:00:05.000Z",
          budgetExceededAt: "2026-01-01T00:05:00.000Z",
          progress: { summary: "Halfway there", remaining: "tests", updatedAt: "2026-01-01T00:04:00.000Z" },
        }),
        run({ sessionId: "active-2", status: "queued", description: "Write docs" }),
        run({ sessionId: "finished-1", status: "completed", description: "Old task" }),
        run({ sessionId: "foreign-1", parentSessionId: "other-parent", status: "running", description: "Foreign work" }),
      ];
    },
    async steer() {},
  });
  const result = await tools.get("list_subagents").execute(
    "call",
    {},
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.deepEqual(listCalls, ["parent-session"]);
  const text = result.content[0].text;
  assert.match(text, /^2 active subagent\(s\):$/m);
  assert.match(text, /- active-1 \| Find parser \| status: running/);
  assert.match(text, /Dependencies: dep-a/);
  assert.match(text, /Waiting for dependencies: dep-a/);
  assert.match(text, /Started: 2026-01-01T00:00:05\.000Z/);
  assert.match(text, /Soft budget exceeded/);
  assert.match(text, /Latest checkpoint \(provisional, 2026-01-01T00:04:00\.000Z\): Halfway there/);
  assert.match(text, /Remaining: tests/);
  assert.match(text, /- active-2 \| Write docs \| status: queued/);
  assert.doesNotMatch(text, /finished-1|Old task/);
  assert.doesNotMatch(text, /foreign-1|Foreign work/);
  assert.equal(result.isError, undefined);
});

test("list_subagents reports an empty roster for this session", async () => {
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list() { return []; },
    async steer() {},
  });
  const result = await tools.get("list_subagents").execute(
    "call",
    {},
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "No active subagents for this session.");
});

test("legacy preference leaves unrelated and partial-overlap extensions intact", () => {
  const host = { path: "<inline:pi-web-subagents>", tools: new Map() };
  const partial = { path: "/tmp/partial.ts", tools: new Map([["Agent", {}]]) };
  const base = { extensions: [host, partial], errors: [] };
  assert.equal(preferPiWebSubagentExtension(base), base);

  const noHost = { extensions: [partial], errors: [] };
  assert.equal(preferPiWebSubagentExtension(noHost), noHost);
});
