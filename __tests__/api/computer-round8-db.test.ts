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
import { ackStart, claimJob, finishJob, finishJobUnder, forgetOldStartMarks, giveComputer, startJob, DEAD_ANSWER_MS } from '@/lib/computer';
import { authorizeModelCall, settleModelCall } from '@/lib/computer-calls';
import { mintJobToken } from '@/lib/computer-token';
import { carryOnPaused, resetCarryOnScanForTests } from '@/lib/computer-limit-pause';
import { GET, POST } from '@/app/api/bots/[id]/computer-jobs/route';
import { POST as CONTROL } from '@/app/api/bots/[id]/computer-jobs/control/route';

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

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const jobsOf = (sara: Owner) => prisma.computerJob.findMany({ where: { personId: sara.id }, orderBy: { createdAt: 'asc' }, select: { id: true, startKey: true, status: true } });
/** The rooms ever taken, by the job they were for (a released room keeps its row). */
const roomJobsOf = async (sara: Owner) => [...new Set((await prisma.meterReservation.findMany({ where: { personId: sara.id }, select: { jobId: true } })).map((room) => room.jobId))];

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
function holdAfterSpendCheck(startKey: string): { reached: Promise<void>; letGo: () => void } {
  let letGo!: () => void;
  held.release = new Promise<void>((resolve) => (letGo = resolve));
  const reached = new Promise<void>((resolve) => (held.reached = resolve));
  held.key = startKey;
  return {
    reached,
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
      await hold.reached;
      // While A is held the look for A never says "no job" (the game would then send a fresh start): it is going on
      const during = await look(sara, KEY_A);
      expect(during.body.started).not.toBeNull();
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
      expect(await roomJobsOf(sara)).toEqual([jobs[0].id]);
      // Whoever made it, the one job is what both keys answer, now and on a retry
      expect((await look(sara, KEY_A)).body.started).toMatchObject({ id: jobs[0].id });
      expect((await look(sara, KEY_B)).body.started).toMatchObject({ id: jobs[0].id });
      const jobOfAnswer = (answer: { ok: boolean; job?: { id: string | null; attempt?: string | null } }) => (answer.ok ? answer.job?.id : (answer.job?.id ?? null));
      expect([jobs[0].id, null]).toContain(jobOfAnswer(a));
      const again = await post(sara, KEY_A, 'Fill the visa form');
      expect((await jobsOf(sara))).toHaveLength(1);
      expect(again.ok ? again.job.id : again.job?.id).toBe(jobs[0].id);
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
      expect(await jobsOf(sara)).toHaveLength(0);
      expect(await roomJobsOf(sara)).toEqual([a.job.id]);
    });

    it('REPRO: after the clean-up pruned the record (past the retention), the IDENTICAL key makes nothing (an old message needs fresh consent)', async () => {
      const sara = await owner('a2-pruned');
      const KEY_A = key();
      const a = await post(sara, KEY_A, 'Fill the visa form');
      await ackStart(sara.brickId, sara.id, KEY_A);
      await finishJob(a.job.id, 'done', new Date());
      await prisma.computerJob.delete({ where: { id: a.job.id } });
      // Eight days on, the clean-up runs
      await prisma.computerStartAttempt.updateMany({ where: { personId: sara.id }, data: { beatAt: new Date(Date.now() - DEAD_ANSWER_MS - 86_400_000), createdAt: new Date(Date.now() - DEAD_ANSWER_MS - 86_400_000) } });
      await forgetOldStartMarks(new Date());
      const again = await post(sara, KEY_A, 'Fill the visa form');
      expect(again.ok).toBe(false);
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
      const stopped = await control(sara, { action: 'stop', confirmedJobIds: confirmed });
      expect(stopped.status).toBe(200);
      expect(stopped.body.ok).toBe(true);
      const after = await prisma.computerJob.findMany({ where: { id: { in: [a.job.id, b.job.id] } }, select: { id: true, status: true, endedBy: true } });
      expect(after.find((job) => job.id === a.job.id)).toMatchObject({ status: 'stopped', endedBy: 'person' });
      const bAfter = after.find((job) => job.id === b.job.id);
      expect(bAfter?.endedBy).not.toBe('person');
      expect(['queued', 'running']).toContain(bAfter?.status);
    });
  });
});
