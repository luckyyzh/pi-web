export interface HandoffReminderState {
  pendingChange: boolean;
  reminded: boolean;
}

export function newHandoffReminderState(): HandoffReminderState {
  return { pendingChange: false, reminded: false };
}

/** Only tools whose successful result is itself an exact file mutation are tracked. */
export function isTrackedWriteTool(toolName: string): boolean {
  return toolName === "write" || toolName === "edit" || toolName === "apply_patch";
}

/** Shell is intentionally narrow: only a standalone git commit is a newly-created work change. */
export function isTrackedShellWrite(toolName: string, args: unknown): boolean {
  if (toolName !== "bash" || !args || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return false;
  return /^\s*git\s+commit(?:\s|$)/i.test(command)
    && !/[;&|\n]/.test(command)
    && !/(?:^|\s)(?:--(?:dry-run|help|short|porcelain|long)|-h)(?:\s|=|$)/.test(command);
}

/**
 * 会话历史里是否出现过「文件修改」证据（与提醒共用同一判定）。
 * 退出兜底只在这个前提下写交接：纯对话、纯阅读/检索的会话不产生兜底记录。
 */
export function hasWorkEvidence(entries: ReadonlyArray<{ type?: unknown; message?: { content?: unknown } }>): boolean {
  for (const entry of entries ?? []) {
    if (!entry || entry.type !== "message") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (b.type !== "toolCall" || typeof b.name !== "string") continue;
      if (isTrackedWriteTool(b.name) || isTrackedShellWrite(b.name, b.arguments)) return true;
    }
  }
  return false;
}

export function toolSucceeded(event: { isError?: boolean; result?: unknown }): boolean {
  if (event.isError) return false;
  const result = event.result;
  if (result && typeof result === "object") {
    const row = result as { details?: unknown };
    if (row.details && typeof row.details === "object") {
      const details = row.details as { cancelled?: unknown; exitCode?: unknown };
      if (details.cancelled === true) return false;
      if (typeof details.exitCode === "number" && details.exitCode !== 0) return false;
    }
  }
  return true;
}

export function markSuccessfulChange(state: HandoffReminderState): void {
  if (!state.pendingChange) state.reminded = false;
  state.pendingChange = true;
}

export function markHandoffSaved(state: HandoffReminderState): void {
  state.pendingChange = false;
  state.reminded = false;
}

export function shouldRemind(state: HandoffReminderState): boolean {
  return state.pendingChange && !state.reminded;
}
