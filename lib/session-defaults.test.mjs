import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Isolate the agent dir so the module reads/writes a temp session-defaults.json.
const root = await mkdtemp(join(tmpdir(), "pi-web-session-defaults-"));
process.env.PI_CODING_AGENT_DIR = root;

const {
  readSessionDefaults,
  updateSessionDefaultSampling,
  updateSessionDefaultTemperature,
  updateSessionDefaultThinkingLevel,
  sessionDefaultsPath,
} = await createJiti(import.meta.url).import("./session-defaults.ts");

const UNSET = { temperature: null, topP: null, topK: null, thinkingLevel: null };

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

test("returns unset defaults when the file is missing", () => {
  assert.deepEqual(readSessionDefaults(), UNSET);
});

test("updateSessionDefaultTemperature persists and reads back", () => {
  updateSessionDefaultTemperature(0.7);
  assert.equal(readSessionDefaults().temperature, 0.7);
  // Updating one field must not clobber the other.
  updateSessionDefaultThinkingLevel("high");
  assert.equal(readSessionDefaults().temperature, 0.7);
  assert.equal(readSessionDefaults().thinkingLevel, "high");
});

test("updateSessionDefaultTemperature(null) resets to unset", () => {
  updateSessionDefaultTemperature(1.5);
  assert.equal(readSessionDefaults().temperature, 1.5);
  updateSessionDefaultTemperature(null);
  assert.equal(readSessionDefaults().temperature, null);
});

test("top_p / top_k defaults persist per field and are inherited by new sessions", () => {
  updateSessionDefaultSampling({ topP: 0.9 });
  assert.equal(readSessionDefaults().topP, 0.9);
  // 只改一个字段不能抹掉另一个，也不能抹掉温度。
  updateSessionDefaultTemperature(0.3);
  updateSessionDefaultSampling({ topK: 100 });
  const withDefaults = readSessionDefaults();
  assert.deepEqual(
    { temperature: withDefaults.temperature, topP: withDefaults.topP, topK: withDefaults.topK },
    { temperature: 0.3, topP: 0.9, topK: 100 },
  );
  updateSessionDefaultSampling({ topP: null, topK: null });
  const cleared = readSessionDefaults();
  assert.deepEqual(
    { temperature: cleared.temperature, topP: cleared.topP, topK: cleared.topK },
    { temperature: 0.3, topP: null, topK: null },
  );
});

test("rejects out-of-range top_p / top_k on read", () => {
  const p = sessionDefaultsPath();
  writeFileSync(p, JSON.stringify({ topP: 1.5, topK: 2.5 }), "utf8");
  assert.equal(readSessionDefaults().topP, null);
  assert.equal(readSessionDefaults().topK, null);
  writeFileSync(p, JSON.stringify({ topP: "0.9", topK: 0 }), "utf8");
  assert.equal(readSessionDefaults().topP, null);
  assert.equal(readSessionDefaults().topK, null);
});

test("rejects out-of-range or invalid temperature on read", () => {
  const p = sessionDefaultsPath();
  mkdirSync(root, { recursive: true });
  writeFileSync(p, JSON.stringify({ temperature: 3, thinkingLevel: "high" }), "utf8");
  assert.equal(readSessionDefaults().temperature, null);
  writeFileSync(p, JSON.stringify({ temperature: "0.5" }), "utf8");
  assert.equal(readSessionDefaults().temperature, null);
});

test("rejects unknown thinking level on read", () => {
  const p = sessionDefaultsPath();
  writeFileSync(p, JSON.stringify({ thinkingLevel: "ultra" }), "utf8");
  assert.equal(readSessionDefaults().thinkingLevel, null);
});

test("corrupted file falls back to unset defaults", () => {
  const p = sessionDefaultsPath();
  writeFileSync(p, "{ not json", "utf8");
  assert.deepEqual(readSessionDefaults(), UNSET);
});
