import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TEMPERATURE_TYPE, TEMPERATURE_MIN, TEMPERATURE_MAX,
  validateTemperature, readSessionTemperature, appendSessionTemperature,
  copySessionTemperature, withSessionTemperature,
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
