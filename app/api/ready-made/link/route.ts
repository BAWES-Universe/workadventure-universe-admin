import { NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAppUse } from '@/lib/app-connections';
import { prisma } from '@/lib/db';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { adapterIsOn } from '@/lib/app-adapter';
import { linkReadyMade } from '@/lib/app-adapter/ready-made';
import { linkGitHub } from '@/lib/github/link';

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
    /** One JSON-RPC message for the person's app link: initialize, notifications/initialized, tools/list or tools/call. */
    message: z.record(z.string(), z.unknown()),
    /** The link's own session id from an earlier answer, when it gave one. */
    sessionId: z.string().trim().min(1).max(500).optional(),
    /** Required for tools/call (it is a use, counted once for each id): the bot server's own id for this call. */
    callId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * POST /api/ready-made/link - one message to a person's own app link of a ready-made app, sent by Orbit. The link answers 401
 * without the provider key, and that key never leaves Orbit: the bot server and the Brick never hold it, so every message goes
 * through here. Same checks as /api/ready-made/use (the use check first, their own signed-in app and Brick only); a tools/call is
 * counted like a use. Answers { status, contentType, sessionId, body } with what the link sent. 404 while the adapter is off.
 * A person's GitHub (game #2041) comes here too: Orbit answers it itself with the person's own token, adapter or not.
 * Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'sending to an app link', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const { botId, serverId, requesterKey, forOwner, message, sessionId, callId } = body.data;
    const verdict = await checkAppUse(botId, serverId, { requesterKey, forOwner });
    if (!verdict) return json(request, { allowed: false, reason: 'gone' }, 404);
    if (!verdict.allowed) return json(request, { allowed: false, reason: verdict.reason }, 403);
    if (!verdict.readyMade) return json(request, { error: 'Not found' }, 404);
    const row = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { connectionId: true, connection: { select: { ownerId: true, source: true } } } });
    if (!row?.connectionId || !row.connection?.ownerId) return json(request, { allowed: false, reason: 'gone' }, 404);
    const github = row.connection.source === 'github';
    if (!github && !adapterIsOn()) return json(request, { error: 'Not found' }, 404);
    const linkInput = { botId, connectionId: row.connectionId, ownerId: row.connection.ownerId, message, callId: callId ?? null };
    const outcome = github ? await linkGitHub(linkInput) : await linkReadyMade({ ...linkInput, sessionId: sessionId ?? null });
    switch (outcome.status) {
      case 'done':
        return json(request, outcome.answer);
      case 'off':
      case 'gone':
        return json(request, { error: 'Not found' }, 404);
      case 'refused':
        return json(request, { error: 'That message is not one an app link takes here', code: 'refused' }, 400);
      case 'not_owner':
        return json(request, { allowed: false, reason: 'not_owner' }, 403);
      case 'already_asked':
        return json(request, { error: 'This call was already made', code: 'already_asked' }, 409);
      default:
        return json(request, { error: 'The app could not be reached', code: 'unavailable' }, 502);
    }
  });
}
