import { execFile } from "child_process";
import fs from "fs";
import path, { posix } from "path";
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
  localPathFor,
  quoteShellArg,
  remotePathFor,
  resolveRemoteWorkspace,
  type RemoteWorkspace,
} from "./remote-workspace";
import { sshExec, sshReadTextFile, type SshExecOptions } from "./ssh";

const GIT_TIMEOUT_MS = 30_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;
// These are emergency ceilings, not the size of a routine scan batch.
export const GIT_STATUS_MAX_FILES = 5_000;
export const GIT_STATUS_MAX_BYTES = 8 * 1024 * 1024;
const UNTRACKED_MAX_FILES = GIT_STATUS_MAX_FILES;
const UNTRACKED_MAX_BYTES = 32 * 1024 * 1024;
const UNTRACKED_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface GitRequestOptions {
  signal?: AbortSignal;
}

function requestSignal(options: GitRequestOptions): AbortSignal {
  const deadline = AbortSignal.timeout(GIT_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

// ============================================================================
// Repository context
//
// A session cwd is either a plain local directory or a path under the shadow
// root of a *persisted* remote workspace. The workspace is resolved exactly
// once per request and threaded through every git invocation, so a request
// never mixes local and remote execution and never depends on the currently
// selected (global) SSH config. Remote commands run as one ssh invocation
// with shell-quoted POSIX paths.
// ============================================================================

interface LocalRepoContext {
  kind: "local";
  /** Requested cwd (native absolute path) */
  cwd: string;
  /** Repository root (native path as printed by git) */
  root: string;
}

interface RemoteRepoContext {
  kind: "remote";
  workspace: RemoteWorkspace;
  /** Requested cwd mapped to the remote (absolute POSIX path) */
  cwd: string;
  /** Remote repository root (absolute POSIX path; may be above workspace.cwd) */
  root: string;
}

type RepoContext = (LocalRepoContext | RemoteRepoContext) & { signal: AbortSignal };

// --- Dependencies (swappable in tests) ---------------------------------------

interface GitChangesDeps {
  resolveWorkspace: (localPath: string) => RemoteWorkspace | null;
  sshExec: typeof sshExec;
  sshReadTextFile: typeof sshReadTextFile;
}

const defaultGitChangesDeps: GitChangesDeps = {
  resolveWorkspace: resolveRemoteWorkspace,
  sshExec,
  sshReadTextFile,
};

let gitChangesDeps: GitChangesDeps = defaultGitChangesDeps;

/** Test-only: stub the workspace lookup or the SSH transport. `null` restores the real dependencies. */
export function setGitChangesDepsForTests(deps: Partial<GitChangesDeps> | null): void {
  gitChangesDeps = deps ? { ...defaultGitChangesDeps, ...deps } : defaultGitChangesDeps;
}

// --- Path helpers -------------------------------------------------------------

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isWithinPosix(parent: string, target: string): boolean {
  const relative = posix.relative(parent, target);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

// --- git execution -------------------------------------------------------------

function localGit(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER, options: SshExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    let stopped = false;
    const child = execFile("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      signal: options.signal,
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (error && !stopped) reject(error);
      else resolve(stdout);
    });
    if (options.onStdout) child.stdout?.on("data", (data: Buffer | string) => {
      if (!stopped && !options.onStdout!(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
        stopped = true;
        child.kill();
      }
    });
  });
}

/** One ssh round trip; every argument is single-quoted (see quoteShellArg). */
function git(ctx: RepoContext, args: string[], maxBuffer?: number, onStdout?: SshExecOptions["onStdout"]): Promise<string> {
  ctx.signal.throwIfAborted();
  const options = { signal: ctx.signal, onStdout };
  if (ctx.kind === "remote") {
    const command = `cd ${quoteShellArg(ctx.root)} && git ${args.map(quoteShellArg).join(" ")}`;
    return gitChangesDeps.sshExec(ctx.workspace.host, command, GIT_TIMEOUT_MS, options);
  }
  return localGit(ctx.root, args, maxBuffer, options);
}

/**
 * Resolve the repository context for a session cwd. Returns null when the
 * directory is not inside a git repository. Throws (via the workspace
 * resolver) for unknown/orphaned remote shadows — the API route surfaces the
 * message instead of silently falling back to local execution.
 */
async function resolveRepoContext(cwd: string, signal: AbortSignal): Promise<RepoContext | null> {
  signal.throwIfAborted();
  const workspace = gitChangesDeps.resolveWorkspace(cwd);
  if (workspace) {
    const remoteCwd = remotePathFor(workspace, cwd);
    let root: string;
    try {
      root = (await gitChangesDeps.sshExec(
        workspace.host,
        `cd ${quoteShellArg(remoteCwd)} && git rev-parse --show-toplevel`,
        GIT_TIMEOUT_MS,
        { signal },
      )).trim();
    } catch {
      signal.throwIfAborted();
      return null; // unreachable host, or not a git repository
    }
    if (!root) return null;
    if (!posix.isAbsolute(root) || !isWithinPosix(root, remoteCwd)) {
      return null; // the returned repository must contain the requested remote cwd
    }
    return { kind: "remote", workspace, cwd: remoteCwd, root, signal };
  }
  let root: string;
  try {
    root = (await localGit(path.resolve(cwd), ["rev-parse", "--show-toplevel"], undefined, { signal })).trim();
  } catch {
    signal.throwIfAborted();
    return null;
  }
  if (!root) return null;
  return { kind: "local", cwd: path.resolve(cwd), root, signal };
}

// --- Reads ---------------------------------------------------------------------

function relativeCwd(ctx: RepoContext): string {
  return (ctx.kind === "remote" ? posix.relative(ctx.root, ctx.cwd) : toGitPath(path.relative(ctx.root, ctx.cwd))) || ".";
}

async function readStatusEntries(ctx: RepoContext, file?: string): Promise<{ entries: GitPorcelainEntry[]; truncated: boolean }> {
  let bytes = 0;
  let records = 0;
  let prefix = "";
  let renameSource = false;
  let truncated = false;
  const output = await git(ctx, [
    "--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file ?? relativeCwd(ctx),
  ], undefined, (chunk) => {
    bytes += chunk.length;
    // Count complete porcelain entries, not NULs (renames have two records).
    for (const byte of chunk) {
      if (byte !== 0) {
        if (prefix.length < 2) prefix += String.fromCharCode(byte);
        continue;
      }
      if (!renameSource && /[RC]/.test(prefix)) renameSource = true;
      else { renameSource = false; records++; }
      prefix = "";
      if (records > GIT_STATUS_MAX_FILES) break;
    }
    // One extra entry distinguishes an exceeded ceiling from an exact fit.
    truncated = bytes > GIT_STATUS_MAX_BYTES || records > GIT_STATUS_MAX_FILES;
    return !truncated;
  });
  // Ignore incomplete final records/renames rather than inventing partial paths.
  const buffer = Buffer.from(output);
  const bounded = buffer.subarray(0, GIT_STATUS_MAX_BYTES);
  const complete = bounded.subarray(0, bounded.lastIndexOf(0) + 1).toString("utf8");
  const entries = parseGitPorcelainV1(complete).filter((entry) =>
    !(/[RC]/.test(entry.indexStatus + entry.worktreeStatus) && !entry.originalPath));
  return {
    entries: entries.slice(0, GIT_STATUS_MAX_FILES),
    truncated: truncated || buffer.length > GIT_STATUS_MAX_BYTES || entries.length > GIT_STATUS_MAX_FILES,
  };
}

async function readTrackedLineStats(
  ctx: RepoContext,
): Promise<{ additions: number; deletions: number; complete: boolean }> {
  const pathspec = relativeCwd(ctx);
  let bytes = 0;
  let complete = true;
  try {
    const output = await git(ctx, [
      "--literal-pathspecs", "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ], undefined, (chunk) => {
      bytes += chunk.length;
      complete = bytes <= GIT_STATUS_MAX_BYTES;
      return complete;
    });
    let additions = 0;
    let deletions = 0;
    const bounded = Buffer.from(output).subarray(0, GIT_STATUS_MAX_BYTES).toString("utf8");
    if (Buffer.byteLength(output) > GIT_STATUS_MAX_BYTES) complete = false;
    const lines = complete ? bounded : bounded.slice(0, bounded.lastIndexOf("\n") + 1);
    for (const line of lines.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions, complete };
  } catch {
    ctx.signal.throwIfAborted();
    return { additions: 0, deletions: 0, complete: false };
  }
}

async function countUntrackedTextLines(ctx: LocalRepoContext & { signal: AbortSignal }, entry: GitPorcelainEntry, remainingBytes: number): Promise<{ lines: number; bytes: number; complete: boolean }> {
  try {
    ctx.signal.throwIfAborted();
    const filePath = path.resolve(ctx.root, entry.path);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) return { lines: 0, bytes: 0, complete: true };
    if (stat.size > Math.min(UNTRACKED_MAX_FILE_BYTES, remainingBytes)) return { lines: 0, bytes: 0, complete: false };
    // Yield between files so cancellation/deadlines are not starved by sync IO.
    const data = await fs.promises.readFile(filePath, { signal: ctx.signal });
    if (data.length > Math.min(UNTRACKED_MAX_FILE_BYTES, remainingBytes)) return { lines: 0, bytes: data.length, complete: false };
    const content = data.toString("utf8");
    const lines = content.includes("\0") || content.length === 0 ? 0
      : content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
    return { lines, bytes: data.length, complete: true };
  } catch {
    ctx.signal.throwIfAborted();
    return { lines: 0, bytes: 0, complete: false };
  }
}

/** 读取本地文件内容文本；失败返回 isFile=false */
async function readLocalFileText(filePath: string): Promise<{ text: string; isFile: boolean }> {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { text: "", isFile: false };
    return { text: fs.readFileSync(filePath).toString("utf8"), isFile: true };
  } catch {
    return { text: "", isFile: false };
  }
}

/** 读取远程文件内容文本（≤256KB，由 sshReadTextFile 保证）；失败返回 isFile=false */
async function readRemoteFileText(
  ctx: RemoteRepoContext & { signal: AbortSignal },
  remoteFile: string,
): Promise<{ text: string; isFile: boolean }> {
  try {
    const { content } = await gitChangesDeps.sshReadTextFile(ctx.workspace.host, remoteFile, TEXT_PREVIEW_MAX_BYTES, { signal: ctx.signal });
    return { text: content, isFile: true };
  } catch {
    ctx.signal.throwIfAborted();
    return { text: "", isFile: false };
  }
}

export async function getGitStatus(cwd: string, options: GitRequestOptions = {}): Promise<GitStatusResponse> {
  const ctx = await resolveRepoContext(cwd, requestSignal(options));
  if (!ctx) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  let scan: Awaited<ReturnType<typeof readStatusEntries>>;
  try {
    scan = await readStatusEntries(ctx);
    ctx.signal.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!ctx.signal.aborted) throw error;
    return {
      isGitRepository: true,
      repositoryRoot: ctx.kind === "remote" ? ctx.workspace.localRoot : ctx.root,
      files: [], additions: 0, deletions: 0,
      truncated: true, lineStatsTruncated: true, lineStatsIncompleteReason: "limit-or-error",
    };
  }
  const { entries } = scan;

  // For remote workspaces the repository root may sit above the persisted
  // workspace; only show entries inside the workspace subtree and map them
  // back to local (shadow) paths so the UI keeps working unchanged.
  const displayed: Array<{ entry: GitPorcelainEntry; filePath: string }> = [];
  for (const entry of entries) {
    let filePath: string | null = null;
    if (ctx.kind === "local") {
      const candidate = path.resolve(ctx.root, entry.path);
      if (isWithinPath(ctx.cwd, candidate)) filePath = candidate;
    } else {
      const remoteFile = posix.join(ctx.root, entry.path);
      if (isWithinPosix(ctx.cwd, remoteFile)) {
        filePath = localPathFor(ctx.workspace, remoteFile);
      }
    }
    if (!filePath) continue;
    displayed.push({ entry, filePath });
  }

  const files: GitFileStatus[] = displayed.map(({ entry, filePath }) => ({
    filePath,
    ...classifyGitStatus(entry),
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    ...(entry.path.endsWith("/") ? { isDirectory: true } : {}),
  }));

  const truncated = scan.truncated;
  let lineStatsTruncated = truncated;
  let remoteUntracked = false;
  let trackedLineStats = { additions: 0, deletions: 0 };
  // Do not start a second whole-tree pass when the status limit was reached.
  if (!scan.truncated && files.some((file) => file.status !== "untracked")) {
    try {
      const stats = await readTrackedLineStats(ctx);
      trackedLineStats = stats;
      if (!stats.complete) lineStatsTruncated = true;
    } catch {
      options.signal?.throwIfAborted();
      lineStatsTruncated = true;
    }
  }

  let untrackedAdditions = 0;
  let untrackedFiles = 0;
  let untrackedBytes = 0;
  for (const { entry } of displayed) {
    if (classifyGitStatus(entry).status !== "untracked") continue;
    // Polling remote metadata must never download untracked files (which may
    // include private keys). Contents are read only for an explicit diff.
    if (ctx.kind === "remote") {
      remoteUntracked = true;
      continue;
    }
    if (scan.truncated || entry.path.endsWith("/")) {
      lineStatsTruncated = true;
      continue;
    }
    options.signal?.throwIfAborted();
    if (ctx.signal.aborted || untrackedFiles >= UNTRACKED_MAX_FILES || untrackedBytes >= UNTRACKED_MAX_BYTES) {
      lineStatsTruncated = true;
      break;
    }
    try {
      const count = await countUntrackedTextLines(ctx, entry, UNTRACKED_MAX_BYTES - untrackedBytes);
      untrackedFiles++;
      untrackedBytes += count.bytes;
      untrackedAdditions += count.lines;
      if (!count.complete) lineStatsTruncated = true;
    } catch {
      options.signal?.throwIfAborted();
      lineStatsTruncated = true;
      break;
    }
  }
  options.signal?.throwIfAborted();

  return {
    isGitRepository: true,
    repositoryRoot: ctx.kind === "remote" ? ctx.workspace.localRoot : ctx.root,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
    ...(truncated ? { truncated: true } : {}),
    ...(lineStatsTruncated || remoteUntracked ? {
      lineStatsTruncated: true,
      lineStatsIncompleteReason: lineStatsTruncated ? "limit-or-error" as const : "remote-untracked" as const,
    } : {}),
  };
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
  ctx: RepoContext,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(ctx, [
      "--literal-pathspecs", "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    ctx.signal.throwIfAborted();
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string, options: GitRequestOptions = {}): Promise<GitFileDiffResponse> {
  const ctx = await resolveRepoContext(cwd, requestSignal(options));
  if (!ctx) return { supported: false };

  // Map the requested file into the repository. `../` escapes and files
  // outside the persisted workspace are rejected, never resolved.
  let relativePath: string;
  let localFile: string | null = null;
  let remoteFile: string | null = null;
  if (ctx.kind === "local") {
    localFile = path.resolve(filePath);
    if (!isWithinPath(ctx.root, localFile)) return { supported: false };
    relativePath = toGitPath(path.relative(ctx.root, localFile));
  } else {
    let mapped: string;
    try {
      mapped = remotePathFor(ctx.workspace, filePath);
    } catch {
      return { supported: false };
    }
    if (!isWithinPosix(ctx.workspace.cwd, mapped)) return { supported: false };
    relativePath = posix.relative(ctx.root, mapped);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || posix.isAbsolute(relativePath)) {
      return { supported: false };
    }
    remoteFile = mapped;
  }

  // An explicit file diff must not enumerate all other changes first.
  const { entries } = await readStatusEntries(ctx, relativePath);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(ctx, relativePath, entry.originalPath);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  const fileRead = ctx.kind === "remote"
    ? await readRemoteFileText(ctx, remoteFile as string)
    : await readLocalFileText(localFile as string);
  if (!fileRead.isFile) return { supported: false };
  const newContent = fileRead.text;
  if (newContent.includes("\0")) return { supported: false };

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(ctx, relativePath, entry.originalPath);
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
