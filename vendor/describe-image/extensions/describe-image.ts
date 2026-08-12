/**
 * describe-image.ts
 *
 * 全局扩展：按需识图（describe_image）——主模型决定何时看图
 *
 * 设计目标（"最优设计"）：
 *  1. 原生支持视觉的模型（model.input 含 "image"）→ 完全不干预，走 pi 正常链路。
 *  2. 非视觉模型（如 DeepSeek）→ 在 context 阶段（早于 pi 的图片剥离）把每个图片块
 *     替换成"可操作的引用提示"，让主模型"知道有图"并能按需调用 describe_image 去提取信息。
 *  3. describe_image(ref, prompt) 工具：
 *     - 把图 + prompt 发给外部视觉模型（OpenAI 兼容，默认阿里云 DashScope qwen-vl-plus，
 *       也支持任何 OpenAI 兼容端点 / Ollama）
 *     - temperature=0 + 固定输出 → 确定性结果
 *     - 按 (ref, prompt) 做 LRU 结果缓存 → 同图同问返回完全相同的文字 → 主模型前缀稳定，
 *       缓存命中率不降
 *
 * 配置（优先级：环境变量 > 配置文件 ~/.pi/agent/extensions/describe-image-config.json）：
 *   VISION_BASE_URL  （默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
 *   VISION_API_KEY   （必需；放环境变量，不要提交进仓库）
 *   VISION_MODEL     （默认 qwen-vl-plus）
 *   也可用 /describe-image config <key> <value> 持久化（apiKey 仍建议环境变量）
 *
 * 安装：放到 ~/.pi/agent/extensions/，/reload 或新开会话。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

// ============================================================================
// 常量 / 配置
// ============================================================================
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "describe-image-config.json");
const VISION_TIMEOUT_MS = 60_000;

interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
}

function loadConfig(): VisionConfig {
  let file: Partial<VisionConfig> = {};
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    file = {};
  }
  return {
    baseUrl: file.baseUrl ?? process.env.VISION_BASE_URL ?? DEFAULT_BASE_URL,
    model: file.model ?? process.env.VISION_MODEL ?? "qwen-vl-plus",
    // apiKey：优先环境变量（更安全），其次配置文件
    apiKey: process.env.VISION_API_KEY ?? file.apiKey,
    maxTokens: file.maxTokens ?? 1024,
  };
}

function saveConfig(partial: Partial<VisionConfig>): void {
  const current = loadConfig();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...partial }, null, 2), "utf8");
}

// ============================================================================
// 图片引用注册表（ref → 图片数据）
// 会话内把图片映射成稳定 ref，供 describe_image 按 ref 取回原图
// ============================================================================
interface RegisteredImage {
  data: string; // base64
  mime: string;
}

const imageRegistry = new Map<string, RegisteredImage>();
const IMAGE_REGISTRY_MAX = 128;

function imageHash(mime: string, data: string): string {
  return createHash("sha256").update(mime).update("\0").update(data).digest("hex").slice(0, 12);
}

function registerImage(img: RegisteredImage): string {
  const ref = `img#${imageHash(img.mime, img.data)}`;
  if (!imageRegistry.has(ref)) {
    imageRegistry.set(ref, img);
    // 防止无界增长：超限时删除最早注册的
    if (imageRegistry.size > IMAGE_REGISTRY_MAX) {
      const oldest = imageRegistry.keys().next().value as string | undefined;
      if (oldest) imageRegistry.delete(oldest);
    }
  }
  return ref;
}

// ============================================================================
// 工具结果缓存（(ref, prompt) → 确定性文本）→ 保证同图同问结果一致，缓存命中率不降
// ============================================================================
const resultCache = new Map<string, string>();
const RESULT_CACHE_MAX = 200;

function cacheKey(ref: string, prompt: string): string {
  return `${ref}\u0000${prompt}`;
}

function getCached(ref: string, prompt: string): string | undefined {
  return resultCache.get(cacheKey(ref, prompt));
}

function putCached(ref: string, prompt: string, text: string): void {
  const key = cacheKey(ref, prompt);
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value as string | undefined;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(key, text);
}

// ============================================================================
// 图片块识别（兼容 pi 的 4 种形态）与提示文字处理
// ============================================================================
function extractImageFromBlock(block: unknown): RegisteredImage | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;

  // pi-ai 内部 / read 工具：{ type:"image", data, mimeType }
  if (b.type === "image" && typeof b.data === "string") {
    return { data: b.data, mime: typeof b.mimeType === "string" ? b.mimeType : "image/png" };
  }
  // Anthropic：{ type:"image", source:{ type:"base64", media_type, data } }
  if (
    b.type === "image" &&
    b.source &&
    typeof b.source === "object" &&
    (b.source as Record<string, unknown>).type === "base64" &&
    typeof (b.source as Record<string, unknown>).data === "string"
  ) {
    const src = b.source as Record<string, unknown>;
    return { data: src.data as string, mime: (src.media_type as string) || "image/png" };
  }
  // OpenAI Chat：{ type:"image_url", image_url:{ url:"data:mime;base64,.." } }
  if (b.type === "image_url" && b.image_url && typeof (b.image_url as Record<string, unknown>).url === "string") {
    const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec((b.image_url as Record<string, unknown>).url as string);
    if (m) return { data: m[2], mime: m[1] };
  }
  // OpenAI Responses：{ type:"input_image", image_url:"data:..." }
  if (b.type === "input_image" && typeof b.image_url === "string") {
    const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(b.image_url as string);
    if (m) return { data: m[2], mime: m[1] };
  }
  return null;
}

/** 升级后的引用提示（告诉主模型"有图、怎么用"） */
function buildHint(ref: string): string {
  return (
    `[image attached, ref="${ref}"; the current model cannot see images directly. ` +
    `To analyze or extract information from this image, call the describe_image tool ` +
    `with ref="${ref}" and a prompt describing what you need.]`
  );
}

/** 需要被移除的误导性占位/提示（这些文本表示"图片被剥离了"，我们已换成更好的提示） */
const STRIPPED_NOTE_PATTERNS: RegExp[] = [
  /\(image omitted: model does not support images\)/g,
  /\(tool image omitted: model does not support images\)/g,
  /\[Current model does not support images\.[^\]]*\]/g,
];

function stripMisleadingNotes(text: string): string | null {
  let t = text;
  for (const re of STRIPPED_NOTE_PATTERNS) t = t.replace(re, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t === "" ? null : t;
}

// ============================================================================
// 视觉模型调用（OpenAI 兼容）
// ============================================================================
async function describeWithVision(cfg: VisionConfig, img: RegisteredImage, prompt: string): Promise<string> {
  if (!cfg.apiKey) throw new Error("未配置视觉模型 API Key（设置环境变量 VISION_API_KEY 或用 /describe-image config apiKey）");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0, // 确定性输出
      max_tokens: cfg.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`视觉模型 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) throw new Error("视觉模型返回空内容");
  return text.trim();
}

// ============================================================================
// 扩展主体
// ============================================================================
export default function (pi: ExtensionAPI) {
  // ---------- context：只在"非视觉模型"上拦截，视觉模型放行 ----------
  pi.on("context", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    // 原生支持视觉 → 走正常链路，什么都不做
    if (Array.isArray(model.input) && model.input.includes("image")) return;
    // 非视觉模型 → 需要视觉模型配置才有意义；没配就不注入（避免引导出坏工具）
    if (!loadConfig().apiKey) return;

    const messages = event.messages as unknown as Array<{ role?: string; content?: unknown[] }>;
    if (!Array.isArray(messages)) return;

    let changed = false;
    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "toolResult") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      const next: unknown[] = [];
      let touched = false;
      for (const block of content) {
        const img = extractImageFromBlock(block);
        if (img) {
          const ref = registerImage(img);
          next.push({ type: "text", text: buildHint(ref) });
          touched = true;
          continue;
        }
        // 文本块：去掉误导性的"图片被省略"提示，保留其它内容
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") {
            const cleaned = stripMisleadingNotes(text);
            if (cleaned !== null) next.push({ type: "text", text: cleaned });
            continue;
          }
        }
        next.push(block);
      }
      if (touched) {
        msg.content = next;
        changed = true;
      }
    }
    if (changed) return { messages: event.messages };
  });

  // ---------- 工具：describe_image ----------
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "用外部视觉模型分析图片。当用户消息里出现 [image attached, ref=\"img#...\"] 提示、或你 read 到图片但看不到内容时，调用本工具传入该 ref 和具体需求来提取信息（如识别报错、描述布局、提取文字）。",
    promptSnippet: "Analyze images with an external vision model; pass a ref (img#xxx) and request to extract errors / describe layout / read text",
    parameters: Type.Object({
      ref: Type.String({ description: "图片引用，形如 img#xxxx。来自消息里的 [image attached, ref=...] 提示" }),
      prompt: Type.String({ description: "对这张图的具体要求，例如：提取图中报错信息 / 描述页面布局 / 识别图中文字" }),
    }),
    async execute(_toolCallId, params: { ref: string; prompt: string }, signal, _onUpdate, _ctx) {
      try {
        const img = imageRegistry.get(params.ref);
        if (!img) {
          return {
            content: [{
              type: "text" as const,
              text: `describe_image 找不到图片引用 "${params.ref}"。图片引用只在图片仍出现在会话里时有效；请确认使用消息提示中给出的 ref。`,
            }],
            details: { error: true },
          };
        }

        // 缓存命中：同图同问 → 完全相同的确定性文本 → 主模型前缀稳定
        const cached = getCached(params.ref, params.prompt);
        if (cached !== undefined) {
          return { content: [{ type: "text" as const, text: cached }], details: { cached: true } };
        }

        if (signal?.aborted) {
          return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        }

        const cfg = loadConfig();
        const text = await describeWithVision(cfg, img, params.prompt);
        putCached(params.ref, params.prompt, text);
        return { content: [{ type: "text" as const, text }], details: { cached: false } };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `describe_image 出错：${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { error: true },
        };
      }
    },
  });

  // ---------- 命令：/describe-image ----------
  pi.registerCommand("describe-image", {
    description: "手动识图 / 配置视觉模型：/describe-image <ref|图片路径> <需求>；/describe-image config <key> <value>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const verb = parts[0];

      if (verb === "config") {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if ((key === "baseUrl" || key === "model" || key === "apiKey" || key === "maxTokens") && value) {
          saveConfig({ [key]: value } as Partial<VisionConfig>);
          ctx.ui.notify(`已保存 ${key}。`, "info");
        } else {
          const cfg = loadConfig();
          ctx.ui.notify(
            `视觉模型配置：\n  baseUrl: ${cfg.baseUrl}\n  model: ${cfg.model}\n  apiKey: ${cfg.apiKey ? "已设置(隐藏)" : "未设置"}\n` +
              `用法：/describe-image config baseUrl|model|apiKey <值>（apiKey 建议用环境变量 VISION_API_KEY）`,
            "info",
          );
        }
        return;
      }

      if (!verb || !parts[1]) {
        ctx.ui.notify(
          "用法：\n  /describe-image <ref> <需求>      按引用分析\n  /describe-image <图片路径> <需求>  读文件分析\n  /describe-image config ...        查看/设置配置",
          "info",
        );
        return;
      }

      const ref = verb.startsWith("img#") ? verb : await readImageRef(verb, ctx);
      if (!ref) {
        ctx.ui.notify(`无法读取图片：${verb}`, "error");
        return;
      }
      const prompt = parts.slice(1).join(" ");
      const img = imageRegistry.get(ref);
      if (!img) {
        ctx.ui.notify(`找不到图片引用 ${ref}`, "error");
        return;
      }
      try {
        const cfg = loadConfig();
        const cached = getCached(ref, prompt);
        const text = cached ?? (await describeWithVision(cfg, img, prompt));
        if (!cached) putCached(ref, prompt, text);
        ctx.ui.notify(`识别结果：\n${text.slice(0, 1500)}`, "info");
      } catch (error) {
        ctx.ui.notify(`识别失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

/** 从本地文件读取图片并注册，返回 ref；失败返回 null */
async function readImageRef(path: string, ctx: ExtensionContext): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path);
    const mime = guessMime(path);
    if (!/^image\//.test(mime)) return null;
    const ref = registerImage({ data: data.toString("base64"), mime });
    return ref;
  } catch {
    return null;
  }
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}
