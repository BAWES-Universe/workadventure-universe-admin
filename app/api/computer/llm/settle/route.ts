import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { releaseModelCall, settleModelCall, settleStep } from '@/lib/computer-calls';

export const runtime = 'nodejs';

const count = z.number().int().min(0).max(2_000_000_000).nullable().optional();
const micros = z.number().int().min(0).max(2_000_000_000);

/** Version 1: today's body. No `contract` field. */
const bodyV1 = z
  .object({
    jobId: z.string().min(1).max(64),
    callId: z.string().min(1).max(80),
    // Nothing was sent to a provider: the room is given back and nothing is written
    sent: z.boolean().default(true),
    costMicros: micros.nullable().optional(),
    basis: z.enum(['measured', 'estimated', 'unknown']).optional(),
    payerPersonId: z.string().min(1).max(64).nullable().optional(),
    route: z.enum(['universe-ai', 'own-key', 'provider']).optional(),
    tokens: z.object({ input: count, output: count, cached: count, reasoning: count }).strict().optional(),
    cutShort: z.boolean().optional(),
  })
  .strict();

/** Version 2 (docs/computer-llm-contract-v2.md): `contract: 2`, the step is named by its `operationId`, and the price charged and the provider's bill are two figures. */
const bodyV2 = z
  .object({
    contract: z.literal(2),
    jobId: z.string().min(1).max(64),
    operationId: z.string().min(1).max(80),
    sent: z.boolean().default(true),
    costMicros: micros.nullable().optional(),
    providerCostMicros: micros.nullable().optional(),
    basis: z.enum(['measured', 'estimated', 'unknown']).optional(),
    payerPersonId: z.string().min(1).max(64).nullable().optional(),
    route: z.enum(['universe-ai', 'own-key', 'provider']).optional(),
    tokens: z.object({ input: count, output: count, cached: count, reasoning: count, cacheWrite: count, cacheWrite1h: count }).strict().optional(),
    unexplained: z.object({ tokens: count, costMicros: count }).strict().optional(),
    cutShort: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/computer/llm/settle - after a model call a computer made, however it ended (finished, cut off, failed): what it cost goes to the
 * books once and its room is settled. Version 1 `{ jobId, callId, sent?, costMicros, basis, payerPersonId?, route, tokens?, cutShort? }`: a price
 * that is not known (`costMicros` null) settles at the room held, never at 0. Version 2 (`contract: 2`) keeps a measured zero at zero, an unknown
 * price unknown (counted in the pool at what was held), corrects a first unknown entry once when a late receipt comes, and answers
 * `{ ok, contract, operationId, state, chargedMicros, providerCostMicros }`. With `sent: false` the call never went out and its room is given
 * back. Safe to send twice. Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const raw = await request.json().catch(() => null);
    const wantsV2 = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'contract' in raw;
    if (wantsV2) {
      const parsed = bodyV2.safeParse(raw);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
      const body = parsed.data;
      if (!body.sent) {
        await releaseModelCall(body.jobId, body.operationId);
        return NextResponse.json({ ok: true, contract: 2 });
      }
      const answer = await settleStep({ ...body, payerPersonId: body.payerPersonId ?? null });
      if (!answer.ok) return NextResponse.json({ ok: false, reason: answer.reason }, { status: 404 });
      return NextResponse.json({ ok: true, contract: 2, operationId: body.operationId, state: answer.state, chargedMicros: answer.chargedMicros, providerCostMicros: answer.providerCostMicros });
    }
    const parsed = bodyV1.safeParse(raw);
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
