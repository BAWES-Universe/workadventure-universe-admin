/**
 * Where piece 1 (controls) meets piece 2 (notes): acceptance case C8 against a real database, run on the folded tree. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-controls-notes-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});
jest.mock('@/lib/meter-allowance', () => {
  const actual = jest.requireActual('@/lib/meter-allowance');
  return { ...actual, reserveRoom: jest.fn((...args: unknown[]) => actual.reserveRoom(...args)) };
});
jest.mock('@/lib/capability-pause', () => {
  const actual = jest.requireActual('@/lib/capability-pause');
  return { ...actual, computersArePaused: jest.fn((...args: unknown[]) => actual.computersArePaused(...args)) };
});
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn((...args: unknown[]) => actual.recordMeterEvent(...args)) };
});

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import * as meterModule from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, giveComputer, startJob } from '@/lib/computer';
import * as profile from '@/lib/computer-browser-profile';
import { pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { addJobNote, notesSent, pendingNotes } from '@/lib/computer-job-notes';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const recordMeterEvent = meterModule.recordMeterEvent as jest.Mock;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, ...over }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const claimed = async (jobId: string, runName: string, at: Date = NOW): Promise<number> => {
  // A job that already has an owner is claimed only once that owner stopped beating (GPT round 6, finding 3): the hold is let go first, as it runs out by itself 90 s after the owner's last beat
  await prisma.computerJob.updateMany({ where: { id: jobId, NOT: { ownerLeaseUntil: null } }, data: { ownerLeaseUntil: null } });
  const won = await claimJob(jobId, { run: runName, seen: (await jobOf(jobId)).ownerEpoch }, at);
  if (!won.ok) throw new Error(`the claim was refused: ${won.reason}`);
  return won.epoch;
};

/** A person with a Brick with a computer and one job running on it since NOW. */
async function running(name: string) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}

run('C8: steering notes and the job controls together, in a real database', () => {
  let fake: FakeComputerProvider;
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    recordMeterEvent.mockClear();
    jest.mocked(profile.parkProfile).mockClear();
    jest.mocked(profile.restoreProfile).mockClear();
    jest.mocked(profile.dropProfile).mockClear();
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('C8.5: a note to a paused job is kept for when it starts; it moves no owner and cancels nothing; the resumed job’s new owner is given it and marks it sent, the old one cannot', async () => {
    const { sara, jobId } = await running('n-paused');
    const e1 = await claimed(jobId, 'r1');
    await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
    await pauseJob(sara.brickId, sara.id, jobId, minutes(5));
    expect(fake.cancelledTurns).toEqual(['resp-1']);
    const paused = await jobOf(jobId);
    const noted = await addJobNote(sara.brickId, sara.id, jobId, 'Use 12 March', minutes(6));
    expect(noted).toMatchObject({ ok: true, note: { seq: 1, delivery: 'when_it_starts' } });
    expect(await jobOf(jobId)).toMatchObject({ ownerEpoch: paused.ownerEpoch, status: 'queued', queuedFor: 'paused' });
    expect(fake.cancelledTurns).toEqual(['resp-1']);
    await resumeJob(sara.brickId, sara.id, jobId, minutes(10));
    const e2 = await claimed(jobId, 'r2', minutes(10));
    expect(await pendingNotes(jobId)).toEqual([{ seq: 1, text: 'Use 12 March' }]);
    expect(await notesSent(jobId, { through: 1, epoch: e1 }, minutes(11))).toMatchObject({ ok: false });
    expect(await pendingNotes(jobId)).toHaveLength(1);
    expect(await notesSent(jobId, { through: 1, epoch: e2 }, minutes(11))).toEqual({ ok: true, sent: 1 });
    expect(await pendingNotes(jobId)).toEqual([]);
  });

  it('C8.1 and C8.2 with a pause: a note at the same moment as a pause cancels only the turn they both read; after the resume a note cancels only the new turn, and never moves the owner', async () => {
    const { sara, jobId } = await running('n-turns');
    await claimed(jobId, 'r1');
    await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-old' } });
    await Promise.all([pauseJob(sara.brickId, sara.id, jobId, minutes(5)), addJobNote(sara.brickId, sara.id, jobId, 'One', minutes(5))]);
    // Only the turn both writes read is ever cancelled (a second cancel of the same ended turn is harmless); nothing else is
    expect(fake.cancelledTurns.every((one) => one === 'resp-old')).toBe(true);
    expect(fake.cancelledTurns.length).toBeGreaterThanOrEqual(1);
    expect(await jobOf(jobId)).toMatchObject({ status: 'queued', queuedFor: 'paused' });
    await resumeJob(sara.brickId, sara.id, jobId, minutes(10));
    const e2 = await claimed(jobId, 'r2', minutes(10));
    await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-new' } });
    fake.cancelledTurns.length = 0;
    expect(await addJobNote(sara.brickId, sara.id, jobId, 'Two', minutes(11))).toMatchObject({ ok: true, note: { delivery: 'now' } });
    expect(fake.cancelledTurns).toEqual(['resp-new']);
    expect((await jobOf(jobId)).ownerEpoch).toBe(e2);
    expect((await pendingNotes(jobId)).map((note) => note.text)).toEqual(['One', 'Two']);
  });
});
