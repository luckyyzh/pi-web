import { NextRequest, NextResponse } from "next/server";
import {
  ensureShadowRoot,
  isRemoteModeActive,
  loadSshConfig,
  saveSshConfig,
  sshTestConnection,
} from "@/lib/ssh";
import { validateSshHost } from "@/lib/remote-workspace";
import { allowFileRoot } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export async function GET() {
  const cfg = loadSshConfig();
  try {
    const shadowRoot = isRemoteModeActive(cfg) ? ensureShadowRoot(cfg) : null;
    return NextResponse.json({ ...cfg, shadowRoot });
  } catch (error) {
    return NextResponse.json({ ...cfg, shadowRoot: null, warning: error instanceof Error ? error.message : String(error) });
  }
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
      host?: unknown;
      path?: unknown;
    } | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const enabled = body.enabled === true;
    const host = typeof body.host === "string" ? body.host.trim() : "";
    let path = typeof body.path === "string" ? body.path.trim() : "";

    if (enabled) {
      try { validateSshHost(host); } catch {
        return NextResponse.json({ error: "host 格式非法（应为 user@host 或 SSH 配置别名）" }, { status: 400 });
      }
      const connection = await sshTestConnection(host, path);
      if (!connection.ok || !connection.cwd) {
        return NextResponse.json({ error: connection.error ?? "无法解析远程目录" }, { status: 400 });
      }
      path = connection.cwd;
    }

    const next = { enabled, host, path };
    let shadowRoot: string | null = null;
    if (enabled) {
      shadowRoot = ensureShadowRoot(next);
      allowFileRoot(shadowRoot);
    }
    // Selection changes do not alter the identities of existing sessions or terminals.
    saveSshConfig(next);
    return NextResponse.json({ ...next, shadowRoot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
