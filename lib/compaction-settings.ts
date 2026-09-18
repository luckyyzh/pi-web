/**
 * lib/compaction-settings.ts
 * 压缩（摘要）模型/思考档位配置：~/.pi/agent/compaction-settings.json 读写。
 * 消费方：lib/compaction-extension.ts（session_before_compact 拦截）与 app/api/compaction-settings。
 * 两个字段都为 null 时不干预，使用内置默认压缩（会话当前模型 + 会话思考档位）。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CompactionModelRef {
  provider: string;
  modelId: string;
}

export interface CompactionSettings {
  /** null = 跟随会话当前模型 */
  model: CompactionModelRef | null;
  /** null = 跟随会话思考档位 */
  thinkingLevel: string | null;
  /**
   * 缓存对齐模式：复用会话原 system prompt + 字节一致的完整历史 + 尾部摘要指令，
   * 使压缩请求与主会话请求前缀一致，命中服务端前缀缓存（需 vLLM 等后端开启 APC）。
   * 默认 false = 独立摘要 prompt（与内置压缩同形态）。
   */
  cacheAligned: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  model: null,
  thinkingLevel: null,
  cacheAligned: false,
};

export const COMPACTABLE_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

const ALLOWED_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function compactionSettingsPath(): string {
  return join(getAgentDir(), "compaction-settings.json");
}

export function isCompactionConfigured(s: CompactionSettings): boolean {
  return s.model !== null || s.thinkingLevel !== null || s.cacheAligned;
}

/** 读取配置；文件缺失/损坏/字段非法时按默认（不干预）处理 */
export function readCompactionSettings(): CompactionSettings {
  try {
    const p = compactionSettingsPath();
    if (!existsSync(p)) return { ...DEFAULT_COMPACTION_SETTINGS };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const m = raw.model;
    const model =
      m && typeof m === "object" &&
      typeof (m as CompactionModelRef).provider === "string" &&
      typeof (m as CompactionModelRef).modelId === "string" &&
      (m as CompactionModelRef).provider.trim() !== "" &&
      (m as CompactionModelRef).modelId.trim() !== ""
        ? { provider: (m as CompactionModelRef).provider, modelId: (m as CompactionModelRef).modelId }
        : null;
    const thinkingLevel =
      typeof raw.thinkingLevel === "string" && ALLOWED_LEVELS.has(raw.thinkingLevel)
        ? raw.thinkingLevel
        : null;
    const cacheAligned = raw.cacheAligned === true;
    return { model, thinkingLevel, cacheAligned };
  } catch {
    return { ...DEFAULT_COMPACTION_SETTINGS };
  }
}

export function writeCompactionSettings(settings: CompactionSettings): void {
  const p = compactionSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** 校验 API 请求体，返回规范化配置；非法时返回 null */
export function normalizeCompactionSettingsBody(body: unknown): CompactionSettings | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const m = b.model;
  let model: CompactionModelRef | null;
  if (m === null || m === undefined) {
    model = null;
  } else if (
    m && typeof m === "object" &&
    typeof (m as CompactionModelRef).provider === "string" &&
    typeof (m as CompactionModelRef).modelId === "string" &&
    (m as CompactionModelRef).provider.trim() !== "" &&
    (m as CompactionModelRef).modelId.trim() !== ""
  ) {
    model = { provider: (m as CompactionModelRef).provider, modelId: (m as CompactionModelRef).modelId };
  } else {
    return null;
  }
  let thinkingLevel: string | null;
  if (b.thinkingLevel === null || b.thinkingLevel === undefined) {
    thinkingLevel = null;
  } else if (typeof b.thinkingLevel === "string" && ALLOWED_LEVELS.has(b.thinkingLevel)) {
    thinkingLevel = b.thinkingLevel;
  } else {
    return null;
  }
  const cacheAligned = b.cacheAligned === true;
  return { model, thinkingLevel, cacheAligned };
}
