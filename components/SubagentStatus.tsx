"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isSubagentActive } from "@/lib/subagent-coordination";
import { subscribeSubagentStatus } from "@/lib/subagent-status-poller";
import type { SubagentRunInfo } from "@/lib/subagents";
import type { SubagentToolDetails } from "@/lib/subagent-extension";

export function SubagentStatus({ details }: { details: SubagentToolDetails }) {
  const { t } = useI18n();
  const { sessionId, parentToolCallId, status } = details;
  const [snapshot, setSnapshot] = useState<{ sessionId: string; parentToolCallId?: string; run?: SubagentRunInfo; unavailable?: boolean }>();
  useEffect(() => {
    if (!isSubagentActive(status)) return;
    return subscribeSubagentStatus({
      sessionId, parentToolCallId,
      onRun: (run) => setSnapshot({ sessionId, parentToolCallId, run }),
      onUnavailable: () => setSnapshot((previous) => ({
        sessionId, parentToolCallId, unavailable: true,
        ...(previous?.sessionId === sessionId && previous.parentToolCallId === parentToolCallId ? { run: previous.run } : {}),
      })),
    });
  }, [sessionId, parentToolCallId, status]);

  const live = snapshot?.sessionId === sessionId && snapshot.parentToolCallId === parentToolCallId ? snapshot : undefined;
  const run = isSubagentActive(status) && live?.run ? live.run : details;
  const progress = run.progress;
  return (
    <div style={{ padding: "0 10px 7px", color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }} data-subagent-status={run.status}>
      <div>
        <span>{t(`agentSwitcher.status.${run.status}`)}</span>
        {run.waitingFor?.length ? <span> · {t("subagent.waitingFor", { ids: run.waitingFor.join(", ") })}</span> : null}
      </div>
      {run.budgetExceededAt && <div style={{ color: "var(--warning, #b7791f)" }}>{t("subagent.budgetExceeded")}</div>}
      {progress && (
        <details>
          <summary style={{ cursor: "pointer" }}>{t("subagent.checkpoint")}: {progress.summary.length > 120 ? `${progress.summary.slice(0, 120)}…` : progress.summary}</summary>
          <div style={{ whiteSpace: "pre-wrap" }}>{progress.summary}</div>
          {progress.remaining && <div>{t("subagent.remaining", { text: progress.remaining })}</div>}
        </details>
      )}
      {progress?.blocked && <div style={{ color: "var(--warning, #b7791f)" }}>{t("subagent.blocked", { text: progress.blocked })}</div>}
      {live?.unavailable && isSubagentActive(status) && <div>{t("subagent.statusUnavailable")}</div>}
    </div>
  );
}
