import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { listRules, proposeRule } from '@/lib/spend-rules';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    // The bot server's own id for the message the person said it in: the same message sent twice is one rule
    sayingKey: z.string().min(1).max(200).optional(),
    // The task it was said during (a computer job or an Instant task), when there is one
    taskKey: z.string().min(1).max(255).optional(),
    scope: z.enum(['task', 'bot', 'person']).optional(),
    period: z.enum(['task', 'day', 'month']).optional(),
    // Millionths of a dollar, as the person said it ($1 is 1000000). 0 means nothing may be spent.
    capMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    onlyOwnAccounts: z.boolean().optional(),
    covers: z.enum(['apps', 'computer', 'all']).optional(),
  })
  .strict();

/**
 * GET /api/bots/:id/spend-rules?userId=&isGuest= - the rules this person has said that reach this Brick (its own, and the ones for
 * everything they pay for), so Brick can show them when asked. Answers { rules: [{ id, words, scope, ... }] }. Guests have none.
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(userId, request.nextUrl.searchParams.get('isGuest') === 'true');
    return NextResponse.json({ rules: person.personId ? await listRules(person.personId, { botId: id }) : [] });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'spend-rules' } });
    console.error('[Rules] Could not read rules:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/bots/:id/spend-rules { userId, isGuest?, sayingKey?, taskKey?, scope?, period?, capMicros?, onlyOwnAccounts?, covers? }
 * The bot server turns something a person said in chat ("only use my accounts", "no more than $1 for this bot") into a rule the
 * server holds. It sends what the words mean, never the words: nothing the person wrote is kept.
 *
 * Answers one of:
 *  - `{ ok: true, rule, created }` the rule is saved (the same message again finds it: `created: false`); `rule.words` is the sentence
 *    to show the person so they can correct it;
 *  - `{ ok: false, reason: 'needs_answer', ask: { about, question, options } }` the rule is missing one thing to be clear ("$1 for each
 *    task, each day or each month?"): Brick asks that one question, then sends the same call again with the answer;
 *  - `{ ok: false, reason: 'not_allowed' }` only the person who pays (a Brick's owner, or a room bot's universe owner) makes rules
 *    about a bot; a guest never has any to make.
 *
 * Auth: service token only.
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
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_allowed' });
    const said = parsed.data;
    const result = await proposeRule({
      botId: id,
      speakerId: person.personId,
      sayingKey: said.sayingKey,
      taskKey: said.taskKey,
      scope: said.scope,
      period: said.period,
      capMicros: said.capMicros,
      onlyOwnAccounts: said.onlyOwnAccounts,
      covers: said.covers,
    });
    if (!result.ok && result.reason === 'invalid') return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result, { status: result.ok && result.created ? 201 : 200 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'spend-rules' } });
    console.error('[Rules] Could not save a rule:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
