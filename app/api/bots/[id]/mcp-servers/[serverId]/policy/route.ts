import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { saveServerSettings, serverSettingsSchema } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * PUT /api/bots/:id/mcp-servers/:serverId/policy
 * What the bot does with a tool under each heading on this server. Body: any of { looksUp, makesNew, changesThings,
 * deletesOrSends }, each "rightAway" | "asksFirst" | "off". Only the headings sent change, and the policy revision goes up
 * when one does. A new server starts with looksUp and makesNew on rightAway and the others on asksFirst.
 * Response: the server's tools, as GET.
 *
 * Auth: Manage bots (403 without it).
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  try {
    const { id, serverId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;

    const parsed = serverSettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await saveServerSettings(id, serverId, parsed.data));
  } catch (error) {
    return toolsFailure(request, error, 'saving the settings');
  }
}
