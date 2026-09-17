import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";
import {
  ensureShadowRoot,
  isRemoteModeActive,
  loadSshConfig,
  saveSshConfig,
  sshResolveDirectory,
} from "@/lib/ssh";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

/** 通过 ssh 把远程路径规范化（支持 ~ / . / ..），失败返回 null */
async function resolveRemotePath(host: string, raw: string): Promise<string | null> {
  try {
    return await sshResolveDirectory(host, raw);
  } catch {
    return null;
  }
}

// POST /api/cwd/validate  body: { cwd: string }
// 本地模式：校验本地目录。
// 远程模式（ssh 启用）：把 cwd 当作远程路径校验，更新 ssh-config 的 path，
//   创建/返回兼容会话 cwd 并持久绑定远程目标；不复制远程可执行配置。
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const sshCfg = loadSshConfig();

    // ---- 远程模式：远程路径校验 + 切目录 + 影子根 ----
    if (isRemoteModeActive(sshCfg)) {
      const remotePath = await resolveRemotePath(sshCfg.host, cwd);
      if (!remotePath) {
        return NextResponse.json({ error: `远程目录不存在: ${cwd}` }, { status: 400 });
      }
      // 切换选择，不修改已注册工作区的执行身份。
      const next = { ...sshCfg, path: remotePath };
      const shadowRoot = ensureShadowRoot(next);
      saveSshConfig(next);
      allowFileRoot(shadowRoot);
      return NextResponse.json({ success: true, cwd: shadowRoot, remotePath, remote: true,
        projectRoot: shadowRoot, projectKey: projectIdentityKey(shadowRoot),
      });
    }

    // ---- 本地模式 ----
    const normalizedCwd = normalizeCwd(cwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    const project = await resolveProject(normalizedCwd);
    return NextResponse.json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
