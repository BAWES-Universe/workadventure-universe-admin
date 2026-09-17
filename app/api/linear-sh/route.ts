import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { linearShService } from "@/lib/linear-sh/service";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const expected = process.env.ADMIN_API_TOKEN;
  const actual = request.headers.get("authorization");
  if (
    !expected ||
    !actual ||
    Buffer.byteLength(actual) !== Buffer.byteLength(`Bearer ${expected}`) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(`Bearer ${expected}`))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 160000) throw new Error("Too large");
    const result = await linearShService(JSON.parse(raw));
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Never log request bodies, tokens, provider responses, employee details or encrypted config.
    return NextResponse.json(
      { error: "Linear SH request unavailable" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
}
