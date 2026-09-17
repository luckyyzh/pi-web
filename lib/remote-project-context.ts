import path from "node:path";
import { quoteShellArg, remotePathFor, type RemoteWorkspace } from "./remote-workspace";
import { sshExec } from "./ssh";
import { samePath } from "./paths";

type ContextFiles = { agentsFiles: Array<{ path: string; content: string }> };

/** Read only context documents. Never unpack remote .pi code or settings onto the host. */
export async function remoteContextOverride(
  workspace: RemoteWorkspace,
  sessionCwd: string,
  agentDir: string,
): Promise<(base: ContextFiles) => ContextFiles> {
  const cwd = remotePathFor(workspace, sessionCwd);
  // NUL framing preserves spaces/tabs in paths; base64 keeps arbitrary text out of the shell protocol.
  const command = `cd ${quoteShellArg(cwd)} && d=$(pwd -P) && while :; do
    for name in AGENTS.override.md AGENTS.md CLAUDE.md; do
      file="$d/$name"
      if [ -f "$file" ]; then
        size=$(stat -c %s -- "$file") || exit 1
        [ "$size" -le 262144 ] || { echo "Context file exceeds 256 KiB: $file" >&2; exit 1; }
        data=$(base64 -- "$file") || exit 1
        printf '%s\\0%s\\0' "$file" "$data"
        break
      fi
    done
    [ "$d" = / ] && break
    d=$(dirname -- "$d")
  done`;
  const output = await sshExec(workspace.host, command);
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("Invalid remote context response");
  const documents: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < fields.length; i += 2) {
    const buffer = Buffer.from(fields[i + 1], "base64");
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Remote project context exceeds 1 MiB");
    documents.unshift({ path: path.posix.normalize(fields[i]), content: decoder.decode(buffer) });
  }
  return (base) => ({
    // Keep explicit global instructions, not stale cache files or local cache-ancestor instructions.
    agentsFiles: [
      ...base.agentsFiles.filter((file) => samePath(path.dirname(file.path), agentDir)),
      ...documents,
    ],
  });
}
