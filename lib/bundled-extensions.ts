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
  /** 安装后 settings packages 里的 source 名 */
  label: string;
  /** 简短中文说明 */
  description: string;
}

export const BUNDLED_EXTENSIONS: BundledExtension[] = [
  {
    name: "ssh",
    label: "SSH 远程执行",
    description: "把 read/write/edit/bash 转发到远程机器（配合远程 SSH 工作区）",
  },
  {
    name: "searxng-search",
    label: "SearXNG 搜索",
    description: "通过自建 SearXNG 端点提供 web_search 工具",
  },
  {
    name: "describe-image",
    label: "图片识别",
    description: "给非视觉模型加 describe_image 识图能力",
  },
];

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** 判断 settings 里某个包是否就是内置扩展 name（精确名或路径结尾） */
function isExtensionPackage(source: string, name: string): boolean {
  const s = source.trim();
  if (s === name) return true;
  return s.endsWith(`/${name}`) || s.endsWith(`\\${name}`);
}

/** vendor 下内置扩展包目录是否真实存在 */
export function bundledExtensionExists(name: string): boolean {
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
 * 安装内置扩展（复制到 agentDir 内，source 规范化为包名，不依赖 pi-web 目录位置）。
 * 已安装则跳过；返回 true 表示本次新安装。
 */
export async function installBundledExtension(name: string): Promise<{ installed: boolean; source: string }> {
  const ext = BUNDLED_EXTENSIONS.find((e) => e.name === name);
  if (!ext) throw new Error(`Unknown bundled extension: ${name}`);
  if (isBundledExtensionInstalled(name)) {
    return { installed: false, source: name };
  }
  const source = join(process.cwd(), "vendor", name);
  if (!existsSync(source)) {
    throw new Error(`内置扩展包不存在（vendor/${name} 缺失）`);
  }
  const agentDir = getAgentDir();
  const dest = join(agentDir, name);
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
  }
  const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
  });
  await packageManager.installAndPersist(dest, { local: false });
  return { installed: true, source: name };
}
