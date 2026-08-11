import { NextRequest, NextResponse } from "next/server";
import { sshTestConnection } from "@/lib/ssh";

const HOST_RE = /^[a-zA-Z0-9._@-]+$/;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      host?: unknown;
      path?: unknown;
    } | null;
    const host = typeof body?.host === "string" ? body.host.trim() : "";
    const path = typeof body?.path === "string" ? body.path.trim() : "";

    if (!host || !HOST_RE.test(host)) {
      return NextResponse.json({ error: "host 格式非法（应为 user@host 或 host）" }, { status: 400 });
    }

    const result = await sshTestConnection(host, path || undefined);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
