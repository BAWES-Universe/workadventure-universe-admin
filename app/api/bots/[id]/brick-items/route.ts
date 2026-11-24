import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { createItem, listItems, newItemSchema } from '@/lib/brick-items';
import { itemsFailed, itemsRefused } from '@/lib/brick-item-api';

export const runtime = 'nodejs';

/**
 * Goals and tasks (game #2002): a reminder, a schedule, a watch or a goal a person gave their Brick. Only the owner of Brick
 * :id, in their own chat with it (`userId` is their game uuid or email); for anyone else, a room bot and the Brick for
 * guests the answer is the same as for a Brick that does not exist.
 *
 * Auth: service token only.
 *
 * GET /api/bots/:id/brick-items?userId=...
 *   { items }  this person's goals and tasks on this Brick that are still wanted, the soonest due first
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const answer = await listItems(id, userId);
    return answer.ok ? NextResponse.json({ items: answer.items }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Listing');
  }
}

/**
 * POST /api/bots/:id/brick-items
 *   { userId, kind: reminder | schedule | watch | goal, words, condition? (watch), outcome? (goal), cadence, timeZone?, waitingFor?, parentId? }
 *   cadence: { type: "once", at } | { type: "daily", time: "07:30", days: [0..6] } | { type: "every", minutes } | { type: "none" }
 * Answers 201 { item }, or a refusal the Brick says plainly, each with a `code`: needs_time_zone (none kept for this person
 * yet), too_often (with `limit`, the shortest wait in minutes), too_many (with `limit`), past, needs_wait, needs_goal, off.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const parsed = newItemSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await createItem(id, parsed.data);
    return answer.ok ? NextResponse.json({ item: answer.item }, { status: 201 }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Setting one');
  }
}
