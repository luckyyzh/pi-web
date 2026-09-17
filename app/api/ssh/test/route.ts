import { NextRequest, NextResponse } from "next/server";
import { sshTestConnection } from "@/lib/ssh";
import { validateSshHost } from "@/lib/remote-workspace";
import { isApiRequestAllowed } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = (await request.json().catch(() => null)) as {
      host?: unknown;
      path?: unknown;
    } | null;
    const host = typeof body?.host === "string" ? body.host.trim() : "";
    const path = typeof body?.path === "string" ? body.path.trim() : "";

    try { validateSshHost(host); } catch {
      return NextResponse.json({ error: "host 格式非法（应为 user@host 或 SSH 配置别名）" }, { status: 400 });
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
