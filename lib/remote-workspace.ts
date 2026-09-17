import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RemoteWorkspaceTarget, WorkspaceTarget } from "./workspace-target";

/** Kept outside the project cache: remote project archives must not overwrite routing metadata. */
export interface WorkspaceLocations {
  remoteBase: string;
  metadataDir: string;
}

export interface RemoteWorkspace extends RemoteWorkspaceTarget {
  localRoot: string;
}

function locations(): WorkspaceLocations {
  return {
    remoteBase: path.join(homedir(), ".pi", "remote"),
    metadataDir: path.join(homedir(), ".pi", "agent", "remote-workspaces"),
  };
}

export function validateSshHost(host: string): void {
  // SSH options must never be accepted as a destination. SSH config aliases are supported.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._@-]*$/.test(host)) {
    throw new Error("Invalid SSH host (use an SSH config alias or user@host)");
  }
}

export function normalizeRemoteCwd(cwd: string): string {
  if (!cwd.startsWith("/") || /[\0\r\n\\]/.test(cwd)) {
    throw new Error("Remote cwd must be an absolute POSIX path");
  }
  return path.posix.normalize(cwd).replace(/\/+$/, "") || "/";
}

export function remoteWorkspaceId(host: string, remoteCwd: string): string {
  const hash = createHash("sha256").update(host).update("\0").update(remoteCwd).digest("hex").slice(0, 12);
  return `${host.replace(/[^a-zA-Z0-9._-]/g, "_")}_${hash}`;
}

export function remoteCacheRoot(host: string, remoteCwd: string, storage = locations()): string {
  return path.join(storage.remoteBase, remoteWorkspaceId(host, remoteCwd));
}

function isInside(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Persist an immutable target for a compatibility cwd. Does not connect to SSH. */
export function registerRemoteWorkspace(host: string, cwd: string, storage = locations()): RemoteWorkspace {
  validateSshHost(host);
  const canonicalCwd = normalizeRemoteCwd(cwd);
  // Preserve the legacy cache key for existing sessions, even when the spelling contains a trailing slash.
  const id = remoteWorkspaceId(host, cwd);
  const workspace: RemoteWorkspace = { kind: "ssh", id, host, cwd: canonicalCwd, localRoot: path.join(storage.remoteBase, id) };
  mkdirSync(workspace.localRoot, { recursive: true });
  mkdirSync(storage.metadataDir, { recursive: true });
  const file = path.join(storage.metadataDir, `${id}.json`);
  const content = JSON.stringify({ version: 1, ...workspace }, null, 2);
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === content) return workspace;
    const saved = JSON.parse(current);
    if (saved.host !== host || saved.cwd !== canonicalCwd || saved.localRoot !== workspace.localRoot) {
      throw new Error("Remote workspace identity cannot be changed");
    }
    return workspace;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return workspace;
}

/** Resolve by saved workspace identity, never by the current global SSH selection. */
export function resolveRemoteWorkspace(localPath: string, storage = locations()): RemoteWorkspace | null {
  const relative = path.relative(path.resolve(storage.remoteBase), path.resolve(localPath));
  if (!isInside(relative)) return null;
  const id = relative.split(path.sep)[0];
  if (!id || !/^[a-zA-Z0-9._-]+_[a-f0-9]{12}$/.test(id)) {
    throw new Error("Unknown remote workspace; reconnect this project from the Remote panel");
  }
  const file = path.join(storage.metadataDir, `${id}.json`);
  if (!existsSync(file)) {
    throw new Error("Remote workspace mapping is missing; reconnect this project from the Remote panel (local execution was blocked)");
  }
  const saved = JSON.parse(readFileSync(file, "utf8"));
  validateSshHost(saved.host);
  if (saved.version !== 1 || saved.kind !== "ssh" || saved.id !== id || typeof saved.cwd !== "string") {
    throw new Error("Invalid remote workspace metadata");
  }
  return {
    kind: "ssh", id, host: saved.host, cwd: normalizeRemoteCwd(saved.cwd),
    localRoot: path.join(storage.remoteBase, id),
  };
}

/** Previously selected remote roots remain authorized just like roots recorded by local sessions. */
export function listRemoteWorkspaceRoots(storage = locations()): string[] {
  if (!existsSync(storage.metadataDir)) return [];
  const roots: string[] = [];
  let names: string[];
  try { names = readdirSync(storage.metadataDir); } catch { return roots; }
  for (const name of names) {
    if (!/^[a-zA-Z0-9._-]+_[a-f0-9]{12}\.json$/.test(name)) continue;
    const root = path.join(storage.remoteBase, name.slice(0, -5));
    try {
      if (resolveRemoteWorkspace(root, storage)) roots.push(root);
    } catch { /* A corrupt manifest is not an authorization grant. */ }
  }
  return roots;
}

export function remotePathFor(workspace: RemoteWorkspace, localPath: string): string {
  const relative = path.relative(path.resolve(workspace.localRoot), path.resolve(localPath));
  if (!isInside(relative)) throw new Error("Path does not belong to this remote workspace");
  return path.posix.join(workspace.cwd, relative.split(path.sep).join("/"));
}

export function localPathFor(workspace: RemoteWorkspace, remotePath: string): string | null {
  const relative = path.posix.relative(workspace.cwd, normalizeRemoteCwd(remotePath));
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return null;
  return path.join(workspace.localRoot, ...relative.split("/"));
}

export function resolveWorkspaceTarget(cwd: string, storage = locations()): WorkspaceTarget {
  const workspace = resolveRemoteWorkspace(cwd, storage);
  return workspace
    ? { kind: "ssh", id: workspace.id, host: workspace.host, cwd: remotePathFor(workspace, cwd) }
    : { kind: "local", cwd: path.resolve(cwd) };
}

/** JSON.stringify is not shell escaping: $() and backticks expand inside double quotes. */
export function quoteShellArg(value: string): string {
  if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sshArguments(host: string, command: string, tty = false): string[] {
  validateSshHost(host);
  return [
    ...(tty ? ["-tt"] : ["-T"]),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes",
    host, command,
  ];
}
