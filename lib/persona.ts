/**
 * lib/persona.ts
 * 用户人设（~/.pi/agent/persona.md）的后端读写 + persona-injector 扩展的幂等安装。
 * 与 vendor/persona-injector 扩展共用同一文件：保存后下一条消息即注入生效。
 */
import { DefaultPackageManager, getAgentDir, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PERSONA_DEFAULT_TEMPLATE = `# 我的用户画像（Persona）

> 该文件会被追加到系统提示词末尾，全局生效，每轮对话都会注入。
> 在这里描述你的身份、对话风格、工作习惯与要求。

## 我是谁
（例：资深后端工程师，负责 xxx 项目的架构与维护）

## 对话要求
（例：回答使用中文；优先给出方案；解释要简洁直接）

## 工作习惯
（例：改动前先列出影响文件；重要操作先确认）

## 其他偏好
（例：不要过度设计；保持接口兼容）
`;

export function personaPath(): string {
  return join(getAgentDir(), "persona.md");
}

/** 读取人设；文件不存在返回空串 */
export function readPersona(): string {
  try {
    if (!existsSync(personaPath())) return "";
    return readFileSync(personaPath(), "utf8");
  } catch {
    return "";
  }
}

/** 写人设（自动建目录）。emptyAllowed 为 true 时允许清空，否则空串按"未修改"处理由调用方决定 */
export function writePersona(content: string): void {
  const p = personaPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** 首次使用时创建模板文件（幂等） */
export function ensurePersonaFile(): void {
  try {
    if (!existsSync(personaPath())) {
      writePersona(PERSONA_DEFAULT_TEMPLATE);
    }
  } catch {
    /* 忽略写文件失败 */
  }
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isPersonaInjectorPackage(source: string): boolean {
  const s = source.trim();
  if (s === "persona-injector") return true;
  return s.endsWith("/persona-injector") || s.endsWith("\\persona-injector");
}

/**
 * 幂等安装内置的 persona 注入扩展。
 * 已装则跳过；未装则把 vendor/persona-injector 安装进全局 packages。
 * 返回 true 表示本次新安装（需要重启会话/pi-web 才加载）。
 */
export async function ensurePersonaInjectorInstalled(): Promise<boolean> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
  const installed = (settingsManager.getGlobalSettings().packages ?? []).some((entry) =>
    isPersonaInjectorPackage(sourceOf(entry)),
  );
  if (installed) return false;
  const source = join(process.cwd(), "vendor", "persona-injector");
  if (!existsSync(source)) return false;
  // 复制到 agentDir 内再安装，source 规范化为 "persona-injector"，不依赖 pi-web 目录位置
  const dest = join(agentDir, "persona-injector");
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
  }
  const packageManager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
  });
  await packageManager.installAndPersist(dest, { local: false });
  return true;
}
