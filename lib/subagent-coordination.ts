import type { SubagentRunInfo } from "./subagents";

export const SUBAGENT_PROGRESS_TOOL_NAME = "report_subagent_progress";
export const SUBAGENT_SCHEDULING_TYPE = "pi-web:subagent-scheduling";
export const DEFAULT_SUBAGENT_SOFT_BUDGET_SECONDS = 300;

export interface SubagentProgress {
  summary: string;
  remaining?: string;
  blocked?: string;
  updatedAt: string;
}

/** Optional additions: old session files and Agent calls remain valid. */
export interface SubagentScheduling {
  dependsOn?: string[];
  waitingFor?: string[];
  softBudgetSeconds?: number;
  startedAt?: string;
  budgetExceededAt?: string;
  progress?: SubagentProgress;
}

export function isSubagentActive(status: SubagentRunInfo["status"]): boolean {
  return status === "starting" || status === "queued" || status === "running";
}

export function subagentSoftBudget(value?: number): number {
  const seconds = value ?? DEFAULT_SUBAGENT_SOFT_BUDGET_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
    throw new Error("soft_budget_seconds must be an integer between 0 and 86400 (0 disables reminders)");
  }
  return seconds;
}

export function subagentDependencyIds(values: readonly string[] = []): string[] {
  if (values.length > 32 || values.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("depends_on must contain at most 32 non-empty subagent session IDs");
  }
  return [...new Set(values.map((id) => id.trim()))];
}

/** One soft deadline per execution, measured from actual start, never an abort. */
export function startSubagentBudget(seconds: number, onExceeded: () => void): () => void {
  if (!seconds) return () => {};
  const timer = setTimeout(onExceeded, seconds * 1000);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export const SUBAGENT_CHECKPOINT_GUIDANCE = `Work only on the delegated deliverable and assigned file scope; do not expand into sibling tasks. Use report_subagent_progress for a useful milestone or blocker, with concrete findings/artifacts and remaining work, not routine tool-by-tool narration. Reports are provisional, not completion or permission to transfer file ownership. If the task is larger than expected, report separable remaining work so the parent can reschedule it. Do not wait for unrelated agents. Before your final answer, identify unverified work and remaining risks.`;

export function subagentSchedulingText(run: SubagentRunInfo): string {
  const parts: string[] = [];
  if (run.waitingFor?.length) parts.push(`Waiting for dependencies: ${run.waitingFor.join(", ")}. Waiting does not occupy a concurrency slot.`);
  if (run.startedAt) parts.push(`Started: ${run.startedAt}.`);
  if (run.budgetExceededAt) parts.push("Soft budget exceeded; reassess scope/blockers. This is not a failure or an instruction to duplicate work.");
  if (run.progress) {
    parts.push(`Latest checkpoint (provisional, ${run.progress.updatedAt}): ${run.progress.summary}`);
    if (run.progress.remaining) parts.push(`Remaining: ${run.progress.remaining}`);
    if (run.progress.blocked) parts.push(`Blocked: ${run.progress.blocked}`);
  }
  return parts.join("\n");
}
