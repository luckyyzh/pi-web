/**
 * lib/remote-agent-transport.ts
 *
 * SSH transport + path mapping for the built-in remote project tools
 * (see lib/remote-agent.ts).
 *
 * Design constraints:
 * - The execution target is the immutable `RemoteWorkspace` identity. The
 *   global `~/.pi/agent/ssh-config.json` is never read here.
 * - SSH is key-based only: `sshArguments()` forces `BatchMode=yes` and
 *   `StrictHostKeyChecking=yes`, so no password prompts and no
 *   known_hosts mutations.
 * - Remote paths are always POSIX; host paths use the platform separator.
 *   The two never mix: remote→virtual mapping builds host paths with
 *   `path.join`, and virtual→remote mapping splits on `path.sep`.
 * - Every SSH invocation is bounded: default 30s timeout for `exec`,
 *   explicit timeouts for `stream` (the SDK bash tool passes its own), and a
 *   16 MiB output cap. Abort/timeout kills the local SSH process.
 *   Terminating the full remote process tree is NOT guaranteed (documented
 *   to the model).
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  quoteShellArg,
  remotePathFor,
  sshArguments,
  type RemoteWorkspace,
} from "./remote-workspace";

// ============================================================================
// Transport
// ============================================================================

export interface RemoteAgentCommandResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface RemoteAgentExecOptions {
  signal?: AbortSignal;
  /** Timeout in ms. Defaults to `REMOTE_EXEC_DEFAULT_TIMEOUT_MS` (30s). */
  timeoutMs?: number;
}

export interface RemoteAgentStreamOptions {
  /** Receives raw stdout+stderr chunks (the SDK accumulates/truncates them). */
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /**
   * Timeout in seconds (SDK bash semantics). Undefined means "no timeout"
   * (interactive bash commands); non-bash callers (write) pass an explicit
   * value so SSH can never hang indefinitely.
   */
  timeout?: number;
  /** Optional command stdin (large write payloads must not go through argv). */
  stdin?: string;
}

export interface RemoteAgentTransport {
  /**
   * Run one remote bash command and collect its output.
   * Never throws for non-zero exit codes; callers inspect `exitCode`.
   * Rejects with `aborted`, `timeout:<seconds>`, or an output-limit error.
   */
  exec(command: string, options?: RemoteAgentExecOptions): Promise<RemoteAgentCommandResult>;
  /**
   * Run one remote bash command, streaming output to `onData`.
   * Resolves with the exit code. Rejects with `Error("aborted")`,
   * `Error("timeout:<seconds>")`, or an output-limit error so the SDK bash
   * tool can format its messages.
   */
  stream(command: string, options: RemoteAgentStreamOptions): Promise<number | null>;
}

/** Injectable spawn for tests: (command, args, useStdin) => child process. */
export type RemoteAgentSpawn = (command: string, args: string[], useStdin: boolean) => ChildProcess;

const defaultSpawn: RemoteAgentSpawn = (command, args, useStdin) =>
  spawn(command, args, { stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"] });

/** Default bound for non-streaming remote commands (file ops, grep, find, ls). */
export const REMOTE_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/** Default bound for non-bash streams (large writes over SSH). */
export const REMOTE_STREAM_DEFAULT_TIMEOUT_SECONDS = 300;
/** Hard cap on collected/forwarded remote output per invocation. */
export const REMOTE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface RemoteRunOptions {
  useStdin: boolean;
  stdin?: string;
  signal?: AbortSignal;
  /** Undefined → no timeout (SDK bash semantics). */
  timeoutMs?: number;
  /** Seconds label used in the `timeout:<seconds>` rejection message. */
  timeoutLabel?: string;
  maxOutputBytes: number;
  onData?: (chunk: Buffer) => void;
  collect: boolean;
}

interface RemoteRunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

function runRemote(
  spawnChild: RemoteAgentSpawn,
  host: string,
  command: string,
  options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<RemoteRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnChild("ssh", sshArguments(host, command), options.useStdin);
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    let settled = false;
    let totalBytes = 0;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const killChild = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => fail(new Error("aborted"));
    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(error);
    };
    const account = (bytes: number) => {
      totalBytes += bytes;
      if (totalBytes > options.maxOutputBytes) {
        fail(new Error(`remote output limit exceeded (${options.maxOutputBytes} bytes)`));
      }
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        fail(new Error(`timeout:${options.timeoutLabel ?? options.timeoutMs! / 1000}`));
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      account(data.length);
      if (settled) return;
      if (options.collect) stdoutChunks.push(data);
      options.onData?.(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      account(data.length);
      if (settled) return;
      stderrText += data.toString("utf8");
      options.onData?.(data);
    });
    child.on("error", (error) => {
      fail(new Error(`SSH spawn failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      resolve({
        exitCode: code,
        stdout: options.collect ? Buffer.concat(stdoutChunks) : Buffer.alloc(0),
        stderr: stderrText,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* EPIPE when the remote command exits early */
      });
      child.stdin?.end(Buffer.from(options.stdin, "utf8"));
    }
  });
}

export function createRemoteAgentTransport(
  host: string,
  options: { spawn?: RemoteAgentSpawn; maxOutputBytes?: number } = {},
): RemoteAgentTransport {
  const spawnChild = options.spawn ?? defaultSpawn;
  const maxOutputBytes = options.maxOutputBytes ?? REMOTE_MAX_OUTPUT_BYTES;

  return {
    async exec(command, execOptions = {}) {
      const timeoutMs = execOptions.timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT_MS;
      const result = await runRemote(spawnChild, host, command, {
        useStdin: false,
        signal: execOptions.signal,
        timeoutMs,
        timeoutLabel: String(timeoutMs / 1000),
        maxOutputBytes,
        collect: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
    },

    async stream(command, { onData, signal, timeout, stdin }) {
      const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
      const result = await runRemote(spawnChild, host, command, {
        useStdin: stdin !== undefined,
        stdin,
        signal,
        timeoutMs,
        timeoutLabel: timeout !== undefined ? String(timeout) : undefined,
        maxOutputBytes,
        onData,
        collect: false,
      });
      return result.exitCode;
    },
  };
}

// ============================================================================
// Path mapping
// ============================================================================

/**
 * Maps between:
 *  - remote POSIX paths (what the LLM sees, rooted at the workspace cwd),
 *  - virtual host paths under the workspace localRoot (fed to the SDK tool
 *    definitions so their host-side `node:path` resolution is a no-op),
 *  - legacy shadow/cache host paths under localRoot (compat for old sessions).
 */
export interface RemoteAgentPathMapping {
  /** Host-absolute base used for the SDK tools (session cwd if inside localRoot, else localRoot). */
  readonly localBase: string;
  /** Remote POSIX absolute path corresponding to `localBase`. */
  readonly remoteBase: string;
  /**
   * Resolve a user-supplied tool path to a remote POSIX absolute path, or
   * null when it is not a path of this workspace's project (host-local,
   * outside the project, or ambiguous).
   */
  toRemotePath(userPath: string): string | null;
  /** Host-absolute virtual path under the workspace localRoot for a remote path. */
  virtualHostPath(remotePath: string): string;
  /** Reverse of `virtualHostPath`. Throws when the host path leaves the workspace. */
  fromVirtualHostPath(hostPath: string): string;
  /** Reverse mapping against the full `localRoot` (legacy shadow paths). Null when outside. */
  fromWorkspaceHostPath(hostPath: string): string | null;
}

function hostInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function createRemoteAgentPathMapping(
  workspace: RemoteWorkspace,
  sessionCwd: string,
): RemoteAgentPathMapping {
  const localRoot = path.resolve(workspace.localRoot);
  const sessionResolved = path.resolve(sessionCwd);
  const localBase = hostInside(localRoot, sessionResolved) ? sessionResolved : localRoot;
  const remoteBase = localBase === localRoot ? workspace.cwd : remotePathFor(workspace, localBase);

  const workspaceHostToRemote = (hostPath: string): string | null => {
    const resolved = path.resolve(hostPath);
    if (!hostInside(localRoot, resolved)) return null;
    const rel = path.relative(localRoot, resolved);
    const posixRel = rel.split(path.sep).join("/");
    return posixRel === "" ? workspace.cwd : path.posix.join(workspace.cwd, posixRel);
  };

  return {
    localBase,
    remoteBase,

    toRemotePath(userPath: string): string | null {
      const raw = (userPath ?? "").trim();
      if (!raw) return null;
      const input = raw.startsWith("@") ? raw.slice(1) : raw;

      // 1) Windows-style host paths (backslashes, drive prefix, UNC): only
      //    legacy shadow/cache paths under this workspace's localRoot map
      //    back to the remote file; anything else is rejected.
      if (input.includes("\\") || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")) {
        return workspaceHostToRemote(input);
      }

      // 2) POSIX absolute paths: first the remote project tree, then — on
      //    POSIX hosts only, where "/..." is also a valid host absolute path
      //    — legacy shadow paths under the workspace localRoot.
      if (input.startsWith("/")) {
        const normalized = path.posix.normalize(input);
        const prefix = workspace.cwd === "/" ? "/" : `${workspace.cwd}/`;
        if (normalized === workspace.cwd || normalized.startsWith(prefix)) return normalized;
        if (process.platform !== "win32") {
          return workspaceHostToRemote(input);
        }
        return null;
      }

      // 3) Relative paths resolve against the remote project root.
      if (input === ".") return remoteBase;
      const joined = path.posix.normalize(path.posix.join(remoteBase, input));
      const prefix = workspace.cwd === "/" ? "/" : `${workspace.cwd}/`;
      return joined === workspace.cwd || joined.startsWith(prefix) ? joined : null;
    },

    virtualHostPath(remotePath: string): string {
      const rel = path.posix.relative(workspace.cwd, remotePath);
      if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) {
        throw new Error(`Path does not belong to this remote workspace: ${remotePath}`);
      }
      return path.join(localRoot, ...rel.split("/"));
    },

    fromVirtualHostPath(hostPath: string): string {
      const resolved = path.resolve(hostPath);
      if (!hostInside(localRoot, resolved)) {
        throw new Error(`Path does not belong to this remote workspace: ${hostPath}`);
      }
      return remotePathFor(workspace, resolved);
    },

    fromWorkspaceHostPath(hostPath: string): string | null {
      return workspaceHostToRemote(hostPath);
    },
  };
}

// ============================================================================
// Remote command builders (all arguments are quoteShellArg-quoted)
// ============================================================================

export function remoteCatCommand(remotePath: string): string {
  return `cat -- ${quoteShellArg(remotePath)}`;
}

export function remoteTestCommand(remotePath: string, test: "-e" | "-r" | "-w" | "-d"): string {
  return `[ ${test} ${quoteShellArg(remotePath)} ]`;
}

/**
 * Single-call directory listing: `type<TAB>name` per entry (dotfiles
 * included). Wrapped in an explicit `bash -c` because `shopt` is a bashism;
 * the remote login shell must not be assumed.
 */
export function buildRemoteLsCommand(remoteDir: string): string {
  const q = quoteShellArg(remoteDir);
  const script = [
    `cd ${q} 2>/dev/null || { [ -e ${q} ] && printf 'NOTDIR\\n' || printf 'MISSING\\n'; exit 1; }`,
    "shopt -s nullglob dotglob",
    "for entry in *; do",
    '  if [ -d "$entry" ]; then printf \'d\\t%s\\n\' "$entry"; else printf \'f\\t%s\\n\' "$entry"; fi',
    "done",
  ].join("\n");
  return `bash -c ${quoteShellArg(script)}`;
}

export interface RemoteGrepCommandOptions {
  baseDir: string;
  target: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
}

/**
 * Single-call remote ripgrep. Exit code 71 with the PIWEB_REMOTE_NO_RG
 * marker means rg is not installed on the remote host.
 */
export function buildRemoteGrepCommand(options: RemoteGrepCommandOptions): string {
  const { baseDir, target, pattern } = options;
  const flags: string[] = [];
  if (options.ignoreCase) flags.push("--ignore-case");
  if (options.literal) flags.push("--fixed-strings");
  if (options.glob) flags.push("--glob", quoteShellArg(options.glob));
  const relTarget = target === baseDir ? "." : path.posix.relative(baseDir, target);
  const rg = `rg --json --line-number --color=never --hidden ${flags.join(" ")} -- ${quoteShellArg(pattern)} ${quoteShellArg(relTarget)}`;
  return [
    `cd ${quoteShellArg(baseDir)} || exit 1`,
    "command -v rg >/dev/null 2>&1 || { printf 'PIWEB_REMOTE_NO_RG\\n' >&2; exit 71; }",
    rg,
  ].join("\n");
}

/**
 * Single-call remote file search: `fd` when available (gitignore-aware,
 * mirroring the SDK flags), otherwise `find -name` for basename patterns.
 * Path patterns (containing `/`) require fd: exit code 2 with the
 * PIWEB_REMOTE_FIND_NEEDS_FD marker.
 */
export function buildRemoteFindCommand(remoteDir: string, pattern: string, limit: number): string {
  const q = quoteShellArg(remoteDir);
  const hasSlash = pattern.includes("/");
  let fdPattern = pattern;
  if (hasSlash && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
    fdPattern = `**/${pattern}`;
  }
  const findPattern = pattern.replace(/\*\*/g, "*");
  const fdCore = `fd --glob --color=never --hidden --max-results ${limit}${hasSlash ? " --full-path" : ""} -- ${quoteShellArg(fdPattern)} .`;
  return [
    `cd ${q} || exit 1`,
    "if command -v fd >/dev/null 2>&1; then",
    "  if [ -d .git ]; then",
    `    ${fdCore}`,
    "  else",
    `    ${fdCore.replace("fd ", "fd --no-require-git ")}`,
    "  fi",
    "else",
    hasSlash
      ? "  printf 'PIWEB_REMOTE_FIND_NEEDS_FD\\n' >&2; exit 2"
      : `  find . -type f -name ${quoteShellArg(findPattern)} | head -n ${limit}`,
    "fi",
  ].join("\n");
}

/** Batch-fetch remote files (grep context lines) with unique marker lines. */
export function buildRemoteFilesCommand(baseDir: string, files: string[], marker: string): string {
  const quoted = files.map((file) => quoteShellArg(file));
  return [
    `cd ${quoteShellArg(baseDir)} || exit 1`,
    `for f in ${quoted.join(" ")}; do`,
    '  printf \'%s:%s\\n\' "' + marker + '" "$f"',
    '  cat -- "$f" 2>/dev/null || true',
    "done",
  ].join("\n");
}

/** Image MIME sniffing from leading bytes (no remote `file` dependency). */
export function sniffImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && (
    (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[4] === 0x37) ||
    (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[4] === 0x39)
  )) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return null;
}
