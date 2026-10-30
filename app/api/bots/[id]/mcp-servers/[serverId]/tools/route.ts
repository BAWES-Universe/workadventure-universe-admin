import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { catalogSchema, readServerTools, syncCatalog } from '@/lib/mcp-tool-policy';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/mcp-servers/:serverId/tools
 * The server's tools with what each is suggested to do, what was chosen and who confirmed it, the setting under each
 * heading, the policy revision, and the state of the server: "notCheckedYet" for a server that existed before tools were
 * checked (it keeps working in text), "notConfirmedYet" while a tool waits, "confirmed" when every tool is.
 *
 * Auth: Manage bots (403 without it), or the bot server's ADMIN_API_TOKEN.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  try {
    const { id, serverId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'read' }, 'read');
    if (auth.response) return auth.response;
    return json(request, await readServerTools(id, serverId));
  } catch (error) {
    return toolsFailure(request, error, 'reading the tools');
  }
}

/**
 * PUT /api/bots/:id/mcp-servers/:serverId/tools
 * The bot server saves the full tool list it just read (every page). Body: { tools: [{ name, title?, description?,
 * fingerprint, suggestedHeading?, suggestionSource? }] }. A new tool waits to be confirmed; a tool whose fingerprint
 * changed goes back to not confirmed yet; a tool the server no longer offers is removed. A suggestion never lets a tool
 * run. Response: the same as GET, plus which tools were added, changed and removed.
 *
 * Auth: the bot server's ADMIN_API_TOKEN only.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  try {
    const { id, serverId } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'write' }, 'write');
    if (auth.response) return auth.response;
    if (auth.person) return json(request, { error: 'Forbidden' }, 403);

    const parsed = catalogSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);
    return json(request, await syncCatalog(id, serverId, parsed.data));
  } catch (error) {
    return toolsFailure(request, error, 'saving the tools');
  }
}
