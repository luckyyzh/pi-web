import { randomUUID } from "crypto";
import { homedir } from "os";
import type { IPty } from "node-pty";
import { quoteShellArg, sshArguments } from "./remote-workspace";
import { samePath } from "./paths";
import { sameWorkspaceTarget, type WorkspaceTarget } from "./workspace-target";

export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

type TerminalListener = (event: TerminalEvent) => void;

interface TerminalRecord {
  pty: IPty;
  cwd: string;
  target: WorkspaceTarget;
  listeners: Set<TerminalListener>;
  backlog: string;
  offset: number;
  exited: boolean;
  exitCode: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __piWebTerminals: Map<string, TerminalRecord> | undefined;
}

// ponytail: bounded replay; use terminal serialization if full-screen snapshots become necessary.
const MAX_BACKLOG = 128 * 1024;
export const TERMINAL_RECONNECT_MS = 120_000;

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__piWebTerminals) {
    globalThis.__piWebTerminals = new Map();
    const shutdown = () => {
      for (const id of globalThis.__piWebTerminals!.keys()) killTerminal(id, true);
    };
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piWebTerminals;
}

function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // Windows shells (Git Bash / MSYS2, cmd, PowerShell) otherwise inherit the
  // system ANSI codepage (e.g. GBK on zh-CN) and mangle non-ASCII filenames.
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}

function emit(record: TerminalRecord, event: TerminalEvent): void {
  for (const listener of record.listeners) listener(event);
}

function localShell(): string {
  return process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL || "/bin/sh";
}

function localShellArgs(): string[] {
  return process.platform === "win32" ? [] : ["-l"];
}

// node-pty's Windows ConPTY spawn cannot resolve the bare name "ssh" (it
// reports "File not found" synchronously); the .exe extension is required.
// POSIX spawn resolves "ssh" through PATH as usual.
function sshCommand(): string {
  return process.platform === "win32" ? "ssh.exe" : "ssh";
}

/**
 * Remote session bootstrap: safely cd into the workspace, then replace the
 * session with a login shell. A missing directory must fail closed (non-zero
 * exit, no interactive shell) and never fall back to another directory.
 * `"${SHELL:-/bin/sh}"` is expanded by the *remote* shell, not here.
 */
function remoteShellCommand(remoteCwd: string): string {
  return "cd " + quoteShellArg(remoteCwd) + ' && exec "${SHELL:-/bin/sh}" -l';
}

function ptyOptions(cwd: string, cols: number, rows: number) {
  return {
    name: "xterm-256color",
    cols: dimension(cols, 80),
    rows: dimension(rows, 24),
    cwd: cwd || homedir(),
    env: shellEnvironment(),
  };
}

function scheduleCleanup(id: string, record: TerminalRecord): void {
  if (record.cleanupTimer || record.listeners.size || registry().get(id) !== record) return;
  record.cleanupTimer = setTimeout(() => killTerminal(id), TERMINAL_RECONNECT_MS);
  record.cleanupTimer.unref?.();
}

function dimension(value: number, fallback: number): number {
  return Math.min(1000, Math.max(2, Number.isFinite(value) ? Math.floor(value) : fallback));
}

export function createTerminal(
  cwd: string,
  cols: number,
  rows: number,
  id: string = randomUUID(),
  target: WorkspaceTarget = { kind: "local", cwd },
): string {
  const existing = registry().get(id);
  if (existing) {
    // Local identity is the cwd (samePath: separator/case tolerant). Remote
    // identity (id+host+cwd) stays an exact snapshot.
    if (!samePath(existing.cwd, cwd) || existing.target.kind !== target.kind
      || (target.kind === "ssh" && !sameWorkspaceTarget(existing.target, target))) {
      throw new Error("Terminal belongs to a different workspace");
    }
    return id;
  }
  let spawn: typeof import("node-pty").spawn;
  try {
    // Load inside creation so native module failures reach the API's JSON error handler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ spawn } = require("node-pty") as typeof import("node-pty"));
  } catch (error) {
    throw new Error(
      `Cannot load the node-pty native terminal module for ${process.platform}-${process.arch}. ` +
      "The binary may be missing or incompatible. In the pi-web installation directory " +
      "(the npx cache directory when using npx), run: npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts. " +
      "On Debian/Ubuntu, install build tools first: sudo apt-get install -y python3 build-essential. " +
      `Then restart pi-web. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // Remote workspaces never spawn a local shell in a local directory. The
  // compatibility path of a remote subdirectory usually does not exist
  // locally, so the ssh client runs from the local home directory; the
  // *remote* command does the cd and fails closed. TERM/-tt come from
  // ptyOptions/sshArguments.
  const options = ptyOptions(target.kind === "ssh" ? homedir() : cwd, cols, rows);
  const pty = target.kind === "ssh"
    ? spawn(sshCommand(), sshArguments(target.host, remoteShellCommand(target.cwd), true), options)
    : spawn(localShell(), localShellArgs(), options);
  const record: TerminalRecord = {
    pty,
    cwd,
    // Frozen copy: callers and API responses can never mutate the snapshot.
    target: Object.freeze({ ...target }),
    listeners: new Set(),
    backlog: "",
    offset: 0,
    exited: false,
    exitCode: null,
    cleanupTimer: null,
  };
  registry().set(id, record);
  // Includes creations whose response or initial SSE connection never arrives.
  scheduleCleanup(id, record);

  pty.onData((data) => {
    record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
    record.offset += data.length;
    emit(record, { type: "output", data, offset: record.offset });
  });
  pty.onExit(({ exitCode }) => {
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
    record.exited = true;
    record.exitCode = exitCode;
    emit(record, { type: "exit", exitCode });
    scheduleCleanup(id, record);
  });
  return id;
}

export function hasTerminal(id: string): boolean {
  return registry().has(id);
}

export function getTerminalCwd(id: string): string | undefined {
  return registry().get(id)?.cwd;
}

export function getTerminalTarget(id: string): WorkspaceTarget | undefined {
  return registry().get(id)?.target;
}

export function subscribeTerminal(
  id: string,
  listener: TerminalListener,
  after?: number,
): { output: Extract<TerminalEvent, { type: "output" }>; exited: boolean; exitCode: number | null; unsubscribe: () => void } | null {
  const record = registry().get(id);
  if (!record) return null;
  record.listeners.add(listener);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  record.cleanupTimer = null;
  const start = record.offset - record.backlog.length;
  const reset = after === undefined || after < start || after > record.offset;
  return {
    output: {
      type: "output",
      data: reset ? record.backlog : record.backlog.slice(after - start),
      offset: record.offset,
      reset,
    },
    exited: record.exited,
    exitCode: record.exitCode,
    unsubscribe: () => {
      record.listeners.delete(listener);
      scheduleCleanup(id, record);
    },
  };
}

export function writeTerminal(id: string, data: string): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.resize(dimension(cols, 80), dimension(rows, 24));
  return true;
}

export function killTerminal(id: string, force = false): boolean {
  const record = registry().get(id);
  if (!record) return false;
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  registry().delete(id);
  if (!record.exited) {
    record.pty.kill(force && process.platform !== "win32" ? "SIGKILL" : undefined);
    // A shell may trap SIGHUP; explicit close and lease expiry must still finish.
    if (!force) {
      record.cleanupTimer = setTimeout(() => {
        if (!record.exited) record.pty.kill(process.platform === "win32" ? undefined : "SIGKILL");
      }, 2000);
      record.cleanupTimer.unref?.();
    }
  }
  emit(record, { type: "closed" });
  record.listeners.clear();
  return true;
}
