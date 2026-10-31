import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { botToolSettingsSchema, readBotToolSettings, saveBotToolSettings } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/tool-settings
 * The bot's own limits for asking: { askBeforeMaking: 3 | 5 | 10 | null (no limit, default 5), askWhichWay: "rarely" |
 * "beforeBiggerJobs" | "never" (default "rarely"), cardWaitMinutes: 5 | 10 | 30 (default 10) }.
 *
 * Auth: Manage bots (403 without it), or the bot server's ADMIN_API_TOKEN.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'read' }, 'read');
    if (auth.response) return auth.response;
    return json(request, await readBotToolSettings(id));
  } catch (error) {
    return toolsFailure(request, error, 'reading the settings');
  }
}

/**
 * PUT /api/bots/:id/tool-settings
 * Change any of askBeforeMaking, askWhichWay, cardWaitMinutes. Only the ones sent change. Response: the same as GET.
 *
 * Auth: Manage bots (403 without it).
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;

    const parsed = botToolSettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await saveBotToolSettings(id, parsed.data));
  } catch (error) {
    return toolsFailure(request, error, 'saving the settings');
  }
}
