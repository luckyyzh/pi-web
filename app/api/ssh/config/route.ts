import { NextRequest, NextResponse } from "next/server";
import {
  ensureShadowRoot,
  isRemoteModeActive,
  loadSshConfig,
  saveSshConfig,
  syncShadowProject,
} from "@/lib/ssh";

const HOST_RE = /^[a-zA-Z0-9._@-]+$/;
const PATH_RE = /^[a-zA-Z0-9._~\-/]+$/;

export async function GET() {
  const cfg = loadSshConfig();
  const shadowRoot = isRemoteModeActive(cfg) ? ensureShadowRoot(cfg) : null;
  return NextResponse.json({ ...cfg, shadowRoot });
}

export async function POST(request: NextRequest) {
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
    const path = typeof body.path === "string" ? body.path.trim() : "";

    if (enabled) {
      if (!host || !HOST_RE.test(host)) {
        return NextResponse.json({ error: "host 格式非法（应为 user@host 或 host）" }, { status: 400 });
      }
      if (path && !PATH_RE.test(path)) {
        return NextResponse.json({ error: "path 格式非法（应为绝对路径，如 /home/user/project）" }, { status: 400 });
      }
    }

    const next = { enabled, host, path };
    saveSshConfig(next);

    let shadowRoot: string | null = null;
    if (enabled) {
      shadowRoot = ensureShadowRoot(next);
      await syncShadowProject(next);
    }

    return NextResponse.json({ ...next, shadowRoot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
