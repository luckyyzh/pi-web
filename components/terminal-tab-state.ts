import type { WorkspaceTarget } from "@/lib/workspace-target";

export interface TerminalTab {
  id: string;
  cwd: string;
  /** Expected target identity, resolved by the server. Client state is display
   *  only; the server's stored target stays authoritative. */
  target?: WorkspaceTarget;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

export function newTerminalTab(cwd: string, target?: WorkspaceTarget): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return target ? { id, cwd, target } : { id, cwd };
}

/** Strictly parse a target from untrusted storage/API JSON. Never throws. */
export function parseWorkspaceTarget(value: unknown): WorkspaceTarget | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "local" && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
    return { kind: "local", cwd: candidate.cwd };
  }
  if (candidate.kind === "ssh"
    && typeof candidate.id === "string" && candidate.id
    && typeof candidate.host === "string" && candidate.host
    && typeof candidate.cwd === "string" && candidate.cwd) {
    return { kind: "ssh", id: candidate.id, host: candidate.host, cwd: candidate.cwd };
  }
  return null;
}

/**
 * Compare an untrusted expected identity (storage/restart) with the target the
 * server resolved for the terminal. The server stays authoritative: this only
 * gates a user-facing mismatch error. ssh identities must match exactly.
 * Local cwds: separators/trailing slashes are canonicalized; case folding
 * applies only to recognizable Windows drive/UNC paths (POSIX stays
 * case-sensitive).
 */
export function targetIdentityMatches(expected: WorkspaceTarget, server: WorkspaceTarget): boolean {
  if (expected.kind === "ssh" || server.kind === "ssh") {
    if (expected.kind !== "ssh" || server.kind !== "ssh") return false;
    return expected.id === server.id && expected.host === server.host && expected.cwd === server.cwd;
  }
  const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");
  const windows = isWindowsPath(expected.cwd) || isWindowsPath(server.cwd);
  const canonical = (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const a = canonical(expected.cwd);
  const b = canonical(server.cwd);
  if (a === b) return true;
  return windows && a.toLowerCase() === b.toLowerCase();
}

/** Mismatch message when the expected identity disagrees with the server. */
export function verifyServerTarget(expected: WorkspaceTarget | null, server: WorkspaceTarget | null): string | null {
  if (!expected) return null;
  return server && targetIdentityMatches(expected, server) ? null : "Terminal target does not match this workspace";
}

/** Expected identity to keep after a successful connection: the remembered
 *  one, or the first server-resolved target when nothing was stored. */
export function nextExpectedTarget(expected: WorkspaceTarget | null, server: WorkspaceTarget | null): WorkspaceTarget | null {
  return expected ?? server;
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id || existing.cwd === tab.cwd)) {
        // Old sessions stored { id, cwd } only; the target (when present) is an
        // expected identity re-validated against the server on restore.
        const target = parseWorkspaceTarget(tab.target);
        tabs.push(target ? { id: tab.id, cwd: tab.cwd, target, restored: true } : { id: tab.id, cwd: tab.cwd, restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
