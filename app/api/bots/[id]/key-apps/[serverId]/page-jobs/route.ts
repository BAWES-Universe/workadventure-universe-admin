import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { createPageJob, readPageJob } from '@/lib/app-direct/pay';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    requesterKey: z.string().trim().min(1).max(400).optional(),
    forOwner: z.boolean().optional(),
    artifactId: z.string().trim().min(1).max(100),
    /** Text or a number, read as exact text: never rounded. */
    amount: z.union([z.string().max(30), z.number()]),
    currency: z.string().trim().min(3).max(3),
    description: z.string().max(200).nullish(),
  })
  .strict();

/**
 * POST /api/bots/:id/key-apps/:serverId/page-jobs { requesterKey? | forOwner?, artifactId, amount, currency, description? } - the owner asked
 * their Brick to make a page of theirs take one fixed payment through this app (game #2044). Frozen here: the page and the visitor send
 * neither the amount nor the currency. Auth: BOT_SERVICE_TOKEN.
 * 200 { job, replaced, waitsForPublish } · 403 { allowed: false, reason } · 404 gone / not_found · 400 bad_terms / no_payments.
 * `waitsForPublish` is true when the page's link still shows an older published version: visitors cannot pay with these terms until the
 * owner publishes this version, so the Brick tells the owner the terms go live when they publish.
 * `job` is the job as it is SAVED, in canonical form: { id, artifactId, connectionId, app, amount (text), amountMinor (whole number),
 * currency (upper case), exponent (0, 2 or 3), description, status, active }. Compare these with what the owner asked for, not any text.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'making a page take payments', async () => {
    const { id, serverId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const outcome = await createPageJob({ botId: id, serverId, ...body.data });
    switch (outcome.status) {
      case 'ok':
        return json(request, { job: outcome.job, replaced: outcome.replaced, waitsForPublish: outcome.waitsForPublish });
      case 'refused':
        return json(request, { allowed: false, reason: outcome.reason }, outcome.reason === 'gone' ? 404 : 403);
      case 'not_found':
        return json(request, { error: 'Not found', code: 'not_found' }, 404);
      case 'no_payments':
        return json(request, { error: 'This app cannot take payments', code: 'no_payments' }, 400);
      default:
        return json(request, { error: outcome.message, code: 'bad_terms' }, 400);
    }
  });
}

/**
 * GET /api/bots/:id/key-apps/:serverId/page-jobs?artifactId=ID - the job this page has now, as it is saved, for a Brick that did not get a
 * clear answer to its write and must not write again to find out. Reads only: nothing is written and no use of the app is counted. Only the
 * job of this Brick's own app for the owner's own page; any other is the same 404. Auth: BOT_SERVICE_TOKEN.
 * 200 { job, waitsForPublish } (the same canonical form as above) · 404 { code: 'not_found' } · 400 when `artifactId` is missing.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'reading the payment job of a page', async () => {
    const { id, serverId } = await params;
    const artifactId = request.nextUrl.searchParams.get('artifactId')?.trim();
    if (!artifactId || artifactId.length > 100) return json(request, { error: 'Name the page', code: 'bad_request' }, 400);
    const outcome = await readPageJob({ botId: id, serverId, artifactId });
    return outcome.status === 'ok' ? json(request, { job: outcome.job, waitsForPublish: outcome.waitsForPublish }) : json(request, { error: 'Not found', code: 'not_found' }, 404);
  });
}
