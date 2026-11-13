import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { corsHeaders } from '@/lib/cors';
import { itemActionSchema } from '@/lib/brick-items';
import { changeFromScreen } from '@/lib/brick-item-screens';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const tapSchema = itemActionSchema.omit({ userId: true });

/**
 * PATCH /api/bricks/:id/items/:itemId   { action: pause | resume | done | reopen | snooze | delete, result? }
 * The owner's own tap on their Goals and tasks screen (game #2002): Pause, Resume, Mark done, Reopen, Snooze, Delete. The same rules as when
 * their Brick does it in chat: every change raises the item's revision, so nothing new starts once it is saved. Changing what it says or
 * when happens in the Brick's chat, in the person's own words (there is no form), so `change` is not taken here.
 * Answers { item }, or a refusal with a `code` (wrong_state, off).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const parsed = tapSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || parsed.data.action === 'change' || parsed.data.change) return brickJson(request, { error: 'Invalid input data', details: parsed.success ? undefined : parsed.error.issues }, 400);
    const answer = await changeFromScreen(owner.userId, id, itemId, parsed.data);
    if (answer.ok) return brickJson(request, { item: answer.item });
    return brickJson(request, { error: answer.error, ...(answer.code ? { code: answer.code } : {}) }, answer.status);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'brick-items' } });
    console.error('Error changing a goal or task:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}
