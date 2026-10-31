import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { findGrant, grantLookupSchema } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/action-grants/find
 * Does a remembered approval cover this call? Body: { requesterKey, conversationKey, connectionRef?, toolName, heading,
 * toolFingerprint, policyRevision, arguments }. Same asker, conversation, connection, tool as reviewed, policy revision
 * and heading, inside both its idle and absolute time, not revoked, and the arguments fit what it allows; never for
 * deletesOrSends. Auth: BOT_SERVICE_TOKEN. Response: { grant: { grantId, scope } | null }. Finding one does not renew it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'looking for a remembered approval', async () => {
    const { id } = await params;
    const body = await readBody(request, grantLookupSchema);
    if (body.response) return body.response;
    return json(request, { grant: await findGrant(id, body.data) });
  });
}
