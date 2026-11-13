import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { z } from 'zod';
import { ITEM_KINDS, claimWork } from '@/lib/brick-items';
import { itemsFailed } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

const dueSchema = z.object({ kinds: z.array(z.enum(ITEM_KINDS)).max(ITEM_KINDS.length).optional() }).strict();

/**
 * POST /api/bricks/items/due
 * What the bot server runs now (game #2002): every reminder, schedule, watch and goal that has fallen due, one run each,
 * claimed once per due time so two servers or a retry never share one. Also a run it was handed and never reported, again,
 * with the same `runId` (look for what that run sent before writing it again). Universe's own scheduler: no provider timer
 * starts a run. Asked by the bot server every minute or so; nothing depends on exactly when.
 *
 * Auth: service token only.
 * Takes `{ kinds?: [reminder | schedule | watch | goal] }`: the kinds the bot server can run. It is handed, and handed out again, only
 * runs of those kinds, and a run of another kind is never claimed, never has a try counted and never counts as a failure (a watch or goal
 * that nothing tried is not failed). Without `kinds`, every kind.
 * `held` lists the watches, briefings and goals that now wait because their person's Universe AI usage for goals and tasks is used up, each
 * with `resumesAt` and a `waitId`: Brick says so once per wait and nothing runs until then. Confirm with
 * POST /api/bricks/items/held/:itemId/told { waitId } after saying it; an unconfirmed notice is handed out again after a while, so it is never lost.
 * A reminder is never held.
 * Answers { runs: [{ runId, itemId, brickId, userId, matrixUserId, kind, words, condition, outcome, steps, statusLine, timeZone, dueAt,
 * revision, late, fresh, attempt, leaseUntil, marker, deliveredEventId }], held: [{ itemId, brickId, userId, matrixUserId, kind, words, resumesAt, waitId }] }
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    // No body at all is every kind (a bot server from before this); an unknown field or kind is refused, never read as "all"
    const text = (await request.text()).trim();
    let body: unknown = {};
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const parsed = dueSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    return NextResponse.json(await claimWork(new Date(), undefined, undefined, parsed.data.kinds));
  } catch (error) {
    return itemsFailed(error, 'Claiming due runs');
  }
}
