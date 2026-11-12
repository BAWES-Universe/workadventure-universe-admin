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
 *   { userId, action: pause | resume | done | reopen | delete | change, result? (done), change? }
 *   change: { words?, condition?, outcome?, cadence?, timeZone?, waitingFor?, statusLine?, steps? }
 * Every action raises the item's revision, so a run that already started is stopped at its next step. Asking twice gives
 * the item as it is. Answers { item }.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    requireServiceToken(request);
    const { id, itemId } = await params;
    const parsed = itemActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await changeItem(id, itemId, parsed.data);
    return answer.ok ? NextResponse.json({ item: answer.item }) : itemsRefused(answer);
  } catch (error) {
    return itemsFailed(error, 'Changing one');
  }
}
