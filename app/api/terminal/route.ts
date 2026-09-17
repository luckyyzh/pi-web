import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { resolveWorkspaceTarget } from "@/lib/remote-workspace";
import { samePath } from "@/lib/paths";
import { sameWorkspaceTarget, type WorkspaceTarget } from "@/lib/workspace-target";
import { createTerminal } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Strictly parse the untrusted expected target identity sent by the client. */
function parseExpectedTarget(value: unknown): WorkspaceTarget | null {
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

/** Compare the untrusted expected identity with the server-resolved target. */
function expectedTargetMatches(expected: WorkspaceTarget, target: WorkspaceTarget): boolean {
  if (expected.kind !== target.kind) return false;
  if (expected.kind === "ssh") return sameWorkspaceTarget(expected, target);
  return samePath(expected.cwd, target.cwd);
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown; target?: unknown };
    if (body.id !== undefined && (typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id))) {
      return NextResponse.json({ error: "Invalid terminal id" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    const cwd = resolve(body.cwd);
    // The server is authoritative for the execution target: body.cwd is a local
    // compatibility path that resolves to a fixed, persisted workspace identity
    // (unknown remote shadows fail closed here; it never trusts the client).
    const target = resolveWorkspaceTarget(cwd);
    // Local targets are validated as real directories. Remote targets are never
    // stat'ed locally: the mapping is already confirmed by the server-side
    // resolve, so the local cache root is authorized lexically.
    if (target.kind === "local" && !(await stat(cwd)).isDirectory()) {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }
    const roots = await getAllowedFileRoots();
    const authorized = target.kind === "ssh"
      ? isFilePathAllowed(cwd, roots)
      : isExistingFilePathAllowed(cwd, roots);
    if (!authorized) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // A restart tab sends the expected target identity it was created from.
    // It is verified against the server-resolved target before any spawn; a
    // mismatch conflicts (409) and no terminal is created.
    const expected = parseExpectedTarget(body.target);
    if (expected && !expectedTargetMatches(expected, target)) {
      return NextResponse.json({ error: "Terminal target does not match this workspace" }, { status: 409 });
    }
    const id = createTerminal(
      cwd,
      typeof body.cols === "number" ? body.cols : 80,
      typeof body.rows === "number" ? body.rows : 24,
      body.id as string | undefined,
      target,
    );
    return NextResponse.json({ id, cwd, target });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
