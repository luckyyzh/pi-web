import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const TEMPERATURE_TYPE = "pi-web:temperature";

/** vLLM/SGLang 与多数 OpenAI 兼容服务端接受的范围；Google 同为 [0,2]，Anthropic/Mistral 为 [0,1]。 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
/** 核采样阈值，标准范围 [0,1]；越小越保守。 */
export const TOP_P_MIN = 0;
export const TOP_P_MAX = 1;
/**
 * 候选词数量上限。本地 vLLM 的默认值常被模型的 generation_config.json 覆盖
 * （例如 Qwen3.8-27B-FP8 的 top_k=20），显式设置这里是覆盖它的唯一客户端手段。
 * 注意：官方 OpenAI 端点不接受该参数，只对 vLLM/SGLang 等兼容服务端有效。
 */
export const TOP_K_MIN = 1;
export const TOP_K_MAX = 1000;

/** null = 显式恢复默认（不发送该字段）；undefined = 从未设置。 */
export type SessionTemperature = number | null;
export type SessionTopP = number | null;
export type SessionTopK = number | null;

/** 会话级采样参数三元组；字段为 null 表示「不注入该字段，用服务端默认」。 */
export interface SessionSampling {
  temperature: SessionTemperature;
  topP: SessionTopP;
  topK: SessionTopK;
}

export const DEFAULT_SAMPLING: SessionSampling = { temperature: null, topP: null, topK: null };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function validateTemperature(value: unknown): SessionTemperature {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("temperature must be a number or null");
  }
  if (!inRange(value, TEMPERATURE_MIN, TEMPERATURE_MAX)) {
    throw new Error(`temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}`);
  }
  return round2(value);
}

export function validateTopP(value: unknown): SessionTopP {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("top_p must be a number or null");
  }
  if (!inRange(value, TOP_P_MIN, TOP_P_MAX)) {
    throw new Error(`top_p must be between ${TOP_P_MIN} and ${TOP_P_MAX}`);
  }
  return round2(value);
}

export function validateTopK(value: unknown): SessionTopK {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("top_k must be a number or null");
  }
  if (!inRange(value, TOP_K_MIN, TOP_K_MAX)) {
    throw new Error(`top_k must be between ${TOP_K_MIN} and ${TOP_K_MAX}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error("top_k must be an integer");
  }
  return value;
}

/** 残缺的采样覆盖：缺省字段表示「保持当前值」，null 表示「清除该字段」。 */
export interface SessionSamplingPatch {
  temperature?: SessionTemperature;
  topP?: SessionTopP;
  topK?: SessionTopK;
}

/** 解析客户端的部分采样覆盖对象；非法值直接抛错，不静默忽略。 */
export function parseSamplingPatch(value: unknown): SessionSamplingPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sampling must be an object");
  }
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.temperature !== undefined ? { temperature: validateTemperature(raw.temperature) } : {}),
    ...(raw.topP !== undefined ? { topP: validateTopP(raw.topP) } : {}),
    ...(raw.topK !== undefined ? { topK: validateTopK(raw.topK) } : {}),
  };
}

/** 把补丁合并到当前采样设置上（缺省字段保持不变）。 */
export function mergeSampling(current: SessionSampling, patch: SessionSamplingPatch): SessionSampling {
  return {
    temperature: patch.temperature === undefined ? current.temperature : validateTemperature(patch.temperature),
    topP: patch.topP === undefined ? current.topP : validateTopP(patch.topP),
    topK: patch.topK === undefined ? current.topK : validateTopK(patch.topK),
  };
}

export function isDefaultSampling(sampling: SessionSampling): boolean {
  return sampling.temperature === null && sampling.topP === null && sampling.topK === null;
}

/** 从已存的条目里读字段：null 合法（清除），undefined 表示缺失/非法。 */
function readField(value: unknown, min: number, max: number, integer = false): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!inRange(value, min, max)) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  return value;
}

/**
 * 会话级偏好：最后一次有效选择整体生效（树导航不回退到分支点之前的选择）。
 * v2 = 三元组；v1 = 只有 value 的旧格式，按「只设了温度」理解。
 */
export function readSessionSampling(entries: readonly SessionEntry[]): SessionSampling | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TEMPERATURE_TYPE) continue;
    const data = entry.data as
      | { version?: unknown; value?: unknown; temperature?: unknown; topP?: unknown; topK?: unknown }
      | null;
    if (!data || typeof data !== "object") continue;
    if (data.version === 2) {
      const temperature = readField(data.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
      const topP = readField(data.topP, TOP_P_MIN, TOP_P_MAX);
      const topK = readField(data.topK, TOP_K_MIN, TOP_K_MAX, true);
      // 三个字段全都缺失/非法才视为无效条目，继续向前找；显式 null 是合法的「恢复默认」。
      if (temperature === undefined && topP === undefined && topK === undefined) continue;
      return {
        temperature: temperature === undefined ? null : temperature,
        topP: topP === undefined ? null : topP,
        topK: topK === undefined ? null : topK,
      };
    }
    if (data.version === 1) {
      if (data.value === null) return { ...DEFAULT_SAMPLING };
      const legacy = readField(data.value, TEMPERATURE_MIN, TEMPERATURE_MAX);
      if (legacy === undefined) continue;
      return { temperature: legacy, topP: null, topK: null };
    }
  }
  return undefined;
}

/** 只关心温度的旧接口（会话列表/详情等消费方保持不变）。 */
export function readSessionTemperature(entries: readonly SessionEntry[]): SessionTemperature | undefined {
  const sampling = readSessionSampling(entries);
  return sampling === undefined ? undefined : sampling.temperature;
}

export function appendSessionSampling(sessionManager: SessionManager, value: SessionSampling): void {
  sessionManager.appendCustomEntry(TEMPERATURE_TYPE, {
    version: 2,
    temperature: validateTemperature(value.temperature),
    topP: validateTopP(value.topP),
    topK: validateTopK(value.topK),
  });
}

/** 旧接口：只写温度，并清掉 top_p/top_k。 */
export function appendSessionTemperature(sessionManager: SessionManager, value: SessionTemperature): void {
  appendSessionSampling(sessionManager, {
    temperature: validateTemperature(value),
    topP: null,
    topK: null,
  });
}

/** Copies the current preference, even when the fork point predates its last change. */
export function copySessionSampling(source: SessionManager, target: SessionManager): void {
  const current = readSessionSampling(source.getEntries() as unknown as SessionEntry[]);
  if (current === undefined) return;
  const existing = readSessionSampling(target.getEntries() as unknown as SessionEntry[]);
  if (
    existing
    && existing.temperature === current.temperature
    && existing.topP === current.topP
    && existing.topK === current.topK
  ) {
    return;
  }
  appendSessionSampling(target, current);
}

/** 旧接口：保持原语义（只比较温度），供既有调用方使用。 */
export function copySessionTemperature(source: SessionManager, target: SessionManager): void {
  const current = readSessionTemperature(source.getEntries() as unknown as SessionEntry[]);
  if (current !== undefined && current !== readSessionTemperature(target.getEntries() as unknown as SessionEntry[])) {
    appendSessionTemperature(target, current);
  }
}

type PayloadHook = AgentOptions["onPayload"];
type ModelLike = { api?: string };

/**
 * 各 provider 的 payload 字段形状不同：
 * - OpenAI 系 / Anthropic / Mistral：顶层 temperature / top_p / top_k
 * - Google：generationConfig 里的 temperature / topP / topK
 * - Bedrock Converse：inferenceConfig 里的 temperature / topP（该协议不支持 top_k，忽略）
 */
function applySamplingToPayload(payload: unknown, api: string | undefined, sampling: SessionSampling): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const temperature = sampling.temperature === null ? undefined : sampling.temperature;
  const topP = sampling.topP === null ? undefined : sampling.topP;
  const topK = sampling.topK === null ? undefined : sampling.topK;
  switch (api) {
    case "google-generative-ai":
    case "google-vertex": {
      const fields: Record<string, number> = {};
      if (temperature !== undefined) fields.temperature = temperature;
      if (topP !== undefined) fields.topP = topP;
      if (topK !== undefined) fields.topK = topK;
      if (!Object.keys(fields).length) return payload;
      const generationConfig = (p.generationConfig ?? {}) as Record<string, unknown>;
      return { ...p, generationConfig: { ...generationConfig, ...fields } };
    }
    case "bedrock-converse":
    case "bedrock-converse-stream": {
      const fields: Record<string, number> = {};
      if (temperature !== undefined) fields.temperature = temperature;
      if (topP !== undefined) fields.topP = topP;
      if (!Object.keys(fields).length) return payload;
      const inferenceConfig = (p.inferenceConfig ?? {}) as Record<string, unknown>;
      return { ...p, inferenceConfig: { ...inferenceConfig, ...fields } };
    }
    default: {
      const fields: Record<string, number> = {};
      if (temperature !== undefined) fields.temperature = temperature;
      if (topP !== undefined) fields.top_p = topP;
      if (topK !== undefined) fields.top_k = topK;
      if (!Object.keys(fields).length) return payload;
      return { ...p, ...fields };
    }
  }
}

/**
 * Preserve SDK/extension payload hooks; inject the session's sampling preference
 * at the shared payload hook (same mechanism as Fast mode).
 */
export function withSessionSampling(
  original: PayloadHook,
  getSampling: () => SessionSampling | null | undefined,
): NonNullable<PayloadHook> {
  const hook: NonNullable<PayloadHook> = async (payload, model) => {
    const replacement = await original?.(payload, model);
    const result = replacement === undefined ? payload : replacement;
    const sampling = getSampling();
    if (sampling === undefined || sampling === null || isDefaultSampling(sampling)) return result;
    return applySamplingToPayload(result, (model as ModelLike | undefined)?.api, sampling);
  };
  return hook;
}

/** 只注入温度的旧接口，语义与行为保持不变。 */
export function withSessionTemperature(
  original: PayloadHook,
  getTemperature: () => SessionTemperature | undefined,
): NonNullable<PayloadHook> {
  return withSessionSampling(original, () => {
    const temperature = getTemperature();
    if (temperature === undefined) return undefined;
    return { temperature, topP: null, topK: null };
  });
}
