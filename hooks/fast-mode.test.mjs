import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const fastToggle = between("const handleFastModeChange = useCallback", "const handleToolPresetChange = useCallback");
const ensureSource = between("const ensureNewSession = useCallback", "const loadSystemInfo = useCallback");
const loadSessionSource = between("const loadSession = useCallback", "const loadContext = useCallback");

test("Fast mode is a session-scoped flag defaulting to false", () => {
  assert.match(source, /const \[fastMode, setFastMode\] = useState\(false\)/);
  // Top-level flag on both the session-file payload and the live state.
  assert.match(between("export interface SessionData {", "interface AgentEvent"), /fastMode\?: boolean;/);
  assert.match(source, /thinkingLevel\?: string;\n  fastMode\?: boolean;\n  isStreaming\?: boolean;/);
});

test("an existing-session toggle is confirmed only by the server response", () => {
  const sidIndex = fastToggle.indexOf("sid = sessionIdRef.current ?? await ensuringNewSessionRef.current");
  const commandIndex = fastToggle.indexOf('await sendAgentCommand<{ fastMode?: boolean }>(sid, {');
  const confirmIndex = fastToggle.indexOf("setFastMode(result.fastMode)");
  assert.ok(sidIndex >= 0);
  assert.ok(commandIndex > sidIndex, "command must be sent after resolving the session");
  assert.ok(confirmIndex > commandIndex, "state must be confirmed only after the awaited command");
  assert.match(fastToggle, /type: "set_fast_mode",\s*\n\s*enabled/);
  // No optimistic flip between resolving the session and the response.
  assert.doesNotMatch(fastToggle.slice(sidIndex, confirmIndex), /setFastMode\(/);
  // A response without the flag must not be read as an implicit "off".
  assert.match(fastToggle, /result\?\.fastMode !== undefined/);
  // State is committed only while the same session is still mounted.
  assert.match(fastToggle, /sessionHookMountedRef\.current\s*\n\s*&& sessionIdRef\.current === sid/);
});

test("a failed Fast toggle surfaces the existing error notice without faking success", () => {
  const catchIndex = fastToggle.indexOf("catch (e)");
  assert.ok(catchIndex > fastToggle.indexOf("await sendAgentCommand"));
  const tail = fastToggle.slice(catchIndex);
  assert.match(tail, /type: "error"/);
  assert.match(tail, /Failed to toggle Fast mode:/);
  assert.doesNotMatch(tail, /setFastMode\((true|false|enabled)\)/);
});

test("busy sessions block the toggle and no duplicate session is created", () => {
  const guardIndex = fastToggle.indexOf("if (agentRunningRef.current || bashRunningRef.current || fastModeSwitching || modelSwitching || isCompacting) return;");
  const sidIndex = fastToggle.indexOf("sid = sessionIdRef.current");
  assert.ok(guardIndex >= 0 && guardIndex < sidIndex, "busy/running guard must run first");
  assert.match(fastToggle, /sessionIdRef\.current \?\? await ensuringNewSessionRef\.current/);
  assert.doesNotMatch(fastToggle, /fetch\("\/api\/agent\/new"/);
});

test("an in-flight ensure is awaited, then the toggle is reconciled explicitly", () => {
  // The draft branch must be skipped while an ensure is already in flight.
  assert.match(fastToggle, /if \(isNew && !sessionIdRef\.current && !ensuringNewSessionRef\.current\)/);
  // The in-flight ensure promise is awaited, then set_fast_mode follows.
  const waitIndex = fastToggle.indexOf("sid = sessionIdRef.current ?? await ensuringNewSessionRef.current");
  const commandIndex = fastToggle.indexOf('await sendAgentCommand<{ fastMode?: boolean }>(sid, {');
  assert.ok(waitIndex >= 0 && commandIndex > waitIndex, "set_fast_mode must follow the awaited ensure");
  // The switching flag is cleared on every path, including a failed wait.
  const finallyIndex = fastToggle.lastIndexOf("} finally {");
  assert.ok(finallyIndex > commandIndex);
  assert.match(fastToggle.slice(finallyIndex), /setFastModeSwitching\(false\)/);
});

test("toggling Fast before a session exists only stores the selection", () => {
  const sidIndex = fastToggle.indexOf("sid = sessionIdRef.current");
  const preCreation = fastToggle.slice(0, sidIndex);
  assert.match(preCreation, /isNew && !sessionIdRef\.current && !ensuringNewSessionRef\.current/);
  assert.match(preCreation, /fastModeOverrideRef\.current = enabled/);
  // A pre-creation selection must not create or touch a live session.
  assert.doesNotMatch(preCreation, /sendAgentCommand|fetch\(/);
});

test("a pre-selected Fast for a new session rides the ensure_session request", () => {
  assert.match(ensureSource, /const selectedFastMode = fastModeOverrideRef\.current;/);
  assert.match(ensureSource, /\.\.\.\(selectedFastMode \? \{ fastMode: selectedFastMode \} : \{\}\)/);
  assert.match(ensureSource, /thinkingLevel\?: ThinkingLevelOption;\n        fastMode\?: boolean;/);
  assert.match(ensureSource, /if \(result\.fastMode !== undefined\) setFastMode\(Boolean\(result\.fastMode\)\)/);
  // Session-scoped override, not a global default.
  assert.match(source, /const fastModeOverrideRef = useRef<boolean \| null>\(null\)/);
});

test("history load, get_state, and tool switches restore the Fast flag", () => {
  // History load: top-level flag from GET /api/sessions/[id].
  assert.match(loadSessionSource, /if \(d\.fastMode !== undefined\) setFastMode\(Boolean\(d\.fastMode\)\)/);
  // Every live-state sync site mirrors the Fast flag right after the model.
  const re = /syncLiveModel\((state|liveState|d\.state|data\.state)\)/g;
  let count = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    const after = source.slice(match.index, match.index + 160);
    assert.match(after, new RegExp(`syncFastMode\\(${match[1]}\\)`), `syncFastMode missing after ${match[0]}`);
    count += 1;
  }
  assert.ok(count >= 8, `expected at least 8 live-state sync sites, found ${count}`);
});

test("Fast support comes from the shared helper on the displayed model, not reasoning", () => {
  assert.match(source, /import \{ supportsCodexFastMode \} from "@\/lib\/session-fast-mode"/);
  assert.match(source, /const fastModeSupported = supportsCodexFastMode\(displayModel\)/);
  // The toggle handler never consults the thinking level.
  assert.doesNotMatch(fastToggle, /thinkingLevel|set_thinking_level/);
  // Exposed to the composer.
  assert.match(source, /fastMode, fastModeSwitching, fastModeSupported,/);
  assert.match(source, /handleFastModeChange,/);
});
