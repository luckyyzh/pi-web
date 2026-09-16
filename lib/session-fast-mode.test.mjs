import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  FAST_MODE_TYPE, supportsCodexFastMode, validateFastMode,
  readSessionFastMode, appendSessionFastMode, copySessionFastMode,
  withSessionFastMode, withoutSessionFastMode,
} = await jiti.import("./session-fast-mode.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { buildSessionTitleAgentOptions } = await jiti.import("./session-title.ts");
const model = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" };

function custom(data, customType = FAST_MODE_TYPE) {
  return { type: "custom", customType, data };
}

function makeInner(manager = SessionManager.inMemory()) {
  return {
    sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
    model: { ...model }, isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: {}, agent: { state: { thinkingLevel: "high" } },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    dispose() {},
  };
}

function appendAssistant(manager) {
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }],
    provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

test("Fast is limited to known official Codex main models, independently of reasoning", () => {
  for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-astra-2026-09-01", "gpt-5.4-codex", "gpt-5.5-2026-04-23"]) {
    assert.equal(supportsCodexFastMode({ ...model, id, reasoning: false }), true);
    assert.equal(supportsCodexFastMode({ provider: model.provider, modelId: id }), true);
  }
  for (const id of ["gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex", "gpt-6", "gpt-6-astra-mini", "gpt-6-astra-spark", "gpt-5.6-sol-mini", "gpt-5.4-custom"]) {
    assert.equal(supportsCodexFastMode({ ...model, id, reasoning: true }), false);
  }
  for (const candidate of [undefined, null, {}, { ...model, provider: "openai" },
    { ...model, provider: "proxy" }, { ...model, api: "openai-completions" }]) {
    assert.equal(supportsCodexFastMode(candidate), false);
  }
});

test("all eight picker models follow the reviewed Codex Fast policy", () => {
  const models = {
    "gpt-5.3-codex-spark": false,
    "gpt-5.4": true, // Legacy compatibility, not a promise of current OAuth availability.
    "gpt-5.4-mini": false, // API Fast support does not establish current OAuth support.
    "gpt-5.5": true,
    "gpt-5.6-luna": true,
    "gpt-5.6-sol": true,
    "gpt-5.6-terra": true,
    "gpt-6-astra": true,
  };
  for (const [id, supported] of Object.entries(models)) {
    assert.equal(supportsCodexFastMode({ ...model, id }), supported, id);
    assert.equal(supportsCodexFastMode({ provider: model.provider, modelId: id }), supported, id);
  }
});

test("Astra and every GPT-5.6 variant enable Fast through RPC without changing xhigh reasoning", async (t) => {
  for (const id of ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    const inner = makeInner();
    inner.model = { ...model, id };
    inner.agent.state.thinkingLevel = "xhigh";
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: true }), { fastMode: true });
    const payload = { model: id, reasoning: { effort: "xhigh" } };
    assert.deepEqual(await inner.agent.onPayload(payload, inner.model), { ...payload, service_tier: "priority" });
    assert.equal(inner.agent.state.thinkingLevel, "xhigh");
    await wrapper.send({ type: "set_fast_mode", enabled: false });
    assert.deepEqual(await inner.agent.onPayload(payload, inner.model), payload);
  }
});

test("Fast persistence is versioned, boolean-only and last valid session-wide choice wins", () => {
  assert.equal(readSessionFastMode([]), undefined);
  assert.equal(readSessionFastMode([custom({ version: 1, enabled: true }, "other")]), undefined);
  const entries = [custom({ version: 1, enabled: true }), custom({ version: 1, enabled: false }),
    custom({ version: 2, enabled: true }), custom({ version: 1, enabled: "true" }), custom(null)];
  assert.equal(readSessionFastMode(entries), false);
  for (const value of [null, undefined, 0, 1, "true", {}]) assert.throws(() => validateFastMode(value), /boolean/);
  assert.equal(validateFastMode(false), false);
});

test("the payload hook preserves extension changes and thinking, without mutating the original", async () => {
  let enabled = true;
  const original = async (payload) => ({ ...payload, extension_field: "kept" });
  const hook = withSessionFastMode(original, () => enabled);
  const payload = { model: model.id, reasoning: { effort: "high" } };
  assert.deepEqual(await hook(payload, model), { ...payload, extension_field: "kept", service_tier: "priority" });
  assert.equal(payload.service_tier, undefined);
  enabled = false;
  assert.deepEqual(await hook(payload, model), { ...payload, extension_field: "kept" });
  enabled = true;
  assert.equal((await hook(payload, { ...model, provider: "other" })).service_tier, undefined);
  assert.equal(withoutSessionFastMode(hook), original);
  assert.equal(withoutSessionFastMode(original), original);
  const mutatingHook = withSessionFastMode((body) => { body.extension_field = "mutated"; }, () => true);
  assert.equal((await mutatingHook({}, model)).extension_field, "mutated");
});

test("the installed SDK serializes priority through streamSimple using only a fake fetch", async () => {
  const sdkModel = getModel("openai-codex", "gpt-5.4");
  assert.ok(sdkModel);
  const tokenBody = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-only" } })).toString("base64");
  for (const enabled of [true, false]) {
    let captured;
    let calls = 0;
    const result = await streamSimple(sdkModel, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
      apiKey: `e30.${tokenBody}.test`, transport: "sse", reasoning: "high", maxRetries: 0,
      onPayload: withSessionFastMode(undefined, () => enabled),
      fetch: async (url, init) => {
        calls += 1;
        const request = new Request(url, init);
        const bytes = Buffer.from(await request.arrayBuffer());
        const json = request.headers.get("content-encoding") === "zstd" ? zlib.zstdDecompressSync(bytes) : bytes;
        captured = JSON.parse(json.toString("utf8"));
        return new Response('{"error":{"message":"offline test capture"}}', { status: 400 });
      },
    }).result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    assert.ok(captured, result.errorMessage);
    assert.equal(captured.service_tier, enabled ? "priority" : undefined);
    assert.equal(captured.reasoning.effort, "high");
  }
});

test("RPC Fast defaults off, persists explicit toggles and never changes thinking or another session", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner);
  const other = new AgentSessionWrapper(makeInner());
  t.after(() => { wrapper.destroy(); other.destroy(); });
  assert.equal((await wrapper.send({ type: "get_state" })).fastMode, false);
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: true }), { fastMode: true });
  assert.equal(readSessionFastMode(inner.sessionManager.getEntries()), true);
  assert.equal((await inner.agent.onPayload({}, model)).service_tier, "priority");
  assert.equal((await other.inner.agent.onPayload({}, model)).service_tier, undefined);
  assert.equal(inner.agent.state.thinkingLevel, "high");
  inner.model = { ...model, provider: "other" };
  assert.equal((await inner.agent.onPayload({}, inner.model)).service_tier, undefined);
  await assert.rejects(wrapper.send({ type: "set_fast_mode", enabled: true }), /official OpenAI Codex/);
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: false }), { fastMode: false });
  assert.equal(readSessionFastMode(inner.sessionManager.getEntries()), false);
  await assert.rejects(wrapper.send({ type: "set_fast_mode", enabled: "true" }), /boolean/);
  inner.model = model;
  inner.isStreaming = true;
  await assert.rejects(wrapper.send({ type: "set_fast_mode", enabled: true }), /running/);
  assert.equal(wrapper.getFastMode(), false);
});

test("Fast survives disk reopening and forks copy the current choice, not an older branch value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fast-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root);
  appendSessionFastMode(manager, true);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  appendAssistant(manager);
  const earlierLeaf = manager.getLeafId();
  const restored = SessionManager.open(manager.getSessionFile(), root);
  const enabledCold = new AgentSessionWrapper(makeInner(restored), { fastMode: readSessionFastMode(restored.getEntries()) });
  t.after(() => enabledCold.destroy());
  assert.equal((await enabledCold.inner.agent.onPayload({}, model)).service_tier, "priority");
  appendSessionFastMode(manager, false);
  const reopened = SessionManager.open(manager.getSessionFile(), root);
  assert.equal(readSessionFastMode(reopened.getEntries()), false);
  const forkFile = reopened.createBranchedSession(earlierLeaf);
  const forked = SessionManager.open(forkFile, root);
  assert.equal(readSessionFastMode(forked.getEntries()), true);
  copySessionFastMode(manager, forked);
  assert.equal(readSessionFastMode(SessionManager.open(forkFile, root).getEntries()), false);
  const count = forked.getEntries().length;
  copySessionFastMode(manager, forked);
  assert.equal(forked.getEntries().length, count);
  const cold = new AgentSessionWrapper(makeInner(manager), { fastMode: readSessionFastMode(manager.getEntries()) });
  t.after(() => cold.destroy());
  assert.equal(cold.getFastMode(), false);
});

test("automatic title generation keeps the original hook without inheriting the paid Fast setting", async () => {
  const original = (payload) => ({ ...payload, extension_field: "preserved" });
  const hook = withSessionFastMode(original, () => true);
  const options = buildSessionTitleAgentOptions({ state: { tools: [] }, onPayload: hook });
  assert.equal(options.onPayload, original);
  assert.equal((await options.onPayload({}, model)).service_tier, undefined);
  assert.equal((await hook({}, model)).service_tier, "priority");
  // Simulate a wrapper created by another Next.js route/module instance.
  const otherRouteHook = () => ({ service_tier: "priority" });
  Object.defineProperty(otherRouteHook, Symbol.for("pi-web:fast-mode:original-payload-hook"), { value: original });
  assert.equal(withoutSessionFastMode(otherRouteHook), original);
});
