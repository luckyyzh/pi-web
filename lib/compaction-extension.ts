/**
 * lib/compaction-extension.ts
 * pi-web 内置内联扩展：按用户配置的模型/思考档位执行上下文压缩摘要。
 *
 * 通过 resourceLoaderOptions.extensionFactories 注册到主会话与子代理会话。
 * 监听 session_before_compact：
 *   - compaction-settings.json 未配置（model 与 thinkingLevel 均为 null）→ 不干预，走内置默认压缩
 *   - 已配置 → 用配置的模型/思考档位生成摘要（流程与上游默认压缩一致：
 *     迭代合并 previousSummary、split-turn 双摘要、fileOps 累计文件清单），
 *     任何失败 → 返回 undefined 回退默认压缩
 */
import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type ExtensionContext,
  type FileOperations,
  type InlineExtension,
  type ModelRegistry,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { isCompactionConfigured, readCompactionSettings } from "./compaction-settings";

// 以下 prompt 与上游 dist/core/compaction（utils.js / compaction.js）逐字一致，
// 保证与内置压缩的输出格式完全兼容。升级上游后如有措辞变化，按需同步。
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 缓存对齐模式尾部指令：要求模型把整段会话当作待摘要内容，只输出摘要 */
const CACHE_ALIGNED_INSTRUCTIONS = `This is a system-level context maintenance task, NOT a new user request. The conversation above is about to be compacted to free context space.

${SUMMARIZATION_PROMPT}

Rules for this task:
- Output ONLY the structured summary, nothing else
- Do NOT call any tools
- Do NOT continue the conversation or respond to questions in it`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ============================================================================

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/**
 * 上游 extractFileOperations 只从非 fromHook 的上一条压缩条目播种 fileOps；
 * 上一条压缩由钩子产生时（即本扩展自身）累计种子会丢失。
 * 这里无条件并入上一条压缩条目的文件清单，与内置压缩的累计语义保持一致。
 */
function seedFileOps(
  fileOps: FileOperations,
  prevEntry: { details?: { readFiles?: unknown; modifiedFiles?: unknown } } | null | undefined,
): FileOperations {
  const out: FileOperations = {
    read: new Set(fileOps.read),
    written: new Set(fileOps.written),
    edited: new Set(fileOps.edited),
  };
  const d = prevEntry?.details;
  if (d) {
    if (Array.isArray(d.readFiles)) for (const f of d.readFiles) out.read.add(f);
    if (Array.isArray(d.modifiedFiles)) for (const f of d.modifiedFiles) out.edited.add(f);
  }
  return out;
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

interface SummarizeArgs {
  modelRegistry: ModelRegistry;
  model: { id: string; maxTokens?: number; reasoning?: boolean };
  messages: unknown[];
  reserveTokens: number;
  previousSummary?: string;
  signal: AbortSignal | undefined;
  thinkingLevel: string | undefined;
  turnPrefix: boolean;
}

/** 与上游 generateSummaryWithUsage / generateTurnPrefixSummary 相同的单次摘要请求 */
async function summarizeOnce(args: SummarizeArgs): Promise<{ text: string; usage: Usage }> {
  const { model, messages, reserveTokens, previousSummary, signal, thinkingLevel, turnPrefix } = args;
  const maxTokens = Math.min(
    Math.floor((turnPrefix ? 0.5 : 0.8) * reserveTokens),
    model.maxTokens && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const basePrompt = turnPrefix
    ? TURN_PREFIX_SUMMARIZATION_PROMPT
    : (previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  const llmMessages = convertToLlm(messages as never) as never;
  const conversationText = serializeConversation(llmMessages as never);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary && !turnPrefix) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  // 与上游 createSummarizationOptions 相同的 reasoning 判定：
  // 非推理模型或 off 档不传 reasoning（= 不思考）
  const options: Record<string, unknown> = {
    maxTokens,
    signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
  };
  if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
  }

  const response = await args.modelRegistry.complete(
    model as never,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
    } as never,
    options as never,
  ) as { stopReason?: string; errorMessage?: string; content: Array<{ type: string; text?: string }>; usage: Usage };
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Summarization attempted to call a tool");
  }
  return { text: contentText(response.content as never), usage: response.usage as unknown as Usage };
}

interface CacheAlignedArgs {
  modelRegistry: ModelRegistry;
  model: { id: string; maxTokens?: number; reasoning?: boolean };
  systemPrompt: string;
  messages: unknown[];
  reserveTokens: number;
  signal: AbortSignal | undefined;
  thinkingLevel: string | undefined;
}

/**
 * 缓存对齐摘要：复用会话原 system prompt + 字节一致的完整历史 + 尾部一条摘要指令。
 * 请求前缀与会话最近一次请求完全一致 → 命中服务端前缀缓存（vLLM APC 等）。
 * 注意：thinkingLevel 必须跟随会话当前档位——qwen chat template 中 enable_thinking/
 * reasoning_effort 会改变 system 块开头字节，用其它档位会使前缀缓存失效。
 */
async function summarizeCacheAligned(args: CacheAlignedArgs): Promise<{ text: string; usage: Usage }> {
  const { model, systemPrompt, messages, reserveTokens, signal, thinkingLevel } = args;
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  // 与主会话相同的 reasoning 判定（跟随会话档位，保证 wire 字节一致）
  const options: Record<string, unknown> = {
    maxTokens,
    signal,
    sessionId: uuidv7(),
  };
  if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
  }

  const response = await args.modelRegistry.complete(
    model as never,
    {
      systemPrompt,
      messages: [
        ...(messages as never),
        { role: "user", content: [{ type: "text", text: CACHE_ALIGNED_INSTRUCTIONS }], timestamp: Date.now() },
      ],
    } as never,
    options as never,
  ) as { stopReason?: string; errorMessage?: string; content: Array<{ type: string; text?: string }>; usage: Usage };
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Summarization attempted to call a tool");
  }
  return { text: contentText(response.content as never), usage: response.usage as unknown as Usage };
}

/**
 * 缓存对齐摘要尝试：失败（或前置条件不满足）返回 undefined，由调用方回退常规路径。
 * split-turn（turn 中途中断的溢出恢复）场景下字节一致性无法保证，直接回退。
 */
async function attemptCacheAligned(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  model: { id: string; maxTokens?: number; reasoning?: boolean },
): Promise<{ text: string; usage: Usage } | undefined> {
  try {
    if (event.preparation.isSplitTurn) return undefined;
    const systemPrompt = ctx.getSystemPrompt();
    const contextMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages) as unknown[];
    if (!systemPrompt || contextMessages.length === 0) return undefined;
    return await summarizeCacheAligned({
      modelRegistry: ctx.modelRegistry,
      model,
      systemPrompt,
      messages: contextMessages,
      reserveTokens: event.preparation.settings.reserveTokens,
      signal: event.signal,
      thinkingLevel: ctx.thinkingLevel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui?.notify?.(`缓存对齐压缩失败，回退常规压缩：${message}`, "warning");
    return undefined;
  }
}

export function createCompactionSettingsExtension(): InlineExtension {
  return {
    name: "compaction-settings",
    hidden: true,
    factory: (pi) => {
      pi.on("session_before_compact", async (event, ctx) => {
        const startedAt = Date.now();
        try {
          const settings = readCompactionSettings();
          if (!isCompactionConfigured(settings)) return;

          const prep = event.preparation;
          let model = settings.model
            ? ctx.modelRegistry.find(settings.model.provider, settings.model.modelId)
            : ctx.model;
          if (!model) {
            model = ctx.model;
            if (!model) return;
            if (settings.model) {
              ctx.ui?.notify?.(
                `压缩模型 ${settings.model.provider}/${settings.model.modelId} 不可用，已回退会话模型`,
                "warning",
              );
            }
          }
          // 思考档位：缓存对齐模式强制跟随会话（模板字节一致）；否则按配置/跟随会话
          const thinkingLevel = settings.thinkingLevel ?? ctx.thinkingLevel;

          let summary: string;
          let usage: Usage | undefined;
          const cacheAligned = settings.cacheAligned
            ? await attemptCacheAligned(event, ctx, model)
            : undefined;
          if (cacheAligned) {
            summary = cacheAligned.text;
            usage = cacheAligned.usage;
          } else if (prep.isSplitTurn && prep.turnPrefixMessages.length > 0) {
            let historyText = "No prior history.";
            if (prep.messagesToSummarize.length > 0) {
              const history = await summarizeOnce({
                modelRegistry: ctx.modelRegistry, model, messages: prep.messagesToSummarize,
                reserveTokens: prep.settings.reserveTokens,
                previousSummary: prep.previousSummary,
                signal: event.signal, thinkingLevel, turnPrefix: false,
              });
              historyText = history.text;
              usage = history.usage;
            }
            const prefix = await summarizeOnce({
              modelRegistry: ctx.modelRegistry, model, messages: prep.turnPrefixMessages,
              reserveTokens: prep.settings.reserveTokens,
              signal: event.signal, thinkingLevel, turnPrefix: true,
            });
            summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
            usage = addUsage(usage, prefix.usage);
          } else {
            const result = await summarizeOnce({
              modelRegistry: ctx.modelRegistry, model, messages: prep.messagesToSummarize,
              reserveTokens: prep.settings.reserveTokens,
              previousSummary: prep.previousSummary,
              signal: event.signal, thinkingLevel, turnPrefix: false,
            });
            summary = result.text;
            usage = result.usage;
          }

          const { readFiles, modifiedFiles } = computeFileLists(
            seedFileOps(prep.fileOps, [...event.branchEntries].reverse().find((e) => e.type === "compaction") as
              | { details?: { readFiles?: unknown; modifiedFiles?: unknown } }
              | undefined),
          );
          summary += formatFileOperations(readFiles, modifiedFiles);

          return {
            compaction: {
              summary,
              firstKeptEntryId: prep.firstKeptEntryId,
              tokensBefore: prep.tokensBefore,
              durationMs: Date.now() - startedAt,
              usage,
              details: { readFiles, modifiedFiles },
            },
          };
        } catch (error) {
          // 任何失败都回退内置默认压缩，不阻断会话
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui?.notify?.(`自定义压缩失败，已回退默认压缩：${message}`, "warning");
          return;
        }
      });
    },
  };
}
