import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { endAllGrants } from '@/lib/bot-actions';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bots/:id/action-grants/end-all
 * "End all" on the bot's Approvals page: every remembered approval of this bot ends, so the next change asks again. No
 * body. Response: { ended }. Auth: Manage bots (403 without it); the bot server's token does not end people's approvals.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'none' });
    if (auth.response) return auth.response;
    return json(request, await endAllGrants(id));
  } catch (error) {
    return toolsFailure(request, error, 'ending the remembered approvals');
  }
}
