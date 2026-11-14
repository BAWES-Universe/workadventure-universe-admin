import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { releaseModelCall, settleModelCall } from '@/lib/computer-calls';

export const runtime = 'nodejs';

const count = z.number().int().min(0).max(2_000_000_000).nullable().optional();
const bodySchema = z
  .object({
    jobId: z.string().min(1).max(64),
    callId: z.string().min(1).max(80),
    // Nothing was sent to a provider: the room is given back and nothing is written
    sent: z.boolean().default(true),
    costMicros: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    basis: z.enum(['measured', 'estimated', 'unknown']).optional(),
    payerPersonId: z.string().min(1).max(64).nullable().optional(),
    route: z.enum(['universe-ai', 'own-key', 'provider']).optional(),
    tokens: z.object({ input: count, output: count, cached: count, reasoning: count }).strict().optional(),
    cutShort: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/computer/llm/settle { jobId, callId, sent?, costMicros, basis, payerPersonId?, route, tokens?, cutShort? } - after a model
 * call a computer made, however it ended (finished, cut off, failed): what it cost goes to the books once and its room is settled.
 * A price that is not known (`costMicros` null) settles at the room held, never at 0. With `sent: false` the call never went out and
 * its room is given back. Safe to send twice. Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const body = parsed.data;
    if (!body.sent) {
      await releaseModelCall(body.jobId, body.callId);
      return NextResponse.json({ ok: true });
    }
    const answer = await settleModelCall(body.jobId, body.callId, {
      costMicros: body.costMicros ?? null,
      basis: body.basis ?? 'unknown',
      payer: body.payerPersonId ? { kind: 'person', personId: body.payerPersonId } : { kind: 'universe' },
      route: body.route ?? (body.payerPersonId ? 'own-key' : 'universe-ai'),
      tokens: body.tokens,
      cutShort: body.cutShort,
    });
    return NextResponse.json(answer, { status: answer.ok ? 200 : 404 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not settle a model call:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
