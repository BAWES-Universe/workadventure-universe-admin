import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { confirmSchema, confirmTools } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bots/:id/mcp-servers/:serverId/tools/confirm
 * Confirm the server's tools ("Confirm all tools"), or only { toolIds: [...] }. Each takes the heading someone chose or,
 * if none, the suggested one; if a tool has neither nothing is confirmed (400, naming it). When every tool is confirmed a
 * server that was Not checked yet is checked. Response: the server's tools, as GET.
 *
 * Auth: Manage bots (403 without it).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  try {
    const { id, serverId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;

    const parsed = confirmSchema.safeParse((await request.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await confirmTools(id, serverId, auth.person!.id, parsed.data.toolIds));
  } catch (error) {
    return toolsFailure(request, error, 'confirming the tools');
  }
}
