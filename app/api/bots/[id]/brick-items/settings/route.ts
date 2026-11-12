import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { itemSettings, keepWorkweek } from '@/lib/brick-items';
import { itemsFailed, itemsRefused } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * What a Brick needs to know about its owner before it sets a goal or task (game #2002): their time zone (kept from their own
 * device, never guessed) and the days they work (their own answer, never guessed from a country), and the limits that decide
 * what can be set. Only for the owner of Brick :id. Auth: service token only.
 *
 * GET /api/bots/:id/brick-items/settings?userId=...
 *   { timeZone: string | null, workdays: number[] | null (0 is Sunday), limits }
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const answer = await itemSettings(id, userId);
    if (!answer.ok) return itemsRefused(answer);
    const { itemsPerPerson, shortestRepeat, runsPerDay, longestRun } = answer.limits;
    return NextResponse.json({ timeZone: answer.timeZone, workdays: answer.workdays, limits: { itemsPerPerson, shortestRepeat, runsPerDay, longestRun } });
  } catch (error) {
    return itemsFailed(error, 'Reading settings');
  }
}

const workweekSchema = z.object({ userId: z.string().trim().min(1).max(320), days: z.array(z.number()).max(7) }).strict();

/**
 * PUT /api/bots/:id/brick-items/settings   { userId, days: [0..6] }
 *   Keeps the days the person works, their answer to the Brick's one-line question. Answers { workdays }.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const parsed = workweekSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await keepWorkweek(id, parsed.data.userId, parsed.data.days);
    return answer.ok ? NextResponse.json({ workdays: answer.workdays }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Keeping the workweek');
  }
}
