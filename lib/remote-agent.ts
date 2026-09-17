/**
 * lib/remote-agent.ts
 *
 * Built-in local-agent + remote-project tool adaptation for pi-web.
 *
 * For every remote (SSH) workspace this module provides one inline extension
 * that overrides the built-in project tools so they execute on the remote
 * host, bound to the immutable `RemoteWorkspace` identity — never to the
 * global `~/.pi/agent/ssh-config.json`:
 *
 *  - read / write / edit: SDK tool definitions with remote operations. User
 *    paths are first resolved POSIX-style against the remote project root,
 *    mapped to a virtual absolute path inside the fixed `localRoot`, and the
 *    SDK's host-side resolution becomes a no-op. The operations reverse-map
 *    virtual paths back to remote POSIX paths (escaping is rejected).
 *  - bash: SDK bash tool with remote SSH operations (key-based SSH only,
 *    safe `cd`, abort/timeout, bounded streaming output via the SDK).
 *    `user_bash` (! / !!) uses the same operations.
 *  - grep: full remote ripgrep execution (the SDK operations would spawn a
 *    local `rg`). Missing remote rg is reported, never installed.
 *  - find: SDK find with remote glob operations (remote fd, find fallback).
 *  - ls: single remote listing command.
 *  - powershell: explicitly rejected for POSIX remotes; never runs locally.
 *
 * `read` additionally accepts exact local resource paths on the host (skills,
 * context files) for read-only use; results are marked as local
 * host files. `write`/`edit` never touch the host. Unknown local/Windows
 * paths are rejected with an explicit error.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
  type BashToolInput,
  type BuildSystemPromptOptions,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  type Extension,
  type ExtensionContext,
  type FindOperations,
  type FindToolDetails,
  type FindToolInput,
  type GrepToolDetails,
  type GrepToolInput,
  type InlineExtension,
  type LoadExtensionsResult,
  type LsToolDetails,
  type LsToolInput,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type WriteOperations,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { quoteShellArg, type RemoteWorkspace } from "./remote-workspace";
import {
  buildRemoteFilesCommand,
  buildRemoteFindCommand,
  buildRemoteGrepCommand,
  buildRemoteLsCommand,
  createRemoteAgentPathMapping,
  createRemoteAgentTransport,
  remoteCatCommand,
  remoteTestCommand,
  sniffImageMimeType,
  REMOTE_STREAM_DEFAULT_TIMEOUT_SECONDS,
  type RemoteAgentCommandResult,
  type RemoteAgentPathMapping,
  type RemoteAgentTransport,
} from "./remote-agent-transport";

export {
  createRemoteAgentPathMapping,
  createRemoteAgentTransport,
  buildRemoteFindCommand,
  buildRemoteGrepCommand,
  buildRemoteLsCommand,
  buildRemoteFilesCommand,
  remoteCatCommand,
  remoteTestCommand,
  sniffImageMimeType,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_STREAM_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_MAX_OUTPUT_BYTES,
  type RemoteAgentCommandResult,
  type RemoteAgentExecOptions,
  type RemoteAgentPathMapping,
  type RemoteAgentSpawn,
  type RemoteAgentStreamOptions,
  type RemoteAgentTransport,
} from "./remote-agent-transport";

export const REMOTE_AGENT_EXTENSION_NAME = "pi-web-remote-agent";
export const REMOTE_AGENT_EXTENSION_PATH = `<inline:${REMOTE_AGENT_EXTENSION_NAME}>`;

/** Built-in project tools whose remote implementation must own the name. */
const PROJECT_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"] as const;
const PROJECT_TOOL_CONFLICT = new RegExp(`^Tool "(?:${PROJECT_TOOL_NAMES.join("|")})" conflicts with `);

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_LS_LIMIT = 500;
const GREP_MAX_LINE_LENGTH = 500;

// ============================================================================
// System prompt
// ============================================================================

/**
 * Structured execution-identity section appended to the system prompt (and
 * usable verbatim for subagent `prompt_mode: "replace"` prompts). The
 * effective remote directory is `mapping.remoteBase` (the session cwd may be
 * a subdirectory of the workspace root).
 */
export function remoteEnvironmentPrompt(workspace: RemoteWorkspace, sessionCwd: string): string {
  const remoteBase = createRemoteAgentPathMapping(workspace, sessionCwd).remoteBase;
  return [
    "# Execution environment (pi-web remote workspace)",
    `- Agent host: local (the pi-web server host, platform ${process.platform}) — the agent process, its extensions, skills, MCP servers, and browser tools run here.`,
    `- Project workspace: remote over SSH — host: ${workspace.host}, workspace root: ${workspace.cwd}.`,
    `- Current remote working directory: ${remoteBase}.`,
    "- Project tools execute on the remote host:",
    `  - read, write, edit, bash, grep, find, and ls all operate on ${workspace.host} under the workspace root ${workspace.cwd}.`,
    `  - Relative paths resolve against ${remoteBase}.`,
    `  - Absolute remote paths must stay under the workspace root ${workspace.cwd}; remote paths are POSIX (forward slashes).`,
    `- The host path ${sessionCwd.replace(/\\/g, "/")} is only the local cache anchor for this workspace; it is NOT the project location.`,
    "- Local Windows paths (for example C:\\...) are host paths, not project paths; project tools reject them.",
    "- read may open exact local resource files on the host (registered skills and context files) read-only; such results are marked as local host files and are not part of the remote project. write and edit never touch the host.",
    `- Other extensions, MCP tools, browser tools, and background tasks are NOT automatically remote; give them an explicit target on ${workspace.host} when they must act there.`,
    "- bash runs on the remote host via SSH (bash, non-login, non-interactive). Cancelling or timing out kills the SSH session; the full remote process tree may not always be terminated.",
  ].join("\n");
}

// ============================================================================
// Legacy SSH extension filtering
// ============================================================================

/**
 * Trusted signatures of the bundled legacy `ssh` package
 * (vendor/ssh/extensions/ssh.ts). Deliberately narrow: plugins that merely
 * mention ssh in their name are NOT filtered.
 */
export function isLegacySshExtension(extension: Extension): boolean {
  for (const candidate of [extension.path, extension.resolvedPath]) {
    if (!candidate) continue;
    if (/^.*\/ssh\/extensions\/ssh\.ts$/.test(candidate.replaceAll("\\", "/"))) return true;
  }
  // The legacy vendor extension registers the --ssh flag, a user_bash hook,
  // and read/write/bash tools — all at once.
  return (
    extension.flags?.has("ssh") === true &&
    extension.handlers?.has("user_bash") === true &&
    extension.tools?.has("read") === true &&
    extension.tools?.has("write") === true &&
    extension.tools?.has("bash") === true
  );
}

/**
 * Remove the legacy global SSH extension (its tools, user_bash and
 * before_agent_start hooks would otherwise hijack sessions). Used for remote
 * sessions (built-in remote tools take over) and local sessions (hijack
 * prevention). Other extensions are left untouched.
 */
export function filterLegacySshExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const legacyPaths = new Set(
    base.extensions.filter(isLegacySshExtension).map((extension) => extension.path),
  );
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => !legacyPaths.has(error.path)),
  };
}

/**
 * `extensionsOverride` for resource loaders:
 * - always filters the legacy SSH extension;
 * - when `remote`, moves the built-in remote-agent extension to the front so
 *   its project tools (read/write/edit/bash/grep/find/ls/powershell) win the
 *   first-registration-wins resolution, while unrelated tools and hooks from
 *   other extensions are preserved.
 */
export function preferRemoteWorkspaceExtension(
  base: LoadExtensionsResult,
  remote: boolean,
): LoadExtensionsResult {
  const filtered = filterLegacySshExtension(base);
  if (!remote) return filtered;
  const hostIndex = filtered.extensions.findIndex((extension) => extension.path === REMOTE_AGENT_EXTENSION_PATH);
  if (hostIndex <= 0) return filtered;
  const reordered = [
    filtered.extensions[hostIndex],
    ...filtered.extensions.filter((_, index) => index !== hostIndex),
  ];
  const errors = filtered.errors.filter(
    (error) => !(error.path === REMOTE_AGENT_EXTENSION_PATH && PROJECT_TOOL_CONFLICT.test(error.error)),
  );
  return { ...filtered, extensions: reordered, errors };
}

// ============================================================================
// Remote operations
// ============================================================================

function hostLabel(workspace: RemoteWorkspace): string {
  return `${workspace.host}:${workspace.cwd}`;
}

/** SDK file-operation callbacks lack a signal parameter; bind it per execution,
 * never in shared mutable state (parallel tool calls can cancel independently). */
function transportForCall(transport: RemoteAgentTransport, signal?: AbortSignal): RemoteAgentTransport {
  return {
    exec: (command, options) => transport.exec(command, { ...options, signal }),
    stream: (command, options) => transport.stream(command, { ...options, signal }),
  };
}

function createRemoteReadOperations(
  workspace: RemoteWorkspace,
  mapping: RemoteAgentPathMapping,
  transport: RemoteAgentTransport,
): ReadOperations {
  return {
    readFile: async (hostPath) => {
      const remote = mapping.fromVirtualHostPath(hostPath);
      const result = await transport.exec(remoteCatCommand(remote));
      if (result.exitCode !== 0) {
        throw new Error(`Could not read file: ${remote}. ${result.stderr.trim() || `cat exited with code ${result.exitCode}`}`);
      }
      return result.stdout;
    },
    access: async (hostPath) => {
      const remote = mapping.fromVirtualHostPath(hostPath);
      const result = await transport.exec(remoteTestCommand(remote, "-r"));
      if (result.exitCode !== 0) {
        throw new Error(`Cannot read file: ${remote} (not found or not readable on ${workspace.host})`);
      }
    },
    detectImageMimeType: async (hostPath) => {
      const remote = mapping.fromVirtualHostPath(hostPath);
      try {
        const result = await transport.exec(`head -c 256 -- ${quoteShellArg(remote)}`);
        if (result.exitCode !== 0) return null;
        return sniffImageMimeType(result.stdout);
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOperations(
  workspace: RemoteWorkspace,
  mapping: RemoteAgentPathMapping,
  transport: RemoteAgentTransport,
): WriteOperations {
  return {
    mkdir: async (hostDir) => {
      const remote = mapping.fromVirtualHostPath(hostDir);
      const result = await transport.exec(`mkdir -p ${quoteShellArg(remote)}`);
      if (result.exitCode !== 0) {
        throw new Error(`Could not create directory: ${remote}. ${result.stderr.trim() || `mkdir exited with code ${result.exitCode}`}`);
      }
    },
    // Large payloads go through SSH stdin, never argv. Bounded by an
    // explicit timeout so a stalled SSH session can never hang the tool.
    writeFile: async (hostPath, content) => {
      const remote = mapping.fromVirtualHostPath(hostPath);
      const code = await transport.stream(`cat > ${quoteShellArg(remote)}`, {
        onData: () => {},
        stdin: content,
        timeout: REMOTE_STREAM_DEFAULT_TIMEOUT_SECONDS,
      });
      if (code !== 0) {
        throw new Error(`Could not write file: ${remote} on ${workspace.host} (exit ${code})`);
      }
    },
  };
}

function createRemoteEditOperations(
  workspace: RemoteWorkspace,
  mapping: RemoteAgentPathMapping,
  transport: RemoteAgentTransport,
): EditOperations {
  const read = createRemoteReadOperations(workspace, mapping, transport);
  const write = createRemoteWriteOperations(workspace, mapping, transport);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (hostPath) => {
      const remote = mapping.fromVirtualHostPath(hostPath);
      const result = await transport.exec(
        `[ -r ${quoteShellArg(remote)} ] && [ -w ${quoteShellArg(remote)} ]`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Cannot edit file: ${remote} (not found or not read/writable on ${workspace.host})`);
      }
    },
  };
}

function mapHostCwdToRemote(cwd: string, mapping: RemoteAgentPathMapping): string {
  try {
    return mapping.fromVirtualHostPath(cwd);
  } catch {
    /* outside the session base; fall through */
  }
  return mapping.fromWorkspaceHostPath(cwd) ?? mapping.remoteBase;
}

export interface RemoteBashOperationsOptions {
  /** Injectable transport (tests). Defaults to spawning `ssh`. */
  transport?: RemoteAgentTransport;
}

/**
 * Remote `BashOperations` for the bash tool and for the user `!` command
 * (rpc-manager calls the SDK `executeBash` directly, bypassing `user_bash`).
 * The command runs through an explicit `bash -c` on the remote (the login
 * shell is not assumed), with a safe `cd ... || exit` so that multi-statement
 * commands can never continue in the home directory. Abort and timeout kill
 * the local SSH process (the full remote process tree is not guaranteed to
 * be terminated).
 */
export function createRemoteBashOperations(
  workspace: RemoteWorkspace,
  sessionCwd: string,
  options: RemoteBashOperationsOptions = {},
): BashOperations {
  const mapping = createRemoteAgentPathMapping(workspace, sessionCwd);
  const transport = options.transport ?? createRemoteAgentTransport(workspace.host);
  return {
    async exec(command, cwd, streamOptions) {
      const remoteCwd = mapHostCwdToRemote(cwd, mapping);
      const script = `cd ${quoteShellArg(remoteCwd)} || exit\n${command}`;
      const remoteCommand = `bash -c ${quoteShellArg(script)}`;
      const exitCode = await transport.stream(remoteCommand, streamOptions);
      return { exitCode };
    },
  };
}

function createRemoteFindOperations(
  workspace: RemoteWorkspace,
  mapping: RemoteAgentPathMapping,
  transport: RemoteAgentTransport,
): FindOperations {
  return {
    exists: async (hostPath) => {
      let remote: string;
      try {
        remote = mapping.fromVirtualHostPath(hostPath);
      } catch {
        return false;
      }
      try {
        const result = await transport.exec(remoteTestCommand(remote, "-e"));
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    glob: async (pattern, searchPath, { limit }) => {
      let remoteDir: string;
      try {
        remoteDir = mapping.fromVirtualHostPath(searchPath);
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }
      const result = await transport.exec(buildRemoteFindCommand(remoteDir, pattern, limit));
      if (result.stderr.includes("PIWEB_REMOTE_FIND_NEEDS_FD")) {
        throw new Error(
          `fd is not installed on the remote host ${workspace.host}; path patterns (containing "/") require fd. ` +
          "Install fd on the remote machine (nothing is installed automatically).",
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `remote find exited with code ${result.exitCode}`);
      }
      return result.stdout
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim().replace(/^\.\//, ""))
        .filter(Boolean);
    },
  };
}

// ============================================================================
// Local resource reads (read-only, exact allowed paths)
// ============================================================================

/**
 * Collect the host-local roots the read tool may open. Restricted to the
 * resources registered for this turn (skill directories, context files) plus
 * explicitly configured roots. The agent dir is deliberately NOT included:
 * it holds credentials and arbitrary configuration. Roots are verified with
 * `realpathSync` so dangling or escaping symlinks are dropped at collection
 * time. Context file paths that do not exist on the host (e.g. remote POSIX
 * paths) are skipped — remote context is injected as plain text, never read
 * through the local read path.
 */
function collectLocalReadRoots(
  options: BuildSystemPromptOptions | undefined,
  baseRoots: string[],
): Set<string> {
  const roots = new Set<string>();
  const addVerified = (candidate: string) => {
    try {
      roots.add(realpathSync(path.resolve(candidate)));
    } catch {
      /* missing or dangling — not a usable local root */
    }
  };
  for (const skill of options?.skills ?? []) {
    addVerified(skill.baseDir || path.dirname(skill.filePath));
  }
  for (const file of options?.contextFiles ?? []) {
    const raw = file.path;
    // A remote POSIX path must never be treated as a host path: if it does
    // not exist on the host, it is remote context, not a local resource.
    if (raw.startsWith("/") && !raw.includes("\\") && !existsSync(path.resolve(raw))) continue;
    addVerified(raw);
  }
  for (const extra of baseRoots) addVerified(extra);
  return roots;
}

/**
 * Resolve a user path to an allowed host-local resource file. Roots and the
 * candidate are both canonicalized with `realpathSync`, so a symlinked skill
 * resource cannot escape its registered directory. Returns null for
 * everything else — in particular unknown Windows paths.
 */
function resolveAllowedLocalReadPath(
  userPath: string,
  localReadRoots: Set<string>,
): string | null {
  const raw = (userPath ?? "").trim();
  if (!raw) return null;
  const input = raw.startsWith("@") ? raw.slice(1) : raw;
  let realCandidate: string;
  try {
    realCandidate = realpathSync(path.resolve(input));
  } catch {
    return null; // not a readable host file
  }
  for (const root of localReadRoots) {
    const rel = path.relative(root, realCandidate);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      return realCandidate;
    }
  }
  return null;
}

// ============================================================================
// Result helpers
// ============================================================================

/** Swap the virtual host path back to the remote path in LLM-facing text. */
function replacePathInResult<TDetails>(
  result: AgentToolResult<TDetails>,
  from: string,
  to: string,
): AgentToolResult<TDetails> {
  const replace = (text: string) => text.split(from).join(to);
  const content = result.content.map((item) =>
    item.type === "text" ? { ...item, text: replace(item.text) } : item,
  );
  let details = result.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const current = details as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };
    let changed = false;
    for (const key of Object.keys(next)) {
      if (typeof next[key] === "string" && (next[key] as string).includes(from)) {
        next[key] = replace(next[key] as string);
        changed = true;
      }
    }
    if (changed) details = next as TDetails;
  }
  return { ...result, content, details };
}

/** Mark a host-local read so the model never mistakes it for a project file. */
function markLocalHostRead<TDetails>(
  result: AgentToolResult<TDetails>,
  localPath: string,
  workspace: RemoteWorkspace,
): AgentToolResult<TDetails> {
  const notice = `[local host file: ${localPath} — read from the pi-web host, NOT from the remote project ${hostLabel(workspace)}]`;
  const content = result.content.map((item, index) =>
    index === 0 && item.type === "text" ? { ...item, text: `${notice}\n\n${item.text}` } : item,
  );
  if (content.length === 0 || content[0].type !== "text") {
    content.unshift({ type: "text", text: notice });
  }
  return { ...result, content };
}

function formatRemotePathError(
  tool: string,
  userPath: string,
  workspace: RemoteWorkspace,
): string {
  const looksLikeWindows = userPath.includes("\\") || /^[A-Za-z]:[\\/]/.test(userPath);
  const parts = [
    `${tool}: '${userPath}' is not a remote project path.`,
    `The project lives on ${workspace.host} at ${workspace.cwd} (POSIX paths).`,
    `Use relative paths (resolved against ${workspace.cwd}) or absolute paths under ${workspace.cwd}.`,
  ];
  if (looksLikeWindows) {
    parts.push("Local Windows host paths are not project paths and cannot be used by project tools.");
  }
  return parts.join(" ");
}

// ============================================================================
// Extension
// ============================================================================

export interface RemoteAgentExtensionOptions {
  /** Injectable transport (tests). Defaults to spawning `ssh`. */
  transport?: RemoteAgentTransport;
  /** Additional host directories that the read tool may open read-only. */
  localReadRoots?: string[];
}

export function createRemoteAgentExtension(
  workspace: RemoteWorkspace,
  sessionCwd: string,
  options: RemoteAgentExtensionOptions = {},
): InlineExtension {
  const transport = options.transport ?? createRemoteAgentTransport(workspace.host);
  const mapping = createRemoteAgentPathMapping(workspace, sessionCwd);
  const baseLocalReadRoots: string[] = options.localReadRoots ?? [];
  const state: { localReadRoots: Set<string> } = {
    localReadRoots: collectLocalReadRoots(undefined, baseLocalReadRoots),
  };

  const readOps = createRemoteReadOperations(workspace, mapping, transport);
  const writeOps = createRemoteWriteOperations(workspace, mapping, transport);
  const editOps = createRemoteEditOperations(workspace, mapping, transport);
  const bashOps = createRemoteBashOperations(workspace, sessionCwd, { transport });
  const findOps = createRemoteFindOperations(workspace, mapping, transport);

  const remoteReadDef = createReadToolDefinition(mapping.localBase, { operations: readOps });
  const remoteWriteDef = createWriteToolDefinition(mapping.localBase, { operations: writeOps });
  const remoteEditDef = createEditToolDefinition(mapping.localBase, { operations: editOps });
  const remoteBashDef = createBashToolDefinition(mapping.localBase, {
    operations: bashOps,
    exposeSessionEnvironment: false,
  });
  const remoteFindDef = createFindToolDefinition(mapping.localBase, { operations: findOps });
  const remoteGrepDef = createGrepToolDefinition(mapping.localBase);
  const remoteLsDef = createLsToolDefinition(mapping.localBase);
  // Plain local read tool (default filesystem ops) for exact resource paths.
  const localReadDef = createReadToolDefinition(mapping.localBase);

  const readExecute = async (
    toolCallId: string,
    params: ReadToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
    ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<ReadToolDetails | undefined>> => {
    const remotePath = mapping.toRemotePath(params.path);
    if (remotePath !== null) {
      const virtual = mapping.virtualHostPath(remotePath);
      const definition = createReadToolDefinition(mapping.localBase, {
        operations: createRemoteReadOperations(workspace, mapping, transportForCall(transport, signal)),
      });
      const result = await definition.execute(
        toolCallId,
        { ...params, path: virtual },
        signal,
        onUpdate,
        ctx as ExtensionContext,
      );
      return replacePathInResult(result, virtual, remotePath);
    }
    const localPath = resolveAllowedLocalReadPath(params.path, state.localReadRoots);
    if (localPath !== null) {
      const result = await localReadDef.execute(
        toolCallId,
        { ...params, path: localPath },
        signal,
        onUpdate,
        ctx as ExtensionContext,
      );
      return markLocalHostRead(result, localPath, workspace);
    }
    throw new Error(formatRemotePathError("read", params.path, workspace));
  };

  const writeExecute = async (
    toolCallId: string,
    params: WriteToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<undefined> | undefined,
    ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<undefined>> => {
    const remotePath = mapping.toRemotePath(params.path);
    if (remotePath === null) {
      throw new Error(formatRemotePathError("write", params.path, workspace));
    }
    const virtual = mapping.virtualHostPath(remotePath);
    const definition = createWriteToolDefinition(mapping.localBase, {
      operations: createRemoteWriteOperations(workspace, mapping, transportForCall(transport, signal)),
    });
    const result = await definition.execute(
      toolCallId,
      { ...params, path: virtual },
      signal,
      onUpdate,
      ctx as ExtensionContext,
    );
    return replacePathInResult(result, virtual, remotePath);
  };

  const editExecute = async (
    toolCallId: string,
    params: EditToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<EditToolDetails | undefined> | undefined,
    ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<EditToolDetails | undefined>> => {
    const remotePath = mapping.toRemotePath(params.path);
    if (remotePath === null) {
      throw new Error(formatRemotePathError("edit", params.path, workspace));
    }
    const virtual = mapping.virtualHostPath(remotePath);
    const definition = createEditToolDefinition(mapping.localBase, {
      operations: createRemoteEditOperations(workspace, mapping, transportForCall(transport, signal)),
    });
    const result = await definition.execute(
      toolCallId,
      { ...params, path: virtual },
      signal,
      onUpdate,
      ctx as ExtensionContext,
    );
    return replacePathInResult(result, virtual, remotePath);
  };

  const findExecute = async (
    toolCallId: string,
    params: FindToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<FindToolDetails | undefined> | undefined,
    ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<FindToolDetails | undefined>> => {
    const definition = createFindToolDefinition(mapping.localBase, {
      operations: createRemoteFindOperations(workspace, mapping, transportForCall(transport, signal)),
    });
    if (params.path) {
      const remotePath = mapping.toRemotePath(params.path);
      if (remotePath === null) {
        // find is a project tool: invalid paths must be rejected explicitly,
        // never silently re-resolved against the host cwd.
        throw new Error(formatRemotePathError("find", params.path, workspace));
      }
      const virtual = mapping.virtualHostPath(remotePath);
      try {
        return await definition.execute(
          toolCallId,
          { ...params, path: virtual },
          signal,
          onUpdate,
          ctx as ExtensionContext,
        );
      } catch (error) {
        // Keep error messages model-facing: show the remote path, not the
        // internal virtual host path.
        if (error instanceof Error && error.message.includes(virtual)) {
          throw new Error(error.message.split(virtual).join(remotePath));
        }
        throw error;
      }
    }
    return definition.execute(toolCallId, params, signal, onUpdate, ctx as ExtensionContext);
  };

  const grepExecute = async (
    toolCallId: string,
    params: GrepToolInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<GrepToolDetails | undefined> | undefined,
    _ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<GrepToolDetails | undefined>> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params;
    const target = mapping.toRemotePath(searchDir ?? ".");
    if (target === null) {
      throw new Error(formatRemotePathError("grep", searchDir ?? ".", workspace));
    }
    const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
    const contextValue = context && context > 0 ? context : 0;
    const relTarget = target === mapping.remoteBase ? "." : path.posix.relative(mapping.remoteBase, target);
    const command = buildRemoteGrepCommand({
      baseDir: mapping.remoteBase,
      target,
      pattern,
      ...(glob !== undefined ? { glob } : {}),
      ...(ignoreCase ? { ignoreCase: true } : {}),
      ...(literal ? { literal: true } : {}),
    });
    let result: RemoteAgentCommandResult;
    try {
      result = await transport.exec(command, { signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === "aborted")) {
        throw new Error("Operation aborted");
      }
      throw error;
    }
    if (signal?.aborted) throw new Error("Operation aborted");
    if (result.exitCode === 71 || result.stderr.includes("PIWEB_REMOTE_NO_RG")) {
      throw new Error(
        `ripgrep (rg) is not installed on the remote host ${workspace.host}. ` +
        "Install rg on the remote machine (nothing is installed automatically).",
      );
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
    }

    interface RgMatch {
      filePath: string;
      lineNumber: number;
      lineText?: string;
    }
    const matches: RgMatch[] = [];
    let matchCount = 0;
    let matchLimitReached = false;
    for (const line of result.stdout.toString("utf8").split("\n")) {
      if (!line.trim() || matchCount >= effectiveLimit) continue;
      let event: {
        type?: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      matchCount++;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (filePath && typeof lineNumber === "number") {
        matches.push({ filePath, lineNumber, lineText });
      }
      if (matchCount >= effectiveLimit) {
        matchLimitReached = true;
        break;
      }
    }
    if (matches.length === 0) {
      return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    }

    const isDirectory = matches.some((match) => match.filePath !== relTarget);
    const formatPath = (filePath: string): string => {
      if (!isDirectory) return path.posix.basename(filePath);
      if (relTarget === ".") return filePath.replace(/^\.\//, "");
      const rel = path.posix.relative(relTarget, filePath);
      return rel && !rel.startsWith("..") ? rel : path.posix.basename(filePath);
    };

    // Context lines: fetch the matched files in a single remote call.
    let linesTruncated = false;
    let fileLines: Map<string, string[]> | null = null;
    if (contextValue > 0 && matches.length > 0) {
      const uniqueFiles = [...new Set(matches.map((match) => match.filePath))];
      const marker = `PIWEB_GREP_FILE_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const filesResult = await transport.exec(
        buildRemoteFilesCommand(mapping.remoteBase, uniqueFiles, marker),
        { signal },
      );
      fileLines = new Map<string, string[]>();
      let current: string | null = null;
      const markerPattern = new RegExp(`^${marker}:(.*)$`);
      for (const line of filesResult.stdout.toString("utf8").split("\n")) {
        const markerMatch = line.match(markerPattern);
        if (markerMatch) {
          current = markerMatch[1];
          fileLines.set(current, []);
        } else if (current !== null) {
          fileLines.get(current)?.push(line.replace(/\r$/, ""));
        }
      }
    }
    const formatBlock = (filePath: string, lineNumber: number): string[] => {
      const relativePath = formatPath(filePath);
      const lines = fileLines?.get(filePath) ?? [];
      if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
      const block: string[] = [];
      const start = Math.max(1, lineNumber - contextValue);
      const end = Math.min(lines.length, lineNumber + contextValue);
      for (let current = start; current <= end; current++) {
        const lineText = lines[current - 1] ?? "";
        const { text: truncatedText, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
        if (wasTruncated) linesTruncated = true;
        block.push(
          current === lineNumber
            ? `${relativePath}:${current}: ${truncatedText}`
            : `${relativePath}-${current}- ${truncatedText}`,
        );
      }
      return block;
    };

    const outputLines: string[] = [];
    for (const match of matches) {
      if (contextValue === 0 && match.lineText !== undefined) {
        const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
        const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
        if (wasTruncated) linesTruncated = true;
        outputLines.push(`${formatPath(match.filePath)}:${match.lineNumber}: ${truncatedText}`);
      } else {
        outputLines.push(...formatBlock(match.filePath, match.lineNumber));
      }
    }
    const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const details: GrepToolDetails = {};
    const notices: string[] = [];
    if (matchLimitReached) {
      notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
      details.matchLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (linesTruncated) {
      notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
      details.linesTruncated = true;
    }
    if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
    return {
      content: [{ type: "text", text: output }],
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  };

  const lsExecute = async (
    toolCallId: string,
    params: LsToolInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<LsToolDetails | undefined> | undefined,
    _ctx: ExtensionContext | undefined,
  ): Promise<AgentToolResult<LsToolDetails | undefined>> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const target = mapping.toRemotePath(params.path ?? ".");
    if (target === null) {
      throw new Error(formatRemotePathError("ls", params.path ?? ".", workspace));
    }
    const effectiveLimit = params.limit ?? DEFAULT_LS_LIMIT;
    let result: RemoteAgentCommandResult;
    try {
      result = await transport.exec(buildRemoteLsCommand(target), { signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === "aborted")) {
        throw new Error("Operation aborted");
      }
      throw error;
    }
    if (signal?.aborted) throw new Error("Operation aborted");
    const lines = result.stdout.toString("utf8").split("\n");
    const first = lines[0] ?? "";
    if (first === "MISSING") throw new Error(`Path not found: ${target}`);
    if (first === "NOTDIR") throw new Error(`Not a directory: ${target}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `ls exited with code ${result.exitCode}`);
    }
    const entries: string[] = [];
    const entryIsDir = new Map<string, boolean>();
    for (const line of lines) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const name = line.slice(tab + 1);
      if (!name) continue;
      entries.push(name);
      entryIsDir.set(name, line.slice(0, tab) === "d");
    }
    entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const results: string[] = [];
    let entryLimitReached = false;
    for (const entry of entries) {
      if (results.length >= effectiveLimit) {
        entryLimitReached = true;
        break;
      }
      results.push(entry + (entryIsDir.get(entry) ? "/" : ""));
    }
    if (results.length === 0) {
      return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
    }
    const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const details: LsToolDetails = {};
    const notices: string[] = [];
    if (entryLimitReached) {
      notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
      details.entryLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
    return {
      content: [{ type: "text", text: output }],
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  };

  const powershellRejected = () =>
    new Error(
      `The powershell tool is not available for this remote SSH workspace: the project runs on a POSIX remote host (${hostLabel(workspace)}). ` +
      "Use the bash tool for shell commands. Nothing was executed on the local host.",
    );

  return {
    name: REMOTE_AGENT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool({ ...remoteReadDef, execute: readExecute });
      pi.registerTool({ ...remoteWriteDef, execute: writeExecute });
      pi.registerTool({ ...remoteEditDef, execute: editExecute });
      pi.registerTool(remoteBashDef);
      pi.registerTool({ ...remoteFindDef, execute: findExecute });
      pi.registerTool({ ...remoteGrepDef, execute: grepExecute });
      pi.registerTool({ ...remoteLsDef, execute: lsExecute });
      pi.registerTool({
        name: "powershell",
        label: "PowerShell",
        description:
          `Execute a PowerShell command in the current working directory. ` +
          `This session targets a POSIX remote host (${workspace.host}); PowerShell is not available there and every call is rejected — use bash instead.`,
        promptSnippet: "Execute PowerShell commands",
        parameters: Type.Object({
          command: Type.String({ description: "Shell command to execute" }),
          timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
        }),
        async execute() {
          throw powershellRejected();
        },
      });

      // User `!` / `!!` commands route to the same remote operations.
      pi.on("user_bash", () => ({ operations: bashOps }));

      // Structured execution identity: replace the session cwd line (with
      // the effective remote working directory, not the workspace root) and
      // append the environment section (the user prompt is untouched).
      pi.on("before_agent_start", (event, ctx) => {
        state.localReadRoots = collectLocalReadRoots(event.systemPromptOptions, baseLocalReadRoots);
        const sessionCwdInPrompt = (event.systemPromptOptions?.cwd ?? ctx.cwd).replace(/\\/g, "/");
        let systemPrompt = event.systemPrompt;
        const originalLine = `Current working directory: ${sessionCwdInPrompt}`;
        const remoteLine = `Current working directory: ${mapping.remoteBase} (remote workspace via SSH: ${workspace.host})`;
        if (systemPrompt.includes(originalLine)) {
          systemPrompt = systemPrompt.replace(originalLine, remoteLine);
        }
        systemPrompt = `${systemPrompt}\n\n${remoteEnvironmentPrompt(workspace, sessionCwd)}`;
        return { systemPrompt };
      });
    },
  };
}
