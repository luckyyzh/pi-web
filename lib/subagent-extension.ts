import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTROL_TOOL_NAMES,
  type SubagentProfile,
  type SubagentRunInfo,
} from "./subagents";
import { MAX_SUBAGENT_INPUT_FILES } from "./subagent-input";
import {
  isSubagentActive,
  subagentSchedulingText,
  type SubagentScheduling,
} from "./subagent-coordination";

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-web-subagents";
const HOST_SUBAGENT_EXTENSION_PATH = `<inline:${HOST_SUBAGENT_EXTENSION_NAME}>`;
const SUBAGENT_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const LEGACY_SUBAGENT_PACKAGE_NAME = "pi-subagents";

const GET_RESULT_DEFAULT_TIMEOUT_SECONDS = 30;
const GET_RESULT_MAX_TIMEOUT_SECONDS = 300;
const GET_RESULT_POLL_INTERVAL_MS = 500;
const LIST_SUBAGENTS_MAX_ITEMS = 20;
const LIST_SUBAGENTS_MAX_DESCRIPTION_LENGTH = 120;

export interface SubagentToolDetails extends SubagentScheduling {
  kind: "pi-web-subagent";
  sessionId: string;
  parentToolCallId?: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

export interface StartSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  profile: string;
  task: string;
  inputFiles?: string[];
  description: string;
  runInBackground?: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  inheritContext?: boolean;
  isolation?: "worktree";
  dependsOn?: string[];
  softBudgetSeconds?: number;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface ResumeSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  sessionId: string;
  task: string;
  description: string;
  runInBackground?: boolean;
  dependsOn?: string[];
  softBudgetSeconds?: number;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface SubagentExecution {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  resume(request: ResumeSubagentRequest): Promise<SubagentExecution>;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  list(parentSessionId: string): Promise<SubagentRunInfo[]>;
  steer(sessionId: string, message: string): Promise<void>;
  notifyParent(run: SubagentRunInfo): Promise<void>;
}

export type SubagentProfileProvider = () => readonly SubagentProfile[];
export type SubagentEnabledProvider = () => boolean;

function agentTypeDescription(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  if (available.length === 0) return "No subagent profiles are currently enabled.";
  return available.map((profile) => {
    const details = [`Tools: ${profile.tools.length > 0 ? profile.tools.join(", ") : "none"}`];
    if (profile.model) details.push(`Model: ${profile.model}`);
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
}

export function subagentToolDetails(run: SubagentRunInfo): SubagentToolDetails {
  return {
    kind: "pi-web-subagent",
    sessionId: run.sessionId,
    parentToolCallId: run.parentToolCallId,
    profile: run.profile,
    description: run.description,
    status: run.status,
    runInBackground: run.runInBackground,
    createdAt: run.createdAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
    ...(run.worktreeCleanupError ? { worktreeCleanupError: run.worktreeCleanupError } : {}),
    ...(run.dependsOn?.length ? { dependsOn: [...run.dependsOn] } : {}),
    ...(run.waitingFor?.length ? { waitingFor: [...run.waitingFor] } : {}),
    ...(run.softBudgetSeconds !== undefined ? { softBudgetSeconds: run.softBudgetSeconds } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.budgetExceededAt ? { budgetExceededAt: run.budgetExceededAt } : {}),
    ...(run.progress ? { progress: run.progress } : {}),
  };
}

export function subagentFinalText(run: SubagentRunInfo): string {
  if (isSubagentActive(run.status)) {
    const base = `Subagent ${run.sessionId} is ${run.status}.`;
    const scheduling = subagentSchedulingText(run);
    return scheduling ? `${base}\n${scheduling}` : base;
  }
  if (run.status === "completed") return run.result?.trim() || "Subagent completed without text output.";
  const terminal = run.status === "aborted" ? `Subagent ${run.sessionId} was stopped.`
    : run.status === "interrupted" ? `Subagent ${run.sessionId} was interrupted before completion.`
      : `Subagent ${run.sessionId} failed: ${run.error ?? "Unknown error"}`;
  const checkpoint = run.progress ? subagentSchedulingText({ ...run, waitingFor: [] }) : "";
  return checkpoint ? `${terminal}\n${checkpoint}` : terminal;
}

function waitForRunUpdate(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Result wait aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function truncateDescription(description: string): string {
  return description.length <= LIST_SUBAGENTS_MAX_DESCRIPTION_LENGTH
    ? description
    : `${description.slice(0, LIST_SUBAGENTS_MAX_DESCRIPTION_LENGTH - 3)}...`;
}

/** Bounded plain-text summary of the current parent's active subagent tasks. */
function listSubagentsText(runs: readonly SubagentRunInfo[]): string {
  if (runs.length === 0) return "No active subagents for this session.";
  const shown = runs.slice(0, LIST_SUBAGENTS_MAX_ITEMS);
  const lines: string[] = [
    `${shown.length} active subagent(s)${runs.length > shown.length ? ` (showing first ${shown.length} of ${runs.length})` : ""}:`,
  ];
  for (const run of shown) {
    lines.push(`- ${run.sessionId} | ${truncateDescription(run.description)} | status: ${run.status}`);
    if (run.dependsOn?.length) lines.push(`  Dependencies: ${run.dependsOn.join(", ")}`);
    const scheduling = subagentSchedulingText(run);
    if (scheduling) lines.push(...scheduling.split("\n").map((line) => `  ${line}`));
  }
  const output = truncateHead(lines.join("\n"), { maxBytes: 24_000, maxLines: 300 });
  return output.content + (output.truncated ? "\n[Overview truncated; inspect individual agent results for details.]" : "");
}

export function createSubagentExtension(
  runtime: SubagentExtensionRuntime,
  getProfiles: SubagentProfileProvider,
  isEnabled: SubagentEnabledProvider = () => true,
): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!isEnabled()) return;
      const profiles = getProfiles().filter((profile) => profile.enabled);
      const profileNames = profiles.map((profile) => profile.name);
      const availableTypes = profileNames.length > 0 ? profileNames.join(", ") : "none";
      pi.registerTool(defineTool({
        name: "Agent",
        label: "Agent",
        description: `Delegate a focused task to a configured subagent. Each subagent runs as a full, inspectable Pi session. Use background mode for independent work and foreground mode when the result is needed immediately.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a focused task to an inspectable subagent session",
        promptGuidelines: [
          "Give each Agent one independently verifiable deliverable with an explicit file scope and acceptance criteria.",
          "Do not duplicate work already delegated to a running subagent, including doing its assigned edits in the parent session.",
          "Declare depends_on only for real data dependencies (at most 32 sibling session IDs that must complete successfully first); never use it as a global barrier for independent work.",
          "Prioritize the critical path and agree on shared interfaces before dispatching dependent tasks.",
          "Dispatch independent work in the background and keep working; do not wait for slow tasks.",
          "After a subagent completes, use Agent resume for related ready work when its context is useful; do not reuse a removed worktree or force unrelated tasks into an old context.",
          "When a soft budget warning appears, narrow the scope or report blockers; do not re-dispatch the same work.",
          "Before handing files to another agent, use steer_subagent to request a wrap-up, then confirm the original writer has actually stopped and review its edits. Sending steering alone does not transfer ownership.",
          "Use list_subagents to reassess active tasks after a milestone or budget warning, not in a busy polling loop. A checkpoint is provisional, not completion.",
        ],
        executionMode: "parallel",
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Configured agent profile. Available types: ${availableTypes}. Default: general-purpose.` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          resume: Type.Optional(Type.String({ description: "Existing subagent session ID to continue instead of creating a new session." })),
          input_files: Type.Optional(Type.Array(Type.String(), {
            description: "UTF-8 text files under the session cwd to include with the task.",
            maxItems: MAX_SUBAGENT_INPUT_FILES,
          })),
          description: Type.String({ description: "Short activity label shown in the UI." }),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and notify this session when complete." })),
          model: Type.Optional(Type.String({ description: "Optional provider/modelId override." })),
          thinking: Type.Optional(Type.String({ description: "Optional thinking level override." })),
          max_turns: Type.Optional(Type.Number({ description: "Optional positive agent turn limit." })),
          inherit_context: Type.Optional(Type.Boolean({ description: "Include the parent session's active conversation context." })),
          isolation: Type.Optional(Type.String({ description: "Run the subagent in an isolated git worktree." })),
          depends_on: Type.Optional(Type.Array(Type.String(), {
            description: "Session IDs of sibling subagents (at most 32) that must complete successfully before this task starts. Use only for real data dependencies, never as a global barrier.",
            maxItems: 32,
          })),
          soft_budget_seconds: Type.Optional(Type.Integer({
            description: "Soft budget in seconds, 0-86400 (default 300). Exceeding it reminds the subagent to reassess scope; it never aborts the run.",
            minimum: 0,
            maximum: 86400,
          })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          try {
            const resume = params.resume?.trim();
            const execution = resume
              ? await runtime.resume({
                  parentContext: ctx,
                  parentToolCallId: toolCallId,
                  sessionId: resume,
                  task: params.prompt,
                  description: params.description,
                  ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
                  ...(params.depends_on ? { dependsOn: params.depends_on } : {}),
                  ...(params.soft_budget_seconds !== undefined ? { softBudgetSeconds: params.soft_budget_seconds } : {}),
                  signal,
                  onUpdate: (run) => onUpdate?.({
                    content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
                    details: subagentToolDetails(run),
                  }),
                })
              : await runtime.start({
              parentContext: ctx,
              parentToolCallId: toolCallId,
              profile: params.subagent_type ?? "general-purpose",
              task: params.prompt,
              ...(params.input_files ? { inputFiles: params.input_files } : {}),
              description: params.description,
              ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
              ...(params.model ? { model: params.model } : {}),
              ...(params.thinking ? { thinking: params.thinking } : {}),
              ...(params.max_turns ? { maxTurns: params.max_turns } : {}),
              ...(params.inherit_context !== undefined ? { inheritContext: params.inherit_context } : {}),
              ...(params.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
              ...(params.depends_on ? { dependsOn: params.depends_on } : {}),
              ...(params.soft_budget_seconds !== undefined ? { softBudgetSeconds: params.soft_budget_seconds } : {}),
              signal,
              onUpdate: (run) => onUpdate?.({
                content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
                details: subagentToolDetails(run),
              }),
                });

            if (execution.run.runInBackground) {
              void execution.completion
                .then((run) => runtime.notifyParent(run))
                .catch((error) => {
                  console.error(
                    "[pi-web] failed to deliver subagent completion:",
                    error instanceof Error ? error.message : error,
                  );
                });
              return {
                content: [{ type: "text", text: `Subagent started in background. Session ID: ${execution.run.sessionId}. You will be notified when it completes.` }],
                details: subagentToolDetails(execution.run),
              };
            }

            const run = await execution.completion;
            return {
              content: [{ type: "text", text: subagentFinalText(run) }],
              details: subagentToolDetails(run),
              ...(run.status === "failed" ? { isError: true } : {}),
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "get_subagent_result",
        label: "Get agent result",
        description: "Check an inspectable subagent session and retrieve its latest result.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          wait: Type.Optional(Type.Boolean({ description: "Wait until the subagent finishes or the timeout elapses. Waiting never cancels the subagent." })),
          timeout_seconds: Type.Optional(Type.Integer({
            description: `Maximum seconds to wait. 0 returns an immediate snapshot, the default is ${GET_RESULT_DEFAULT_TIMEOUT_SECONDS}, and the maximum is ${GET_RESULT_MAX_TIMEOUT_SECONDS}.`,
            minimum: 0,
            maximum: GET_RESULT_MAX_TIMEOUT_SECONDS,
          })),
        }),
        async execute(_toolCallId, params, signal) {
          const notFound = () => ({ content: [{ type: "text" as const, text: `Subagent not found: ${params.agent_id}` }], details: undefined, isError: true });
          let run = await runtime.get(params.agent_id);
          if (!run) return notFound();
          const timeoutSeconds = Math.min(
            Math.max(Math.floor(params.timeout_seconds ?? GET_RESULT_DEFAULT_TIMEOUT_SECONDS), 0),
            GET_RESULT_MAX_TIMEOUT_SECONDS,
          );
          if (params.wait && timeoutSeconds > 0) {
            const deadline = Date.now() + timeoutSeconds * 1000;
            while (isSubagentActive(run.status)) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              await waitForRunUpdate(signal, Math.min(GET_RESULT_POLL_INTERVAL_MS, remaining));
              run = await runtime.get(params.agent_id);
              if (!run) return notFound();
            }
          }
          return {
            content: [{ type: "text", text: subagentFinalText(run) }],
            details: subagentToolDetails(run),
            ...(run.status === "failed" ? { isError: true } : {}),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "steer_subagent",
        label: "Steer agent",
        description: "Send a steering message to a currently running subagent session.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          message: Type.String({ description: "Instruction to inject after the current tool execution." }),
        }),
        async execute(_toolCallId, params) {
          try {
            await runtime.steer(params.agent_id, params.message);
            return { content: [{ type: "text", text: `Steering message sent to ${params.agent_id}.` }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "list_subagents",
        label: "List agents",
        description: "List the active subagent tasks of the current session with their status, dependencies, progress, and budget state.",
        promptSnippet: "List active subagents of this session",
        executionMode: "parallel",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          try {
            const parentSessionId = ctx.sessionManager.getSessionId();
            const runs = (await runtime.list(parentSessionId))
              .filter((run) => run.parentSessionId === parentSessionId && isSubagentActive(run.status));
            return { content: [{ type: "text", text: listSubagentsText(runs) }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        },
      }));
    },
  };
}

/** Keep Pi Web's integrated implementation when the legacy package is loaded. */
export function preferPiWebSubagentExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_SUBAGENT_EXTENSION_PATH);
  if (!host?.tools.has("Agent")) return base;
  const legacyPaths = new Set(base.extensions
    .filter((extension) => extension.path !== HOST_SUBAGENT_EXTENSION_PATH)
    .filter((extension) => {
      const source = extension.sourceInfo?.source ?? "";
      const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      return sourcePackage === LEGACY_SUBAGENT_PACKAGE_NAME
        || pathSegments.some((segment) => segment === LEGACY_SUBAGENT_PACKAGE_NAME);
    })
    .filter((extension) => [...SUBAGENT_TOOL_NAMES].some((name) => extension.tools.has(name)))
    .map((extension) => extension.path));
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (legacyPaths.has(error.path)) return false;
      if (error.path !== HOST_SUBAGENT_EXTENSION_PATH) return true;
      return ![...legacyPaths].some((legacyPath) =>
        [...SUBAGENT_TOOL_NAMES].some((name) =>
          error.error === `Tool "${name}" conflicts with ${legacyPath}`
        )
      );
    }),
  };
}
