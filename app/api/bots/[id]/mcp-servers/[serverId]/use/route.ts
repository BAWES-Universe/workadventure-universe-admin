import { NextRequest } from 'next/server';
import { checkAppUse, useCheckSchema } from '@/lib/app-connections';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/**
 * POST /api/bots/:id/mcp-servers/:serverId/use { requesterKey?, forOwner? }
 * May this app be used right now, for this request? The bot server asks on EVERY use of an app (not once per chat or goal), so a
 * grant taken away, a disconnected app or a switch turned off stops it at once, also in a chat that is already open (game
 * #2001, checks 32 and 38). `requesterKey` is who is asking (their WorkAdventure uuid or email); `forOwner` says the Brick is
 * working for its owner on its own. Auth: BOT_SERVICE_TOKEN.
 * Response: { allowed } and, when not, { reason: gone | off | not_owner }, never anything about what the app holds.
 * 404 when this Brick has no such app: the use is refused too.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'checking an app', async () => {
    const { id, serverId } = await params;
    const body = await readBody(request, useCheckSchema, true);
    if (body.response) return body.response;
    const verdict = await checkAppUse(id, serverId, body.data);
    if (!verdict) return json(request, { allowed: false, reason: 'gone' }, 404);
    return json(request, { allowed: verdict.allowed, ...(verdict.allowed ? {} : { reason: verdict.reason }), viaConnection: verdict.viaConnection });
  });
}
