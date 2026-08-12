import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { installBundledExtension, listBundledExtensions } from "@/lib/bundled-extensions";

export const dynamic = "force-dynamic";

// GET /api/bundled-extensions：列出内置扩展 + 安装状态
export async function GET() {
  return NextResponse.json({ extensions: listBundledExtensions() });
}

// POST /api/bundled-extensions：安装指定内置扩展（body: { name })
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const result = await installBundledExtension(name);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
