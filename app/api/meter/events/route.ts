import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { describeBot, recordMeterEvent } from '@/lib/meter';
import { personKeyOf, readMeterEvent } from '@/lib/meter-values';

export const runtime = 'nodejs';

/** The most events one request may carry. */
const MAX_EVENTS = 100;

export type EventResult = { eventId: string | null; status: 'recorded' | 'duplicate' | 'conflict' | 'invalid' | 'unknown_bot'; error?: string };

async function write(raw: unknown): Promise<EventResult> {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const eventId = typeof body.eventId === 'string' ? body.eventId.slice(0, 255) : null;

  // Who it was for and which Brick did it are worked out here, never taken from the request: a person's key, their account and whether the bot is a Brick are ours to say
  const botId = typeof body.botId === 'string' && body.botId ? body.botId : null;
  const bot = botId ? await describeBot(botId) : null;
  if (botId && !bot) return { eventId, status: 'unknown_bot', error: 'Bot not found' };
  let personId: string | null = null;
  let guestId: string | null = null;
  if (typeof body.userId === 'string' && body.userId) {
    const person = await resolveUsagePerson(body.userId.slice(0, 255), body.isGuest);
    personId = person.personId;
    guestId = !personId && person.guest !== false ? body.userId : null;
  }
  // Work a Brick does on its own, with nobody talking to it, is its owner's
  if (!personId && !guestId && bot?.brick) personId = bot.ownerId;

  const checked = readMeterEvent({ ...body, personKey: personKeyOf({ personId, guestId }), personId, brick: bot ? bot.brick : null });
  if (!checked.ok) return { eventId, status: 'invalid', error: checked.error };
  const result = await recordMeterEvent(checked.value);
  return { eventId: checked.value.eventId, status: result.recorded ? 'recorded' : result.conflict ? 'conflict' : 'duplicate' };
}

/**
 * POST /api/meter/events { ...event } or { events: [...] } - the one way anything but a model call (an app use, a computer minute,
 * a size change, stored bytes, speech) gets into the meter's books (game #1998). Written once under `eventId`: the same id again
 * is a "duplicate" and adds nothing, and the same id with other figures is a "conflict" and adds nothing either.
 * Answers 200 with one result for each event, so a bad one never hides a good one.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const list = typeof body === 'object' && body !== null && Array.isArray((body as { events?: unknown }).events) ? ((body as { events: unknown[] }).events) : [body];
  if (list.length === 0) return NextResponse.json({ error: 'No events' }, { status: 400 });
  if (list.length > MAX_EVENTS) return NextResponse.json({ error: `At most ${MAX_EVENTS} events in one request` }, { status: 400 });
  try {
    const results: EventResult[] = [];
    // One after another, so two events of one request that share an id are a recorded and a duplicate, in that order
    for (const event of list) results.push(await write(event));
    return NextResponse.json({ results });
  } catch (error) {
    console.error('[Meter] Could not record events:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
