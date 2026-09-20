import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// 隔离 agent 目录：set_temperature / set_sampling 会写全局「上次使用」默认值，
// 不能污染真实用户配置。
const agentRoot = await mkdtemp(join(tmpdir(), "pi-web-session-sampling-"));
process.env.PI_CODING_AGENT_DIR = agentRoot;
test.after(async () => {
  await rm(agentRoot, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TEMPERATURE_TYPE, TEMPERATURE_MIN, TEMPERATURE_MAX,
  validateTemperature, validateTopP, validateTopK, mergeSampling,
  readSessionTemperature, readSessionSampling, appendSessionTemperature, appendSessionSampling,
  copySessionTemperature, withSessionTemperature, withSessionSampling,
} = await jiti.import("./session-temperature.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function custom(data, customType = TEMPERATURE_TYPE) {
  return { type: "custom", customType, data };
}

function makeInner(manager = SessionManager.inMemory(), model = { provider: "a6000", id: "qwen3.8-27b-fp8", api: "openai-completions", reasoning: true }) {
  return {
    sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
    model, isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: {}, agent: { state: { thinkingLevel: "off" } },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    dispose() {},
  };
}

test("temperature validation bounds values to the server-accepted range", () => {
  assert.equal(validateTemperature(0), 0);
  assert.equal(validateTemperature(0.7), 0.7);
  assert.equal(validateTemperature(2), 2);
  assert.equal(validateTemperature(null), null);
  assert.equal(validateTemperature(0.12345), 0.12);
  for (const value of [-0.5, TEMPERATURE_MAX + 0.01, "0.7", undefined, {}, NaN, Infinity]) {
    assert.throws(() => validateTemperature(value), /temperature/);
  }
});

test("top_p / top_k validation keeps the triple in range", () => {
  assert.equal(validateTopP(0.95), 0.95);
  assert.equal(validateTopP(null), null);
  assert.equal(validateTopK(20), 20);
  assert.equal(validateTopK(null), null);
  for (const value of [-0.1, 1.01, "0.9", undefined, NaN]) {
    assert.throws(() => validateTopP(value), /top_p/);
  }
  for (const value of [0, -1, 1001, 20.5, "20", undefined, NaN]) {
    assert.throws(() => validateTopK(value), /top_k/);
  }

  const current = { temperature: 0.3, topP: 0.9, topK: null };
  // 缺省字段保持当前值，显式 null 清除该字段。
  assert.deepEqual(mergeSampling(current, { topK: 80 }), { temperature: 0.3, topP: 0.9, topK: 80 });
  assert.deepEqual(mergeSampling(current, { topP: null }), { temperature: 0.3, topP: null, topK: null });
  assert.throws(() => mergeSampling(current, { topK: 0 }), /top_k/);
});

test("sampling persistence reads v1 entries as temperature-only and last choice wins", () => {
  // 旧会话只写了 v1（value）；新代码必须照样认。
  const legacy = [custom({ version: 1, value: 0.3 })];
  assert.deepEqual(readSessionSampling(legacy), { temperature: 0.3, topP: null, topK: null });
  assert.equal(readSessionTemperature(legacy), 0.3);
  assert.deepEqual(readSessionSampling([custom({ version: 1, value: null })]), { temperature: null, topP: null, topK: null });
  // v2 条目整体生效，不会与更早的 v1 条目拼起来。
  const mixed = [
    custom({ version: 1, value: 0.3 }),
    custom({ version: 2, temperature: 0.8, topP: 0.9, topK: 80 }),
  ];
  assert.deepEqual(readSessionSampling(mixed), { temperature: 0.8, topP: 0.9, topK: 80 });
  // 三个字段全缺失/非法才跳过；显式 null 是合法的「恢复默认」。
  assert.deepEqual(
    readSessionSampling([custom({ version: 1, value: 1.2 }), custom({ version: 2 })]),
    { temperature: 1.2, topP: null, topK: null },
  );

  const source = SessionManager.inMemory();
  appendSessionSampling(source, { temperature: null, topP: 0.9, topK: 100 });
  assert.deepEqual(readSessionSampling(source.getEntries()), { temperature: null, topP: 0.9, topK: 100 });
});

test("the sampling hook injects top_p / top_k per provider payload shape", async () => {
  let current = { temperature: null, topP: 0.9, topK: 100 };
  const hook = withSessionSampling(undefined, () => current);

  const openai = { model: "qwen3.8-27b-fp8", stream: true };
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), { ...openai, top_p: 0.9, top_k: 100 });

  const google = { contents: [] };
  assert.deepEqual(await hook(google, { api: "google-generative-ai" }), {
    contents: [], generationConfig: { topP: 0.9, topK: 100 },
  });

  // Bedrock Converse 协议没有 top_k。
  const bedrock = { messages: [] };
  assert.deepEqual(await hook(bedrock, { api: "bedrock-converse-stream" }), {
    messages: [], inferenceConfig: { topP: 0.9 },
  });

  current = null;
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), openai);
  current = { temperature: null, topP: null, topK: null };
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), openai);
});

test("temperature persistence is versioned and last valid session-wide choice wins", () => {
  assert.equal(readSessionTemperature([]), undefined);
  assert.equal(readSessionTemperature([custom({ version: 1, value: 0.7 }, "other")]), undefined);
  const entries = [
    custom({ version: 1, value: 0.3 }),
    custom({ version: 1, value: null }),
    custom({ version: 2, value: 0.7 }),
    custom({ version: 1, value: "0.7" }),
    custom(null),
    custom({ version: 1, value: 1.2 }),
  ];
  assert.equal(readSessionTemperature(entries), 1.2);
  assert.equal(readSessionTemperature([custom({ version: 1, value: 0.3 }), custom({ version: 1, value: null })]), null);
});

test("append and copy persist the preference and forks take the latest choice", () => {
  const source = SessionManager.inMemory();
  appendSessionTemperature(source, 0.7);
  appendSessionTemperature(source, null);
  assert.equal(readSessionTemperature(source.getEntries()), null);
  appendSessionTemperature(source, 1.1);
  assert.equal(readSessionTemperature(source.getEntries()), 1.1);

  const forked = SessionManager.inMemory();
  appendSessionTemperature(forked, 0.2);
  copySessionTemperature(source, forked);
  assert.equal(readSessionTemperature(forked.getEntries()), 1.1);
});

test("the payload hook injects temperature per provider payload shape", async () => {
  let current = 0.7;
  const hook = withSessionTemperature(undefined, () => current);

  const openai = { model: "qwen3.8-27b-fp8", stream: true };
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), { ...openai, temperature: 0.7 });

  const google = { contents: [], generationConfig: { maxOutputTokens: 100 } };
  assert.deepEqual(await hook(google, { api: "google-generative-ai" }), {
    contents: [],
    generationConfig: { maxOutputTokens: 100, temperature: 0.7 },
  });

  const bedrock = { messages: [], inferenceConfig: { maxTokens: 10 } };
  assert.deepEqual(await hook(bedrock, { api: "bedrock-converse-stream" }), {
    messages: [],
    inferenceConfig: { maxTokens: 10, temperature: 0.7 },
  });

  current = null;
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), openai);
  current = undefined;
  assert.deepEqual(await hook(openai, { api: "openai-completions" }), openai);

  // A preceding hook's replacement still receives the temperature.
  const chained = withSessionTemperature(async (payload) => ({ ...payload, seeded: true }), () => 1.5);
  assert.deepEqual(await chained(openai, { api: "openai-completions" }), { ...openai, seeded: true, temperature: 1.5 });
});

test("set_temperature persists through RPC and skips Anthropic extended thinking", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner, {});
  t.after(() => wrapper.destroy());

  assert.deepEqual(await wrapper.send({ type: "get_state" }).then((s) => s.temperature), null);

  assert.deepEqual(await wrapper.send({ type: "set_temperature", temperature: 0.7 }), { temperature: 0.7 });
  assert.equal(readSessionTemperature(inner.sessionManager.getEntries()), 0.7);
  assert.deepEqual(await inner.agent.onPayload({ model: inner.model.id }, inner.model), { model: inner.model.id, temperature: 0.7 });

  // Out-of-range values are rejected without persisting.
  await assert.rejects(wrapper.send({ type: "set_temperature", temperature: 3 }), /between/);
  assert.equal(readSessionTemperature(inner.sessionManager.getEntries()), 0.7);

  // Anthropic + active thinking: pi omits temperature, so the hook must too.
  inner.model = { provider: "anthropic", id: "claude-9", api: "anthropic-messages", reasoning: true };
  inner.agent.state.thinkingLevel = "high";
  assert.deepEqual(await inner.agent.onPayload({ model: "claude-9" }, inner.model), { model: "claude-9" });

  // Thinking off: injection resumes.
  inner.agent.state.thinkingLevel = "off";
  assert.deepEqual(await inner.agent.onPayload({ model: "claude-9" }, inner.model), { model: "claude-9", temperature: 0.7 });

  // Explicit default clears both the payload and the session entry.
  assert.deepEqual(await wrapper.send({ type: "set_temperature", temperature: null }), { temperature: null });
  assert.equal(readSessionTemperature(inner.sessionManager.getEntries()), null);
  assert.deepEqual(await inner.agent.onPayload({ model: "claude-9" }, inner.model), { model: "claude-9" });
});

test("set_sampling persists the triple, patches per field and reaches the payload", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner, {});
  t.after(() => wrapper.destroy());

  // 只传 top_k：其余字段保持「默认」。
  assert.deepEqual(
    await wrapper.send({ type: "set_sampling", topK: 100 }),
    { sampling: { temperature: null, topP: null, topK: 100 }, temperature: null, topP: null, topK: 100 },
  );
  assert.deepEqual(await inner.agent.onPayload({ model: "m" }, inner.model), { model: "m", top_k: 100 });

  // 补一个 top_p：既有的 top_k 不能被抹掉。
  await wrapper.send({ type: "set_sampling", topP: 0.9 });
  assert.deepEqual(await inner.agent.onPayload({ model: "m" }, inner.model), { model: "m", top_p: 0.9, top_k: 100 });

  // 显式 null 清除单个字段。
  await wrapper.send({ type: "set_sampling", topK: null });
  assert.deepEqual(await inner.agent.onPayload({ model: "m" }, inner.model), { model: "m", top_p: 0.9 });

  // 越界值被拒且不落盘。
  await assert.rejects(wrapper.send({ type: "set_sampling", topP: 1.5 }), /between/);
  assert.equal(readSessionSampling(inner.sessionManager.getEntries()).topP, 0.9);

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.topP, 0.9);
  assert.equal(state.topK, null);
});
