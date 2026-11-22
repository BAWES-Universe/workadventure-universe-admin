import { NextRequest, NextResponse, after } from 'next/server';
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
    /** The provider and route the call will go to ("universe-ai:<providerId>"): a route failing for many people is paused for new work. Required for a call we fund (it is what the pause is checked by); optional for a person's own key. */
    route: z.string().min(1).max(120).nullable().optional(),
    /** The turn of the run the call is made for, and the run (a restart makes a new run that numbers turns again): kept with the admission, so a stop for our capacity that rests on this turn or an earlier one answers stale. */
    turn: z.number().int().min(0).max(100_000).nullable().optional(),
    run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional(),
  })
  .strict()
  // A call we pay for that names no route would reach the room unchecked while its provider's route is paused (a missing route matches no pause key): it is refused as malformed
  .refine((body) => body.payer !== 'universe' || (typeof body.route === 'string' && body.route.length > 0), { message: 'A route is required for a call the platform funds', path: ['route'] });

/**
 * POST /api/computer/llm/authorize { token, callId, estimateMicros, payer, route } - before a model call a Brick's computer makes: the
 * computer's key is checked against Orbit's records and room for this one call is reserved from the person's computer allowance.
 * Answers { ok: true, jobId, botId, reservedMicros } or { ok: false, reason: refused | allowance | pool | rule, full? }: nothing is sent to an AI
 * provider unless it says ok. `full` comes with reason `pool` only: true when the pool has no room even for the smallest call, or new work on the call's
 * route is paused (our decision), so the relay records it as a confirmed fault of ours (pool_busy); false when the call was refused for its own size. Whose AI it runs on is the bot server's to say (it reads the Brick's own AI policy); Orbit records who
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
    // The end of a job whose cutoff this call decides runs AFTER the answer has been sent: the relay is never kept waiting on the cleanup (the cutoff's record and the end of its keys are committed before the answer)
    const answer = await authorizeModelCall(parsed.data, undefined, (task) => after(task));
    return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not authorize a model call:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
