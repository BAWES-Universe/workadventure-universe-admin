import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { startJob } from '@/lib/computer';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    title: z.string().trim().min(1).max(200),
    writes: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/computer-jobs { userId, isGuest?, title, writes? }
 * The bot server starts a job on a Brick's computer (game #2000), after it chose the computer as the way (an app that can do it for
 * less wakes no computer: that choice is made before this call, and this call is the only thing that can make or wake a machine).
 * Only the Brick's owner starts work on it: whoever else is talking to the Brick gets `not_owner`. Answers with the job and why
 * it waits if it does: `turn` (another job is writing), `allowance` (the person's own is used up: "Ask for more"), `busy` or
 * `pool` (wait in line, nothing to ask for), or `{ ok: false, reason }` when it cannot start at all.
 *
 * Auth: service token only.
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
    const person = await resolveUsagePerson(parsed.data.userId, parsed.data.isGuest);
    // A guest never has a Brick computer: a Brick belongs to an account
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_owner' });
    const started = await startJob({ botId: id, personId: person.personId, title: parsed.data.title, writes: parsed.data.writes });
    return NextResponse.json(started.ok ? { ok: true, job: started.job, restoredFrom: started.restoredFrom } : { ok: false, reason: started.reason });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not start a job:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
