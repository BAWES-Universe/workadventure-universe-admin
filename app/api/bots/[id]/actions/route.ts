import { NextRequest } from 'next/server';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { createRequest, createRequestSchema } from '@/lib/bot-actions';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/actions
 * Save an action that waits for a tap (#739). Auth: BOT_SERVICE_TOKEN (the bot server).
 * Body: { proposalKey, requesterKey, conversationKey, connectionRef?, toolName, heading, toolFingerprint, policyRevision,
 *   arguments, rememberScope?: { fixed, varies }, reviewMinutes? }. The arguments are stored exactly as given and are what
 * runs; the same proposalKey again returns the request already saved (200), and the same key with other content is a 409.
 * rememberScope is what "allow more" would remember; not allowed for deletesOrSends.
 * Response: 201 { action } with revision, status "waiting" and reviewExpiresAt.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serviceRoute(request, 'saving the action', async () => {
    const { id } = await params;
    const body = await readBody(request, createRequestSchema);
    if (body.response) return body.response;
    const { action, created } = await createRequest(id, body.data);
    return json(request, { action }, created ? 201 : 200);
  });
}
