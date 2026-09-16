import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const FAST_MODE_TYPE = "pi-web:fast-mode";

type FastModeModel = {
  provider?: string;
  id?: string;
  modelId?: string;
  api?: string;
};

/** Reviewed Codex OAuth allowlist, not the broader OpenAI API Fast-support list. */
export function supportsCodexFastMode(model?: FastModeModel | null): boolean {
  if (model?.provider !== "openai-codex") return false;
  if (model.api !== undefined && model.api !== "openai-codex-responses") return false;
  // Catalog IDs include product names, not just version numbers. The Codex
  // Speed guide covers GPT-5.6 (Luna/Sol/Terra) and Astra; retain legacy IDs.
  // https://learn.chatgpt.com/docs/agent-configuration/speed
  return /^(?:gpt-5\.(?:4|5|6)(?:-codex)?|gpt-5\.6-(?:luna|sol|terra)|gpt-6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id ?? model.modelId ?? "");
}

export function validateFastMode(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("fastMode must be a boolean");
  return value;
}

/** Session-wide preference: tree navigation does not rewind the latest explicit choice. */
export function readSessionFastMode(entries: readonly SessionEntry[]): boolean | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== FAST_MODE_TYPE) continue;
    const data = entry.data as { version?: unknown; enabled?: unknown } | null;
    if (data?.version === 1 && typeof data.enabled === "boolean") return data.enabled;
  }
  return undefined;
}

export function appendSessionFastMode(sessionManager: SessionManager, enabled: boolean): void {
  sessionManager.appendCustomEntry(FAST_MODE_TYPE, { version: 1, enabled: validateFastMode(enabled) });
}

/** Copies the current preference, even when the fork point predates its last change. */
export function copySessionFastMode(source: SessionManager, target: SessionManager): void {
  const enabled = readSessionFastMode(source.getEntries() as unknown as SessionEntry[]);
  if (enabled !== undefined && enabled !== readSessionFastMode(target.getEntries() as unknown as SessionEntry[])) {
    appendSessionFastMode(target, enabled);
  }
}

type PayloadHook = AgentOptions["onPayload"];
// Next.js routes/HMR can load separate copies of this module. Use a shared symbol
// rather than a module-local WeakMap so the title route can always unwrap it.
const ORIGINAL_PAYLOAD_HOOK = Symbol.for("pi-web:fast-mode:original-payload-hook");
type FastPayloadHook = NonNullable<PayloadHook> & { [ORIGINAL_PAYLOAD_HOOK]?: PayloadHook };

/** Preserve SDK/extension payload hooks; do not replace the authenticated stream implementation. */
export function withSessionFastMode(original: PayloadHook, isEnabled: () => boolean): NonNullable<PayloadHook> {
  const hook: NonNullable<PayloadHook> = async (payload, model) => {
    const replacement = await original?.(payload, model);
    const result = replacement === undefined ? payload : replacement;
    if (!isEnabled() || !supportsCodexFastMode(model)) return result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Cannot apply Fast mode to a non-object Codex request");
    }
    // Pi's generic streamSimple does not forward serviceTier. Inject it at the
    // supported payload hook, shared by Codex SSE and WebSocket transports.
    return { ...result, service_tier: "priority" };
  };
  Object.defineProperty(hook, ORIGINAL_PAYLOAD_HOOK, { value: original });
  return hook;
}

/** Background title generation must not inherit this session's paid Fast opt-in. */
export function withoutSessionFastMode(hook: PayloadHook): PayloadHook {
  return hook && ORIGINAL_PAYLOAD_HOOK in hook ? (hook as FastPayloadHook)[ORIGINAL_PAYLOAD_HOOK] : hook;
}
