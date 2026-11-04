import { NextRequest, NextResponse } from 'next/server';
import { authorizeToolsRequest, json, toolsFailure } from '@/lib/mcp-tool-api';
import { listActiveGrants } from '@/lib/bot-actions';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/action-grants
 * "Allowed more right now" on the bot's Approvals page: the remembered approvals ("allow more of the same in this chat")
 * that are still alive. Response: { grants: [{ id, requesterKey, person: { name, isGuest }, toolName, toolTitle, heading, connectionRef, scope: { fixed, varies },
 * createdAt, idleExpiresAt, absoluteExpiresAt }] }, newest first. Card content is never included.
 *
 * Auth: Manage bots (403 without it), or the bot server's ADMIN_API_TOKEN.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeToolsRequest(request, id, { adminToken: 'read' }, 'read');
    if (auth.response) return auth.response;
    return json(request, { grants: await listActiveGrants(id) });
  } catch (error) {
    return toolsFailure(request, error, 'reading the remembered approvals');
  }
}
