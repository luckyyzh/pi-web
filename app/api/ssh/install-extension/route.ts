import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** 内嵌的 ssh 扩展包目录（pi-web/vendor/ssh） */
function bundledSshPath(): string {
  return join(process.cwd(), "vendor", "ssh");
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isSshPackage(source: string): boolean {
  const s = source.trim();
  if (s === "ssh") return true;
  // 本地路径（.../ssh 或 ...\ssh）或 git/npm 源也视为 ssh 扩展
  return s.endsWith("/ssh") || s.endsWith("\\ssh") || s.includes("pi-web-extensions");
}

// GET /api/ssh/install-extension：检测 ssh 扩展是否已安装
export async function GET() {
  const source = bundledSshPath();
  const bundled = existsSync(source);
  let installed = false;
  let installedSource: string | null = null;
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
    for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
      const s = sourceOf(entry);
      if (isSshPackage(s)) {
        installed = true;
        installedSource = s;
        break;
      }
    }
  } catch {
    // 读不到配置时按未安装处理
  }
  return NextResponse.json({ installed, bundled, installedSource, source });
}

// POST /api/ssh/install-extension：安装内嵌的 ssh 扩展（全局 scope）
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const source = bundledSshPath();
    if (!existsSync(source)) {
      return NextResponse.json({ error: "ssh 扩展包不存在（vendor/ssh 缺失）" }, { status: 404 });
    }
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: true });
    const packageManager = new DefaultPackageManager({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
    });
    await packageManager.installAndPersist(source, { local: false });
    return NextResponse.json({ ok: true, source });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
