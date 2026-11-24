import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { canonicalStartKey, retireStartKey } from '@/lib/computer';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    // The key the game gives up on (the start's own grammar)
    startKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

/**
 * POST /api/bots/:id/computer-jobs/start-retire { userId, isGuest?, startKey } (round 8; Opus's ruling on CodeRabbit's pass of game 24dea75c)
 * The game gives up on a key of an earlier, DIFFERENT ask that it holds open and Orbit never answered (its look found no job), before it goes on with the new ask under its own key. Under the person's lock:
 *  - a key with no attempt, or whose start came to nothing: retired, 200 `{ ok: true, retired: true }`. Every later send of that key is `{ ok: false, reason: 'retired_by_game' }` and makes nothing (a copy of it
 *    still on its way, delayed before it registered, included).
 *  - a key Orbit did see: 200 `{ ok: true, retired: false, answer }`, the start answer a send of it would get now, read only (nothing is tried, made or confirmed): that start happened, and the game follows it.
 * The same as `POST /api/bots/:id/computer-jobs { action: 'start-retire', userId, isGuest?, attempt }`. 503 `{ retry: true }` when who it was for could not be looked up just now. Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const who = await resolveUsagePerson(parsed.data.userId, parsed.data.isGuest);
    if (who.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    // A guest has no Brick computer and no start: there is nothing to follow
    if (!who.personId) return NextResponse.json({ ok: true, retired: true });
    return NextResponse.json({ ok: true, ...(await retireStartKey(id, who.personId, await canonicalStartKey(id, who.personId, parsed.data.startKey))) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not retire a start key:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
