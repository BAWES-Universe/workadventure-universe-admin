/**
 * GPT seventh note (round 8), the Orbit side of A, C and D2, against a real database through the real routes the game comes in by:
 *  - A1: a start delayed INSIDE the route's spending check is registered before a later (reworded, new-key) retry can overtake it: one request, one job, one reservation, and both keys answer that job.
 *  - A2: a key whose job ran and whose record was retired gets a terminal answer (never `expired`, which the game answers with a fresh key), and the identical key after the clean-up makes nothing.
 *  - C: a job its month or a limit paused, carried on but sent back in line, is admitted only if the refused call and the startup still fit when it actually starts; otherwise it stays paused with ZERO new billable time.
 *  - D2: Stop all carries the confirmed job set: a job that joined the line after the confirmation is not the person's stop.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-round8-db.test.ts --runInBand
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
import { ackStart, claimJob, controlInternals, finishJob, finishJobUnder, forgetOldStartMarks, giveComputer, issuedOfKey, registerStart, startJob, DEAD_ANSWER_MS } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { carryOnPaused, resetCarryOnScanForTests } from '@/lib/computer-limit-pause';
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

// Round 8, A2: a start that acks carries its issue time (the moment of the message) in its key
const key = () => `t${Date.now().toString(36)}-${randomUUID().replace(/-/g, '')}`;
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

run('GPT seventh note (round 8): Orbit side of A, C and D2, in a real database', () => {
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

  describe('A1: the original start is registered before a later request can overtake it', () => {
    it('REPRO: A held inside the route’s spending check; reworded retry B under a new key is sent, (if admitted) acknowledged and finished; A goes on: ONE job, ONE reservation, both keys answer it', async () => {
      const sara = await owner('a1');
      const KEY_A = key();
      const KEY_B = key();
      const hold = holdAfterSpendCheck(KEY_A);
      const pendingA = post(sara, KEY_A, 'Fill the visa form');
      pendingA.catch(() => undefined);
      try {
        await hold.reachedBy(pendingA);
        // While A is held the look for A never says "no job" (the game would then send a fresh start): it is going on: the answer is the 503 `inProgress` one, not a miss and not some other failure
        const during = await look(sara, KEY_A);
        expect(during.status).toBe(503);
        expect(during.body).toMatchObject({ retry: true, inProgress: true });
        const b = await post(sara, KEY_B, 'Please do the visa form');
        // What the game does with B's answer: a job it acknowledges, and the job runs to the end
        if (b.ok) {
          expect(await ackStart(sara.brickId, sara.id, KEY_B)).toBe(true);
          await finishJob(b.job.id, 'done', new Date());
        }
        hold.letGo();
        const a = await pendingA;
        const jobs = await jobsOf(sara);
        expect(jobs).toHaveLength(1);
        // ONE reservation row for time, and it is the one job's
        expect(await roomJobsOf(sara)).toEqual([jobs[0].id]);
        // Whoever made it, the one job is what both keys answer, now and on a retry
        expect((await look(sara, KEY_A)).body.started).toMatchObject({ id: jobs[0].id });
        expect((await look(sara, KEY_B)).body.started).toMatchObject({ id: jobs[0].id });
        const jobOfAnswer = (answer: { ok: boolean; job?: { id: string | null; attempt?: string | null } }) => (answer.ok ? answer.job?.id : (answer.job?.id ?? null));
        expect([jobs[0].id, null]).toContain(jobOfAnswer(a));
        const again = await post(sara, KEY_A, 'Fill the visa form');
        expect((await jobsOf(sara))).toHaveLength(1);
        expect(again.ok ? again.job.id : again.job?.id).toBe(jobs[0].id);
      } finally {
        hold.letGo();
        await Promise.allSettled([pendingA]);
      }
    });

    it('variant: A’s registration itself is delayed past B’s job (A began first): A is answered with B’s job and makes none', async () => {
      const sara = await owner('a1-late-insert');
      const KEY_A = key();
      const KEY_B = key();
      const beganA = new Date();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const b = await post(sara, KEY_B, 'Please do the visa form');
      expect(b).toMatchObject({ ok: true });
      expect(await ackStart(sara.brickId, sara.id, KEY_B)).toBe(true);
      // A's request began before B's, and only now writes its attempt
      const issued = issuedOfKey(KEY_A);
      if (!issued) throw new Error('untimed');
      const registered = await registerStart(sara.brickId, sara.id, KEY_A, beganA, issued);
      if (!('registration' in registered)) throw new Error(JSON.stringify(registered));
      try {
        const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fill the visa form', startKey: KEY_A, acks: true, began: beganA, registration: registered.registration, origin: { kind: 'dm', ref: `!chat-${tag}:example.test` } });
        expect(a).toMatchObject({ ok: true, job: { id: b.job.id } });
      } finally {
        await registered.registration.release();
      }
      expect((await jobsOf(sara)).map((job) => job.id)).toEqual([b.job.id]);
      expect(await roomJobsOf(sara)).toEqual([b.job.id]);
    });

    it('variant: A held inside the spending check ends `rule`; B, which waited on A, is answered `rule` too on its retry (never `expired`), and nothing is made', async () => {
      const sara = await owner('a1-rule');
      await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(1), words: 'Never more than this a day', createdById: sara.id } });
      const KEY_A = key();
      const KEY_B = key();
      const hold = holdAfterSpendCheck(KEY_A);
      const pendingA = post(sara, KEY_A, 'Fill the visa form');
      pendingA.catch(() => undefined);
      try {
        await hold.reachedBy(pendingA);
        const b = await post(sara, KEY_B, 'Please do the visa form');
        expect(b).toMatchObject({ ok: false, reason: 'earlier', job: { id: null, state: 'starting', attempt: KEY_A } });
        hold.letGo();
        const a = await pendingA;
        expect(a).toMatchObject({ ok: false, reason: 'rule' });
        // Both keys, asked again: that same refusal, kept
        expect(await post(sara, KEY_A, 'Fill the visa form')).toEqual(a);
        expect(await post(sara, KEY_B, 'Please do the visa form')).toEqual(a);
        expect(await jobsOf(sara)).toHaveLength(0);
        expect(await roomJobsOf(sara)).toEqual([]);
      } finally {
        hold.letGo();
        await Promise.allSettled([pendingA]);
      }
    });

    it('CONTROL: a deliberate new request with the same words under a NEW key, once the first is acknowledged, still makes its own job', async () => {
      const sara = await owner('a1-new');
      const KEY_A = key();
      const a = await post(sara, KEY_A, 'Fill the visa form');
      expect(a).toMatchObject({ ok: true });
      await ackStart(sara.brickId, sara.id, KEY_A);
      await finishJob(a.job.id, 'done', new Date());
      const KEY_C = key();
      const c = await post(sara, KEY_C, 'Fill the visa form');
      expect(c).toMatchObject({ ok: true });
      expect(c.job.id).not.toBe(a.job.id);
      expect(await jobsOf(sara)).toHaveLength(2);
    });
  });

  describe('A2: a key whose job ran and whose record was retired', () => {
    it('REPRO: the job finished and its row was removed: the same key is answered with a terminal "already ran" (never `expired`), and makes nothing', async () => {
      const sara = await owner('a2-removed');
      const KEY_A = key();
      const a = await post(sara, KEY_A, 'Fill the visa form');
      await ackStart(sara.brickId, sara.id, KEY_A);
      await finishJob(a.job.id, 'done', new Date());
      await prisma.computerJob.delete({ where: { id: a.job.id } });
      const again = await post(sara, KEY_A, 'Fill the visa form');
      expect(again.ok).toBe(false);
      // `expired` makes the game start afresh under a derived key; a retired key's answer must not
      expect(again.reason).not.toBe('expired');
      expect(again).toEqual({ ok: false, reason: 'retired' });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toEqual([a.job.id]);
    });

    it('REPRO: after the clean-up pruned the record (past the retention), the IDENTICAL key makes nothing: it is `stale_consent` (an old message needs fresh consent)', async () => {
      const sara = await owner('a2-pruned');
      const KEY_A = key();
      const a = await post(sara, KEY_A, 'Fill the visa form');
      await ackStart(sara.brickId, sara.id, KEY_A);
      await finishJob(a.job.id, 'done', new Date());
      await prisma.computerJob.delete({ where: { id: a.job.id } });
      // Eight days on, the clean-up runs and the key's record is gone
      const later = new Date(Date.now() + DEAD_ANSWER_MS + 86_400_000);
      await forgetOldStartMarks(later);
      expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id } })).toBe(0);
      // The identical key, eight days after it was issued (the route's own clock is the request's: the library is asked at that moment)
      const issued = issuedOfKey(KEY_A);
      if (!issued) throw new Error('the key carries no issue time');
      expect(await registerStart(sara.brickId, sara.id, KEY_A, later, issued, later)).toEqual({ answer: { ok: false, reason: 'stale_consent' } });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id } })).toBe(0);
    });

    it('through the route: a key issued 7 hours ago that Orbit never saw is `stale_consent`, and nothing is made or reserved; one issued 5 hours ago starts', async () => {
      const sara = await owner('a2-stale');
      const old = `t${(Date.now() - 7 * 3_600_000).toString(36)}-${randomUUID().replace(/-/g, '')}`;
      expect(await post(sara, old, 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
      expect(await post(sara, old, 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toEqual([]);
      const recent = `t${(Date.now() - 5 * 3_600_000).toString(36)}-${randomUUID().replace(/-/g, '')}`;
      expect(await post(sara, recent, 'Fill the visa form')).toMatchObject({ ok: true });
    });

    it('Opus’s survivor M6: an attempt that ended with no job (expired, or open but no longer beating) whose key was issued 6 h + 1 min ago is NOT reopened: `stale_consent`, no job, nothing reserved', async () => {
      const sara = await owner('a2-ended-stale');
      const issuedAt = new Date(Date.now() - 6 * 3_600_000 - 60_000);
      for (const state of ['expired', 'open'] as const) {
        const OLD = `t${issuedAt.getTime().toString(36)}-${randomUUID().replace(/-/g, '')}`;
        // Its start began right after the message, and stopped beating long ago
        await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: OLD, state, beatAt: new Date(issuedAt.getTime() + 60_000), createdAt: new Date(issuedAt.getTime() + 1_000), issuedAt } });
        expect(await post(sara, OLD, 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
        expect(await post(sara, OLD, 'Fill the visa form')).toEqual({ ok: false, reason: 'stale_consent' });
        // Left as it was: never reopened
        expect(await prisma.computerStartAttempt.findUniqueOrThrow({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey: OLD } } })).toMatchObject({ state, jobId: null });
      }
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toEqual([]);
      // CONTROL: the same ended attempt with a key issued 5 h 59 min ago is reopened and makes its job
      const recentAt = new Date(Date.now() - 6 * 3_600_000 + 60_000);
      const RECENT = `t${recentAt.getTime().toString(36)}-${randomUUID().replace(/-/g, '')}`;
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: RECENT, state: 'expired', beatAt: new Date(recentAt.getTime() + 60_000), createdAt: new Date(recentAt.getTime() + 1_000), issuedAt: recentAt } });
      expect(await post(sara, RECENT, 'Fill the visa form')).toMatchObject({ ok: true });
      expect(await jobsOf(sara)).toHaveLength(1);
    });

    it('a key that carries no issue time, or one from the future, is refused (400) on a start that acks', async () => {
      const sara = await owner('a2-untimed');
      const untimed = await POST(
        new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, { method: 'POST', body: JSON.stringify({ userId: sara.uuid, title: 'x' }), headers: { 'content-type': 'application/json', 'x-computer-start-attempt': `k_${randomUUID().replace(/-/g, '')}`, 'x-computer-start-acks': '1' } }),
        { params: Promise.resolve({ id: sara.brickId }) },
      );
      expect(untimed.status).toBe(400);
      const future = await POST(
        new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, { method: 'POST', body: JSON.stringify({ userId: sara.uuid, title: 'x' }), headers: { 'content-type': 'application/json', 'x-computer-start-attempt': `t${(Date.now() + 10 * 60_000).toString(36)}-abcdef0123`, 'x-computer-start-acks': '1' } }),
        { params: Promise.resolve({ id: sara.brickId }) },
      );
      expect(future.status).toBe(400);
      expect(await jobsOf(sara)).toHaveLength(0);
    });
  });

  describe('C: funding is checked again when a queued carry-on actually starts', () => {
    const PER_MINUTE = 6_000;
    const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
    const timeEvents = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' } });
    const roomsOfJob = (jobId: string) => prisma.meterReservation.count({ where: { jobId } });

    it('REPRO: 900,000 refused; allowance raised so it fits; another job holds the machine so it goes back in line; allowance lowered to 600,000; the slot opens: it stays paused, ZERO new time event, ZERO new room', async () => {
      const sara = await owner('c-line');
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!started.ok) throw new Error('no job');
      const jobId = started.job.id;
      const won = await claimJob(jobId, { run: 'rA', seen: (await jobOf(jobId)).ownerEpoch });
      if (!won.ok) throw new Error('not claimed');
      const token = ((await mintJobToken(jobId, 'model', new Date(), { generation: (await jobOf(jobId)).controlGeneration }, { epoch: won.epoch })) as { ok: true; token: string }).token;
      expect(await authorizeModelCall({ token, callId: 'c-small', estimateMicros: 300_000, payer: 'universe', turn: 1, run: 'rA' })).toMatchObject({ ok: true });
      await settleModelCall(jobId, 'c-small', { costMicros: 300_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, new Date());
      expect(await authorizeModelCall({ token, callId: 'c-big', estimateMicros: 900_000, payer: 'universe', turn: 1, run: 'rA' })).toEqual({ ok: false, reason: 'allowance' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance' });
      const before = { events: (await timeEvents(jobId)).length, rooms: await roomsOfJob(jobId) };
      // Another job takes the machine (it writes, as this one does)
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hotel' });
      if (!other.ok || other.job.status !== 'running') throw new Error('the other job did not run');
      // Enough for the refused call and the room to run: carried on, but back in line behind the other job
      await setUp({ memberAllowanceMicros: 2_000_000 });
      expect(await carryOnPaused(new Date())).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', carryOnPending: true });
      // The money goes before the slot opens
      await setUp({ memberAllowanceMicros: 600_000 });
      await finishJobUnder(other.job.id, null, 'done', new Date());
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', reservationKey: null });
      expect((await timeEvents(jobId)).length).toBe(before.events);
      // Exactly one time event: the first pause's
      expect(before.events).toBe(1);
      expect(await roomsOfJob(jobId)).toBe(before.rooms);
      // CONTROL: when the money is back the sweep carries it on (and only then)
      await setUp({ memberAllowanceMicros: 5_000_000 });
      expect(await carryOnPaused(new Date())).toBe(1);
      expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      expect(PER_MINUTE).toBe(6_000);
    });
  });

  describe('D2: Stop all stops only the confirmed jobs', () => {
    it('REPRO: the person confirmed [A]; job B joined the line before the Stop landed: A is stopped by the person, B is NOT', async () => {
      const sara = await owner('d2');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!a.ok || a.job.status !== 'running') throw new Error('A did not run');
      const listed = await control(sara, { action: 'list' });
      const confirmed: string[] = [listed.body.view.job.id];
      expect(confirmed).toEqual([a.job.id]);
      // B arrives after the question was asked
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Taxi booking' });
      if (!b.ok) throw new Error('B was not made');
      expect(b.job.status).toBe('queued');
      const command = randomUUID();
      const stopped = await control(sara, { action: 'stop_all', confirmedJobIds: confirmed }, command);
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ ok: true, stopped: [a.job.id], left: [{ id: b.job.id, title: 'Taxi booking' }] });
      // The same command again: the same outcome, nothing more ended
      const replay = await control(sara, { action: 'stop_all', confirmedJobIds: confirmed }, command);
      expect(replay.body).toMatchObject({ ok: true, stopped: [a.job.id], left: [{ id: b.job.id, title: 'Taxi booking' }] });
      // The same command id with ANOTHER set is a conflict, and ends nothing
      const other = await control(sara, { action: 'stop_all', confirmedJobIds: [b.job.id] }, command);
      expect(other.status).toBe(409);
      expect(other.body).toMatchObject({ ok: false, reason: 'command_reused' });
      const after = await prisma.computerJob.findMany({ where: { id: { in: [a.job.id, b.job.id] } }, select: { id: true, status: true, endedBy: true } });
      expect(after.find((job) => job.id === a.job.id)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      const bAfter = after.find((job) => job.id === b.job.id);
      expect(bAfter?.endedBy).not.toBe('person');
      expect(['queued', 'running']).toContain(bAfter?.status);
    });

    it('`left` names every live job not in the set, newest first, with its title; the panel’s stop route takes the same set', async () => {
      const sara = await owner('d2-left');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Taxi booking' }, new Date(Date.now() + 1_000));
      const c = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Hotel' }, new Date(Date.now() + 2_000));
      if (!a.ok || !b.ok || !c.ok) throw new Error('jobs were not made');
      const stopped = await control(sara, { action: 'stop_all', confirmedJobIds: [a.job.id] });
      expect(stopped.body.left).toEqual([
        { id: c.job.id, title: 'Hotel' },
        { id: b.job.id, title: 'Taxi booking' },
      ]);
    });

    it('confirmed ids that are already over or unknown are skipped; `stop` with the set behaves as `stop_all`', async () => {
      const sara = await owner('d2-skip');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!a.ok) throw new Error('A was not made');
      const stopped = await control(sara, { action: 'stop', confirmedJobIds: [a.job.id, randomUUID()] });
      expect(stopped.body).toMatchObject({ ok: true, stopped: [a.job.id], left: [] });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
    });

    it('CONTROL (legacy): `stop` with no set still ends everything live, and answers no stopped/left', async () => {
      const sara = await owner('d2-legacy');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Taxi booking' });
      if (!a.ok || !b.ok) throw new Error('jobs were not made');
      const stopped = await control(sara, { action: 'stop' });
      expect(stopped.body.ok).toBe(true);
      expect(stopped.body.stopped).toBeUndefined();
      const after = await prisma.computerJob.findMany({ where: { id: { in: [a.job.id, b.job.id] } }, select: { status: true } });
      expect(after.map((job) => job.status)).toEqual(['stopped', 'stopped']);
    });

    it('`stop_all` without a set, or with more than 50 ids, is refused as invalid', async () => {
      const sara = await owner('d2-invalid');
      expect((await control(sara, { action: 'stop_all' })).status).toBe(400);
      expect((await control(sara, { action: 'stop_all', confirmedJobIds: Array.from({ length: 51 }, () => randomUUID()) })).status).toBe(400);
    });
  });

  describe('CodeRabbit on #1025 (d522f4b3 pass, N11): a Cancel that leaves the job live is a retryable failure, never a cancelled job', () => {
    it('the bot route answers 503 not_ended retry:true while the job still holds the machine, keeps the command pending, and the same command id then ends it (200)', async () => {
      const sara = await owner('n11');
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' });
      if (!a.ok || a.job.status !== 'running') throw new Error('A did not run');
      const command = randomUUID();
      const spy = jest.spyOn(controlInternals, 'endByPerson').mockImplementation(async () => undefined);
      try {
        const first = await control(sara, { action: 'cancel', jobId: a.job.id }, command);
        expect(first.status).toBe(503);
        expect(first.body).toEqual({ ok: false, reason: 'not_ended', retry: true });
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'running' });
      // The SAME command row is still there, pending, and still targets this job: the retry below finishes it, it does not make a new one (CodeRabbit on #1025, 14c4e407 pass, N11)
      expect(await prisma.computerJobCommand.findUnique({ where: { commandId: command } })).toMatchObject({ jobId: a.job.id, outcome: { ok: true, pending: true, targets: [a.job.id] } });
      const retried = await control(sara, { action: 'cancel', jobId: a.job.id }, command);
      expect(retried.status).toBe(200);
      expect(retried.body.ok).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
      // CONTROL: a Cancel that did end the job is the success it always was
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Taxi booking' });
      if (!b.ok) throw new Error('B was not made');
      expect((await control(sara, { action: 'cancel', jobId: b.job.id })).status).toBe(200);
    });
  });

  describe('start-retire: the game gives up on a key Orbit never answered (Opus’s ruling on CodeRabbit’s pass of game 24dea75c)', () => {
    const retire = async (sara: Owner, attempt: string) =>
      (await POST(
        new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, { method: 'POST', body: JSON.stringify({ action: 'start-retire', userId: sara.uuid, attempt }), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ id: sara.brickId }) },
      )).json();

    it('a key Orbit never saw is retired; its start arriving late (it never registered) makes nothing and is answered `retired_by_game` from then on', async () => {
      const sara = await owner('retire-unseen');
      const OLD = key();
      expect(await retire(sara, OLD)).toEqual({ ok: true, retired: true });
      expect(await retire(sara, OLD)).toMatchObject({ ok: true, retired: false, answer: { ok: false, reason: 'retired_by_game' } });
      expect(await post(sara, OLD, 'Visa form')).toEqual({ ok: false, reason: 'retired_by_game' });
      expect(await jobsOf(sara)).toHaveLength(0);
      // The new, different ask goes on under its own key
      expect(await post(sara, key(), 'Book a taxi')).toMatchObject({ ok: true });
      expect(await jobsOf(sara)).toHaveLength(1);
    });

    it('a key Orbit saw is NOT retired: the answer a send would get (a job, or a kept refusal), and nothing changes', async () => {
      const sara = await owner('retire-seen');
      const MADE = key();
      const made = await post(sara, MADE, 'Visa form');
      await ackStart(sara.brickId, sara.id, MADE);
      expect(await retire(sara, MADE)).toMatchObject({ ok: true, retired: false, answer: { ok: true, job: { id: made.job.id } } });
      await finishJob(made.job.id, 'done', new Date());
      // A refused key: its kept refusal
      const tom = await owner('retire-refused');
      await prisma.brickComputer.update({ where: { botId: tom.brickId }, data: { enabled: false } });
      const REFUSED = key();
      expect(await post(tom, REFUSED, 'Visa form')).toEqual({ ok: false, reason: 'off' });
      expect(await retire(tom, REFUSED)).toEqual({ ok: true, retired: false, answer: { ok: false, reason: 'off' } });
      expect(await jobsOf(tom)).toHaveLength(0);
    });

    it('the same through its own path (`/computer-jobs/start-retire` with `startKey`)', async () => {
      const sara = await owner('retire-path');
      const OLD = key();
      const call = async (body: Record<string, unknown>) => {
        const res = await RETIRE(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs/start-retire`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: sara.brickId }) });
        return { status: res.status, body: await res.json() };
      };
      expect(await call({ userId: sara.uuid, startKey: OLD })).toEqual({ status: 200, body: { ok: true, retired: true } });
      expect(await post(sara, OLD, 'Visa form')).toEqual({ ok: false, reason: 'retired_by_game' });
      expect((await call({ userId: sara.uuid, startKey: 'no' })).status).toBe(400);
      expect(await jobsOf(sara)).toHaveLength(0);
    });

    it('a key whose start came to nothing (expired) is retired, and is never reopened after', async () => {
      const sara = await owner('retire-expired');
      const OLD = key();
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: OLD, state: 'expired', beatAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 60_000) } });
      expect(await retire(sara, OLD)).toEqual({ ok: true, retired: true });
      expect(await post(sara, OLD, 'Visa form')).toEqual({ ok: false, reason: 'retired_by_game' });
      expect(await jobsOf(sara)).toHaveLength(0);
    });

    it('a start of the key that is still going on is not retired: the answer names that key, to be looked up', async () => {
      const sara = await owner('retire-going');
      const OLD = key();
      const hold = holdAfterSpendCheck(OLD);
      const pending = post(sara, OLD, 'Visa form');
      pending.catch(() => undefined);
      try {
        await hold.reachedBy(pending);
        expect(await retire(sara, OLD)).toEqual({ ok: true, retired: false, answer: { ok: false, reason: 'earlier', job: { id: null, status: null, state: 'starting', attempt: OLD } } });
        hold.letGo();
        expect(await pending).toMatchObject({ ok: true });
      } finally {
        hold.letGo();
        await Promise.allSettled([pending]);
      }
    });
  });

  describe('GET ended=N: the person’s ended jobs for "Which job?" (round 8, E)', () => {
    const ended = async (sara: Owner, n: string, who: string = sara.uuid) => {
      const res = await GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(who)}&ended=${n}`), { params: Promise.resolve({ id: sara.brickId }) });
      return { status: res.status, body: await res.json() };
    };

    it('newest first, at most 5, with `continuable` as the start’s own test; nonsense is 400; someone else gets none', async () => {
      const sara = await owner('ended');
      const ids: string[] = [];
      for (let n = 0; n < 7; n++) {
        const job = await startJob({ botId: sara.brickId, personId: sara.id, title: `Job ${n}` });
        if (!job.ok) throw new Error('no job');
        ids.push(job.job.id);
        // The odd ones reached their agent and failed on our side (they carry on); the even ones were done
        if (n % 2 === 1) await prisma.computerJob.update({ where: { id: job.job.id }, data: { agentSessionId: `s-${n}` } });
        await finishJob(job.job.id, n % 2 === 1 ? 'failed' : 'done', new Date(Date.now() + n * 1_000), null, n % 2 === 1 ? 'ours' : null);
      }
      const all = await ended(sara, '9');
      expect(all.status).toBe(200);
      expect(all.body.ended.map((job: { id: string }) => job.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
      expect(all.body.ended[0]).toMatchObject({ title: 'Job 6', continuable: false });
      expect(all.body.ended[1]).toMatchObject({ title: 'Job 5', continuable: true });
      expect((await ended(sara, '2')).body.ended).toHaveLength(2);
      expect((await ended(sara, 'x')).status).toBe(400);
      expect((await ended(sara, '0')).status).toBe(400);
      // Not the owner: nothing is listed
      const tom = await owner('ended-other');
      expect((await ended(sara, '3', tom.uuid)).body.ended).toEqual([]);
    });
  });
});
