import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { isRemoteModeActive, loadSshConfig, sshBrowse } from "@/lib/ssh";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
// 远程模式（ssh 启用）：path 是远程绝对路径，用 ssh 浏览远程目录。
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();
    const sshCfg = loadSshConfig();

    if (isRemoteModeActive(sshCfg)) {
      const remotePath = requested && requested.startsWith("/") ? requested : (sshCfg.path || "/");
      try {
        const r = await sshBrowse(sshCfg.host, remotePath);
        // 与本地 browse 保持统一格式 { name, path }：sshBrowse 返回的是名字数组
        const base = r.current === "/" ? "" : r.current.replace(/\/+$/, "");
        const dirs = r.dirs.map((name) => ({ name, path: `${base}/${name}` }));
        return NextResponse.json({ path: r.current, parentPath: r.parent, directories: dirs, remote: true });
      } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 404 });
      }
    }

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
