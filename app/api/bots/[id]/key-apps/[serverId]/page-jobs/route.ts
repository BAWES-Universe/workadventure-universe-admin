import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { createPageJob } from '@/lib/app-direct/pay';

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
 * 200 { job } · 403 { allowed: false, reason } · 404 gone / not_found · 400 bad_terms / no_payments.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  return serviceRoute(request, 'making a page take payments', async () => {
    const { id, serverId } = await params;
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const outcome = await createPageJob({ botId: id, serverId, ...body.data });
    switch (outcome.status) {
      case 'ok':
        return json(request, { job: outcome.job, replaced: outcome.replaced });
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
