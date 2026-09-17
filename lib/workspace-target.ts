/** Serializable execution identity. A local cache path is not a remote cwd. */
export interface RemoteWorkspaceTarget {
  kind: "ssh";
  id: string;
  host: string;
  cwd: string;
}

export type WorkspaceTarget = { kind: "local"; cwd: string } | RemoteWorkspaceTarget;

export function workspaceTargetLabel(target: WorkspaceTarget): string {
  return target.kind === "ssh" ? `SSH · ${target.host}:${target.cwd}` : target.cwd;
}

export function sameWorkspaceTarget(a: WorkspaceTarget, b: WorkspaceTarget): boolean {
  return a.kind === b.kind && a.cwd === b.cwd
    && (a.kind === "local" || (b.kind === "ssh" && a.id === b.id && a.host === b.host));
}
