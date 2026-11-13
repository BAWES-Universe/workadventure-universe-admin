import { NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAppUse } from '@/lib/app-connections';
import { prisma } from '@/lib/db';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { adapterIsOn } from '@/lib/app-adapter';
import { useReadyMade } from '@/lib/app-adapter/ready-made';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    botId: z.string().min(1),
    serverId: z.string().min(1),
    requesterKey: z.string().trim().min(1).max(400).optional(),
    forOwner: z.boolean().optional(),
    tool: z.string().trim().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).default({}),
    /** The bot server's own id for this call (its attempt id): a retry is the same call and runs once. */
    callId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * POST /api/ready-made/use - one use of a ready-made app for its owner, through the adapter (game #2001, step 8). The bot server
 * calls it with the same asker facts as the per-app use check, which is run first. Writes the meter before anything else, never
 * runs a call id twice, and answers 404 while the adapter is off. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'using a ready-made app', async () => {
    // Off is "not there", before anything else is looked at
    if (!adapterIsOn()) return json(request, { error: 'Not found' }, 404);
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const { botId, serverId, requesterKey, forOwner, tool, callId } = body.data;
    const verdict = await checkAppUse(botId, serverId, { requesterKey, forOwner });
    if (!verdict) return json(request, { allowed: false, reason: 'gone' }, 404);
    if (!verdict.allowed) return json(request, { allowed: false, reason: verdict.reason }, 403);
    if (!verdict.readyMade) return json(request, { error: 'Not found' }, 404);
    const row = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { connectionId: true, connection: { select: { ownerId: true } } } });
    if (!row?.connectionId || !row.connection?.ownerId) return json(request, { allowed: false, reason: 'gone' }, 404);
    const outcome = await useReadyMade({ botId, connectionId: row.connectionId, ownerId: row.connection.ownerId, tool, arguments: body.data.arguments, callId });
    switch (outcome.status) {
      case 'done':
        return json(request, { ok: outcome.ok, data: outcome.data });
      case 'off':
      case 'gone':
        return json(request, { error: 'Not found' }, 404);
      case 'not_owner':
        return json(request, { allowed: false, reason: 'not_owner' }, 403);
      case 'already_asked':
        return json(request, { error: 'This call was already made', code: 'already_asked' }, 409);
      default:
        return json(request, { error: 'The app could not be reached', code: 'unavailable' }, 502);
    }
  });
}
