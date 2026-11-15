import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { closeReceipt, openReceipt } from '@/lib/task-receipts';
import { paidBy, payerOf } from '@/lib/paid-by';

export const runtime = 'nodejs';

const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    // The task: a computer job id, or the id the bot server gives an Instant task. One receipt for each Brick and task.
    taskKey: z.string().min(1).max(255),
    // open: the task begins. close: it ended (done), a failure on our side took nothing (refunded), or an answer did not come back and it is being checked.
    action: z.enum(['open', 'close']),
    // open only
    title: z.string().trim().min(1).max(120).optional(),
    runId: z.string().min(1).max(255).optional(),
    category: z.enum(['apps', 'computer']).optional(),
    // The most the task can take while it runs
    boundMicros: micros.optional(),
    // close only
    state: z.enum(['done', 'refunded', 'checking']).optional(),
    chargedMicros: micros.optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/task-receipts - one receipt for each task, for Activity on the Usage page. The bot server opens it when a costly task
 * begins and closes it when it ends; both are safe to send twice.
 *
 *  - `{ userId, taskKey, action: 'open', title, runId?, category?, boundMicros? }` answers `{ id, link, paidBy: { payer, payerName, label }, created }`:
 *    `link` is the "[What it used](#usage=<id>)" a reply can carry, and `paidBy.label` is the words for the status line ("Paid by you").
 *  - `{ userId, taskKey, action: 'close', state, chargedMicros? }` answers `{ ok: true, id, state }`. A receipt that is done or refunded stays as it ended.
 *
 * What a task used is never sent: it is read from the meter's books by the task's key. Only the title is the Brick's own words, kept short
 * and shown only to the person who asked. Auth: service token only.
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
    const body = parsed.data;
    const person = await resolveUsagePerson(body.userId, body.isGuest);
    // A guest has no credit and no Activity
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_allowed' });
    if (body.action === 'open') {
      if (!body.title) return NextResponse.json({ error: 'A title is required to open a receipt' }, { status: 400 });
      const opened = await openReceipt({ botId: id, personId: person.personId, taskKey: body.taskKey, title: body.title, runId: body.runId, category: body.category, boundMicros: body.boundMicros });
      return NextResponse.json({ ...opened, paidBy: paidBy(await payerOf(id), person.personId) }, { status: opened.created ? 201 : 200 });
    }
    if (!body.state) return NextResponse.json({ error: 'A state is required to close a receipt' }, { status: 400 });
    const closed = await closeReceipt({ botId: id, taskKey: body.taskKey, personId: person.personId, state: body.state, chargedMicros: body.chargedMicros });
    return NextResponse.json(closed.ok ? closed : { ok: false, reason: closed.reason });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    Sentry.captureException(error, { tags: { area: 'task-receipts' } });
    console.error('[Receipts] Could not write a receipt:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
