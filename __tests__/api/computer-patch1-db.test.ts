/**
 * GPT eighth note, patch 1 (Opus's designs A1 and A2), against a real database through the real routes the game comes in by:
 *  - A1: an ask issued BEFORE one Orbit already holds, arriving after it (the earlier packet delayed on the way), is answered with that ask and makes and reserves nothing; a deliberate later ask still makes its job.
 *  - A2: a redelivered event (the same identity under another time prefix) is the same start, and its consent time is the first key's.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-patch1-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});
// The route's spending check is the real one; a test can hold ONE start (by its key) right after it answered, before the start goes on (GPT's A1 delay)
const held: { key: string | null; reached: (() => void) | null; release: Promise<void> | null } = { key: null, reached: null, release: null };
jest.mock('@/lib/spend-rules', () => {
  const actual = jest.requireActual('@/lib/spend-rules');
  return {
    ...actual,
    ownerSpendAllowed: jest.fn(async (...args: unknown[]) => {
      const answer = await actual.ownerSpendAllowed(...args);
      if (held.key !== null && args[5] === held.key) {
        held.reached?.();
        await held.release;
      }
      return answer;
    }),
  };
});

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { ackStart, finishJob, giveComputer, issuedOfKey, startJob } from '@/lib/computer';
import { resetCarryOnScanForTests } from '@/lib/computer-limit-pause';
import { GET, POST } from '@/app/api/bots/[id]/computer-jobs/route';
import { POST as CONTROL } from '@/app/api/bots/[id]/computer-jobs/control/route';
import { POST as RETIRE } from '@/app/api/bots/[id]/computer-jobs/start-retire/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function owner(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, uuid: unique, brickId: brick.id };
}
type Owner = Awaited<ReturnType<typeof owner>>;

const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, rolloutBudgetMicros: 1_000_000_000_000, ...over }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.spendRule.deleteMany({ where: { ownerPersonId: { in: people } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobsOf = (sara: Owner) => prisma.computerJob.findMany({ where: { personId: sara.id }, orderBy: { createdAt: 'asc' }, select: { id: true, startKey: true, status: true } });
/** The time rooms ever taken, ONE entry per reservation row, by the job each was for (a released room keeps its row). Disk rooms are not time rooms and are left out; the rows are not de-duplicated, so a job that reserved its time twice is listed twice. */
const roomJobsOf = async (sara: Owner) => (await prisma.meterReservation.findMany({ where: { personId: sara.id, reservationKey: { startsWith: 'computer:job:' } }, select: { jobId: true }, orderBy: { createdAt: 'asc' } })).map((room) => room.jobId);

/** One start through the real route, as the game makes it when it acks (key + acks headers). */
const post = async (sara: Owner, startKey: string, title: string, extra: Record<string, string> = {}) =>
  (await POST(
    new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, {
      method: 'POST',
      body: JSON.stringify({ userId: sara.uuid, title, origin: { kind: 'dm', ref: `!chat-${tag}:example.test` } }),
      headers: { 'content-type': 'application/json', 'x-computer-start-attempt': startKey, 'x-computer-start-acks': '1', ...extra },
    }),
    { params: Promise.resolve({ id: sara.brickId }) },
  )).json();
const look = async (sara: Owner, startKey: string) => {
  const res = await GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(sara.uuid)}&attempt=${startKey}`), { params: Promise.resolve({ id: sara.brickId }) });
  return { status: res.status, body: await res.json() };
};
const control = async (sara: Owner, body: Record<string, unknown>, command: string = randomUUID()) => {
  const res = await CONTROL(
    new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/control`, { method: 'POST', body: JSON.stringify({ personId: sara.uuid, ...body }), headers: { 'content-type': 'application/json', 'x-computer-command': command } }),
    { params: Promise.resolve({ id: sara.brickId }) },
  );
  return { status: res.status, body: await res.json() };
};

/** Holds the start under `startKey` right after the route's spending check answered it: resolves once it is held, with the function that lets it go on. */
function holdAfterSpendCheck(startKey: string): { reached: Promise<void>; reachedBy: (request: Promise<unknown>) => Promise<void>; letGo: () => void } {
  let letGo!: () => void;
  held.release = new Promise<void>((resolve) => (letGo = resolve));
  const reached = new Promise<void>((resolve) => (held.reached = resolve));
  held.key = startKey;
  return {
    reached,
    /** Resolves once the start is held; rejects at once, with what it answered, if the request ended without ever reaching the spending check (never a wait until the test times out). */
    reachedBy: (request) => Promise.race([reached, request.then((answer) => Promise.reject(new Error(`the request ended before the spending check held it: ${JSON.stringify(answer)}`)))]),
    letGo: () => {
      held.key = null;
      letGo();
    },
  };
}

/** A key issued `msAgo` before now, with a given identity (the part after the time prefix). */
const keyAgo = (msAgo: number, rest: string = randomUUID().replace(/-/g, '')) => `t${(Date.now() - msAgo).toString(36)}-${rest}`;
const attemptOf = (sara: Owner, startKey: string) => prisma.computerStartAttempt.findUnique({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey } } });
const answerJobOf = (answer: { ok: boolean; job?: { id: string | null } }) => answer.job?.id ?? null;

run('GPT eighth note, patch 1: start identity, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    setComputerProviderForTests(new FakeComputerProvider());
    resetCarryOnScanForTests();
    await setUp();
    held.key = null;
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('A1: the oldest message can be the last one to reach Orbit', () => {
    it('GPT’s trace: B (issued later) is made, acknowledged and finished; A (issued earlier) reaches Orbit afterwards: ONE job, ONE reservation, A answers `earlier` naming B, and a retry of A gets B’s job', async () => {
      const sara = await owner('a1-trace');
      const KEY_A = keyAgo(60_000);
      const KEY_B = keyAgo(30_000);
      const b = await post(sara, KEY_B, 'Please do the visa form');
      expect(b).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, KEY_B)).toBe(true);
      await finishJob(b.job.id, 'done', new Date());
      const a = await post(sara, KEY_A, 'Fill the visa form');
      expect(a).toMatchObject({ ok: false, reason: 'earlier', job: { id: b.job.id, attempt: KEY_B } });
      expect((await jobsOf(sara)).map((job) => job.id)).toEqual([b.job.id]);
      expect(await roomJobsOf(sara)).toEqual([b.job.id]);
      // A's own record: answered with B's job, carrying A's own issue time
      expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'answered', jobId: b.job.id, issuedAt: issuedOfKey(KEY_A) });
      // A retry of A is answered with B's job, which was acknowledged by now (as any key answered with an acknowledged job is), and the look for A says B's job: never "no job", never a second one
      expect(await post(sara, KEY_A, 'Fill the visa form')).toMatchObject({ ok: true, job: { id: b.job.id } });
      expect((await look(sara, KEY_A)).body.started).toMatchObject({ id: b.job.id });
      expect((await jobsOf(sara)).map((job) => job.id)).toEqual([b.job.id]);
      expect(await roomJobsOf(sara)).toEqual([b.job.id]);
    });

    it('A reaches Orbit while B is still being decided (open, no job): A waits on B, and once B made its job, A answers that job; no second job', async () => {
      const sara = await owner('a1-open');
      const KEY_A = keyAgo(60_000);
      const KEY_B = keyAgo(30_000);
      const hold = holdAfterSpendCheck(KEY_B);
      const pendingB = post(sara, KEY_B, 'Please do the visa form');
      pendingB.catch(() => undefined);
      try {
        await hold.reachedBy(pendingB);
        const a = await post(sara, KEY_A, 'Fill the visa form');
        expect(a).toMatchObject({ ok: false, reason: 'earlier', job: { id: null, state: 'starting', attempt: KEY_B } });
        hold.letGo();
        const b = await pendingB;
        expect(b).toMatchObject({ ok: true });
        expect(await post(sara, KEY_A, 'Fill the visa form')).toMatchObject({ ok: false, reason: 'earlier', job: { id: b.job.id } });
        expect((await jobsOf(sara)).map((job) => job.id)).toEqual([b.job.id]);
        expect(await roomJobsOf(sara)).toEqual([b.job.id]);
      } finally {
        hold.letGo();
        await Promise.allSettled([pendingB]);
      }
    });

    it('A reaches Orbit while B is still being decided and B is then REFUSED by the person’s rule: A gives the same refusal, and nothing is made', async () => {
      const sara = await owner('a1-refused');
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(1), words: 'Never more than this a day', createdById: sara.id } });
      const KEY_A = keyAgo(60_000);
      const KEY_B = keyAgo(30_000);
      const hold = holdAfterSpendCheck(KEY_B);
      const pendingB = post(sara, KEY_B, 'Please do the visa form');
      pendingB.catch(() => undefined);
      try {
        await hold.reachedBy(pendingB);
        expect(await post(sara, KEY_A, 'Fill the visa form')).toMatchObject({ ok: false, reason: 'earlier', job: { id: null, state: 'starting', attempt: KEY_B } });
        hold.letGo();
        const b = await pendingB;
        expect(b).toMatchObject({ ok: false, reason: 'rule' });
        expect(await post(sara, KEY_A, 'Fill the visa form')).toEqual(b);
        expect(await jobsOf(sara)).toHaveLength(0);
        expect(await roomJobsOf(sara)).toHaveLength(0);
      } finally {
        hold.letGo();
        await Promise.allSettled([pendingB]);
      }
    });

    it('B (issued later) was REFUSED by the person’s rule and kept; A (issued earlier) then arrives late: A gets B’s kept refusal, no job and no room, and a replay of A says the same (a late older packet never overrides the latest decision)', async () => {
      const sara = await owner('a1-late-after-refusal');
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(1), words: 'Never more than this a day', createdById: sara.id } });
      const KEY_A = keyAgo(60_000);
      const KEY_B = keyAgo(30_000);
      const b = await post(sara, KEY_B, 'Please do the visa form');
      expect(b).toMatchObject({ ok: false, reason: 'rule' });
      expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'refused' });
      expect(await post(sara, KEY_A, 'Fill the visa form')).toEqual(b);
      expect(await post(sara, KEY_A, 'Fill the visa form')).toEqual(b);
      expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'answered', issuedAt: issuedOfKey(KEY_A) });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toHaveLength(0);
    });

    it('positive control: a deliberate second same-title ask, issued AFTER the first was answered, makes its own job and room', async () => {
      const sara = await owner('a1-second');
      const KEY_A = keyAgo(60_000);
      const KEY_C = keyAgo(10_000);
      const a = await post(sara, KEY_A, 'Fill the visa form');
      expect(a).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, KEY_A)).toBe(true);
      await finishJob(a.job.id, 'done', new Date());
      const c = await post(sara, KEY_C, 'Fill the visa form');
      expect(c).toMatchObject({ ok: true });
      expect(c.job.id).not.toBe(a.job.id);
      expect(await jobsOf(sara)).toHaveLength(2);
      expect(new Set(await roomJobsOf(sara)).size).toBe(2);
    });

    it('two starts of ONE message (the same issue time to the millisecond) never answer each other: both make their jobs', async () => {
      const sara = await owner('a1-equal');
      const at = Date.now() - 20_000;
      const KEY_1 = `t${at.toString(36)}-${randomUUID().replace(/-/g, '')}`;
      const KEY_2 = `t${at.toString(36)}-${randomUUID().replace(/-/g, '')}`;
      const first = await post(sara, KEY_2, 'Fill the visa form');
      expect(first).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, KEY_2)).toBe(true);
      const second = await post(sara, KEY_1, 'Book the taxi');
      expect(second).toMatchObject({ ok: true });
      expect(answerJobOf(second)).not.toBe(first.job.id);
    });

    it('a start with no time in its key (the legacy format, no ack) is untouched by a newer ask', async () => {
      const sara = await owner('a1-legacy');
      const b = await post(sara, keyAgo(30_000), 'Please do the visa form');
      expect(b).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, (await jobsOf(sara))[0].startKey as string)).toBe(true);
      const legacy = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fill the visa form', startKey: `legacy-${tag}-${made}-aaaa` });
      expect(legacy).toMatchObject({ ok: true });
      expect(await jobsOf(sara)).toHaveLength(2);
    });
  });

  describe('A2: a redelivered event is the same start', () => {
    const restOf = () => `mx_${randomUUID().replace(/-/g, '').slice(0, 32)}`;
    const ack = async (sara: Owner, startKey: string) => (await jobsOf(sara)).find((job) => job.startKey === startKey);
    const ack2 = (sara: Owner, startKey: string) =>
      POST(
        new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, {
          method: 'POST',
          body: JSON.stringify({ action: 'start-ack', userId: sara.uuid, attempt: startKey }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ id: sara.brickId }) },
      ).then((res) => res.json());

    it('GPT’s trace: the first key made its job, which was acknowledged and ended; the same event again under a NEW time prefix is that start: ONE job, ONE reservation, the first key is what it answers', async () => {
      const sara = await owner('a2-redelivery');
      const REST = restOf();
      const KEY_1 = keyAgo(120_000, REST);
      const KEY_2 = keyAgo(1_000, REST);
      const first = await post(sara, KEY_1, 'Fill the visa form');
      expect(first).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, KEY_1)).toBe(true);
      await finishJob(first.job.id, 'done', new Date());
      const again = await post(sara, KEY_2, 'Fill the visa form');
      expect(again).toMatchObject({ ok: true, job: { id: first.job.id } });
      expect(await jobsOf(sara)).toHaveLength(1);
      expect(await roomJobsOf(sara)).toEqual([first.job.id]);
      // The look for the new prefix finds the first key's job, and it names the first key
      expect((await look(sara, KEY_2)).body.started).toMatchObject({ id: first.job.id, attempt: KEY_1 });
      // No row of its own is made for the replay
      expect(await attemptOf(sara, KEY_2)).toBeNull();
    });

    it('the ack and the retire of the new prefix reach the first key’s start', async () => {
      const sara = await owner('a2-ack');
      const REST = restOf();
      const KEY_1 = keyAgo(120_000, REST);
      const KEY_2 = keyAgo(1_000, REST);
      const first = await post(sara, KEY_1, 'Fill the visa form');
      expect(first).toMatchObject({ ok: true });
      expect((await ack(sara, KEY_1))?.id).toBe(first.job.id);
      expect(await ack2(sara, KEY_2)).toMatchObject({ ok: true, acked: true });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: first.job.id } })).startAckedAt).not.toBeNull();
      const retired = await RETIRE(
        new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/start-retire`, { method: 'POST', body: JSON.stringify({ userId: sara.uuid, startKey: KEY_2 }), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ id: sara.brickId }) },
      );
      // A key Orbit has seen is followed, never retired: its start happened
      expect(await retired.json()).toMatchObject({ ok: true, retired: false });
      expect(await jobsOf(sara)).toHaveLength(1);
    });

    it('consent is the FIRST key’s: a first key issued 7 hours ago whose attempt ended with no job makes the replay `stale_consent`, whatever time its prefix carries now', async () => {
      const sara = await owner('a2-stale');
      const REST = restOf();
      const KEY_OLD = keyAgo(7 * 3_600_000, REST);
      const KEY_NEW = keyAgo(1_000, REST);
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_OLD, state: 'expired', issuedAt: issuedOfKey(KEY_OLD) } });
      expect(await post(sara, KEY_NEW, 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toHaveLength(0);
      // The same identity under a time of its own, with no record before: a fresh ask
      expect(await post(sara, keyAgo(1_000), 'Fill the visa form')).toMatchObject({ ok: true });
    });

    it('two records of one identity (the result of a race): the FIRST consent decides, so a third delivery under a new prefix is `stale_consent` when the first record is 7 hours old, though the second one is fresh', async () => {
      const sara = await owner('a2-order');
      const REST = restOf();
      const KEY_OLD = keyAgo(7 * 3_600_000, REST);
      const KEY_MID = keyAgo(2_000, REST);
      for (const startKey of [KEY_MID, KEY_OLD]) await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey, state: 'expired', issuedAt: issuedOfKey(startKey) } });
      expect(await post(sara, keyAgo(500, REST), 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toHaveLength(0);
    });

    it('a NEW event (another identity) still makes its own second job, even with the same title', async () => {
      const sara = await owner('a2-second');
      const first = await post(sara, keyAgo(60_000, restOf()), 'Fill the visa form');
      expect(first).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, first.job.attempt)).toBe(true);
      await finishJob(first.job.id, 'done', new Date());
      const second = await post(sara, keyAgo(1_000, restOf()), 'Fill the visa form');
      expect(second).toMatchObject({ ok: true });
      expect(second.job.id).not.toBe(first.job.id);
      expect(await jobsOf(sara)).toHaveLength(2);
      expect(new Set(await roomJobsOf(sara)).size).toBe(2);
    });

    it('the identity is matched EXACTLY: `_` is no wildcard (a stored identity that differs in that one character is another event)', async () => {
      const sara = await owner('a2-like');
      const stored = await post(sara, keyAgo(60_000, 'mxXabcdef0123456789abcdef01234567'), 'Fill the visa form');
      expect(stored).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, stored.job.attempt)).toBe(true);
      await finishJob(stored.job.id, 'done', new Date());
      const other = await post(sara, keyAgo(1_000, 'mx_abcdef0123456789abcdef01234567'), 'Fill the visa form');
      expect(other).toMatchObject({ ok: true });
      expect(other.job.id).not.toBe(stored.job.id);
    });

    it('two prefixes of one identity at once, with no record yet: ONE job and ONE reservation (repeated, so the order varies)', async () => {
      for (let round = 0; round < 6; round++) {
        const sara = await owner(`a2-race-${round}`);
        const REST = restOf();
        const answers = await Promise.all([post(sara, keyAgo(2_000, REST), 'Fill the visa form'), post(sara, keyAgo(500, REST), 'Fill the visa form')]);
        const jobs = await jobsOf(sara);
        expect(jobs).toHaveLength(1);
        expect(await roomJobsOf(sara)).toEqual([jobs[0].id]);
        for (const answer of answers) expect(answerJobOf(answer) === null || answerJobOf(answer) === jobs[0].id).toBe(true);
      }
    });
  });

  describe('E2 (Orbit side): the times the game tells two same-title jobs apart by', () => {
    it('every job of the list carries `askedAt` (when the person asked) and an ended job lists its `endedAt`, both ISO 8601 UTC text', async () => {
      const sara = await owner('e2-times');
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!first.ok) throw new Error('no job');
      await finishJob(first.job.id, 'done', new Date(Date.now() - 60_000));
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!second.ok) throw new Error('no job');
      const third = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!third.ok) throw new Error('no job');
      const rows = await prisma.computerJob.findMany({ where: { personId: sara.id }, select: { id: true, createdAt: true, endedAt: true } });
      const created = (id: string) => rows.find((row) => row.id === id)?.createdAt.toISOString();
      const listed = await control(sara, { action: 'list' });
      expect(listed.body.view.job.askedAt).toBe(created(listed.body.view.job.id));
      expect(listed.body.view.queued).toHaveLength(1);
      // The order contract with the game: the line is oldest asked first; ended jobs are newest ended first
      expect(new Date(listed.body.view.job.askedAt).getTime()).toBeLessThanOrEqual(new Date(listed.body.view.queued[0].askedAt).getTime());
      expect(listed.body.view.queued[0].askedAt).toBe(created(listed.body.view.queued[0].id));
      const ended = await GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(sara.uuid)}&ended=3`), { params: Promise.resolve({ id: sara.brickId }) });
      const body = await ended.json();
      expect(body.ended).toHaveLength(1);
      expect(body.ended[0]).toMatchObject({ id: first.job.id, endedAt: rows.find((row) => row.id === first.job.id)?.endedAt?.toISOString() });
      expect(body.ended[0].endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
