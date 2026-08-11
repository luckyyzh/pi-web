/**
 * lib/ssh.ts
 *
 * 共享 SSH 工具 + 影子目录基础设施。
 *
 * 影子目录（Shadow）方案：每个远程目录映射到一个本地影子根（真实存在的空目录），
 * 让 pi 的会话/信任/AGENTS 机制"以为"它是本地项目，同时所有文件/agent 操作通过
 * 「影子路径 → 远程路径」映射走 ssh。不同远程目录 = 不同影子根 = 独立会话。
 *
 * 配置格式（与 ssh 扩展一致，存 ~/.pi/agent/ssh-config.json）：
 *   { "enabled": boolean, "host": "user@host", "path": "/remote/dir" | "" }
 *
 * 影子根：~/.pi/remote/<host>_<path-hash>/（确定性 hash，同一远程目录永远同一影子根）
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ssh-config.json");
const REMOTE_BASE = join(homedir(), ".pi", "remote");
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

/** 在远程执行命令，成功返回 stdout 文本，失败抛错（含 stderr） */
export function sshExec(remote: string, command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("SSH command timed out"));
      } else if (code !== 0) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
      } else {
        resolve(Buffer.concat(chunks).toString());
      }
    });
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
  const hash = createHash("sha256").update(host).update("\0").update(remotePath).digest("hex").slice(0, 12);
  const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(REMOTE_BASE, `${safeHost}_${hash}`);
}

/** 确保影子根目录存在并返回它 */
export function ensureShadowRoot(cfg: SshConfig): string {
  const root = shadowRootFor(cfg.host, cfg.path || "/");
  mkdirSync(root, { recursive: true });
  return root;
}

/** 当前激活的影子根（远程模式且启用时）；否则 null */
export function activeShadowRoot(cfg?: SshConfig): string | null {
  const c = cfg ?? loadSshConfig();
  if (!isRemoteModeActive(c)) return null;
  return ensureShadowRoot(c);
}

/**
 * 本地路径 → 远程路径。
 * 仅当 localPath 在"当前影子根"下时映射；否则返回 null。
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
 * 影子方案下优先用 localToRemotePath；保留此函数用于非影子映射（如旧调用）。
 * @deprecated 新代码请用 localToRemotePath
 */
export function toRemotePath(localPath: string, roots: Iterable<string>, cfg: SshConfig): string | null {
  return localToRemotePath(localPath, cfg);
}

// ============================================================================
// 远程文件/目录操作
// ============================================================================

/** 列出远程目录条目，返回 [{ name, isDir }]（未排序，未过滤） */
export async function sshListDir(host: string, remoteDir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const q = JSON.stringify(remoteDir);
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
export async function sshReadTextFile(host: string, remoteFile: string): Promise<{ content: string; size: number }> {
  const q = JSON.stringify(remoteFile);
  const [sizeRaw, b64Raw] = await Promise.all([
    sshExec(host, `stat -c %s ${q} 2>/dev/null`).catch(() => ""),
    sshExec(host, `base64 ${q} 2>/dev/null`).catch(() => ""),
  ]);
  const size = parseInt(sizeRaw.trim(), 10);
  const content = Buffer.from(b64Raw.replace(/\s+/g, ""), "base64").toString("utf-8");
  return { content, size: Number.isFinite(size) ? size : content.length };
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
  const q = JSON.stringify(remotePath);
  try {
    await sshExec(host, `test -d ${q}`);
    return true;
  } catch {
    return false;
  }
}

/** 测试连接：执行 pwd 确认免密可用 */
export async function sshTestConnection(host: string, path?: string): Promise<{ ok: boolean; cwd?: string; error?: string }> {
  try {
    const pwd = (await sshExec(host, "pwd", 10_000)).trim();
    let cwd = pwd;
    if (path) {
      try {
        cwd = (await sshExec(host, `cd ${JSON.stringify(path)} && pwd`, 10_000)).trim();
      } catch {
        return { ok: false, cwd: pwd, error: `远程目录不存在: ${path}` };
      }
    }
    return { ok: true, cwd };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// 影子目录同步（AGENTS.md / .pi / .agents → 影子根）
// 让 pi 的 AGENTS 注入、项目信任在远程模式下自动生效。
// 幂等：远程内容不变则影子文件不变，不破坏 prompt 前缀缓存。
// ============================================================================

const execFileAsync = promisify(execFile);

/** 探测系统 tar 可执行文件（Windows 自带 System32\tar.exe） */
function findTar(): string {
  const candidates = ["C:\\Windows\\System32\\tar.exe", "tar"];
  for (const c of candidates) {
    try {
      if (c.includes("\\")) return existsSync(c) ? c : "";
      return c;
    } catch {
      /* ignore */
    }
  }
  return "tar";
}

/**
 * 把远程配置类文件同步到影子根。
 * 远程 `tar czf - AGENTS.md .pi .agents | base64` → 本地解压到影子根。
 * 仅同步这些固定名字，避免路径穿越风险。
 */
export async function syncShadowProject(cfg: SshConfig): Promise<{ ok: boolean; error?: string }> {
  if (!isRemoteModeActive(cfg)) return { ok: false, error: "SSH 未启用" };
  try {
    const root = ensureShadowRoot(cfg);
    const remote = (cfg.path || "/").replace(/\/+$/, "");
    const q = JSON.stringify(remote);
    const b64 = await sshExec(
      cfg.host,
      `cd ${q} 2>/dev/null && tar czf - AGENTS.md AGENTS.zh-CN.md AGENTS.zh.md .pi .agents 2>/dev/null | base64 2>/dev/null || true`,
      60_000,
    );
    if (b64.trim()) {
      const buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
      const tmp = join(tmpdir(), `pi-ssh-shadow-${createHash("sha256").update(root).digest("hex").slice(0, 10)}.tar.gz`);
      writeFileSync(tmp, buf);
      await execFileAsync(findTar(), ["-xzf", tmp, "-C", root]);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
