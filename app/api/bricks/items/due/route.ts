import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { claimWork } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * POST /api/bricks/items/due
 * What the bot server runs now (game #2002): every reminder, schedule, watch and goal that has fallen due, one run each,
 * claimed once per due time so two servers or a retry never share one. Also a run it was handed and never reported, again,
 * with the same `runId` (look for what that run sent before writing it again). Universe's own scheduler: no provider timer
 * starts a run. Asked by the bot server every minute or so; nothing depends on exactly when.
 *
 * Auth: service token only.
 * `held` lists the watches, briefings and goals that now wait because their person's Universe AI usage for goals and tasks is used up, each
 * with `resumesAt` and a `waitId`: Brick says so once per wait and nothing runs until then. Confirm with
 * POST /api/bricks/items/held/:itemId/told { waitId } after saying it; an unconfirmed notice is handed out again after a while, so it is never lost.
 * A reminder is never held.
 * Answers { runs: [{ runId, itemId, brickId, userId, chatId, kind, words, condition, outcome, steps, statusLine, timeZone, dueAt,
 * revision, late, fresh, attempt, leaseUntil, marker, deliveredEventId }], held: [{ itemId, brickId, userId, chatId, kind, words, resumesAt, waitId }] }
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await claimWork());
  } catch (error) {
    return itemsFailed(error, 'Claiming due runs');
  }
}
