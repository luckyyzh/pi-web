import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { ensurePersonaFile, personaPath, readPersona, writePersona } from "@/lib/persona";

export const dynamic = "force-dynamic";

// GET /api/persona：读取用户人设（~/.pi/agent/persona.md）
export async function GET() {
  ensurePersonaFile();
  return NextResponse.json({
    content: readPersona(),
    path: personaPath(),
  });
}

// POST /api/persona：保存用户人设
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
    if (!body || typeof body.content !== "string") {
      return NextResponse.json({ error: "content (string) required" }, { status: 400 });
    }
    writePersona(body.content);
    return NextResponse.json({ ok: true, path: personaPath() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
