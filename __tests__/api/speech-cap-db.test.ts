/**
 * The month's stops on the speech Universe AI pays for, in money (billing consensus v2, P2 and P3), against a real database. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { saveMeterSettings } from '@/lib/meter';
import { checkSpeechCap, speechSpent, type SpeechAsk } from '@/lib/speech-cap';
import { getRateCard } from '@/lib/speech-rates';
import type { SpeechHeld } from '@/lib/speech-reserved';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const NOW = new Date('2031-06-15T12:00:00Z');
let sara = '';
let omar = '';
let before: { value: unknown } | null = null;

const NONE: SpeechHeld = { mineSeconds: 0, openMicros: 0, unknownMicros: 0, nextEndsInSeconds: null, parts: { notes: { open: 0, unknown: 0 }, replies: { open: 0, unknown: 0 }, hearing: { open: 0, unknown: 0 } } };
const held = (all: Partial<typeof NONE> = {}, mine: Partial<typeof NONE> = {}): SpeechAsk['held'] => ({ all: { ...NONE, ...all }, mine: { ...NONE, ...mine } });
const ask = (personId: string | null, memberSeconds: number, exposureMicros: number, h: SpeechAsk['held'] = held()): SpeechAsk => ({ personId, memberSeconds, exposureMicros, held: h });

/** One metered second of speech: with a price when `micros` is given, else as written before there was a price. */
const speech = (who: { id: string } | null, seconds: number, over: { payerKind?: string; at?: Date; micros?: number; part?: 'hearing' | 'speaking' } = {}) =>
  prisma.meterEvent.create({
    data: {
      eventId: `speech:cap:${tag}:${randomUUID()}`,
      kind: 'speech',
      pool: 'chat',
      occurredAt: over.at ?? NOW,
      personKey: who ? `person:${who.id}` : 'unknown',
      personId: who?.id ?? null,
      payerKind: over.payerKind ?? 'universe',
      quantity: BigInt(seconds),
      unit: 'second',
      costMicros: over.micros === undefined ? null : BigInt(over.micros),
      basis: over.micros === undefined ? 'unknown' : 'estimated',
      detail: over.part ? { part: over.part } : undefined,
    },
  });

run('the month’s stops on speech Universe AI pays for, in a real database', () => {
  beforeAll(async () => {
    before = await prisma.appSetting.findUnique({ where: { key: 'meter' }, select: { value: true } });
    sara = (await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'Sara' } })).id;
    omar = (await prisma.user.create({ data: { uuid: `omar-${tag}`, email: `omar-${tag}@example.test`, name: 'Omar' } })).id;
  });
  afterAll(async () => {
    await prisma.meterEvent.deleteMany({ where: { eventId: { startsWith: `speech:cap:${tag}` } } });
    if (before) await prisma.appSetting.update({ where: { key: 'meter' }, data: { value: before.value as never } });
    else await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.meterEvent.deleteMany({ where: { eventId: { startsWith: `speech:cap:${tag}` } } });
    // The months in these cases are in 2031, with nothing else in them: a budget of 1,000,000 millionths (one dollar), 300 s a person
    await saveMeterSettings({ speechBudgetMicros: 1_000_000, speechMemberCeilingSeconds: 300 }, sara);
  });

  it('lets a use through while it fits a person’s own entitlement, and holds it back the moment it would pass it, naming the next month as when it carries on', async () => {
    await speech({ id: sara }, 200, { micros: 100 });
    expect(await checkSpeechCap(ask(sara, 100, 100), NOW)).toBeNull();
    expect(await checkSpeechCap(ask(sara, 101, 100), NOW)).toEqual({ stopped: 'person', reason: 'person', resetsAt: '2031-07-01T00:00:00.000Z' });
    // What is set aside for them counts against their own entitlement too
    expect(await checkSpeechCap(ask(sara, 60, 100, held({}, { mineSeconds: 41 })), NOW)).toMatchObject({ stopped: 'person' });
    // Another person still has theirs
    expect(await checkSpeechCap(ask(omar, 300, 100), NOW)).toBeNull();
  });

  it('carries on past 100 metered hours while the budget allows: hours are no longer a stop', async () => {
    await saveMeterSettings({ speechBudgetMicros: 1_000_000_000, speechMemberCeilingSeconds: 10_000_000 }, sara);
    // 101 hours heard by many people, at a fraction of a cent an hour
    await speech({ id: omar }, 101 * 3_600, { micros: 5_000 });
    expect(await checkSpeechCap(ask(sara, 60, 2_000), NOW)).toBeNull();
    expect((await speechSpent(prisma, await getRateCard(prisma), NOW)).seconds).toBe(101 * 3_600);
  });

  it('stops everyone at the month’s Speech budget, all people together including someone nobody could name, as "budget"', async () => {
    await saveMeterSettings({ speechMemberCeilingSeconds: 1_000_000 }, sara);
    await speech({ id: sara }, 100, { micros: 300_000 });
    await speech({ id: omar }, 100, { micros: 300_000 });
    await speech(null, 100, { micros: 300_000 });
    // 900,000 of 1,000,000 spent: 100,000 fits, 100,001 does not
    expect(await checkSpeechCap(ask(omar, 10, 100_000), NOW)).toBeNull();
    expect(await checkSpeechCap(ask(omar, 10, 100_001), NOW)).toMatchObject({ stopped: 'budget', reason: 'budget' });
    expect(await checkSpeechCap(ask(null, 10, 100_001), NOW)).toMatchObject({ stopped: 'budget', reason: 'budget' });
  });

  it('keeps what is only set aside apart from what is spent or unknown: waiting helps for the first ("hold"), never for the others ("budget")', async () => {
    await speech({ id: sara }, 100, { micros: 500_000 });
    // 500,000 spent; 300,000 set aside for a reply still going on: 200,000 more fits only if that were freed
    expect(await checkSpeechCap(ask(omar, 10, 200_000, held({ openMicros: 300_000, nextEndsInSeconds: 20 })), NOW)).toBeNull();
    expect(await checkSpeechCap(ask(omar, 10, 300_000, held({ openMicros: 300_000, nextEndsInSeconds: 20 })), NOW)).toEqual({
      stopped: 'hold',
      reason: 'hold',
      resetsAt: '2031-07-01T00:00:00.000Z',
      retryAfterSeconds: 20,
    });
    // Money with no receipt is counted unknown: it stays counted, and waiting does not free it
    expect(await checkSpeechCap(ask(omar, 10, 300_000, held({ unknownMicros: 300_000 })), NOW)).toMatchObject({ stopped: 'budget' });
    // More than the whole budget on its own is never helped by waiting
    expect(await checkSpeechCap(ask(omar, 10, 600_000, held({ openMicros: 300_000 })), NOW)).toMatchObject({ stopped: 'budget' });
  });

  it('counts only what Universe AI paid for, and only this month, and values seconds written without a price at the current rates (never as 0)', async () => {
    await speech({ id: sara }, 290, { payerKind: 'person', micros: 900_000 });
    await speech({ id: sara }, 290, { at: new Date('2031-05-31T23:59:59Z'), micros: 900_000 });
    expect(await checkSpeechCap(ask(sara, 300, 1_000_000), NOW)).toBeNull();
    expect(await checkSpeechCap(ask(sara, 300, 1_000_000), new Date('2031-05-31T23:59:59Z'))).toMatchObject({ stopped: 'person' });
    // An hour of hearing written with no price is worth the card's hearing rate, not 0
    await speech({ id: omar }, 3_600, { part: 'hearing' });
    const spent = await speechSpent(prisma, await getRateCard(prisma), NOW);
    expect(spent.unpricedMicros).toBeGreaterThan(0);
    expect(spent.micros).toBe(spent.unpricedMicros);
  });

  it('stops all of it while a setting is empty, and 0 pauses it', async () => {
    await saveMeterSettings({ speechBudgetMicros: null }, sara);
    expect(await checkSpeechCap(ask(sara, 1, 1), NOW)).toMatchObject({ stopped: 'not_set' });
    await saveMeterSettings({ speechBudgetMicros: 1_000_000, speechMemberCeilingSeconds: null }, sara);
    expect(await checkSpeechCap(ask(sara, 1, 1), NOW)).toMatchObject({ stopped: 'not_set' });
    await saveMeterSettings({ speechMemberCeilingSeconds: 0 }, sara);
    expect(await checkSpeechCap(ask(sara, 1, 1), NOW)).toMatchObject({ stopped: 'person' });
    await saveMeterSettings({ speechMemberCeilingSeconds: 300, speechBudgetMicros: 0 }, sara);
    expect(await checkSpeechCap(ask(sara, 1, 1), NOW)).toMatchObject({ stopped: 'budget' });
  });

  it('applies a changed setting to the very next check, with no restart', async () => {
    await speech({ id: sara }, 100, { micros: 900_000 });
    expect(await checkSpeechCap(ask(sara, 10, 150_000), NOW)).toMatchObject({ stopped: 'budget' });
    await saveMeterSettings({ speechBudgetMicros: 2_000_000 }, sara);
    expect(await checkSpeechCap(ask(sara, 10, 150_000), NOW)).toBeNull();
    await saveMeterSettings({ speechMemberCeilingSeconds: 105 }, sara);
    expect(await checkSpeechCap(ask(sara, 10, 150_000), NOW)).toMatchObject({ stopped: 'person' });
  });
});
