/**
 * The meter against a real database (game #1998, Brick 7): what only the database can show. The same event written twice counts
 * once, even from many writers at the same moment. Room taken at the same moment can never pass a member's allowance or our pool.
 * A grant is recorded once. Chat's money and the computer's are two pools. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a
 * migrated THROWAWAY database (it empties the meter's tables first, so it never runs against anything that matters):
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/meter-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { POST as writeEvents } from '@/app/api/meter/events/route';
import { recordMeterEvent, saveMeterSettings, settleEventsThrough } from '@/lib/meter';
import { currentEnvelope, memberAllowance, releaseRoom, renewRoom, reserveRoom, settleRoom } from '@/lib/meter-allowance';
import { GrantRefused, markGrantBilled, recordGrant } from '@/lib/meter-grants';
import { compareModelCalls, compareReplyWindow } from '@/lib/meter-shadow';
import { getMeterSettings } from '@/lib/meter';
import { readMeterEvent, type MeterEventInput } from '@/lib/meter-values';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let providerId = '';

let made = 0;
async function person(name: string): Promise<{ id: string; uuid: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: user.uuid, brickId: brick.id };
}

const event = (over: Partial<Record<keyof MeterEventInput, unknown>> = {}): MeterEventInput => {
  const read = readMeterEvent({ eventId: `e-${randomUUID()}`, kind: 'computer_time', personKey: 'person:x', payerKind: 'universe', basis: 'measured', quantity: 1, unit: 'minute', costMicros: 100, occurredAt: NOW, ...over });
  if (!read.ok) throw new Error(read.error);
  return read.value;
};

/** The money and the counts, all set; a test changes the ones it is about. */
const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 1_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, ...over }, 'admin');

const wipe = async () => {
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
};

run('the meter, in a real database', () => {
  beforeAll(async () => {
    providerId = `p-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId, name: `Server ${tag}`, type: 'openai', enabled: true } });
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.botsAiUsage.deleteMany({ where: { providerId } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId } });
    await prisma.replyWindow.deleteMany({ where: { key: { in: people.map((id) => `ua:person:${id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('once, under an event id', () => {
    it('counts the same event written twice once, and the second write says it was a duplicate', async () => {
      const e = event({ eventId: `dup-${tag}` });
      expect(await recordMeterEvent(e)).toEqual({ recorded: true, conflict: false });
      expect(await recordMeterEvent(e)).toEqual({ recorded: false, conflict: false });
      expect(await prisma.meterEvent.count({ where: { eventId: e.eventId } })).toBe(1);
    });

    it('counts it once when many writers send it at the same moment: two servers, a retry, a reconnect', async () => {
      const e = event({ eventId: `race-${tag}` });
      const answers = await Promise.all(Array.from({ length: 25 }, () => recordMeterEvent(e)));
      expect(answers.filter((answer) => answer.recorded)).toHaveLength(1);
      expect(answers.filter((answer) => answer.conflict)).toHaveLength(0);
      expect(await prisma.meterEvent.count({ where: { eventId: e.eventId } })).toBe(1);
    });

    it('keeps the first figures when the same id comes back with other ones, and says so', async () => {
      const first = event({ eventId: `same-id-${tag}`, quantity: 3 });
      await recordMeterEvent(first);
      expect(await recordMeterEvent(event({ eventId: first.eventId, quantity: 9 }))).toEqual({ recorded: false, conflict: true });
      expect(Number((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: first.eventId } })).quantity)).toBe(3);
    });

    it('keeps an unknown price empty and a real zero as zero, with their marks', async () => {
      await recordMeterEvent(event({ eventId: `unknown-${tag}`, basis: 'unknown', costMicros: null }));
      await recordMeterEvent(event({ eventId: `zero-${tag}`, basis: 'measured', costMicros: 0 }));
      const rows = await prisma.meterEvent.findMany({ where: { eventId: { in: [`unknown-${tag}`, `zero-${tag}`] } }, orderBy: { eventId: 'asc' } });
      expect(rows.map((row) => [row.basis, row.costMicros === null ? null : Number(row.costMicros)])).toEqual([
        ['unknown', null],
        ['measured', 0],
      ]);
    });

    it('is checked by the database too: a figure that is not one of the four marks, or a negative amount, is never kept', async () => {
      const base = { id: randomUUID(), eventId: `raw-${tag}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: 'unknown', payerKind: 'unknown', quantity: 1, unit: 'use', basis: 'unknown' };
      await expect(prisma.meterEvent.create({ data: { ...base, basis: 'probably' } })).rejects.toThrow();
      await expect(prisma.meterEvent.create({ data: { ...base, eventId: `raw2-${tag}`, quantity: -1 } })).rejects.toThrow();
      await expect(prisma.meterEvent.create({ data: { ...base, eventId: `raw3-${tag}`, personKey: 'sara' } })).rejects.toThrow();
    });
  });

  describe('model calls, written from where they are already counted', () => {
    it('copies a reported call into the books once, against the person who talked, their Brick and us as payer', async () => {
      const sara = await person('sara');
      const report = (extra: object = {}) =>
        trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: sara.brickId, providerId, userId: sara.uuid, isGuest: false, tokensUsed: 500, channel: 'dm', ...extra }) }));
      expect((await report()).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [row] = await prisma.botsAiUsage.findMany({ where: { botId: sara.brickId } });
      const stored = await prisma.meterEvent.findMany({ where: { botId: sara.brickId } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ eventId: `ai-usage:${row.id}`, kind: 'model_call', pool: 'chat', personKey: `person:${sara.id}`, personId: sara.id, brick: true, payerKind: 'universe', sourceRef: `bots_ai_usage:${row.id}` });
    });

    it('is one event when the bot server reports the same call twice under its own id, and the comparison shows the doubled row', async () => {
      const omar = await person('omar');
      const report = () =>
        trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: omar.brickId, providerId, userId: omar.uuid, isGuest: false, eventId: 'turn-1' }) }));
      await report();
      await report();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await prisma.botsAiUsage.count({ where: { botId: omar.brickId } })).toBe(2);
      expect(await prisma.meterEvent.count({ where: { botId: omar.brickId } })).toBe(1);
      const compared = await compareModelCalls(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
      expect(compared.usageRowsWithoutEvent).toBeGreaterThanOrEqual(1);
    });

    it('agrees with today’s count of a person’s replies in their running window', async () => {
      const lina = await person('lina');
      const since = new Date(Date.now() - 60 * 60_000);
      await prisma.replyWindow.create({ data: { key: `ua:person:${lina.id}`, startedAt: since } });
      const report = (extra: object = {}) =>
        trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: lina.brickId, providerId, userId: lina.uuid, isGuest: false, ...extra }) }));
      await report();
      await report();
      await report({ error: true });
      await report({ greeting: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const compared = await compareReplyWindow(lina.id);
      expect(compared.today).toBe(2);
      expect(compared.books).toBe(2);
      expect(compared.replies.state).toBe('same');
    });

    it('leaves work a Brick did on its own out of the comparison with today’s window count', async () => {
      const dana = await person('dana');
      await prisma.replyWindow.create({ data: { key: `ua:person:${dana.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
      const report = (extra: object = {}) =>
        trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: dana.brickId, providerId, ...extra }) }));
      await report({ userId: dana.uuid, isGuest: false });
      // Nobody talked to it: the books put this one to the owner, today's count has no person for it
      await report();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await prisma.meterEvent.count({ where: { personKey: `person:${dana.id}` } })).toBe(2);
      const compared = await compareReplyWindow(dana.id);
      expect([compared.today, compared.books, compared.replies.state]).toEqual([1, 1, 'same']);
    });

    it('takes an app use from the bot server, with the person and the Brick worked out here', async () => {
      const noor = await person('noor');
      const response = await writeEvents(
        new NextRequest('http://localhost:3333/api/meter/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: `app-${tag}`, kind: 'app_use', payerKind: 'universe', basis: 'estimated', quantity: 1, unit: 'use', costMicros: 300, botId: noor.brickId, userId: noor.uuid, isGuest: false }) }),
      );
      expect((await response.json()).results).toEqual([{ eventId: `app-${tag}`, status: 'recorded' }]);
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `app-${tag}` } })).toMatchObject({ personKey: `person:${noor.id}`, brick: true, pool: 'chat' });
    });
  });

  describe('one allowance per member, shared by all their Bricks', () => {
    it('refuses all room until every setting is set: a computer does not open before its controls do', async () => {
      const sara = await person('sara');
      await saveMeterSettings({ memberAllowanceMicros: 1_000 }, 'admin');
      const refused = await reserveRoom({ key: `k-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      expect(refused).toMatchObject({ ok: false, reason: 'not_set' });
      expect(refused.ok === false && refused.reason === 'not_set' && refused.missing).toEqual(['poolCeilingMicros', 'reserveMicros', 'storageMicrosPerGbMonth', 'atOnceMember', 'atOnceAll']);
      expect(await prisma.meterReservation.count()).toBe(0);
    });

    it('never lets room taken at the same moment pass the member’s allowance', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000 });
      const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveRoom({ key: `race-${tag}-${i}`, personId: sara.id, amountMicros: 400 }, NOW)));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(2);
      expect(answers.filter((answer) => !answer.ok).every((answer) => !answer.ok && answer.reason === 'allowance')).toBe(true);
      const held = await prisma.meterReservation.aggregate({ where: { personKey: `person:${sara.id}`, state: 'held' }, _sum: { amountMicros: true } });
      expect(Number(held._sum.amountMicros)).toBe(800);
    });

    it('shares one allowance between all of a member’s Bricks, another Brick adds nothing', async () => {
      const sara = await person('sara');
      const second = await createBrick({ ownerId: sara.id, name: 'Second' });
      await setUp({ memberAllowanceMicros: 1_000 });
      expect((await reserveRoom({ key: `a-${tag}`, personId: sara.id, botId: sara.brickId, amountMicros: 700 }, NOW)).ok).toBe(true);
      expect(await reserveRoom({ key: `b-${tag}`, personId: sara.id, botId: second.id, amountMicros: 700 }, NOW)).toMatchObject({ ok: false, reason: 'allowance', leftMicros: 300 });
    });

    it('counts what was spent this month against it, and gives it all again the next month', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000 });
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, costMicros: 900 }));
      expect(await reserveRoom({ key: `m-${tag}`, personId: sara.id, amountMicros: 200 }, NOW)).toMatchObject({ ok: false, reason: 'allowance' });
      const december = new Date('2026-12-02T09:00:00Z');
      expect((await reserveRoom({ key: `d-${tag}`, personId: sara.id, amountMicros: 200 }, december)).ok).toBe(true);
    });

    it('counts a figure it does not know apart, and never as nothing spent', async () => {
      const sara = await person('sara');
      await setUp();
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, basis: 'unknown', costMicros: null }));
      const envelope = await currentEnvelope(NOW);
      expect(envelope.unknownEvents).toBe(1);
      expect((await memberAllowance(sara.id, NOW, await getMeterSettings()))?.usedMicros).toBe(0);
    });

    it('does not answer for the same key once the room was settled, released or lapsed', async () => {
      const sara = await person('sara');
      await setUp({ renewMinutes: 10 });
      await reserveRoom({ key: `a-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      await reserveRoom({ key: `b-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      await reserveRoom({ key: `c-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      await settleRoom({ key: `a-${tag}`, settledMicros: 5 }, minutes(1));
      await releaseRoom({ key: `b-${tag}` }, minutes(1));
      for (const key of ['a', 'b']) expect(await reserveRoom({ key: `${key}-${tag}`, personId: sara.id, amountMicros: 10 }, minutes(2))).toEqual({ ok: false, reason: 'closed' });
      // c is still held and in time at minute 5, and lapsed at minute 11
      expect(await reserveRoom({ key: `c-${tag}`, personId: sara.id, amountMicros: 10 }, minutes(5))).toMatchObject({ ok: true, created: false });
      expect(await reserveRoom({ key: `c-${tag}`, personId: sara.id, amountMicros: 10 }, minutes(11))).toEqual({ ok: false, reason: 'closed' });
    });

    it('answers the same reservation for the same key and takes nothing more', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000 });
      const first = await reserveRoom({ key: `once-${tag}`, personId: sara.id, amountMicros: 600 }, NOW);
      const again = await Promise.all(Array.from({ length: 5 }, () => reserveRoom({ key: `once-${tag}`, personId: sara.id, amountMicros: 600 }, NOW)));
      expect(first).toMatchObject({ ok: true, created: true });
      expect(again.every((answer) => answer.ok && !answer.created)).toBe(true);
      expect(await prisma.meterReservation.count()).toBe(1);
    });
  });

  describe('a key that was used before', () => {
    it('is never answered with someone else’s reservation', async () => {
      const [sara, omar] = await Promise.all([person('sara'), person('omar')]);
      await setUp();
      await reserveRoom({ key: `shared-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      expect(await reserveRoom({ key: `shared-${tag}`, personId: omar.id, amountMicros: 10 }, NOW)).toEqual({ ok: false, reason: 'key_reused' });
      expect(await prisma.meterReservation.count()).toBe(1);
    });
  });

  describe('the envelope around our own pool', () => {
    it('never lets room taken at the same moment, by different members, pass the pool', async () => {
      const members = await Promise.all(['a', 'b', 'c', 'd'].map((name) => person(name)));
      await setUp({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 1_500, reserveMicros: 100 });
      const answers = await Promise.all(members.flatMap((member, i) => [0, 1, 2].map((n) => reserveRoom({ key: `p-${tag}-${i}-${n}`, personId: member.id, amountMicros: 300 }, NOW))));
      // 1,500 less the 100 kept back leaves room for four steps of 300
      expect(answers.filter((answer) => answer.ok)).toHaveLength(4);
      expect(answers.filter((answer) => !answer.ok).every((answer) => !answer.ok && answer.reason === 'pool')).toBe(true);
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(1_200);
    });

    it('says "waiting in line" and not "ask for more" when jobs at once are taken, for the member and for everyone', async () => {
      const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((name) => person(name)));
      await setUp({ atOnceMember: 1, atOnceAll: 2 });
      expect((await reserveRoom({ key: `1-${tag}`, personId: a.id, amountMicros: 10 }, NOW)).ok).toBe(true);
      expect(await reserveRoom({ key: `2-${tag}`, personId: a.id, amountMicros: 10 }, NOW)).toMatchObject({ ok: false, reason: 'busy' });
      expect((await reserveRoom({ key: `3-${tag}`, personId: b.id, amountMicros: 10 }, NOW)).ok).toBe(true);
      expect(await reserveRoom({ key: `4-${tag}`, personId: c.id, amountMicros: 10 }, NOW)).toMatchObject({ ok: false, reason: 'busy' });
    });

    it('asks for more only for a member who used their own allowance up, never when the pool is full', async () => {
      const a = await person('a');
      await setUp({ memberAllowanceMicros: 100, poolCeilingMicros: 150 });
      expect(await reserveRoom({ key: `x-${tag}`, personId: a.id, amountMicros: 200 }, NOW)).toMatchObject({ ok: false, reason: 'allowance' });
      expect(await reserveRoom({ key: `y-${tag}`, personId: a.id, amountMicros: 100 }, NOW)).toMatchObject({ ok: true });
      const b = await person('b');
      expect(await reserveRoom({ key: `z-${tag}`, personId: b.id, amountMicros: 100 }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
    });

    it('adds up what is committed, reserved, not yet settled, kept storage and the reserve', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 1_000_000, reserveMicros: 500, storageMicrosPerGbMonth: 2_000 });
      const key = `person:${sara.id}`;
      // Spent and settled by the provider, spent and not settled yet, and a reservation that lapsed
      await recordMeterEvent(event({ personKey: key, personId: sara.id, costMicros: 1_000 }));
      await settleEventsThrough(NOW);
      await recordMeterEvent(event({ personKey: key, personId: sara.id, costMicros: 250, occurredAt: minutes(5) }));
      await reserveRoom({ key: `lapsed-${tag}`, personId: sara.id, amountMicros: 40 }, NOW);
      await reserveRoom({ key: `live-${tag}`, personId: sara.id, amountMicros: 60 }, minutes(20));
      // Two disks, each as big as it last was: 3 GB, then the same Brick shrinking to 1 GB, and another at 2 GB
      const other = await createBrick({ ownerId: sara.id, name: 'Other' });
      await recordMeterEvent(event({ kind: 'stored_bytes', unit: 'byte', quantity: 3_000_000_000, costMicros: 0, botId: sara.brickId, occurredAt: minutes(1) }));
      await recordMeterEvent(event({ kind: 'stored_bytes', unit: 'byte', quantity: 1_000_000_000, costMicros: 0, botId: sara.brickId, occurredAt: minutes(2) }));
      await recordMeterEvent(event({ kind: 'stored_bytes', unit: 'byte', quantity: 2_000_000_000, costMicros: 0, botId: other.id, occurredAt: minutes(3) }));
      expect(await currentEnvelope(minutes(25))).toMatchObject({
        committedMicros: 1_000,
        unsettledMicros: 250 + 40,
        reservedMicros: 60,
        keptStorageMicros: 6_000,
        reserveMicros: 500,
        totalMicros: 1_000 + 290 + 60 + 6_000 + 500,
        jobsRunning: 1,
      });
    });

    it('keeps chat’s money apart: whatever chat spends, the computer pool and its room do not move', async () => {
      const sara = await person('sara');
      await setUp({ poolCeilingMicros: 1_000, memberAllowanceMicros: 1_000 });
      await recordMeterEvent(event({ kind: 'model_call', unit: 'call', pool: 'chat', personKey: `person:${sara.id}`, personId: sara.id, costMicros: 900_000 }));
      const envelope = await currentEnvelope(NOW);
      expect(envelope).toMatchObject({ committedMicros: 0, unsettledMicros: 0, chatMicros: 900_000 });
      expect((await reserveRoom({ key: `chat-${tag}`, personId: sara.id, amountMicros: 1_000 }, NOW)).ok).toBe(true);
      expect((await memberAllowance(sara.id, NOW, await getMeterSettings()))?.usedMicros).toBe(0);
    });

    it('does not count what someone else pays for against ours', async () => {
      const sara = await person('sara');
      await setUp();
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, payerKind: 'person', payerPersonId: sara.id, basis: 'paid_by_other', costMicros: 5_000 }));
      expect(await currentEnvelope(NOW)).toMatchObject({ committedMicros: 0, unsettledMicros: 0 });
      expect((await memberAllowance(sara.id, NOW, await getMeterSettings()))?.usedMicros).toBe(0);
    });
  });

  describe('renewing, settling and giving room back', () => {
    it('renews while a job runs, and the extra room passes the same checks as new room', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000, renewMinutes: 10 });
      await reserveRoom({ key: `job-${tag}`, personId: sara.id, amountMicros: 400 }, NOW);
      const renewed = await renewRoom({ key: `job-${tag}`, moreMicros: 300 }, minutes(8));
      expect(renewed).toMatchObject({ ok: true, reservation: { amountMicros: 700, renewals: 1, expiresAt: minutes(18) } });
      // 700 held, 300 left: 400 more is not there, and nothing changes
      expect(await renewRoom({ key: `job-${tag}`, moreMicros: 400 }, minutes(9))).toMatchObject({ ok: false, reason: 'allowance' });
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: `job-${tag}` } })).renewals).toBe(1);
    });

    it('does not renew room that lapsed, or that was settled or released: the job saves its work and stops', async () => {
      const sara = await person('sara');
      await setUp({ renewMinutes: 10 });
      await reserveRoom({ key: `lapse-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      expect(await renewRoom({ key: `lapse-${tag}` }, minutes(11))).toEqual({ ok: false, reason: 'closed' });
      await reserveRoom({ key: `done-${tag}`, personId: sara.id, amountMicros: 10 }, NOW);
      await settleRoom({ key: `done-${tag}`, settledMicros: 8 }, minutes(2));
      expect(await renewRoom({ key: `done-${tag}` }, minutes(3))).toEqual({ ok: false, reason: 'closed' });
      expect(await renewRoom({ key: `nothing-${tag}` }, minutes(3))).toEqual({ ok: false, reason: 'closed' });
    });

    it('gives room back once settled or released, says it twice with no change, and never takes a reservation out of the books', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000 });
      await reserveRoom({ key: `s-${tag}`, personId: sara.id, amountMicros: 600 }, NOW);
      expect(await reserveRoom({ key: `t-${tag}`, personId: sara.id, amountMicros: 600 }, NOW)).toMatchObject({ ok: false, reason: 'allowance' });
      expect(await settleRoom({ key: `s-${tag}`, settledMicros: 450 }, minutes(1))).toMatchObject({ state: 'settled', settledMicros: 450 });
      expect(await settleRoom({ key: `s-${tag}`, settledMicros: 1 }, minutes(2))).toMatchObject({ state: 'settled', settledMicros: 450 });
      expect(await releaseRoom({ key: `s-${tag}` }, minutes(3))).toMatchObject({ state: 'settled' });
      expect((await reserveRoom({ key: `t-${tag}`, personId: sara.id, amountMicros: 600 }, minutes(3))).ok).toBe(true);
      expect(await releaseRoom({ key: `t-${tag}` }, minutes(4))).toMatchObject({ state: 'released' });
      expect(await releaseRoom({ key: `unknown-${tag}` }, minutes(4))).toBeNull();
      expect(await prisma.meterReservation.count()).toBe(2);
    });
  });

  describe('extra usage', () => {
    const grant = (over: object = {}) => ({ grantKey: `g-${tag}`, personId: '', settlement: 'gift' as const, multiplier: 2, startsAt: new Date('2026-11-10T00:00:00Z'), endsAt: new Date('2026-11-20T00:00:00Z'), givenById: 'admin', ...over });

    it('is recorded once under its key, even when two super admins or a retry give it at the same moment', async () => {
      const sara = await person('sara');
      const answers = await Promise.all(Array.from({ length: 10 }, () => recordGrant(grant({ personId: sara.id }))));
      expect(answers.filter((answer) => answer.recorded)).toHaveLength(1);
      expect(new Set(answers.map((answer) => answer.grant.id)).size).toBe(1);
      expect(await prisma.meterGrant.count({ where: { personId: sara.id } })).toBe(1);
    });

    it('refuses the same key for a different grant, and keeps the first', async () => {
      const sara = await person('sara');
      await recordGrant(grant({ personId: sara.id }));
      await expect(recordGrant(grant({ personId: sara.id, multiplier: 5 }))).rejects.toBeInstanceOf(GrantRefused);
      expect((await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey: `g-${tag}` } })).multiplier).toBe(2);
    });

    it('keeps a gift apart from extra usage to be billed: a gift is never owed, and "billed" is said once with its first time', async () => {
      const sara = await person('sara');
      await recordGrant(grant({ personId: sara.id, grantKey: `gift-${tag}`, settlement: 'gift' }));
      await recordGrant(grant({ personId: sara.id, grantKey: `bill-${tag}`, settlement: 'to_bill', note: 'Agreed 5 KD for the month' }));
      expect(await markGrantBilled(`gift-${tag}`)).toBe('not_billable');
      expect(await markGrantBilled(`nothing-${tag}`)).toBe('not_found');
      expect(await markGrantBilled(`bill-${tag}`, new Date('2026-11-16T10:00:00Z'))).toBe('billed');
      expect(await markGrantBilled(`bill-${tag}`, new Date('2026-11-17T10:00:00Z'))).toBe('already_billed');
      const rows = await prisma.meterGrant.findMany({ where: { personId: sara.id }, orderBy: { grantKey: 'asc' } });
      expect(rows.map((row) => [row.settlement, row.billedAt?.toISOString() ?? null, row.note])).toEqual([
        ['to_bill', '2026-11-16T10:00:00.000Z', 'Agreed 5 KD for the month'],
        ['gift', null, null],
      ]);
      // The database says it as well: a gift can never carry a billed date
      await expect(prisma.meterGrant.update({ where: { grantKey: `gift-${tag}` }, data: { billedAt: new Date() } })).rejects.toThrow();
    });

    it('raises the allowance while it lasts, and when it ends only the extra goes', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 1_000 });
      await recordGrant(grant({ personId: sara.id }));
      // 1,500 can be reserved while double runs, 1,000 is the most without it
      expect((await reserveRoom({ key: `x2-${tag}`, personId: sara.id, amountMicros: 1_500 }, NOW)).ok).toBe(true);
      await releaseRoom({ key: `x2-${tag}` }, NOW);
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, costMicros: 500, occurredAt: NOW }));
      const settings = await getMeterSettings();
      const state = (when: Date) => memberAllowance(sara.id, when, settings, prisma);
      expect((await state(NOW))?.leftMicros).toBe(1_500);
      // The 500 came out of the extra: after it ends the whole usual allowance is still there
      expect((await state(new Date('2026-11-25T00:00:00Z')))?.leftMicros).toBe(1_000);
    });

    it('lifts the member’s own limit with no limit, while our pool still holds', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 100, poolCeilingMicros: 1_000 });
      await recordGrant(grant({ personId: sara.id, multiplier: null, noLimit: true }));
      expect((await reserveRoom({ key: `big-${tag}`, personId: sara.id, amountMicros: 900 }, NOW)).ok).toBe(true);
      expect(await reserveRoom({ key: `too-big-${tag}`, personId: sara.id, amountMicros: 200 }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
    });

    it('is only for a person who exists, and is a multiple or no limit, never both, and ends', async () => {
      const sara = await person('sara');
      await expect(recordGrant(grant({ personId: 'nobody' }))).rejects.toBeInstanceOf(GrantRefused);
      await expect(recordGrant(grant({ personId: sara.id, multiplier: 1 }))).rejects.toBeInstanceOf(GrantRefused);
      await expect(recordGrant(grant({ personId: sara.id, noLimit: true }))).rejects.toBeInstanceOf(GrantRefused);
      await expect(recordGrant(grant({ personId: sara.id, endsAt: new Date('2026-11-10T00:00:00Z') }))).rejects.toBeInstanceOf(GrantRefused);
    });
  });

  describe('settling what the provider has', () => {
    it('marks what was recorded up to a moment as settled, once, and leaves later events alone', async () => {
      const sara = await person('sara');
      await setUp();
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, costMicros: 10, occurredAt: NOW }));
      await recordMeterEvent(event({ personKey: `person:${sara.id}`, personId: sara.id, costMicros: 20, occurredAt: minutes(30) }));
      expect(await settleEventsThrough(minutes(10))).toBe(1);
      expect(await settleEventsThrough(minutes(10))).toBe(0);
      expect(await currentEnvelope(minutes(40))).toMatchObject({ committedMicros: 10, unsettledMicros: 20 });
    });
  });
});
