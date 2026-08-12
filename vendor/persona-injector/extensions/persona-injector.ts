/**
 * persona-injector.ts
 *
 * pi-web 内置的用户人设注入扩展。
 * 在每次发消息（before_agent_start）时读取 ~/.pi/agent/persona.md 并追加到系统提示词，
 * 全局生效、每轮稳定注入。由 pi-web 后端幂等安装到 agent 扩展目录。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PERSONA_PATH = join(getAgentDir(), "persona.md");

function readPersona(): string {
  try {
    if (!existsSync(PERSONA_PATH)) return "";
    return readFileSync(PERSONA_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

export default async function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const persona = readPersona();
    if (!persona) return;
    const sep = event.systemPrompt.trimEnd().endsWith("\n\n") ? "" : "\n\n";
    return { systemPrompt: `${event.systemPrompt}${sep}${persona}` };
  });
}
