export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
  /** A directory entry from Git, for example an untracked nested repository. */
  isDirectory?: boolean;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
  /** The file listing could not finish within the scan limits. */
  truncated?: boolean;
  /** Counts omit files because of scan/read limits or remote untracked files. */
  lineStatsTruncated?: boolean;
  /** Distinguish the remote content-read policy from an interrupted count. */
  lineStatsIncompleteReason?: "remote-untracked" | "limit-or-error";
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}
