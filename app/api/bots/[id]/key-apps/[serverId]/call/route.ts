import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { runKeyApp } from '@/lib/app-direct/use';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    /** Who is asking, as the bot server authenticated them. A key app is only ever for its owner. */
    requesterKey: z.string().trim().min(1).max(400).optional(),
    /** The Brick works for its owner on its own (a goal they set). Only the bot server can say it. */
    forOwner: z.boolean().optional(),
    callId: z.string().trim().min(1).max(200),
    operation: z.string().trim().min(1).max(60),
    arguments: z.record(z.string(), z.unknown()).default({}),
    /** The definition version (from the key-apps list) the person's approval was for. */
    definitionHash: z.string().trim().length(64),
  })
  .strict();

/**
 * POST /api/bots/:id/key-apps/:serverId/call { requesterKey? | forOwner?, callId, operation, arguments, definitionHash } - one use of an app
 * with a key (game #2044). Orbit checks the use as it does for every app (own Brick, on, asker is the owner), sends the one operation to
 * the origin the owner confirmed with the key only Orbit holds, and answers with the fields the definition lists. A raw error answer never
 * comes back. Auth: BOT_SERVICE_TOKEN.
 * 200 { ok, httpStatus, data, truncated } · 403 { allowed: false, reason } · 404 gone / unknown operation · 409 changed (the definition is
 * not the version approved) or already_asked · 400 bad_arguments · 429 limit · 502 key_rejected / unavailable.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'using a key app', async () => {
    const { id, serverId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const outcome = await runKeyApp({ botId: id, serverId, ...body.data });
    switch (outcome.status) {
      case 'done':
        return json(request, { ok: outcome.ok, httpStatus: outcome.httpStatus, data: outcome.data, truncated: outcome.truncated });
      case 'refused':
        return json(request, { allowed: false, reason: outcome.reason }, outcome.reason === 'gone' ? 404 : 403);
      case 'unknown_operation':
        return json(request, { error: 'Not found', code: 'unknown_operation' }, 404);
      case 'changed':
        return json(request, { error: 'This app changed since it was approved', code: 'changed' }, 409);
      case 'already_asked':
        return json(request, { error: 'This call was already made', code: 'already_asked' }, 409);
      case 'bad_arguments':
        return json(request, { error: outcome.message, code: 'bad_arguments' }, 400);
      case 'limit':
        return json(request, { error: 'Too many requests for now', code: 'limit' }, 429);
      case 'key_rejected':
        return json(request, { error: 'The service did not accept the key', code: 'key_rejected', httpStatus: outcome.httpStatus }, 502);
      default:
        return json(request, { error: 'The app could not be reached', code: 'unavailable' }, 502);
    }
  });
}
