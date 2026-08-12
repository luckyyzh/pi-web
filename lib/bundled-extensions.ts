/**
 * lib/bundled-extensions.ts
 * pi-web 内嵌的扩展包（vendor/）统一管理：检测安装状态 + 一键安装。
 * 不强制自动安装：用户在 Plugins 面板手动触发，装一次生效，可自行卸载。
 */
import { DefaultPackageManager, getAgentDir, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface BundledExtension {
  /** 包名（vendor/<name> 目录名，也是 pi 包名） */
  name: string;
  /** vendor 本地包目录，或 npm 包（从 npm 安装） */
  sourceType: "vendor" | "npm";
  /** 安装后 settings packages 里的 source 名 */
  label: string;
  /** 简短中文说明 */
  description: string;
}

export const BUNDLED_EXTENSIONS: BundledExtension[] = [
  {
    name: "ssh",
    sourceType: "vendor",
    label: "SSH 远程执行",
    description: "把 read/write/edit/bash 转发到远程机器（配合远程 SSH 工作区）",
  },
  {
    name: "searxng-search",
    sourceType: "vendor",
    label: "SearXNG 搜索",
    description: "通过自建 SearXNG 端点提供 web_search 工具",
  },
  {
    name: "describe-image",
    sourceType: "vendor",
    label: "图片识别",
    description: "给非视觉模型加 describe_image 识图能力",
  },
  {
    name: "pi-mcp-adapter",
    sourceType: "npm",
    label: "MCP 适配器",
    description: "MCP server 管理适配器（npm 包，随官方仓库发布）",
  },
];

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** 判断 settings 里某个包是否就是内置扩展 name（精确名、npm:name 或路径结尾） */
function isExtensionPackage(source: string, name: string): boolean {
  const s = source.trim();
  if (s === name) return true;
  if (s === `npm:${name}`) return true;
  return s.endsWith(`/${name}`) || s.endsWith(`\\${name}`);
}

/** vendor 下内置扩展包目录是否真实存在（npm 包视为始终可用） */
export function bundledExtensionExists(name: string): boolean {
  const ext = BUNDLED_EXTENSIONS.find((e) => e.name === name);
  if (ext?.sourceType === "npm") return true;
  return existsSync(join(process.cwd(), "vendor", name));
}

/** 检测某个内置扩展是否已安装（settings packages 里有匹配 source） */
export function isBundledExtensionInstalled(name: string): boolean {
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
    return (settingsManager.getGlobalSettings().packages ?? []).some((entry) =>
      isExtensionPackage(sourceOf(entry), name),
    );
  } catch {
    return false;
  }
}

/** 列出内置扩展 + 各自安装状态 */
export function listBundledExtensions(): Array<BundledExtension & { bundled: boolean; installed: boolean }> {
  return BUNDLED_EXTENSIONS.map((ext) => ({
    ...ext,
    bundled: bundledExtensionExists(ext.name),
    installed: isBundledExtensionInstalled(ext.name),
  }));
}

/**
 * 安装内置扩展。
 * vendor 包复制到 agentDir 内（source 规范化为包名，不依赖 pi-web 目录位置）；
 * npm 包直接 npm 安装（npm:<name>）。已安装则跳过。
 * 返回 true 表示本次新安装。
 */
export async function installBundledExtension(name: string): Promise<{ installed: boolean; source: string }> {
  const ext = BUNDLED_EXTENSIONS.find((e) => e.name === name);
  if (!ext) throw new Error(`Unknown bundled extension: ${name}`);
  if (isBundledExtensionInstalled(name)) {
    return { installed: false, source: name };
  }
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
  });

  // npm 包：直接按 npm 源安装
  if (ext.sourceType === "npm") {
    await packageManager.installAndPersist(`npm:${name}`, { local: false });
    return { installed: true, source: `npm:${name}` };
  }

  // vendor 本地包：复制到 agentDir 后安装
  const source = join(process.cwd(), "vendor", name);
  if (!existsSync(source)) {
    throw new Error(`内置扩展包不存在（vendor/${name} 缺失）`);
  }
  const dest = join(agentDir, name);
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
  }
  await packageManager.installAndPersist(dest, { local: false });
  return { installed: true, source: name };
}
