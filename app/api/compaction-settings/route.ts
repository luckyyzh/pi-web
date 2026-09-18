import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  normalizeCompactionSettingsBody,
  readCompactionSettings,
  writeCompactionSettings,
} from "@/lib/compaction-settings";

export const dynamic = "force-dynamic";

// GET /api/compaction-settings：读取压缩模型/思考档位配置
export async function GET() {
  return NextResponse.json(readCompactionSettings());
}

// POST /api/compaction-settings：保存配置（model/thinkingLevel 均可为 null = 跟随会话）
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    const settings = normalizeCompactionSettingsBody(body);
    if (!settings) {
      return NextResponse.json(
        { error: "Invalid body: expect { model: {provider, modelId} | null, thinkingLevel: string | null, cacheAligned?: boolean }" },
        { status: 400 },
      );
    }
    writeCompactionSettings(settings);
    return NextResponse.json(readCompactionSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
