import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { authorizeModelCall } from '@/lib/computer-calls';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    token: z.string().min(1).max(200),
    callId: z.string().min(1).max(80),
    estimateMicros: z.number().int().min(0).max(2_000_000_000),
    payer: z.enum(['universe', 'own-key']),
  })
  .strict();

/**
 * POST /api/computer/llm/authorize { token, callId, estimateMicros, payer } - before a model call a Brick's computer makes: the
 * computer's key is checked against Orbit's records and room for this one call is reserved from the person's computer allowance.
 * Answers { ok: true, jobId, botId, reservedMicros } or { ok: false, reason: refused | allowance | pool }: nothing is sent to an AI
 * provider unless it says ok. Whose AI it runs on is the bot server's to say (it reads the Brick's own AI policy); Orbit records who
 * paid when the call is settled. Asked again with the same callId it is the same call. Auth: service token only (the computer never calls this).
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
    const answer = await authorizeModelCall(parsed.data);
    return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not authorize a model call:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
