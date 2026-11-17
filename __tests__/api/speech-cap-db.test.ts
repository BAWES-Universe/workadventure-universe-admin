/**
 * The month's spending stop on the speech Universe AI pays for (0.5.0 spend caps, gap F4), against a real database. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { saveMeterSettings } from '@/lib/meter';
import { checkSpeechCap } from '@/lib/speech-cap';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const NOW = new Date('2031-06-15T12:00:00Z');
let sara = '';
let omar = '';
let before: { value: unknown } | null = null;

const speech = (who: { id: string } | null, seconds: number, over: { payerKind?: string; at?: Date } = {}) =>
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
      basis: 'unknown',
    },
  });

run('the month’s stop on speech Universe AI pays for, in a real database', () => {
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
    await saveMeterSettings({ speechCeilingSeconds: 1_000, speechMemberCeilingSeconds: 300 }, sara);
  });

  it('lets a use through while it fits, and holds it back the moment it would pass the person’s Limit, naming the next month as when it carries on', async () => {
    await speech({ id: sara }, 200);
    expect(await checkSpeechCap({ personId: sara, seconds: 100 }, NOW)).toBeNull();
    expect(await checkSpeechCap({ personId: sara, seconds: 101 }, NOW)).toEqual({ stopped: 'person', resetsAt: '2031-07-01T00:00:00.000Z' });
    // Another person still has theirs
    expect(await checkSpeechCap({ personId: omar, seconds: 300 }, NOW)).toBeNull();
  });

  it('holds everyone back at the month’s Limit for all people together, including someone nobody could name', async () => {
    await saveMeterSettings({ speechMemberCeilingSeconds: 1_000 }, sara);
    await speech({ id: sara }, 250);
    await speech({ id: omar }, 250);
    await speech(null, 400);
    expect(await checkSpeechCap({ personId: omar, seconds: 100 }, NOW)).toBeNull();
    expect(await checkSpeechCap({ personId: omar, seconds: 101 }, NOW)).toMatchObject({ stopped: 'month' });
    expect(await checkSpeechCap({ personId: null, seconds: 101 }, NOW)).toMatchObject({ stopped: 'month' });
  });

  it('counts only what Universe AI paid for, and only this month', async () => {
    await speech({ id: sara }, 290, { payerKind: 'person' });
    await speech({ id: sara }, 290, { at: new Date('2031-05-31T23:59:59Z') });
    expect(await checkSpeechCap({ personId: sara, seconds: 300 }, NOW)).toBeNull();
    expect(await checkSpeechCap({ personId: sara, seconds: 300 }, new Date('2031-05-31T23:59:59Z'))).toMatchObject({ stopped: 'person' });
  });

  it('stops all of it while a Limit is empty, and 0 pauses it', async () => {
    await saveMeterSettings({ speechCeilingSeconds: null }, sara);
    expect(await checkSpeechCap({ personId: sara, seconds: 1 }, NOW)).toMatchObject({ stopped: 'not_set' });
    await saveMeterSettings({ speechCeilingSeconds: 1_000, speechMemberCeilingSeconds: null }, sara);
    expect(await checkSpeechCap({ personId: sara, seconds: 1 }, NOW)).toMatchObject({ stopped: 'not_set' });
    await saveMeterSettings({ speechMemberCeilingSeconds: 0 }, sara);
    expect(await checkSpeechCap({ personId: sara, seconds: 1 }, NOW)).toMatchObject({ stopped: 'person' });
  });
});
