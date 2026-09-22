import test from "node:test";
import assert from "node:assert/strict";
import {
  hasWorkEvidence,
  isTrackedShellWrite,
  markHandoffSaved,
  markSuccessfulChange,
  newHandoffReminderState,
  shouldRemind,
  toolSucceeded,
} from "../src/handoff-reminder.ts";

test("only successful exact mutations become pending", () => {
  const state = newHandoffReminderState();
  assert.equal(toolSucceeded({ isError: true }), false);
  assert.equal(toolSucceeded({ result: { details: { cancelled: true } } }), false);
  assert.equal(toolSucceeded({ isError: false, result: { details: { exitCode: 1 } } }), false, "failed git commit must not become pending even when isError is false");
  assert.equal(toolSucceeded({ isError: false }), true);
  markSuccessfulChange(state);
  assert.equal(shouldRemind(state), true);
});

test("handoff success clears pending; knowledge does not use this path", () => {
  const state = newHandoffReminderState();
  markSuccessfulChange(state);
  markHandoffSaved(state);
  assert.equal(shouldRemind(state), false);
});

test("one pending epoch does not re-arm after later edits", () => {
  const state = newHandoffReminderState();
  markSuccessfulChange(state);
  state.reminded = true;
  markSuccessfulChange(state);
  assert.equal(shouldRemind(state), false);
});

test("pending reminder does not depend on assistant wording", () => {
  const state = newHandoffReminderState();
  markSuccessfulChange(state);
  assert.equal(shouldRemind(state), true, "a terse final answer such as 好了 must still remind");
});

test("literal failed in successful edit or handoff content is not treated as tool failure", () => {
  assert.equal(toolSucceeded({ isError: false, result: { content: [{ type: "text", text: "wrote assertion containing failed" }] } }), true);
});

test("工作证据只认文件修改，不认闲聊与只读工具", () => {
  const chat = [
    { type: "message", message: { role: "user", content: "哪里来的伞" } },
    { type: "message", message: { role: "assistant", content: "那是我多加的细节" } },
  ];
  assert.equal(hasWorkEvidence(chat), false);
  const readOnly = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "poem.md" } }] } },
  ];
  assert.equal(hasWorkEvidence(readOnly), false, "只读检索不产生兜底交接");
  const edited = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "改好了" }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "a.ts" } }] } },
  ];
  assert.equal(hasWorkEvidence(edited), true);
  const committed = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "git commit -m done" } }] } },
  ];
  assert.equal(hasWorkEvidence(committed), true);
  const queried = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "npm test" } }] } },
  ];
  assert.equal(hasWorkEvidence(queried), false);
  assert.equal(hasWorkEvidence([]), false);
});

test("shell mutation recognition is deliberately narrow", () => {
  assert.equal(isTrackedShellWrite("bash", { command: "git commit -m done" }), true);
  assert.equal(isTrackedShellWrite("bash", { command: "git status" }), false);
  assert.equal(isTrackedShellWrite("bash", { command: "git commit --dry-run" }), false);
  assert.equal(isTrackedShellWrite("bash", { command: "git commit --help" }), false);
  assert.equal(isTrackedShellWrite("bash", { command: "npm test" }), false);
  assert.equal(isTrackedShellWrite("bash", { command: "git commit -m done; git push" }), false);
});
