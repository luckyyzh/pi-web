/**
 * lib/session-defaults.ts
 * 全局「上次使用」的会话默认值：~/.pi/agent/session-defaults.json 读写。
 * 新建会话时，若未显式指定温度/思考档位，则跟随这里记录的上次修改，
 * 免去每次新开会话都重新调整。
 * 消费方：lib/rpc-manager.ts（set_temperature / set_thinking_level 写入，startRpcSession 读取兜底）。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionDefaults {
  /** null = 未设置（新建会话走服务端默认温度） */
  temperature: number | null;
  /** null = 未设置（新建会话走服务端默认 top_p） */
  topP: number | null;
  /** null = 未设置（新建会话走服务端默认 top_k） */
  topK: number | null;
  /** null = 未设置（新建会话走 SDK 默认思考档位） */
  thinkingLevel: string | null;
}

const DEFAULTS: SessionDefaults = { temperature: null, topP: null, topK: null, thinkingLevel: null };
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const TOP_P_MIN = 0;
const TOP_P_MAX = 1;
const TOP_K_MIN = 1;
const TOP_K_MAX = 1000;

export function sessionDefaultsPath(): string {
  return join(getAgentDir(), "session-defaults.json");
}

/** 读取全局默认；文件缺失/损坏/字段非法时按未设置（null）处理 */
export function readSessionDefaults(): SessionDefaults {
  try {
    const p = sessionDefaultsPath();
    if (!existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const temperature = readNumber(raw.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
    const topP = readNumber(raw.topP, TOP_P_MIN, TOP_P_MAX);
    const topK = readNumber(raw.topK, TOP_K_MIN, TOP_K_MAX, true);
    const thinkingLevel =
      typeof raw.thinkingLevel === "string" && THINKING_LEVELS.has(raw.thinkingLevel)
        ? raw.thinkingLevel
        : null;
    return { temperature, topP, topK, thinkingLevel };
  } catch {
    return { ...DEFAULTS };
  }
}

function readNumber(value: unknown, min: number, max: number, integer = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function writeSessionDefaults(defaults: SessionDefaults): void {
  const p = sessionDefaultsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(defaults, null, 2) + "\n", "utf8");
}

/** 记录上次使用的温度（null = 恢复默认） */
export function updateSessionDefaultTemperature(value: number | null): void {
  const current = readSessionDefaults();
  writeSessionDefaults({ ...current, temperature: value });
}

/** 记录上次使用的 top_p / top_k（null = 恢复默认；字段缺省 = 保持不变） */
export function updateSessionDefaultSampling(patch: { topP?: number | null; topK?: number | null }): void {
  const current = readSessionDefaults();
  writeSessionDefaults({
    ...current,
    ...(patch.topP === undefined ? {} : { topP: patch.topP }),
    ...(patch.topK === undefined ? {} : { topK: patch.topK }),
  });
}

/** 记录上次使用的思考档位（null = 恢复默认） */
export function updateSessionDefaultThinkingLevel(level: string | null): void {
  const current = readSessionDefaults();
  writeSessionDefaults({ ...current, thinkingLevel: level });
}
