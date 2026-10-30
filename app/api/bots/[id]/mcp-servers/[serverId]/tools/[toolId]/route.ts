import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { moveSchema, moveTool } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * PATCH /api/bots/:id/mcp-servers/:serverId/tools/:toolId
 * Move one tool under another heading. Body: { heading: "looksUp" | "makesNew" | "changesThings" | "deletesOrSends" }.
 * A tool that was confirmed stays confirmed, now by the person who moved it; one that was not still waits.
 * Response: the server's tools, as GET.
 *
 * Auth: Manage bots (403 without it).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string; toolId: string }> }) {
  try {
    const { id, serverId, toolId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;

    const parsed = moveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await moveTool(id, serverId, toolId, parsed.data.heading, auth.person!.id));
  } catch (error) {
    return toolsFailure(request, error, 'moving the tool');
  }
}
