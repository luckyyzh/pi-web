import path from "node:path";
import { MAX_SUBAGENT_INPUT_BYTES, MAX_SUBAGENT_INPUT_FILES, type SubagentInputFile } from "./subagent-input";
import { quoteShellArg, remotePathFor, type RemoteWorkspace } from "./remote-workspace";
import { sshExec, sshReadTextFile } from "./ssh";

/** Attach project files from the same machine as the parent, not its local resource cache. */
export async function loadRemoteSubagentInputFiles(workspace: RemoteWorkspace, cwd: string, requestedPaths: readonly string[]): Promise<SubagentInputFile[]> {
  if (requestedPaths.length > MAX_SUBAGENT_INPUT_FILES) throw new Error(`Agent input_files accepts at most ${MAX_SUBAGENT_INPUT_FILES} files`);
  if (requestedPaths.length === 0) return [];
  const remoteCwd = remotePathFor(workspace, cwd);
  const realRoot = (await sshExec(workspace.host, `cd ${quoteShellArg(remoteCwd)} && pwd -P`)).trim();
  const files: SubagentInputFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const requested of requestedPaths) {
    if (!requested.trim() || /[\0\r\n]/.test(requested)) throw new Error("Invalid Agent input_files path");
    const remotePath = /^[A-Za-z]:[\\/]/.test(requested) || requested.startsWith(workspace.localRoot)
      ? remotePathFor(workspace, requested)
      : path.posix.resolve(remoteCwd, requested);
    const realFile = (await sshExec(workspace.host, `readlink -f -- ${quoteShellArg(remotePath)}`)).trim();
    const relative = path.posix.relative(realRoot, realFile);
    if (!realFile || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new Error(`Agent input file is outside the session cwd: ${requested}`);
    }
    if (seen.has(realFile)) continue;
    seen.add(realFile);
    const { content, size } = await sshReadTextFile(workspace.host, realFile, MAX_SUBAGENT_INPUT_BYTES - bytes);
    bytes += size;
    if (bytes > MAX_SUBAGENT_INPUT_BYTES) throw new Error(`Agent input_files exceeds the ${MAX_SUBAGENT_INPUT_BYTES}-byte total limit`);
    if (content.includes("\0")) throw new Error(`Agent input file is not valid UTF-8 text: ${requested}`);
    files.push({ path: relative, content });
  }
  return files;
}
