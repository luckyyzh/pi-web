import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_PROGRESS_TOOL_NAME, type SubagentProgress } from "./subagent-coordination";

export function createSubagentProgressExtension(
  report: (sessionId: string, progress: Omit<SubagentProgress, "updatedAt">) => void,
): InlineExtension {
  return {
    name: "pi-web-subagent-progress",
    hidden: true,
    factory(pi) {
      pi.registerTool(defineTool({
        name: SUBAGENT_PROGRESS_TOOL_NAME,
        label: "Report agent checkpoint",
        description: "Report a useful milestone or blocker to your parent without ending your task. Include concrete findings/artifacts and remaining work. Provisional, not completion; do not report every tool call.",
        parameters: Type.Object({
          summary: Type.String({ minLength: 1, maxLength: 2000 }),
          remaining: Type.Optional(Type.String({ maxLength: 2000 })),
          blocked: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          report(ctx.sessionManager.getSessionId(), params);
          return { content: [{ type: "text", text: "Checkpoint recorded. Continue only your assigned task; the parent may adjust your scope." }], details: {} };
        },
      }));
    },
  };
}
