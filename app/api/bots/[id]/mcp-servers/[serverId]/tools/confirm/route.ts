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
 * Confirm the server's tools ("Confirm all tools"), or only { toolIds: [...] }. An empty body means all; a body that is not
 * valid JSON is a 400. { policyRevision } is the revision the page showed: if the tools moved since, nothing is confirmed
 * (409 "This tool changed, review it again"). Each takes the heading someone chose or,
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

    // Only an empty body means "all tools": a body that is cut off or garbled is never read as that
    const text = (await request.text().catch(() => null))?.trim();
    if (text === undefined) return json(request, { error: 'Invalid request data' }, 400);
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(request, { error: 'Invalid request data' }, 400);
      }
    }
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await confirmTools(id, serverId, auth.person!.id, parsed.data.toolIds, parsed.data.policyRevision));
  } catch (error) {
    return toolsFailure(request, error, 'confirming the tools');
  }
}
