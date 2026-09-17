/**
 * lib/ssh.ts
 *
 * 共享 SSH 工具 + 影子目录基础设施。
 *
 * 本地目录仅保留为旧会话键和项目资源缓存。执行目标单独持久化在
 * remote-workspace.ts，文件、Agent 和终端按各自工作区绑定路由，
 * 不再以当前全局 SSH 开关决定已有工作区的执行位置。
 *
 * 配置格式（与 ssh 扩展一致，存 ~/.pi/agent/ssh-config.json）：
 *   { "enabled": boolean, "host": "user@host", "path": "/remote/dir" | "" }
 *
 * 影子根：~/.pi/remote/<host>_<path-hash>/（确定性 hash，同一远程目录永远同一影子根）
 */

import { spawn } from "node:child_process";
import { quoteShellArg, registerRemoteWorkspace, remoteCacheRoot, sshArguments, normalizeRemoteCwd } from "./remote-workspace";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ssh-config.json");
const EXEC_TIMEOUT_MS = 30_000;

export interface SshConfig {
  enabled: boolean;
  host: string; // user@host
  path: string; // "" = 登录后所在目录(pwd)
}

export function loadSshConfig(): SshConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return {
        enabled: !!raw.enabled,
        host: typeof raw.host === "string" ? raw.host : "",
        path: typeof raw.path === "string" ? raw.path : "",
      };
    }
  } catch {
    /* ignore */
  }
  return { enabled: false, host: "", path: "" };
}

export function saveSshConfig(cfg: SshConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export interface SshExecOptions {
  signal?: AbortSignal;
  /** Returning false stops the producer and returns the captured prefix. */
  onStdout?: (chunk: Buffer) => boolean;
}

/** 在远程执行命令，成功返回 stdout 文本，失败抛错（含 stderr） */
export function sshExec(remote: string, command: string, timeoutMs = EXEC_TIMEOUT_MS, options: SshExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn("ssh", sshArguments(remote, command), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Settle immediately: a killed SSH child is not guaranteed to emit close.
      if (stop) child.kill();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const abort = () => finish(options.signal?.reason ?? new Error("SSH command aborted"), true);
    const timer = setTimeout(() => finish(new Error("SSH command timed out"), true), timeoutMs);
    const collect = (target: Buffer[], data: Buffer) => {
      if (settled) return;
      bytes += data.length;
      if (bytes > 16 * 1024 * 1024) {
        finish(new Error("SSH output exceeded the 16 MiB limit"), true);
      } else {
        target.push(data);
        if (target === chunks && options.onStdout) {
          try {
            if (!options.onStdout(data)) finish(undefined, true);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)), true);
          }
        }
      }
    };
    child.stdout.on("data", (data: Buffer) => collect(chunks, data));
    child.stderr.on("data", (data: Buffer) => collect(errChunks, data));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`)));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

/** 远程模式是否生效（配置 enabled 且 host 非空） */
export function isRemoteModeActive(cfg?: SshConfig): boolean {
  const c = cfg ?? loadSshConfig();
  return !!c.enabled && !!c.host;
}

// ============================================================================
// 影子目录
// ============================================================================

/** 影子根绝对路径（确定性 hash：同一 (host, path) 永远同一影子根，保证会话/缓存前缀稳定） */
export function shadowRootFor(host: string, remotePath: string): string {
  return remoteCacheRoot(host, remotePath);
}

/** 确保影子根目录存在并返回它 */
export function ensureShadowRoot(cfg: SshConfig): string {
  if (!cfg.path) throw new Error("请重新连接远程工作区，以解析并保存登录目录");
  return registerRemoteWorkspace(cfg.host, cfg.path).localRoot;
}

/** 当前激活的影子根（远程模式且启用时）；否则 null */
export function activeShadowRoot(cfg?: SshConfig): string | null {
  const c = cfg ?? loadSshConfig();
  if (!isRemoteModeActive(c)) return null;
  return ensureShadowRoot(c);
}

/**
 * 旧接口：根据调用方传入的配置进行路径转换。
 * @deprecated 工作区执行请用 resolveRemoteWorkspace + remotePathFor，不能依赖全局选择。
 */
export function localToRemotePath(localPath: string, cfg: SshConfig): string | null {
  if (!isRemoteModeActive(cfg)) return null;
  const root = shadowRootFor(cfg.host, cfg.path || "/").split("\\").join("/");
  const norm = localPath.split("\\").join("/");
  const remoteBase = (cfg.path || "/").replace(/\/+$/, "");
  if (norm === root) return remoteBase || "/";
  if (norm.startsWith(root + "/")) {
    return (remoteBase + norm.slice(root.length)).replace(/\/{2,}/g, "/");
  }
  return null;
}

/**
 * 兼容函数：把"本地根(roots) 下路径"映射为远程路径。
 * 仅为旧调用保留；不会用于新工作区路由。
 * @deprecated 新代码请用 resolveRemoteWorkspace + remotePathFor
 */
export function toRemotePath(localPath: string, roots: Iterable<string>, cfg: SshConfig): string | null {
  return localToRemotePath(localPath, cfg);
}

// ============================================================================
// 远程文件/目录操作
// ============================================================================

/** 列出远程目录条目，返回 [{ name, isDir }]（未排序，未过滤） */
export async function sshListDir(host: string, remoteDir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const q = quoteShellArg(remoteDir);
  const out = await sshExec(
    host,
    `find ${q} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\n' 2>/dev/null`,
  );
  const entries: Array<{ name: string; isDir: boolean }> = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab);
    const type = line.slice(tab + 1).trim();
    if (!name) continue;
    entries.push({ name, isDir: type === "d" });
  }
  return entries;
}

/** 读取远程文本文件内容（base64 传输避免编码问题） */
export async function sshReadTextFile(host: string, remoteFile: string, maxBytes = 256 * 1024, options: SshExecOptions = {}): Promise<{ content: string; size: number }> {
  const q = quoteShellArg(remoteFile);
  const sizeRaw = await sshExec(host, `stat -c %s -- ${q}`, EXEC_TIMEOUT_MS, options);
  const byteSize = Number(sizeRaw.trim());
  if (!Number.isFinite(byteSize) || byteSize > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte text limit`);
  const b64Raw = await sshExec(host, `base64 -- ${q}`, EXEC_TIMEOUT_MS, options);
  const buffer = Buffer.from(b64Raw.replace(/\s+/g, ""), "base64");
  if (buffer.length > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte text limit`);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  return { content, size: buffer.length };
}

/** 远程目录浏览（供 DirectoryPicker 远程模式用）：校验目录 + 列出子目录 + 父目录 */
export async function sshBrowse(host: string, remotePath: string): Promise<{
  current: string;
  parent: string | null;
  dirs: string[];
}> {
  const clean = (remotePath || "/").replace(/\/+$/, "") || "/";
  const exists = await sshPathExistsDir(host, clean);
  if (!exists) throw new Error(`远程目录不存在: ${clean}`);
  const list = await sshListDir(host, clean);
  const dirs = list.filter((e) => e.isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const parent = clean === "/" ? null : (clean.split("/").slice(0, -1).join("/") || "/");
  return { current: clean, parent, dirs };
}

/** 校验远程目录是否存在 */
export async function sshPathExistsDir(host: string, remotePath: string): Promise<boolean> {
  const q = quoteShellArg(remotePath);
  try {
    await sshExec(host, `test -d ${q}`);
    return true;
  } catch {
    return false;
  }
}

/** Resolve login-relative paths once, before persisting a workspace identity. */
export async function sshResolveDirectory(host: string, directory = ""): Promise<string> {
  const target = !directory || directory === "~"
    ? '"$HOME"'
    : directory.startsWith("~/")
      ? `"$HOME"/${quoteShellArg(directory.slice(2))}`
      : quoteShellArg(directory);
  return normalizeRemoteCwd((await sshExec(host, `cd ${target} && pwd -P`, 15_000)).trim());
}

/** 测试连接：执行 pwd 确认免密可用，不修改 known_hosts。 */
export async function sshTestConnection(host: string, path?: string): Promise<{ ok: boolean; cwd?: string; error?: string }> {
  try {
    return { ok: true, cwd: await sshResolveDirectory(host, path) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
