import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { changeItem, itemActionSchema, readItem } from '@/lib/brick-items';
import { itemsFailed, itemsRefused } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * One goal or task of the owner of Brick :id (game #2002). Auth: service token only.
 *
 * GET /api/bots/:id/brick-items/:itemId?userId=...  { item }
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    requireServiceToken(request);
    const { id, itemId } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const answer = await readItem(id, itemId, userId);
    return answer.ok ? NextResponse.json({ item: answer.item }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Reading one');
  }
}

/**
 * PATCH /api/bots/:id/brick-items/:itemId
 *   { userId, action: pause | resume | done | reopen | delete | change | snooze | run, result? (done), change?, key? (run) }
 *   run: Run now. One extra run of this item, asked for by the owner: the next time it comes is not moved, a pause they chose is not undone, and
 *     it passes the same checks as a scheduled run (Brick on, usage, runs a day), so it is refused with a code when it can't: off, needs_setup,
 *     needs_goal, wrong_state, busy (one is running), no_room (with `until`), runs_a_day. `key` is its own idempotency key: the same key is the same
 *     run. Answers { item, run: { runId, state, replay } }; the item is not changed and its revision does not move.
 *   snooze: a reminder or briefing comes back after the Limits setting "Snooze" (starting value 1 hour); a one-off that was just delivered is switched on again for that time
 *   change: { words?, condition?, outcome?, cadence?, timeZone?, waitingFor?, statusLine?, steps? }
 * Every action but run raises the item's revision, so a run that already started is stopped at its next step. Asking twice gives
 * the item as it is, except `snooze`, which has two cases. A one-off that is not due yet moves from its due time, so asking again puts it back by
 * another delay: a caller that retries must not retry a snooze that was answered. Anything else (a repeating reminder or briefing, or a one-off that was just
 * delivered) comes back the delay after the tap, whatever it was due before: at 10:00 with a 60-minute delay, a repeating one due at 12:00 is due at 11:00
 * (earlier), and asking again later moves it to the delay after that tap, not by another delay. Answers { item }.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    requireServiceToken(request);
    const { id, itemId } = await params;
    const parsed = itemActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await changeItem(id, itemId, parsed.data);
    return answer.ok ? NextResponse.json({ item: answer.item, ...(answer.run ? { run: answer.run } : {}) }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Changing one');
  }
}
