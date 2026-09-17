import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveRemoteWorkspace, resolveWorkspaceTarget, type WorkspaceLocations } from "./remote-workspace";
import { sameWorkspaceTarget, type WorkspaceTarget } from "./workspace-target";

export const SESSION_WORKSPACE_TYPE = "pi-web:workspace";

/** Persist execution identity without changing Pi's session header/cwd format. */
export function bindSessionWorkspace(manager: SessionManager, storage?: WorkspaceLocations): ReturnType<typeof resolveRemoteWorkspace> {
  const cwd = manager.getCwd();
  const remote = resolveRemoteWorkspace(cwd, storage);
  if (!remote) return null;
  const target = resolveWorkspaceTarget(cwd, storage);
  const previous = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === SESSION_WORKSPACE_TYPE);
  if (previous?.type === "custom") {
    const saved = previous.data as { version?: number; target?: WorkspaceTarget } | undefined;
    if (saved?.version !== 1 || !saved.target || !sameWorkspaceTarget(saved.target, target)) {
      throw new Error("Saved session belongs to a different remote workspace; execution was blocked");
    }
  } else {
    manager.appendCustomEntry(SESSION_WORKSPACE_TYPE, { version: 1, target });
  }
  return remote;
}
