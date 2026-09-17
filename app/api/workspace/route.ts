import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { resolveWorkspaceTarget } from "@/lib/remote-workspace";

export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    if (!isFilePathAllowed(cwd, await getAllowedFileRoots())) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    return NextResponse.json({ target: resolveWorkspaceTarget(cwd) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
