import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { reviewAppSteps } from '@/lib/computer';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    // The connected app the Brick has been using, and how many steps of it it has taken in this answer so far
    app: z.string().trim().min(1).max(120),
    steps: z.number().int().min(1).max(10000),
  })
  .strict();

/**
 * POST /api/bots/:id/computer-route-review { userId, isGuest?, app, steps }
 * The bot server counts the steps a Brick takes with a connected app in one answer and asks here at 20 whether they have already cost as much as
 * the whole job would on the computer. `{ review: true }` means the Brick should look at moving the rest to the computer (advice only: nothing is
 * started, woken, reserved or written here). `{ review: false }` for everything else, including someone else's Brick, a guest, a computer that is
 * off, and a wind-down. Auth: service token only.
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
    if (!person.personId) return NextResponse.json({ review: false });
    return NextResponse.json(await reviewAppSteps(id, person.personId, { app: parsed.data.app, steps: parsed.data.steps }));
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not weigh the steps of an app:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
