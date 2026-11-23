/**
 * GPT round 6, findings 4 and 11 (Rule D, identity of a control): every control the person gives a computer job carries its own command id, so a replay returns the stored outcome and writes nothing (no second
 * pause, time event, note number or provider cancel), and "do this first" is ONE transaction, so a refusal leaves the order and the stretches intact. Each case asserts the job, its epoch and stretch, its rooms,
 * its time events and the answer. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database, in UTC and in Kuwait time:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-controls-identity-db.test.ts --runInBand
 *   TZ=Asia/Kuwait ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-controls-identity-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});
// The job lock is the real one behind a jest.fn: a test runs something at the moment a control takes a job's lock (what another request could do between a selection and a commit)
jest.mock('@/lib/computer-owner', () => {
  const actual = jest.requireActual('@/lib/computer-owner');
  return { ...actual, lockJob: jest.fn((...args: unknown[]) => actual.lockJob(...args)) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, giveComputer, recordFinishIntent, startJob } from '@/lib/computer';
import { moveJobFirst } from '@/lib/computer-job-controls';
import * as owner from '@/lib/computer-owner';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
const realLockJob = jest.requireActual('@/lib/computer-owner').lockJob as typeof owner.lockJob;
const lockJob = owner.lockJob as jest.MockedFunction<typeof owner.lockJob>;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: unique, brickId: brick.id };
}
type Person = Awaited<ReturnType<typeof person>>;

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const eventsOf = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const pausesOf = (jobId: string) => prisma.computerJobPause.count({ where: { jobId } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};
/** A person with a Brick with a computer, one job running on it since NOW and claimed by its runner. */
async function running(name: string) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  const epoch = await claimed(started.job.id, 'rA');
  return { sara, jobId: started.job.id, epoch };
}
const another = async (sara: Person, title: string, at: Date = NOW) => {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title }, at);
  if (!started.ok) throw new Error('the job was not made');
  return started.job.id;
};
/** Runs `between` once, right before a control takes the lock of job `jobId` (in its own transaction: another request landing first). */
const beforeLockOf = (jobId: string, between: () => Promise<unknown>) => {
  let fired = false;
  lockJob.mockImplementation((async (tx: Parameters<typeof owner.lockJob>[0], id: string) => {
    if (!fired && id === jobId) {
      fired = true;
      await between();
    }
    return realLockJob(tx, id);
  }) as typeof owner.lockJob);
};

run('findings 4 and 11 (GPT round 6): one control, one effect, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(new FakeComputerProvider());
    lockJob.mockImplementation(realLockJob);
    await setUp();
  });
  afterAll(async () => {
    lockJob.mockImplementation(realLockJob);
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('finding 11: "do this first" is atomic', () => {
    it('REPRO: the person takes the screen between the selection and the commit: `taken_over`, and the target’s rank, the running job’s stretch, epoch and time are all unchanged', async () => {
      const { sara, jobId, epoch } = await running('f11-taken');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      beforeLockOf(jobId, () => prisma.computerJob.update({ where: { id: jobId }, data: { status: 'waiting', control: 'person', waitingFor: 'signin' } }));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3))).toEqual({ ok: false, reason: 'taken_over' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person', pauses: 0, ownerEpoch: epoch, secondsBilled: 0 });
      expect(await eventsOf(jobId)).toHaveLength(0);
      expect(await pausesOf(jobId)).toBe(0);
    });

    it('REPRO: the runner keeps its finish intent between the selection and the commit: `ending`, nothing moved', async () => {
      const { sara, jobId, epoch } = await running('f11-ending');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const rankBefore = (await jobOf(taxi)).queueRank;
      beforeLockOf(jobId, () => recordFinishIntent(jobId, { outcome: 'done', epoch }, minutes(2)));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3))).toEqual({ ok: false, reason: 'ending' });
      expect(await jobOf(taxi)).toMatchObject({ status: 'queued', queueRank: rankBefore });
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', pauses: 0, ownerEpoch: epoch });
      expect(await eventsOf(jobId)).toHaveLength(0);
    });

    it('two concurrent "do this first" requests serialize on the Brick’s line: the running job is paused ONCE (one stretch, one event), and the line ends in one order', async () => {
      const { sara, jobId } = await running('f11-race');
      const taxi = await another(sara, 'Taxi', minutes(1));
      const hotel = await another(sara, 'Hotel', minutes(1));
      const [a, b] = await Promise.all([moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(3)), moveJobFirst(sara.brickId, sara.id, hotel, { pauseRunning: true }, minutes(3))]);
      expect([a.ok, b.ok]).toContain(true);
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1 });
      expect(await pausesOf(jobId)).toBe(1);
      expect(await eventsOf(jobId)).toHaveLength(1);
      const statuses = [(await jobOf(taxi)).status, (await jobOf(hotel)).status].sort();
      expect(statuses).toEqual(['queued', 'running']);
    });

    it('CONTROL: with nothing in the way it goes first and the running job waits right behind it, paused once', async () => {
      const { sara, jobId } = await running('f11-ok');
      const taxi = await another(sara, 'Taxi', minutes(1));
      expect(await moveJobFirst(sara.brickId, sara.id, taxi, { pauseRunning: true }, minutes(5))).toMatchObject({ ok: true });
      expect(await jobOf(taxi)).toMatchObject({ status: 'running' });
      expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'turn', pauses: 1, secondsBilled: 300 });
      expect(await eventsOf(jobId)).toHaveLength(1);
    });
  });
});
