import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const TEMPERATURE_TYPE = "pi-web:temperature";

/** vLLM/SGLang 与多数 OpenAI 兼容服务端接受的范围；Google 同为 [0,2]，Anthropic/Mistral 为 [0,1]。 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;

/** null = 显式恢复默认（不发送 temperature）；undefined = 从未设置。 */
export type SessionTemperature = number | null;

export function validateTemperature(value: unknown): SessionTemperature {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("temperature must be a number or null");
  }
  if (value < TEMPERATURE_MIN || value > TEMPERATURE_MAX) {
    throw new Error(`temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}`);
  }
  return Math.round(value * 100) / 100;
}

/** Session-wide preference: tree navigation does not rewind the latest explicit choice. */
export function readSessionTemperature(entries: readonly SessionEntry[]): SessionTemperature | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TEMPERATURE_TYPE) continue;
    const data = entry.data as { version?: unknown; value?: unknown } | null;
    if (data?.version !== 1) continue;
    if (data.value === null) return null;
    if (typeof data.value === "number" && Number.isFinite(data.value)) return data.value;
  }
  return undefined;
}

export function appendSessionTemperature(sessionManager: SessionManager, value: SessionTemperature): void {
  sessionManager.appendCustomEntry(TEMPERATURE_TYPE, { version: 1, value: validateTemperature(value) });
}

/** Copies the current preference, even when the fork point predates its last change. */
export function copySessionTemperature(source: SessionManager, target: SessionManager): void {
  const current = readSessionTemperature(source.getEntries() as unknown as SessionEntry[]);
  if (current !== undefined && current !== readSessionTemperature(target.getEntries() as unknown as SessionEntry[])) {
    appendSessionTemperature(target, current);
  }
}

type PayloadHook = AgentOptions["onPayload"];
type ModelLike = { api?: string };

/** 各 provider 的 payload 中 temperature 字段位置不同；未知形状一律放顶层（OpenAI 系/Anthropic/Mistral）。 */
function applyTemperatureToPayload(payload: unknown, api: string | undefined, temperature: number): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  switch (api) {
    case "google-generative-ai":
    case "google-vertex": {
      const generationConfig = (p.generationConfig ?? {}) as Record<string, unknown>;
      return { ...p, generationConfig: { ...generationConfig, temperature } };
    }
    case "bedrock-converse":
    case "bedrock-converse-stream": {
      const inferenceConfig = (p.inferenceConfig ?? {}) as Record<string, unknown>;
      return { ...p, inferenceConfig: { ...inferenceConfig, temperature } };
    }
    default:
      return { ...p, temperature };
  }
}

/**
 * Preserve SDK/extension payload hooks; inject the session's temperature
 * preference at the shared payload hook (same mechanism as Fast mode).
 */
export function withSessionTemperature(
  original: PayloadHook,
  getTemperature: () => SessionTemperature | undefined,
): NonNullable<PayloadHook> {
  const hook: NonNullable<PayloadHook> = async (payload, model) => {
    const replacement = await original?.(payload, model);
    const result = replacement === undefined ? payload : replacement;
    const temperature = getTemperature();
    if (temperature === undefined || temperature === null) return result;
    return applyTemperatureToPayload(result, (model as ModelLike | undefined)?.api, temperature);
  };
  return hook;
}
