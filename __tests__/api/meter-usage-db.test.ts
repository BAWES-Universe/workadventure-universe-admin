/**
 * Usage for people, and cost for us (game #1999), against a real database: the Usage page's bar and words, "Ask for more" (once, and
 * never a debt), extra usage raising what a person may do and ending by itself, and the Costs page's figures. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/meter-usage-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email: string | null) => email === 'admin@example.test') }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { recordMeterEvent, saveMeterSettings } from '@/lib/meter';
import { GrantRefused, changeGrant, endGrantNow, markGrantBilled, recordGrant, runningExtra } from '@/lib/meter-grants';
import { answerRequests, askForMore, openRequests } from '@/lib/meter-requests';
import { memberUsage } from '@/lib/meter-usage';
import { personUsage } from '@/lib/meter-person';
import { costsReport, readDay } from '@/lib/meter-costs';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { readMeterEvent, type MeterEventInput } from '@/lib/meter-values';
import { GET as usageGet } from '@/app/api/me/usage/route';
import { POST as askPost } from '@/app/api/me/usage/ask-for-more/route';
import { GET as costsGet } from '@/app/api/admin/meter-costs/route';
import { GET as personGet, PATCH as personPatch, POST as personPost } from '@/app/api/admin/users/[id]/extra-usage/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const session = getSessionUser as jest.Mock;
const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
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

/** The usual allowance is 1,000 millionths: small, so a test can use it up with one event. */
const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000, poolCeilingMicros: 1_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, ...over }, 'admin');

const spendComputer = (who: { id: string; brickId: string }, micros: number, at: Date = NOW) =>
  recordMeterEvent(event({ personKey: `person:${who.id}`, personId: who.id, botId: who.brickId, brick: true, costMicros: micros, occurredAt: at }));

const wipe = async () => {
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.meterRequest.deleteMany({});
  await prisma.guestBrickReply.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
};

const addUsage = async (who: { id: string; uuid: string; brickId: string }, count: number, extra: object = {}) => {
  await prisma.botsAiUsage.createMany({ data: Array.from({ length: count }, () => ({ botId: who.brickId, providerId, talkedUserId: who.uuid, talkedPersonId: who.id, talkedGuest: false, timestamp: hours(-1), ...extra })) });
};

const adminCall = (url: string) => new NextRequest(`http://localhost:3333${url}`);
const body = (method: string, url: string, json: unknown) => new NextRequest(`http://localhost:3333${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
const asAdmin = () => session.mockResolvedValue({ id: 'admin-user', email: 'admin@example.test' });

/**
 * The next grant is written through its transaction (the one holding the key's lock), so this runs `before` ahead of that write and
 * can give the transaction another time limit. Gives back what undoes it.
 */
const beforeNextGrantWrite = (before: () => Promise<unknown>, timeout?: number) => {
  const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
    original(
      (tx: Prisma.TransactionClient) =>
        fn(
          new Proxy(tx, {
            get: (target, key) =>
              key === 'meterGrant'
                ? new Proxy(target.meterGrant, { get: (grants, method) => (method === 'createMany' ? (args: never) => before().then(() => grants.createMany(args)) : (grants as never)[method as never]) })
                : (target as never)[key as never],
          }),
        ),
      timeout ? { ...options, timeout } : options,
    )) as never);
  return () => spy.mockRestore();
};

run('usage for people, and cost for us, in a real database', () => {
  beforeAll(async () => {
    providerId = `p-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId, name: `Server ${tag}`, type: 'openai', enabled: true } });
  });
  beforeEach(async () => {
    await wipe();
    session.mockResolvedValue(null);
  });
  afterAll(async () => {
    await wipe();
    await prisma.botsAiUsage.deleteMany({ where: { providerId } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId } });
    await prisma.replyWindow.deleteMany({ where: { key: { in: people.map((id) => `ua:person:${id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('the Usage page: one bar and plain words', () => {
    it('is a full bar of plenty for someone who has not used anything, with no computer or storage shown', async () => {
      const sara = await person('sara');
      expect(await memberUsage(sara.id, NOW)).toEqual({ chat: { left: 1, words: 'plenty', fullAgainAt: null }, computer: null, storage: null, extra: null });
    });

    it('counts only what Universe AI paid for: a Brick on their own key uses none of the bar', async () => {
      const sara = await person('sara');
      await prisma.replyWindow.create({ data: { key: `ua:person:${sara.id}`, startedAt: hours(-2) } });
      // 30 replies on Universe AI is the signed-in limit; 29 on their own key are nobody's here
      await addUsage(sara, 10);
      await addUsage(sara, 29, { keyOwnerId: sara.id });
      const bar = (await memberUsage(sara.id, NOW)).chat;
      expect(bar.left).toBeCloseTo(1 - 10 / 30, 5);
      expect(bar.words).toBe('plenty');
      expect(bar.fullAgainAt).toBe(hours(3).toISOString());
      // Spend the rest on Universe AI and it is out, in words, with no count anywhere
      await addUsage(sara, 20);
      expect((await memberUsage(sara.id, NOW)).chat).toEqual({ left: 0, words: 'out', fullAgainAt: hours(3).toISOString() });
    });

    it('is full again once the window has ended, and a greeting or a failed reply never used any of it', async () => {
      const sara = await person('sara');
      await prisma.replyWindow.create({ data: { key: `ua:person:${sara.id}`, startedAt: hours(-6) } });
      await addUsage(sara, 30);
      expect((await memberUsage(sara.id, NOW)).chat.words).toBe('plenty');
      await prisma.replyWindow.update({ where: { key: `ua:person:${sara.id}` }, data: { startedAt: hours(-1) } });
      await prisma.botsAiUsage.deleteMany({ where: { botId: sara.brickId } });
      await addUsage(sara, 30, { greeting: true });
      await addUsage(sara, 30, { error: true });
      expect((await memberUsage(sara.id, NOW)).chat.left).toBe(1);
    });

    it('shows computer time and storage only to someone whose Brick uses a computer, in plain words about this month', async () => {
      await setUp();
      const sara = await person('sara');
      const omar = await person('omar');
      await spendComputer(sara, 300);
      await recordMeterEvent(event({ eventId: `disk-${tag}`, kind: 'stored_bytes', unit: 'byte', quantity: 1_400_000_000, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, costMicros: 0 }));
      const usage = await memberUsage(sara.id, NOW);
      expect(usage.computer).toMatchObject({ left: 0.7, words: 'plenty', startsAgainAt: '2026-12-01T00:00:00.000Z', unlimited: false, asked: false, canAskForMore: false });
      expect(usage.storage).toEqual({ bytes: 1_400_000_000 });
      // Someone whose Brick never used one sees neither
      expect(await memberUsage(omar.id, NOW)).toMatchObject({ computer: null, storage: null });
    });

    it('says low, then out, and only offers "Ask for more" when it is out', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 850);
      expect((await memberUsage(sara.id, NOW)).computer).toMatchObject({ words: 'low', canAskForMore: false });
      await spendComputer(sara, 150);
      expect((await memberUsage(sara.id, NOW)).computer).toMatchObject({ left: 0, words: 'out', canAskForMore: true });
    });

    it('shows nothing about the computer allowance until a super admin has set it', async () => {
      const sara = await person('sara');
      await spendComputer(sara, 300);
      expect((await memberUsage(sara.id, NOW)).computer).toBeNull();
    });

    it('answers the person asking only, and a person who is not signed in gets nothing', async () => {
      expect((await usageGet(adminCall('/api/me/usage'))).status).toBe(401);
      const sara = await person('sara');
      session.mockResolvedValue({ id: sara.id, email: 'sara@example.test' });
      const response = await usageGet(adminCall('/api/me/usage'));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(Object.keys(json).sort()).toEqual(['chat', 'computer', 'extra', 'storage']);
      // Never a count of replies and never a price
      expect(JSON.stringify(json)).not.toMatch(/cost|price|micros|replies|\$/i);
    });
  });

  describe('Ask for more', () => {
    it('is only a request: once while it waits, no grant, no debt, and nothing billed', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 1_000, new Date());
      session.mockResolvedValue({ id: sara.id, email: 'sara@example.test' });
      const first = await askPost(body('POST', '/api/me/usage/ask-for-more', {}));
      expect(first.status).toBe(201);
      const second = await askPost(body('POST', '/api/me/usage/ask-for-more', {}));
      expect(second.status).toBe(200);
      expect((await second.json()).created).toBe(false);
      // Two taps at the same moment are one request too
      await Promise.all([askForMore(sara.id), askForMore(sara.id), askForMore(sara.id)]);
      expect(await prisma.meterRequest.count({ where: { personId: sara.id } })).toBe(1);
      expect(await prisma.meterGrant.count({})).toBe(0);
      expect(await prisma.meterEvent.count({ where: { eventId: { startsWith: 'grant' } } })).toBe(0);
      expect((await memberUsage(sara.id, NOW)).computer?.asked).toBe(true);
      expect((await openRequests()).map((request) => request.personId)).toEqual([sara.id]);
    });

    it('keeps the moment of the ask as it was, whatever time zone the database session runs in', async () => {
      await setUp();
      const sara = await person('sara');
      const at = new Date('2026-11-10T09:30:00.000Z');
      const { request } = await askForMore(sara.id, at);
      expect(request.createdAt.toISOString()).toBe(at.toISOString());
      expect((await prisma.meterRequest.findFirstOrThrow({ where: { personId: sara.id } })).createdAt.toISOString()).toBe(at.toISOString());
    });

    it('never fails when an admin answers the request while a person asks again', async () => {
      await setUp();
      const sara = await person('sara');
      // Many rounds of asking at the same moment as the answer: every ask returns a request, none throws
      for (let round = 0; round < 15; round += 1) {
        await askForMore(sara.id);
        const asks = await Promise.all([askForMore(sara.id), askForMore(sara.id), answerRequests(sara.id, `race-${round}`).then(() => null)]);
        for (const ask of asks.filter((item) => item !== null)) expect(ask?.request.personId).toBe(sara.id);
      }
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, answeredAt: null } })).toBeLessThanOrEqual(1);
    });

    it('is refused while computer time is not used up, so asking is never a way around a limit', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 300);
      session.mockResolvedValue({ id: sara.id, email: 'sara@example.test' });
      expect((await askPost(body('POST', '/api/me/usage/ask-for-more', {}))).status).toBe(409);
      expect(await prisma.meterRequest.count({})).toBe(0);
    });
  });

  describe('a person’s page', () => {
    it('says unlimited from the running grant itself, even while no computer allowance is set', async () => {
      const sara = await person('sara');
      const faisal = await person('faisal');
      await recordGrant({ grantKey: `g-${tag}-nolimit`, personId: sara.id, settlement: 'gift', noLimit: true, startsAt: days(-1), endsAt: days(5), givenById: faisal.id });
      const usage = await personUsage(sara.id, NOW, faisal.id);
      expect(usage).toMatchObject({ allowanceSet: false, noLimit: true, allowanceMicros: null });
      expect(usage.extra?.noLimit).toBe(true);
    });
  });

  describe('extra usage', () => {
    it('raises the chat window by its multiple while it runs, and the usual limit is back when it ends', async () => {
      const sara = await person('sara');
      await prisma.replyWindow.create({ data: { key: `ua:person:${sara.id}`, startedAt: hours(-2) } });
      await addUsage(sara, 30);
      const ask = () => checkReplyAllowance(sara.brickId, { userId: sara.uuid, isGuest: false, source: 'universe-ai' }, NOW);
      expect((await ask()).allowed).toBe(false);
      const { grant } = await recordGrant({ grantKey: `g-${tag}-1`, personId: sara.id, settlement: 'gift', multiplier: 2, startsAt: days(-1), endsAt: days(5), givenById: sara.id });
      // Twice the usual 30: 30 used, so there is room; 60 used, so there is not
      expect((await ask()).allowed).toBe(true);
      await addUsage(sara, 30);
      expect((await ask()).allowed).toBe(false);
      expect(await endGrantNow(grant.grantKey, NOW)).toBe('ended');
      await addUsage(sara, 1);
      expect((await ask()).allowed).toBe(false);
    });

    it('lifts a signed-in person’s limit with no limit, never a guest’s', async () => {
      const sara = await person('sara');
      await prisma.replyWindow.create({ data: { key: `ua:person:${sara.id}`, startedAt: hours(-2) } });
      await addUsage(sara, 40);
      await recordGrant({ grantKey: `g-${tag}-2`, personId: sara.id, settlement: 'gift', noLimit: true, startsAt: days(-1), endsAt: days(5), givenById: sara.id });
      expect((await checkReplyAllowance(sara.brickId, { userId: sara.uuid, isGuest: false, source: 'universe-ai' }, NOW)).allowed).toBe(true);
      // A guest with the same id is not signed in: nothing lifts theirs
      await prisma.replyWindow.upsert({ where: { key: `ua:guest:guest-x` }, create: { key: `ua:guest:guest-x`, startedAt: hours(-2) }, update: { startedAt: hours(-2) } });
      await prisma.botsAiUsage.createMany({ data: Array.from({ length: 10 }, () => ({ botId: sara.brickId, providerId, talkedUserId: 'guest-x', talkedGuest: true, timestamp: hours(-1) })) });
      expect((await checkReplyAllowance(sara.brickId, { userId: 'guest-x', isGuest: true, source: 'universe-ai' }, NOW)).allowed).toBe(false);
    });

    it('is one line on the Usage page while it runs, and says nothing about how it was given', async () => {
      const sara = await person('sara');
      await recordGrant({ grantKey: `g-${tag}-3`, personId: sara.id, settlement: 'to_bill', multiplier: 5, startsAt: days(-1), endsAt: days(10), givenById: sara.id, note: 'Agreed on 11 Nov' });
      const usage = await memberUsage(sara.id, NOW);
      expect(usage.extra).toEqual({ until: days(10).toISOString() });
      expect(JSON.stringify(usage)).not.toMatch(/bill|agreed|gift/i);
    });

    it('measures the bar against the raised limit, and a window that is full under the usual has room', async () => {
      const sara = await person('sara');
      await prisma.replyWindow.create({ data: { key: `ua:person:${sara.id}`, startedAt: hours(-1) } });
      await addUsage(sara, 30);
      expect((await memberUsage(sara.id, NOW)).chat.words).toBe('out');
      await recordGrant({ grantKey: `g-${tag}-4`, personId: sara.id, settlement: 'gift', multiplier: 5, startsAt: days(-1), endsAt: days(2), givenById: sara.id });
      expect((await memberUsage(sara.id, NOW)).chat.left).toBeCloseTo(1 - 30 / 150, 5);
    });

    it('answers an open request, and gives the person room in computer time too', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 1_000, new Date());
      await askForMore(sara.id);
      asAdmin();
      const given = await personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'to_bill', note: 'Agreed with Sara' }), { params: Promise.resolve({ id: sara.id }) });
      expect(given.status).toBe(201);
      expect(await openRequests()).toEqual([]);
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, answeredAt: { not: null } } })).toBe(1);
      const usage = await memberUsage(sara.id, new Date());
      expect(usage.computer).toMatchObject({ words: 'plenty', canAskForMore: false });
      expect(usage.computer?.left).toBeCloseTo(0.8, 5);
    });

    it('leaves a newer ask open when an old grant is sent again', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 1_000, new Date());
      await askForMore(sara.id, new Date(Date.now() - 1_000));
      asAdmin();
      const key = randomUUID();
      const send = () => personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: key, amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' }), { params: Promise.resolve({ id: sara.id }) });
      expect((await send()).status).toBe(201);
      expect(await openRequests()).toEqual([]);
      // She asks again later; the same grant sent again (a retry, a replay) is not an answer to that
      await new Promise((resolve) => setTimeout(resolve, 20));
      await askForMore(sara.id);
      expect((await send()).status).toBe(200);
      expect((await openRequests()).map((request) => request.personId)).toEqual([sara.id]);
    });

    describe('a grant sent again after its end date passed', () => {
      const give = (sara: { id: string }, json: object) => personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, json), { params: Promise.resolve({ id: sara.id }) });
      const grantRows = (personId: string) => prisma.meterGrant.count({ where: { personId } });

      it('is answered as saved, not refused as an end in the past, so nothing new is given', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const key = randomUUID();
        const endsAt = new Date(Date.now() + 400).toISOString();
        const first = { grantKey: key, amount: 'five', endsAt, settlement: 'gift' };
        expect((await give(sara, first)).status).toBe(201);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // The end has passed: the same try is still the saved grant, and a changed one says the key was used
        const again = await give(sara, first);
        expect(again.status).toBe(200);
        expect((await again.json()).recorded).toBe(false);
        expect((await give(sara, { ...first, amount: 'double' })).status).toBe(409);
        expect(await grantRows(sara.id)).toBe(1);
      });

      it('still refuses an end in the past for a key that was never saved', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const response = await give(sara, { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() - 1_000).toISOString(), settlement: 'gift' });
        expect(response.status).toBe(400);
        expect(await grantRows(sara.id)).toBe(0);
      });

      it('waits for the first try still being saved, so the end passing meanwhile never gives a second grant', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const key = randomUUID();
        const first = { grantKey: key, amount: 'five', endsAt: new Date(Date.now() + 600).toISOString(), settlement: 'gift' };
        // The first try has passed its checks and is slow to write: the end date passes while it is
        const restore = beforeNextGrantWrite(() => new Promise((resolve) => setTimeout(resolve, 900)));
        try {
          const slow = give(sara, first);
          await new Promise((resolve) => setTimeout(resolve, 750));
          // Sent again after the end has passed: it waits for the first, then finds it saved (the old answer was "end in the past",
          // which the sheet read as a refusal and gave a new grant)
          const again = await give(sara, first);
          expect(again.status).toBe(200);
          expect((await again.json()).recorded).toBe(false);
          expect((await slow).status).toBe(201);
        } finally {
          restore();
        }
        expect(await grantRows(sara.id)).toBe(1);
      });

      it('refuses a key too long to keep whole instead of cutting it short', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const long = (tail: string) => ({ grantKey: `${'k'.repeat(250)}${tail}`, amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' });
        expect((await give(sara, long('a'))).status).toBe(400);
        expect((await give(sara, long('b'))).status).toBe(400);
        expect(await grantRows(sara.id)).toBe(0);
      });

      it('is answered as used, not refused, when the saved grant was changed by another admin before it came again', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const first = { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' };
        expect((await give(sara, first)).status).toBe(201);
        // Another admin changes the amount; the sheet's try that got no answer comes again with the old figures
        await prisma.meterGrant.updateMany({ where: { personId: sara.id }, data: { multiplier: 2 } });
        const again = await give(sara, first);
        expect(again.status).toBe(409);
        expect(await again.json()).toMatchObject({ code: 'key_used', usage: expect.anything() });
        expect(await grantRows(sara.id)).toBe(1);
      });

      it('undoes a try whole when its transaction runs out of time, so nothing of it lands late and the next try gives one grant', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const first = { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' };
        // The write is slower than the transaction's time limit
        const restore = beforeNextGrantWrite(() => new Promise((resolve) => setTimeout(resolve, 900)), 300);
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
          expect((await give(sara, first)).status).toBe(500);
        } finally {
          restore();
          errors.mockRestore();
        }
        // Long after the write would have landed, nothing did
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(await grantRows(sara.id)).toBe(0);
        // Sent again, it is given once
        expect((await give(sara, first)).status).toBe(201);
        expect(await grantRows(sara.id)).toBe(1);
      });

      it('gives one grant, once, when the same try arrives many times at the same moment', async () => {
        await setUp();
        const sara = await person('sara');
        asAdmin();
        const json = { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' };
        const statuses = (await Promise.all(Array.from({ length: 6 }, () => give(sara, json)))).map((response) => response.status).sort();
        expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
        expect(await grantRows(sara.id)).toBe(1);
      });
    });

    it('answers an ask made while the grant was still being recorded', async () => {
      await setUp();
      const sara = await person('sara');
      await spendComputer(sara, 1_000, new Date());
      asAdmin();
      // The ask lands after the grant's start time was taken and before the grant is written
      const restore = beforeNextGrantWrite(() => askForMore(sara.id, new Date()));
      try {
        const given = await personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: randomUUID(), amount: 'five', endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), settlement: 'gift' }), { params: Promise.resolve({ id: sara.id }) });
        expect(given.status).toBe(201);
      } finally {
        restore();
      }
      expect(await openRequests()).toEqual([]);
      // It was answered after it was asked, never before
      const row = await prisma.meterRequest.findFirstOrThrow({ where: { personId: sara.id } });
      expect(row.answeredAt).not.toBeNull();
      expect(row.answeredAt!.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
    });

    it('makes one open request for each person from taps at the same moment, also where the partial index was never made (a database built with db:push)', async () => {
      await setUp();
      const people = await Promise.all(['ali', 'bo', 'cy'].map((name) => person(name)));
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "meter_requests_one_open"');
      try {
        await Promise.all(people.flatMap((one) => Array.from({ length: 8 }, () => askForMore(one.id))));
        for (const one of people) expect(await prisma.meterRequest.count({ where: { personId: one.id, answeredAt: null } })).toBe(1);
      } finally {
        await prisma.meterRequest.deleteMany({});
        await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "meter_requests_one_open" ON "meter_requests"("person_id", "what") WHERE "answered_at" IS NULL');
      }
    });

    it('leaves no request waiting when extra usage lands while a person is asking', async () => {
      await setUp();
      for (let round = 0; round < 8; round++) {
        const who = await person(`racer${round}`);
        await spendComputer(who, 1_000, new Date());
        session.mockResolvedValue({ id: who.id, email: `${who.id}@example.test` });
        const grant = (async () => {
          const given = await recordGrant({ grantKey: `g-${tag}-room-${round}`, personId: who.id, settlement: 'gift', multiplier: 5, startsAt: new Date(), endsAt: new Date(Date.now() + 10 * 86_400_000), givenById: who.id });
          const answeredAt = new Date();
          await answerRequests(who.id, given.grant.grantKey, answeredAt, answeredAt);
        })();
        const [asked] = await Promise.all([askPost(body('POST', '/api/me/usage/ask-for-more', {})), grant]);
        expect([200, 201, 409]).toContain(asked.status);
        // There is room again, so nothing is left waiting, whichever of the two came first
        expect((await memberUsage(who.id, new Date())).computer?.canAskForMore).toBe(false);
        expect((await openRequests()).filter((request) => request.personId === who.id)).toEqual([]);
      }
    });

    it('is given once however many times it is sent: a double tap, a retry', async () => {
      const sara = await person('sara');
      asAdmin();
      const send = (key: string, over: object = {}) =>
        personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: key, amount: 'double', endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), settlement: 'gift', ...over }), { params: Promise.resolve({ id: sara.id }) });
      const key = randomUUID();
      const answers = await Promise.all([send(key), send(key), send(key)]);
      expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
      expect(await prisma.meterGrant.count({ where: { personId: sara.id } })).toBe(1);
      // A retry a moment later, with a later start and end, is the same grant: nothing is given twice and nothing is refused
      await new Promise((resolve) => setTimeout(resolve, 20));
      const retry = await send(key, { endsAt: new Date(Date.now() + 5 * 86_400_000 + 5_000).toISOString() });
      expect(retry.status).toBe(200);
      expect((await retry.json()).recorded).toBe(false);
      expect(await prisma.meterGrant.count({ where: { personId: sara.id } })).toBe(1);
      // The same key with another amount is not given as something else: something is saved under it, so it says so (409)
      expect((await send(key, { amount: 'five' })).status).toBe(409);
      expect(await prisma.meterGrant.count({ where: { personId: sara.id } })).toBe(1);
    });

    it('says "you" for extra usage the super admin looking gave, and the giver’s name to anyone else', async () => {
      const sara = await person('sara');
      const khalid = await person('khalid');
      asAdmin();
      const ctx = { params: Promise.resolve({ id: sara.id }) };
      await personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: randomUUID(), amount: 'double', endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), settlement: 'gift' }), ctx);
      expect((await (await personGet(adminCall(`/api/admin/users/${sara.id}/extra-usage`), ctx)).json()).extra.givenByName).toBe('you');
      session.mockResolvedValue({ id: khalid.id, email: 'admin@example.test' });
      expect((await (await personGet(adminCall(`/api/admin/users/${sara.id}/extra-usage`), ctx)).json()).extra.givenByName).toMatch(/admin-user|a super admin/);
    });

    it('keeps the largest one running and ends the rest by themselves', async () => {
      const sara = await person('sara');
      const base = { personId: sara.id, settlement: 'gift' as const, givenById: sara.id, startsAt: days(-1) };
      await recordGrant({ ...base, grantKey: `g-${tag}-a`, multiplier: 2, endsAt: days(3) });
      await recordGrant({ ...base, grantKey: `g-${tag}-b`, multiplier: 5, endsAt: days(2) });
      expect(await runningExtra(sara.id, NOW)).toMatchObject({ grantKey: `g-${tag}-b`, multiplier: 5 });
      expect(await runningExtra(sara.id, days(2.5))).toMatchObject({ grantKey: `g-${tag}-a`, multiplier: 2 });
      expect(await runningExtra(sara.id, days(4))).toBeNull();
    });

    it('keeps every change and never reopens a grant when two admins act at the same moment', async () => {
      const sara = await person('sara');
      const base = { personId: sara.id, givenById: sara.id, startsAt: days(-1) };
      const live = await recordGrant({ ...base, grantKey: `g-${tag}-r1`, settlement: 'to_bill', multiplier: 2, endsAt: days(5) });
      // Two different fields changed together: both stay
      await Promise.all([changeGrant(live.grant.grantKey, { multiplier: 4 }, NOW), changeGrant(live.grant.grantKey, { note: 'Agreed on a call' }, NOW)]);
      const row = await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey: live.grant.grantKey } });
      expect(row).toMatchObject({ multiplier: 4, note: 'Agreed on a call' });
      // Ended and changed together: it ends and stays ended, whichever came first
      const results = await Promise.allSettled([endGrantNow(live.grant.grantKey, NOW), changeGrant(live.grant.grantKey, { endsAt: days(30) }, NOW)]);
      const after = await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey: live.grant.grantKey } });
      // Ending always wins, in whichever order they ran: a change that came first is overwritten by the end, one that came after is refused
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'ended' });
      expect(after.endsAt).toEqual(NOW);
      // Billed first: a later change is refused and writes nothing
      const owed = await recordGrant({ ...base, grantKey: `g-${tag}-r2`, settlement: 'to_bill', multiplier: 2, endsAt: days(5) });
      await markGrantBilled(owed.grant.grantKey, NOW);
      await expect(changeGrant(owed.grant.grantKey, { multiplier: 9 }, NOW)).rejects.toThrow(/billed/);
      expect((await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey: owed.grant.grantKey } })).multiplier).toBe(2);
    });

    it('lets a running one change and end, and refuses to rewrite one that was billed, one that ended, or a gift marked billed', async () => {
      const sara = await person('sara');
      const base = { personId: sara.id, givenById: sara.id, startsAt: days(-1) };
      const live = await recordGrant({ ...base, grantKey: `g-${tag}-c`, settlement: 'to_bill', multiplier: 2, endsAt: days(5) });
      const changed = await changeGrant(live.grant.grantKey, { multiplier: 5, endsAt: days(9), note: ' New note ' }, NOW);
      expect(changed).toMatchObject({ multiplier: 5, noLimit: false, note: 'New note' });
      expect(changed.endsAt).toEqual(days(9));
      expect((await changeGrant(live.grant.grantKey, { noLimit: true }, NOW)).noLimit).toBe(true);
      await expect(changeGrant(live.grant.grantKey, { multiplier: 1 }, NOW)).rejects.toThrow(GrantRefused);
      expect(await markGrantBilled(live.grant.grantKey, NOW)).toBe('billed');
      await expect(changeGrant(live.grant.grantKey, { multiplier: 3 }, NOW)).rejects.toThrow(/billed/);
      const gift = await recordGrant({ ...base, grantKey: `g-${tag}-d`, settlement: 'gift', multiplier: 2, endsAt: days(5) });
      expect(await markGrantBilled(gift.grant.grantKey, NOW)).toBe('not_billable');
      expect(await endGrantNow(gift.grant.grantKey, NOW)).toBe('ended');
      expect(await endGrantNow(gift.grant.grantKey, NOW)).toBe('already_ended');
      // One that has not started yet never runs
      const omar = await person('omar');
      const later = await recordGrant({ ...base, personId: omar.id, grantKey: `g-${tag}-g`, settlement: 'gift', multiplier: 2, startsAt: days(2), endsAt: days(5) });
      expect(await endGrantNow(later.grant.grantKey, NOW)).toBe('ended');
      expect(await runningExtra(omar.id, days(3))).toBeNull();
      await expect(changeGrant(gift.grant.grantKey, { multiplier: 3 }, new Date(NOW.getTime() + 1000))).rejects.toThrow(/ended/);
    });
  });

  describe('the super admin’s routes', () => {
    it('are for super admins only: nobody else reads costs, a person’s usage or gives extra usage', async () => {
      const sara = await person('sara');
      session.mockResolvedValue({ id: sara.id, email: 'sara@example.test' });
      const ctx = { params: Promise.resolve({ id: sara.id }) };
      expect((await costsGet(adminCall('/api/admin/meter-costs'))).status).toBe(403);
      expect((await personGet(adminCall(`/api/admin/users/${sara.id}/extra-usage`), ctx)).status).toBe(403);
      expect((await personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, {}), ctx)).status).toBe(403);
      expect((await personPatch(body('PATCH', `/api/admin/users/${sara.id}/extra-usage`, {}), ctx)).status).toBe(403);
      session.mockResolvedValue(null);
      expect((await costsGet(adminCall('/api/admin/meter-costs'))).status).toBe(403);
    });

    it('turn down what cannot be given: a bad amount, a date that is past or more than a year away, no choice of gift or bill, a guest', async () => {
      asAdmin();
      const sara = await person('sara');
      const guest = await prisma.user.create({ data: { uuid: `guest-${tag}`, email: null, name: 'Guest', isGuest: true } });
      people.push(guest.id);
      const ok = { grantKey: randomUUID(), amount: 'double', endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), settlement: 'gift' };
      const send = (over: object, id = sara.id) => personPost(body('POST', `/api/admin/users/${id}/extra-usage`, { ...ok, grantKey: randomUUID(), ...over }), { params: Promise.resolve({ id }) });
      expect((await send({ amount: 'ten' })).status).toBe(400);
      expect((await send({ endsAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
      expect((await send({ endsAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status).toBe(400);
      expect((await send({ settlement: 'free' })).status).toBe(400);
      expect((await send({ settlement: undefined })).status).toBe(400);
      expect((await send({}, guest.id)).status).toBe(404);
      expect((await send({}, 'nobody')).status).toBe(404);
      expect(await prisma.meterGrant.count({})).toBe(0);
      expect((await send({})).status).toBe(201);
    });

    it('only change a person’s own extra usage through that person’s page', async () => {
      asAdmin();
      const sara = await person('sara');
      const omar = await person('omar');
      const real = (n: number) => new Date(Date.now() + n * 86_400_000);
      const { grant } = await recordGrant({ grantKey: `g-${tag}-e`, personId: sara.id, settlement: 'to_bill', multiplier: 2, startsAt: real(-1), endsAt: real(5), givenById: sara.id });
      const patch = (id: string, json: object) => personPatch(body('PATCH', `/api/admin/users/${id}/extra-usage`, json), { params: Promise.resolve({ id }) });
      expect((await patch(omar.id, { grantKey: grant.grantKey, action: 'end' })).status).toBe(404);
      expect((await patch(sara.id, { grantKey: grant.grantKey, action: 'nonsense' })).status).toBe(400);
      expect((await patch(sara.id, { grantKey: grant.grantKey, action: 'billed' })).status).toBe(200);
      const read = await (await personGet(adminCall(`/api/admin/users/${sara.id}/extra-usage`), { params: Promise.resolve({ id: sara.id }) })).json();
      expect(read.extra).toMatchObject({ grantKey: grant.grantKey, settlement: 'to_bill' });
      expect(read.extra.billedAt).not.toBeNull();
      expect((await patch(sara.id, { grantKey: grant.grantKey, action: 'end' })).status).toBe(200);
      expect((await (await personGet(adminCall(`/api/admin/users/${sara.id}/extra-usage`), { params: Promise.resolve({ id: sara.id }) })).json()).extra).toBeNull();
      // A gift cannot be marked billed through the route either
      const gift = await recordGrant({ grantKey: `g-${tag}-f`, personId: sara.id, settlement: 'gift', multiplier: 2, startsAt: real(-1), endsAt: real(5), givenById: sara.id });
      expect((await patch(sara.id, { grantKey: gift.grant.grantKey, action: 'billed' })).status).toBe(400);
    });

    it('turn down dates that are not dates, run backwards, or ask for more than a year of figures', async () => {
      asAdmin();
      expect((await costsGet(adminCall('/api/admin/meter-costs?from=yesterday&to=2026-11-10'))).status).toBe(400);
      expect((await costsGet(adminCall('/api/admin/meter-costs?from=2026-11-10&to=2026-11-04'))).status).toBe(400);
      expect((await costsGet(adminCall('/api/admin/meter-costs?from=2024-01-01&to=2026-11-10'))).status).toBe(400);
      expect((await costsGet(adminCall('/api/admin/meter-costs?from=2026-11-04&to=2026-11-10'))).status).toBe(200);
    });
  });

  describe('the Costs page', () => {
    const range = { from: new Date('2026-11-14T00:00:00Z'), to: new Date('2026-11-15T00:00:00Z') };

    it('counts what was recorded by person, Brick and what the Brick did, each figure with its mark', async () => {
      await setUp();
      const sara = await person('sara');
      const omar = await person('omar');
      const call = (who: { id: string; brickId: string }, micros: number | null, over: object = {}) =>
        recordMeterEvent(event({ kind: 'model_call', pool: 'chat', unit: 'call', personKey: `person:${who.id}`, personId: who.id, botId: who.brickId, brick: true, costMicros: micros, basis: micros === null ? 'unknown' : 'measured', detail: { error: false, greeting: false }, ...over }));
      await call(sara, 4_000_000);
      await call(sara, 2_000_000);
      await call(omar, 1_000_000, { basis: 'estimated' });
      await call(omar, null);
      await recordMeterEvent(event({ kind: 'app_use', pool: 'chat', unit: 'use', quantity: 3, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, costMicros: 0, basis: 'estimated' }));
      await spendComputer(sara, 500_000);
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.totals).toMatchObject({ costMicros: 7_500_000, people: 2, guests: 0, bricks: 2, computers: 1 });
      const models = report.goes.find((row) => row.key === 'models')!;
      expect(models).toMatchObject({ ourMicros: 7_000_000, unpriced: 1, sure: 'Estimated' });
      expect(report.goes.find((row) => row.key === 'apps')).toMatchObject({ uses: 3, sure: 'Estimated' });
      expect(report.goes.find((row) => row.key === 'computers')).toMatchObject({ ourMicros: 500_000, sure: 'Measured' });
      // People: the one who cost most first, with what they did
      expect(report.people.rows.map((row) => [row.name, row.costMicros, row.replies, row.appUses])).toEqual([
        ['sara', 6_500_000, 2, 3],
        ['omar', 1_000_000, 2, 0],
      ]);
      expect(report.bricks.rows.map((row) => row.name)).toEqual([`sara's Brick`, `omar's Brick`]);
      expect(report.bricks.rows[0]).toMatchObject({ ownerName: 'sara', replies: 2, appUses: 3, computerSeconds: 60 });
      expect(report.ways.map((way) => [way.key, way.costMicros])).toEqual([['answered', 7_000_000], ['app', 0], ['computer', 500_000]]);
    });

    it('never counts a price nobody knows as nothing, and a person’s own key as ours', async () => {
      const sara = await person('sara');
      await recordMeterEvent(event({ kind: 'model_call', pool: 'chat', unit: 'call', personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, payerKind: 'person', payerPersonId: sara.id, basis: 'paid_by_other', costMicros: 9_000_000, detail: { error: false } }));
      await recordMeterEvent(event({ kind: 'model_call', pool: 'chat', unit: 'call', personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, basis: 'unknown', costMicros: null, detail: { error: false } }));
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.totals.costMicros).toBe(0);
      expect(report.goes.find((row) => row.key === 'models')).toMatchObject({ ourMicros: null, unpriced: 1, sure: 'Unknown' });
      expect(report.bricks.rows[0]).toMatchObject({ costMicros: 0, ownKeyReplies: 1 });
      const own = await costsReport(range.from, range.to, NOW);
      expect(own.bricks.rows[0].sure).toBe('Unknown');
      await prisma.meterEvent.deleteMany({ where: { basis: 'unknown' } });
      expect((await costsReport(range.from, range.to, NOW)).bricks.rows[0].sure).toBe('Paid by someone else');
    });

    it('stays inside the dates it was given, both ends included, and lists days newest first', async () => {
      const sara = await person('sara');
      const at = (iso: string) => new Date(iso);
      for (const [iso, micros] of [['2026-11-13T23:59:00Z', 100], ['2026-11-14T00:00:00Z', 200], ['2026-11-15T23:59:00Z', 400], ['2026-11-16T00:00:00Z', 800]] as const) await spendComputer(sara, micros, at(iso));
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.totals.costMicros).toBe(600);
      expect(report.days.map((day) => [day.day, day.costMicros, day.people])).toEqual([['2026-11-15', 400, 1], ['2026-11-14', 200, 1]]);
    });

    it('lists the rest of the people in one line when there are many', async () => {
      const who = [];
      for (let i = 0; i < 12; i++) who.push(await person(`p${i}`));
      for (const [i, one] of who.entries()) await spendComputer(one, 1_000 * (i + 1));
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.people.rows).toHaveLength(10);
      expect(report.people.total).toBe(12);
      expect(report.people.more).toEqual({ count: 2, costMicros: 1_000 + 2_000 });
    });

    it('counts guests by universe from their own Brick’s replies, never a failed one', async () => {
      const universe = await prisma.universe.create({ data: { slug: `u-${tag}`, name: `Guest place ${tag}`, ownerId: (await person('host')).id } });
      const reply = (guestKey: string, over: object = {}) => ({ turnId: randomUUID(), universeKey: universe.id, guestKey, createdAt: NOW, ...over });
      await prisma.guestBrickReply.createMany({ data: [reply('g1', { costMicros: 300 }), reply('g1', { costMicros: 200 }), reply('g2', { costMicros: 100 }), reply('g3', { failed: true, costMicros: 999 }), reply('g4', { universeKey: 'outside', costMicros: 50 })] });
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.guests).toEqual([
        { universeKey: universe.id, name: `Guest place ${tag}`, guests: 2, replies: 3, costMicros: 600 },
        { universeKey: 'outside', name: 'Outside any universe', guests: 1, replies: 1, costMicros: 50 },
      ]);
      // Their cost is part of the headline too (a failed reply cost nothing)
      expect(report.totals.costMicros).toBe(650);
      // ...and of the daily figures: the guests' day shows, with nobody counted as a person
      expect(report.days).toEqual([{ day: NOW.toISOString().slice(0, 10), people: 0, costMicros: 650 }]);
      await prisma.universe.delete({ where: { id: universe.id } });
    });

    it('counts the disk as it stood when the dates end, and reads only real calendar days', async () => {
      const sara = await person('sara');
      const disk = (id: string, bytes: number, at: Date) => recordMeterEvent(event({ eventId: `${id}-${tag}`, kind: 'stored_bytes', unit: 'byte', quantity: bytes, personKey: `person:${sara.id}`, personId: sara.id, botId: sara.brickId, brick: true, costMicros: 0, occurredAt: at }));
      await disk('disk-in', 1_000_000_000, new Date('2026-11-14T12:00:00Z'));
      await disk('disk-after', 9_000_000_000, new Date('2026-11-20T12:00:00Z'));
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.goes.find((row) => row.key === 'files')?.bytes).toBe(1_000_000_000);
      expect(readDay('2026-02-30')).toBeNull();
      expect(readDay('2026-13-01')).toBeNull();
      expect(readDay('2026-02-28')).toEqual(new Date('2026-02-28T00:00:00Z'));
    });

    it('keeps the recent places for ended grants, however many newer ones still run', async () => {
      const sara = await person('sara');
      const base = { personId: sara.id, givenById: sara.id, settlement: 'gift' as const, multiplier: 2 };
      await recordGrant({ ...base, grantKey: `g-${tag}-old`, startsAt: days(-30), endsAt: days(-20) });
      for (let i = 0; i < 55; i++) await recordGrant({ ...base, grantKey: `g-${tag}-run-${i}`, startsAt: days(-1), endsAt: days(10) });
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.given.some((row) => row.grantKey === `g-${tag}-old` && row.ended)).toBe(true);
      expect(report.given.filter((row) => !row.ended)).toHaveLength(55);
    });

    it('counts the people waiting beyond the ones listed', async () => {
      const sara = await person('sara');
      await prisma.meterRequest.createMany({ data: Array.from({ length: 202 }, (_, i) => ({ personId: sara.id, what: `thing-${i}`, createdAt: hours(-i) })) });
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.asked).toHaveLength(200);
      expect(report.askedMore).toBe(2);
    });

    it('lists who asked for more, and everything given with "To bill" or "A gift" and what it cost above the usual', async () => {
      await setUp();
      const sara = await person('sara');
      const faisal = await person('faisal');
      await askForMore(sara.id, NOW);
      await recordGrant({ grantKey: `g-${tag}-sara`, personId: sara.id, settlement: 'to_bill', multiplier: 5, startsAt: days(-1), endsAt: days(10), givenById: faisal.id, note: 'Agreed' });
      await recordGrant({ grantKey: `g-${tag}-faisal`, personId: faisal.id, settlement: 'gift', multiplier: 2, startsAt: days(-10), endsAt: days(-5), givenById: sara.id });
      // 1,000 is the usual; Sara spent 2,500 while 5 times the usual ran: 2,500 of it came from the extra
      await spendComputer(sara, 2_500, hours(-5));
      await spendComputer(faisal, 1_500, days(-7));
      const report = await costsReport(range.from, range.to, NOW);
      expect(report.asked.map((row) => row.name)).toEqual(['sara']);
      const bySara = report.given.find((row) => row.grantKey === `g-${tag}-sara`)!;
      const byFaisal = report.given.find((row) => row.grantKey === `g-${tag}-faisal`)!;
      expect(bySara).toMatchObject({ name: 'sara', givenByName: 'faisal', settlement: 'to_bill', billedAt: null, ended: false, aboveUsualMicros: 2_500 });
      expect(byFaisal).toMatchObject({ name: 'faisal', settlement: 'gift', ended: true, aboveUsualMicros: 1_000 });
      // And the person’s row says extra usage runs, until when
      expect((await costsReport(new Date('2026-11-01T00:00:00Z'), range.to, NOW)).people.rows.find((row) => row.name === 'sara')?.extraUntil).toBe(days(10).toISOString());
    });
    it('reads the computer spending once for everyone, whatever the number of people and months their grants span', async () => {
      await setUp();
      const sara = await person('sara');
      const faisal = await person('faisal');
      // Sara's grant crosses from October into November, Faisal's is in November: three months of grants between them, two people
      await recordGrant({ grantKey: `g-${tag}-sara`, personId: sara.id, settlement: 'gift', multiplier: 2, startsAt: days(-30), endsAt: days(10), givenById: faisal.id });
      await recordGrant({ grantKey: `g-${tag}-faisal`, personId: faisal.id, settlement: 'gift', multiplier: 2, startsAt: days(-10), endsAt: days(10), givenById: sara.id });
      // Extra usage is drawn first, a month at a time: Sara's 400 in October and 600 in November both come from hers, Faisal's 300 from his
      await spendComputer(sara, 400, days(-20));
      await spendComputer(sara, 600, days(-2));
      await spendComputer(faisal, 300, days(-2));
      const spy = jest.spyOn(prisma.meterEvent, 'findMany');
      try {
        const report = await costsReport(range.from, range.to, NOW);
        expect(spy.mock.calls.filter(([args]) => (args?.where as { pool?: string } | undefined)?.pool === 'computer')).toHaveLength(1);
        expect(report.given.find((row) => row.grantKey === `g-${tag}-sara`)?.aboveUsualMicros).toBe(1_000);
        expect(report.given.find((row) => row.grantKey === `g-${tag}-faisal`)?.aboveUsualMicros).toBe(300);
      } finally {
        spy.mockRestore();
      }
    });

    it('says the same end on the person’s page and on the Costs page when grants of one size overlap, or a bigger one ends sooner than a smaller one', async () => {
      await setUp();
      const sara = await person('sara');
      const faisal = await person('faisal');
      await spendComputer(sara, 2_500, hours(-5));
      const give = (key: string, amount: number, ends: number) => recordGrant({ grantKey: `g-${tag}-${key}`, personId: sara.id, settlement: 'gift', multiplier: amount, startsAt: days(-1), endsAt: days(ends), givenById: faisal.id });
      // Two of the same size that overlap: the later end is the one reported, in both places
      await give('five-soon', 5, 3);
      await give('five-late', 5, 6);
      const same = async () => {
        const page = (await personUsage(sara.id, NOW)).extra;
        const costs = (await costsReport(new Date('2026-11-01T00:00:00Z'), range.to, NOW)).people.rows.find((row) => row.name === 'sara')?.extraUntil;
        return { page: page?.endsAt, costs, key: page?.grantKey };
      };
      expect(await same()).toEqual({ page: days(6).toISOString(), costs: days(6).toISOString(), key: `g-${tag}-five-late` });
      // A bigger one that ends sooner is the one reported (it is the limit that applies), in both places
      await recordGrant({ grantKey: `g-${tag}-none`, personId: sara.id, settlement: 'gift', noLimit: true, startsAt: days(-1), endsAt: days(2), givenById: faisal.id });
      expect(await same()).toEqual({ page: days(2).toISOString(), costs: days(2).toISOString(), key: `g-${tag}-none` });
    });

    it('keeps a grant still running and a grant still to bill in the list however many newer ones have ended', async () => {
      await setUp();
      const sara = await person('sara');
      const faisal = await person('faisal');
      const old = new Date('2026-09-01T00:00:00Z');
      // Two old ones that still matter: one running now, one that ended long ago and was never billed
      await prisma.meterGrant.create({ data: { grantKey: `g-${tag}-running`, personId: sara.id, settlement: 'gift', multiplier: 2, startsAt: days(-30), endsAt: days(30), givenById: faisal.id, createdAt: old } });
      await prisma.meterGrant.create({ data: { grantKey: `g-${tag}-unbilled`, personId: sara.id, settlement: 'to_bill', multiplier: 2, startsAt: new Date('2026-09-02T00:00:00Z'), endsAt: new Date('2026-09-09T00:00:00Z'), givenById: faisal.id, createdAt: old } });
      // And sixty newer ones that ended and need nothing
      await prisma.meterGrant.createMany({
        data: Array.from({ length: 60 }, (_, index) => ({ grantKey: `g-${tag}-done-${index}`, personId: faisal.id, settlement: 'gift', multiplier: 2, startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: new Date('2026-10-02T00:00:00Z'), givenById: sara.id, createdAt: new Date(old.getTime() + (index + 1) * 60_000) })),
      });
      const report = await costsReport(range.from, range.to, NOW);
      const keys = report.given.map((row) => row.grantKey);
      expect(keys).toContain(`g-${tag}-running`);
      expect(keys).toContain(`g-${tag}-unbilled`);
      // The ended ones that need nothing are only the latest fifty
      expect(keys.filter((key) => key.includes('-done-'))).toHaveLength(50);
    });
  });
});
