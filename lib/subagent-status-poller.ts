import { isSubagentActive } from "./subagent-coordination";
import type { SubagentRunInfo } from "./subagents";

/** UI-only refresh; scheduling itself is event-driven. One request at a time. */
export function subscribeSubagentStatus(options: {
  sessionId: string;
  parentToolCallId?: string;
  onRun(run: SubagentRunInfo): void;
  onUnavailable(): void;
  fetcher?: typeof fetch;
  isVisible?: () => boolean;
}): () => void {
  let stopped = false;
  let errors = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(requestTimer);
    controller?.abort();
  };
  const unavailable = () => { if (!stopped) options.onUnavailable(); stop(); };
  const poll = async () => {
    if (stopped) return;
    const visible = options.isVisible?.() ?? (typeof document === "undefined" || !document.hidden);
    if (!visible) { timer = setTimeout(() => { void poll(); }, 5000); return; }
    controller = new AbortController();
    requestTimer = setTimeout(() => controller?.abort(), 10_000);
    try {
      const response = await (options.fetcher ?? fetch)(`/api/subagents/${encodeURIComponent(options.sessionId)}`, { signal: controller.signal, cache: "no-store" });
      if (stopped) return;
      if (response.status === 404) { unavailable(); return; }
      if (!response.ok) throw new Error("Subagent status unavailable");
      const { run } = await response.json() as { run?: SubagentRunInfo };
      if (stopped) return;
      if (!run || run.sessionId !== options.sessionId || (options.parentToolCallId && run.parentToolCallId !== options.parentToolCallId)) {
        unavailable(); return; // A resumed session is a new task, not this historical card.
      }
      errors = 0;
      options.onRun(run);
      if (!isSubagentActive(run.status)) { stop(); return; }
    } catch {
      if (stopped) return;
      errors += 1;
      if (errors >= 3) { unavailable(); return; }
    } finally {
      clearTimeout(requestTimer);
    }
    if (!stopped) timer = setTimeout(() => { void poll(); }, 5000);
  };
  void poll();
  return stop;
}
