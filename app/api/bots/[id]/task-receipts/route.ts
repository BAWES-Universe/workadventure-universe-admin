import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { closeReceipt, openReceipt, renewReceipt } from '@/lib/task-receipts';
import { paidBy } from '@/lib/paid-by';

export const runtime = 'nodejs';

const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    // The task: a computer job id, or the id the bot server gives an Instant task. One receipt for each Brick and task.
    taskKey: z.string().min(1).max(255),
    // open: the task begins. renew: the task is alive (a run starts, a turn ends). close: it ended (done), a failure on our side took nothing
    // (refunded), or an answer did not come back and it is being checked.
    action: z.enum(['open', 'renew', 'close']),
    // open only
    title: z.string().trim().min(1).max(120).optional(),
    runId: z.string().min(1).max(255).optional(),
    category: z.enum(['apps', 'computer']).optional(),
    // The most the task can take while it runs
    boundMicros: micros.optional(),
    // close and renew: the generation the receipt was opened under (the answer to open, renew or close says which it is on now)
    generation: z.number().int().min(1).max(2_147_483_647).optional(),
    // close only
    state: z.enum(['done', 'refunded', 'checking']).optional(),
    chargedMicros: micros.optional(),
  })
  .strict();

/**
 * POST /api/bots/:id/task-receipts - one receipt for each task, for Activity on the Usage page. The bot server opens it when a costly task
 * begins, renews it while the task lives and closes it when it ends; all three are safe to send any number of times.
 *
 * An open receipt is on a lease (10 minutes, renewed by every open and renew, and by Orbit itself when a run of the task goes out). A receipt
 * still running when its lease runs out is ended by Orbit's sweep from the task's run records, with no word from the bot server and no
 * message from the person, so nothing depends on the bot server staying up.
 *
 *  - `{ userId, taskKey, action: 'open', title, runId?, category?, boundMicros? }` answers `{ id, link, paidBy: { payer, payerName, label }, created, generation, leaseUntil }`:
 *    `link` is the "[What it used](#usage=<id>)" a reply can carry, and `paidBy.label` is the words for the status line ("Paid by you").
 *    `generation` is the turn the receipt is on: send it with every renew and close. Opening again renews a running receipt.
 *  - `{ userId, taskKey, action: 'renew', generation? }` answers `{ ok: true, id, state, generation, leaseUntil, renewed, stale? }`. `renewed` is false (and `leaseUntil`
 *    null) for a receipt that is not running; it is never brought back by a renewal. A `generation` older than the receipt's changes nothing and
 *    answers `stale: true` with the generation the receipt is on now: use that one from then on.
 *  - `{ userId, taskKey, action: 'close', state, chargedMicros?, generation? }` answers `{ ok: true, id, state, generation, stale? }`. `state` is where the receipt
 *    stands now: running is never an answer to a close, and a close for an older generation answers `stale: true` and changes nothing. A receipt that has ended stays
 *    as it ended (a second word, even a different one, changes nothing), unless its run records say it came to something else. Orbit reads how a
 *    task came to end from its Instant runs, not from `state`: all worked is done, some is partly done (`outcome` on Activity), none is refunded.
 *    `state` is the bot server's word for a task with no Instant run.
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
      const { payer, leaseUntil, ...receipt } = opened;
      return NextResponse.json({ ...receipt, leaseUntil: leaseUntil?.toISOString() ?? null, paidBy: paidBy(payer, person.personId) }, { status: opened.created ? 201 : 200 });
    }
    if (body.action === 'renew') {
      const renewed = await renewReceipt({ botId: id, taskKey: body.taskKey, personId: person.personId, generation: body.generation });
      return NextResponse.json(renewed.ok ? { ...renewed, leaseUntil: renewed.leaseUntil?.toISOString() ?? null } : { ok: false, reason: renewed.reason });
    }
    if (!body.state) return NextResponse.json({ error: 'A state is required to close a receipt' }, { status: 400 });
    const closed = await closeReceipt({ botId: id, taskKey: body.taskKey, personId: person.personId, state: body.state, chargedMicros: body.chargedMicros, generation: body.generation });
    return NextResponse.json(closed.ok ? closed : { ok: false, reason: closed.reason });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    Sentry.captureException(error, { tags: { area: 'task-receipts' } });
    console.error('[Receipts] Could not write a receipt:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
