import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { supportsCodexFastMode } = await jiti.import("@/lib/session-fast-mode.ts");

const SUPPORTED_MODEL = { provider: "openai-codex", modelId: "gpt-5.5" };
const SUPPORTED_MODEL_LIST = [{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" }];

function renderComposer(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, isStreaming: false, ...props,
    })),
  );
}

function fastButton(html, pressed) {
  const anchor = html.indexOf(`aria-pressed="${pressed}"`);
  assert.notEqual(anchor, -1, `expected aria-pressed="${pressed}"`);
  const start = html.lastIndexOf("<button", anchor);
  const end = html.indexOf("</button>", anchor);
  return html.slice(start, end);
}

test("hides the Fast toggle when the current model lacks Codex Fast support", () => {
  const html = renderComposer({
    model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    fastModeSupported: false,
    fastMode: true,
    onFastModeChange() {},
  });
  assert.doesNotMatch(html, /aria-pressed/);
  assert.doesNotMatch(html, /⚡/);
});

test("shows the ⚡ Fast toggle next to the model selector with aria-pressed", () => {
  const html = renderComposer({
    model: SUPPORTED_MODEL,
    modelList: SUPPORTED_MODEL_LIST,
    fastModeSupported: true,
    fastMode: true,
    onFastModeChange() {},
  });
  const button = fastButton(html, "true");
  assert.match(button, /⚡/);
  assert.match(button, />Fast<\/span>/);
  assert.match(button, /title="Fast requests faster responses without changing the thinking level\. It is a request, not a speed guarantee, and consumes extra quota\."/);
  // Placed beside the model selector in the bottom bar, after the composer.
  assert.ok(html.indexOf("title=\"Change model\"") < html.indexOf("⚡"), "Fast toggle follows the model selector");
  assert.ok(html.indexOf("⚡") > html.indexOf("<textarea"), "Fast toggle sits in the bottom bar");
});

test("Astra and all GPT-5.6 catalog variants display Fast using the real capability helper", () => {
  for (const [id, name] of [
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ]) {
    const selectedModel = { provider: "openai-codex", modelId: id };
    const html = renderComposer({
      model: selectedModel,
      modelList: [{ provider: selectedModel.provider, id, name }],
      fastModeSupported: supportsCodexFastMode(selectedModel),
      fastMode: false,
      onFastModeChange() {},
    });
    assert.match(fastButton(html, "false"), /⚡/, id);
  }
});

test("reflects the off state via aria-pressed=false", () => {
  const html = renderComposer({
    model: SUPPORTED_MODEL,
    modelList: SUPPORTED_MODEL_LIST,
    fastModeSupported: true,
    fastMode: false,
    onFastModeChange() {},
  });
  assert.match(fastButton(html, "false"), /⚡/);
});

test("locks the Fast toggle while the session is busy or the switch is in flight", () => {
  for (const [name, props] of [
    ["streaming", { isStreaming: true }],
    ["switching", { fastModeSwitching: true }],
    ["model switching", { modelSwitching: true }],
    ["compacting", { isCompacting: true }],
  ]) {
    const html = renderComposer({
      model: SUPPORTED_MODEL,
      modelList: SUPPORTED_MODEL_LIST,
      fastModeSupported: true,
      fastMode: false,
      onFastModeChange() {},
      ...props,
    });
    const button = fastButton(html, "false");
    assert.match(button, /disabled=""/, name);
  }
});

test("hides the Fast toggle for read-only composers without a handler", () => {
  const html = renderComposer({
    model: SUPPORTED_MODEL,
    modelList: SUPPORTED_MODEL_LIST,
    fastModeSupported: true,
    fastMode: true,
    onFastModeChange: undefined,
  });
  assert.doesNotMatch(html, /aria-pressed/);
});

test("localizes the Fast tooltip copy in zh-CN and zh-TW", async () => {
  const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN.ts");
  const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW.ts");
  for (const [label, messages] of [["zh-CN", zhCNLocale.messages], ["zh-TW", zhTWLocale.messages]]) {
    assert.equal(messages["chat.fastMode"], "Fast", label);
    // Copy must explain: no thinking-level change, extra quota, request not guarantee.
    assert.match(messages["chat.fastModeHint"], /不改[變变]思考[等級層级]/, label);
    assert.match(messages["chat.fastModeHint"], /额外消耗额度|額外消耗額度/, label);
    assert.match(messages["chat.fastModeHint"], /不保证加速|不保證加速/, label);
  }
});
