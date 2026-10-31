import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { revokeGrants, revokeSchema } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/action-grants/revoke
 * End the asker's remembered approvals for this bot, in one conversation or all of theirs. Body: { requesterKey,
 * conversationKey?, reason: "ask_again" | "signed_out" | "connection_changed" | "policy_changed" | "lost_permission" |
 * "left" }. "left" and "signed_out" also close their requests still waiting. Auth: BOT_SERVICE_TOKEN.
 * Response: { revoked }.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'ending remembered approvals', async () => {
    const { id } = await params;
    const body = await readBody(request, revokeSchema);
    if (body.response) return body.response;
    return json(request, await revokeGrants(id, body.data));
  });
}
