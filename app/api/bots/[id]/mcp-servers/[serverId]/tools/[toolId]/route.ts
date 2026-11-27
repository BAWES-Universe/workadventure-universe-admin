import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { moveTool, setToolSetting, toolPatchSchema } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * PATCH /api/bots/:id/mcp-servers/:serverId/tools/:toolId
 * One of two bodies:
 *  - { heading: "looksUp" | "makesNew" | "changesThings" | "deletesOrSends" }: move one tool of a bot's own server under another heading.
 *    A tool that was confirmed stays confirmed, now by the person who moved it; one that was not still waits. Refused (409) on a ready-made
 *    App's grant (`kind: "appActions"`): its actions stay where Universe sorted them.
 *  - { setting: "rightAway" | "asksFirst" | "off" | null }: an App action's own choice over its heading's; null follows the heading again.
 *    Only on a ready-made App's grant (409 on a bot's own server). The policy revision goes up when it changes.
 * Response: the server's tools, as GET.
 *
 * Auth: Manage bots (403 without it).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string; toolId: string }> }) {
  try {
    const { id, serverId, toolId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;

    const parsed = toolPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    if ('setting' in parsed.data) return json(request, await setToolSetting(id, serverId, toolId, parsed.data.setting));
    return json(request, await moveTool(id, serverId, toolId, parsed.data.heading, auth.person!.id));
  } catch (error) {
    return toolsFailure(request, error, 'changing the tool');
  }
}
