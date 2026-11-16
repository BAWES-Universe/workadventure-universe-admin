import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { ownerAsker } from '@/lib/instant/asker';
import { giveBack, instantRunKey } from '@/lib/instant/executor';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    botId: z.string().min(1),
    requesterKey: z.string().trim().min(1).max(400).optional(),
    forOwner: z.boolean().optional(),
    /** The call id of the run that "Didn't work". */
    callId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * POST /api/instant/giveback - "Didn't work" on an Instant run that was charged: a bounded goodwill give-back, once per run, inside the
 * limits a super admin set (none is assumed). A run Universe saw fail was never charged and needs none. 200 { status: 'given', amountMicros }
 * or { status: 'refused', reason }. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'giving back an Instant run', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const personId = await ownerAsker(body.data.botId, body.data);
    if (!personId) return json(request, { error: 'Not found' }, 404);
    const run = await prisma.instantRun.findUnique({ where: { runKey: instantRunKey(body.data.botId, body.data.callId) }, select: { id: true } });
    if (!run) return json(request, { status: 'refused', reason: 'not_found' });
    return json(request, await giveBack({ personId, runId: run.id }));
  });
}
