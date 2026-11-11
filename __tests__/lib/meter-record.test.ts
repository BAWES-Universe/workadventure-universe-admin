/**
 * The meter's one write path and the model calls copied into it (game #1998, Brick 7), with a stand-in for the database. What
 * only the database can show (the same event twice counts once, under many writers at once) is in meter-db.test.ts.
 */
import { prisma } from '@/lib/db';
import { recordMeterEvent, recordModelCall, type ModelCallFacts } from '@/lib/meter';
import { readMeterEvent, type MeterEventInput } from '@/lib/meter-values';

jest.mock('@/lib/db', () => ({
  prisma: {
    meterEvent: { createMany: jest.fn(), findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
  },
}));

const events = prisma.meterEvent as unknown as Record<'createMany' | 'findUnique', jest.Mock>;
const bots = prisma.bot as unknown as Record<'findUnique', jest.Mock>;

const input = (over: Partial<MeterEventInput> = {}): MeterEventInput => {
  const read = readMeterEvent({ eventId: 'e1', kind: 'app_use', personKey: 'person:sara', payerKind: 'universe', basis: 'estimated', quantity: 2, unit: 'use', costMicros: 300, botId: 'b1', ...over });
  if (!read.ok) throw new Error(read.error);
  return read.value;
};

beforeEach(() => {
  events.createMany.mockReset().mockResolvedValue({ count: 1 });
  events.findUnique.mockReset();
  bots.findUnique.mockReset().mockResolvedValue({ roomId: null, ownerId: 'sara' });
});

describe('writing an event once', () => {
  it('writes the figures as they were said, with the first write skipping a duplicate by id in the database itself', async () => {
    expect(await recordMeterEvent(input())).toEqual({ recorded: true, conflict: false });
    const call = events.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0]).toMatchObject({ eventId: 'e1', kind: 'app_use', pool: 'chat', personKey: 'person:sara', payerKind: 'universe', basis: 'estimated', quantity: BigInt(2), unit: 'use', costMicros: BigInt(300) });
  });

  it('writes nothing when the id was written before, and says so', async () => {
    events.createMany.mockResolvedValue({ count: 0 });
    events.findUnique.mockResolvedValue({ kind: 'app_use', personKey: 'person:sara', botId: 'b1', unit: 'use', quantity: BigInt(2), costMicros: BigInt(300), jobId: null });
    expect(await recordMeterEvent(input())).toEqual({ recorded: false, conflict: false });
  });

  it('says it is a conflict when the id was written before with other figures: the first stands', async () => {
    events.createMany.mockResolvedValue({ count: 0 });
    events.findUnique.mockResolvedValue({ kind: 'app_use', personKey: 'person:sara', botId: 'b1', unit: 'use', quantity: BigInt(5), costMicros: BigInt(300), jobId: null });
    expect(await recordMeterEvent(input())).toEqual({ recorded: false, conflict: true });
  });

  it('keeps an unknown price empty and never 0', async () => {
    await recordMeterEvent(input({ basis: 'unknown', costMicros: null }));
    expect(events.createMany.mock.calls[0][0].data[0].costMicros).toBeNull();
  });
});

describe('a model call copied from its usage row', () => {
  const facts = (over: Partial<ModelCallFacts> = {}): ModelCallFacts => ({
    usageRowId: 77,
    botId: 'b1',
    providerId: 'deepseek-flash',
    sentProviderId: 'universe-ai',
    keyOwnerId: null,
    talkedUserId: 'wa-sara',
    talkedPersonId: 'sara',
    talkedGuest: false,
    channel: 'dm',
    tokensUsed: 900,
    apiCalls: 1,
    error: false,
    greeting: false,
    costBasis: 'priced',
    costMicros: 1200,
    tokens: { input: 700, output: 200 },
    occurredAt: new Date('2026-11-11T10:00:00Z'),
    ...over,
  });
  const written = () => events.createMany.mock.calls[0][0].data[0];

  it('is one event under the usage row’s id, against the person who talked, the Brick and us as payer, chat’s pool', async () => {
    await recordModelCall(facts());
    expect(written()).toMatchObject({
      eventId: 'ai-usage:77',
      kind: 'model_call',
      pool: 'chat',
      personKey: 'person:sara',
      personId: 'sara',
      botId: 'b1',
      brick: true,
      payerKind: 'universe',
      payerPersonId: null,
      route: 'universe-ai',
      quantity: BigInt(1),
      unit: 'call',
      costMicros: BigInt(1200),
      basis: 'estimated',
      sourceRef: 'bots_ai_usage:77',
    });
    expect(written().detail).toMatchObject({ error: false, greeting: false, channel: 'dm', providerId: 'deepseek-flash', tokens: { input: 700, output: 200 } });
  });

  it('uses the bot server’s own id for the call when it sends one, so a report sent twice is one event', async () => {
    await recordModelCall(facts({ clientEventId: 'turn-9' }));
    expect(written().eventId).toBe('model:b1:turn-9');
    expect(written().sourceRef).toBe('bots_ai_usage:77');
  });

  it('is someone else’s bill when a key someone owns ran it, and never ours', async () => {
    await recordModelCall(facts({ sentProviderId: 'key-1', keyOwnerId: 'maker-1' }));
    expect(written()).toMatchObject({ payerKind: 'person', payerPersonId: 'maker-1', route: 'own-key', basis: 'paid_by_other' });
  });

  it('is a guest by their own id, never named', async () => {
    await recordModelCall(facts({ talkedPersonId: null, talkedGuest: true, talkedUserId: 'wa-guest' }));
    expect(written()).toMatchObject({ personKey: 'guest:wa-guest', personId: null });
  });

  it('is the owner’s when a Brick answered on its own with nobody talking, and nobody’s when a room bot did', async () => {
    await recordModelCall(facts({ talkedPersonId: null, talkedGuest: null, talkedUserId: null }));
    expect(written()).toMatchObject({ personKey: 'person:sara', personId: 'sara' });
    events.createMany.mockClear();
    bots.findUnique.mockResolvedValue({ roomId: 'room-1', ownerId: null });
    await recordModelCall(facts({ talkedPersonId: null, talkedGuest: null, talkedUserId: null }));
    expect(written()).toMatchObject({ personKey: 'unknown', brick: false });
  });

  it('says a price it does not have is unknown, and a failed call and a greeting are marked as what they are', async () => {
    await recordModelCall(facts({ costBasis: null, costMicros: null, error: true, greeting: true }));
    expect(written()).toMatchObject({ basis: 'unknown', costMicros: null });
    expect(written().detail).toMatchObject({ error: true, greeting: true });
  });

  it('never throws, so the books are never why a usage report fails', async () => {
    events.createMany.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordModelCall(facts())).resolves.toBeNull();
    spy.mockRestore();
  });
});
