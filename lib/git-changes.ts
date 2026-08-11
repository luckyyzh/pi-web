import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";
import {
  isRemoteModeActive,
  loadSshConfig,
  localToRemotePath,
  shadowRootFor,
  sshExec,
  sshReadTextFile,
} from "./ssh";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

/** 远程模式是否生效（且作用于本地路径 —— 影子路径会翻译成远程） */
function remoteContext(): { active: boolean; host: string; shadowRoot: string | null } {
  const cfg = loadSshConfig();
  if (!isRemoteModeActive(cfg)) return { active: false, host: "", shadowRoot: null };
  return { active: true, host: cfg.host, shadowRoot: shadowRootFor(cfg.host, cfg.path || "/") };
}

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const remote = remoteContext();
  if (remote.active) {
    // 本地路径（可能是影子路径）→ 远程路径
    const remoteBase = localToRemotePath(cwd, loadSshConfig());
    if (remoteBase) {
      const quoted = args.map((a) => JSON.stringify(a)).join(" ");
      const out = await sshExec(
        remote.host,
        `cd ${JSON.stringify(remoteBase)} && git ${quoted}`,
        GIT_TIMEOUT_MS,
      );
      return out;
    }
    // 路径不在影子根下 → 走本地
  }
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<{ root: string; shadowRoot: string | null } | null> {
  const remote = remoteContext();
  try {
    if (remote.active) {
      const remoteBase = localToRemotePath(cwd, loadSshConfig());
      if (!remoteBase) return null;
      const root = (await sshExec(remote.host, `cd ${JSON.stringify(remoteBase)} && git rev-parse --show-toplevel`))
        .trim() || null;
      if (!root) return null;
      return { root, shadowRoot: remote.shadowRoot };
    }
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
    return root ? { root, shadowRoot: null } : null;
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/** 把远程 repo 相对路径映射为"前端可见路径"（本地模式=本地绝对路径；远程模式=影子路径） */
function filePathFor(entryPath: string, repo: { root: string; shadowRoot: string | null }): string {
  if (repo.shadowRoot) {
    return repo.shadowRoot + "/" + entryPath.split("/").join(path.sep);
  }
  return path.resolve(repo.root, entryPath);
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const remote = remoteContext();
  let relativeCwd: string;
  if (remote.active) {
    const remoteCwd = localToRemotePath(cwd, loadSshConfig());
    relativeCwd = remoteCwd
      ? toGitPath(path.relative(repositoryRoot.replace(/\\/g, "/"), remoteCwd))
      : ".";
  } else {
    relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  }
  const pathspec = relativeCwd || ".";
  try {
    const output = await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

async function countUntrackedTextLines(filePath: string): Promise<number> {
  const remote = remoteContext();
  try {
    let content: string | null = null;
    let isFile = false;
    if (remote.active) {
      const remoteFile = localToRemotePath(filePath, loadSshConfig());
      if (remoteFile) {
        const q = JSON.stringify(remoteFile);
        const statOut = await sshExec(remote.host, `stat -c %s ${q} 2>/dev/null`).catch(() => "");
        const size = parseInt(statOut.trim(), 10);
        if (!Number.isFinite(size) || size > TEXT_PREVIEW_MAX_BYTES) return 0;
        const { content: text } = await sshReadTextFile(remote.host, remoteFile).catch(() => ({ content: "", size: 0 }));
        content = text;
        isFile = true;
      }
    } else {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return 0;
      content = fs.readFileSync(filePath).toString("utf8");
      isFile = true;
    }
    if (!isFile || content === null || content.includes("\0") || content.length === 0) return 0;
    return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
  } catch {
    return 0;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repo = await findRepositoryRoot(cwd);
  if (!repo) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  const [entries, trackedLineStats] = await Promise.all([
    readStatusEntries(repo.root),
    readTrackedLineStats(repo.root, cwd),
  ]);
  const files: GitFileStatus[] = [];
  for (const entry of entries) {
    const filePath = filePathFor(entry.path, repo);
    if (!isWithinPath(cwd, filePath)) continue;
    const classified = classifyGitStatus(entry);
    files.push({
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    });
  }
  const untrackedAdditions = await files.reduce(
    async (accPromise, file) => {
      const acc = await accPromise;
      return acc + (file.status === "untracked" ? await countUntrackedTextLines(file.filePath) : 0);
    },
    Promise.resolve(0),
  );

  return {
    isGitRepository: true,
    repositoryRoot: repo.root,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

/** 读取文件内容文本；远程模式走 ssh。失败返回 null */
async function readFileText(filePath: string): Promise<{ text: string; isFile: boolean }> {
  const remote = remoteContext();
  try {
    if (remote.active) {
      const remoteFile = localToRemotePath(filePath, loadSshConfig());
      if (remoteFile) {
        const q = JSON.stringify(remoteFile);
        const statOut = await sshExec(remote.host, `stat -c %s ${q} 2>/dev/null`).catch(() => "");
        const size = parseInt(statOut.trim(), 10);
        if (!Number.isFinite(size) || size > TEXT_PREVIEW_MAX_BYTES) return { text: "", isFile: false };
        const { content } = await sshReadTextFile(remote.host, remoteFile).catch(() => ({ content: "", size: 0 }));
        return { text: content, isFile: true };
      }
      return { text: "", isFile: false };
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { text: "", isFile: false };
    return { text: fs.readFileSync(filePath).toString("utf8"), isFile: true };
  } catch {
    return { text: "", isFile: false };
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repo = await findRepositoryRoot(cwd);
  if (!repo) return { supported: false };

  const remote = remoteContext();
  let resolvedFilePath = path.resolve(filePath);
  let relativePath: string;
  if (remote.active) {
    // 远程模式：filePath 必须是影子根下路径 → 转远程路径求相对
    const remoteFile = localToRemotePath(filePath, loadSshConfig());
    if (!remoteFile) return { supported: false };
    relativePath = toGitPath(path.relative(repo.root.replace(/\\/g, "/"), remoteFile));
    resolvedFilePath = filePath;
  } else {
    if (!isWithinPath(repo.root, filePath)) return { supported: false };
    relativePath = toGitPath(path.relative(repo.root, resolvedFilePath));
  }
  const entries = await readStatusEntries(repo.root);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repo.root, relativePath, entry.originalPath);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  const fileRead = await readFileText(resolvedFilePath);
  if (!fileRead.isFile) return { supported: false };
  const newContent = fileRead.text;
  if (newContent.includes("\0")) return { supported: false };

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repo.root, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
