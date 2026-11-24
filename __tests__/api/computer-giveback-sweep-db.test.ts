/**
 * Which failed jobs the sweep tries to give back the model calls of, against a real database: a job whose give-back keeps failing never keeps another out (CodeRabbit on Orbit #1025, 21 Nov).
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-giveback-sweep-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
// The give-back of a failed job's model calls, replaced by a recorder a test can make fail
jest.mock('@/lib/computer-calls', () => {
  const actual = jest.requireActual('@/lib/computer-calls');
  return { ...actual, giveBackModelCalls: jest.fn() };
});
import * as computerCalls from '@/lib/computer-calls';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { computerTimeInBooks, sweepComputers } from '@/lib/computer';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const gives = computerCalls.giveBackModelCalls as jest.Mock;
const env = process.env.COMPUTER_PROVIDER;
const CURSOR_KEY = 'computer_giveback_sweep_cursor';
let personId = '';
let botId = '';

/** Failed-on-our-side jobs that still have a model call written against the person, `count` of them, ended a minute apart (the first is the oldest). */
async function failedJobs(count: number): Promise<string[]> {
  const base = Date.now() - 6 * 3_600_000;
  const ids = Array.from({ length: count }, () => randomUUID());
  await prisma.computerJob.createMany({
    data: ids.map((id, index) => ({ id, botId, personId, title: `Failed ${index}`, status: 'failed', endedBy: 'error', startedAt: new Date(base + index * 60_000 - 30_000), endedAt: new Date(base + index * 60_000) })),
  });
  await prisma.meterEvent.createMany({
    data: ids.map((id) => ({ eventId: `computer:${id}:call:owed`, kind: 'model_call', pool: 'computer', occurredAt: new Date(), personKey: `person:${personId}`, personId, botId, brick: true, payerKind: 'universe', jobId: id, sourceRef: `computer_jobs:${id}`, quantity: BigInt(1), unit: 'call', costMicros: BigInt(4000), basis: 'measured' })),
  });
  return ids;
}

const wipe = async () => {
  await prisma.meterEvent.deleteMany({ where: { personId } });
  await prisma.computerJob.deleteMany({ where: { personId } });
  await prisma.appSetting.deleteMany({ where: { key: CURSOR_KEY } });
};

run('the sweep that gives back a failed job’s model calls, in a real database', () => {
  beforeAll(async () => {
    process.env.COMPUTER_PROVIDER = 'fake';
    const unique = `gbs-${tag}`;
    const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name: 'gbs' } });
    personId = user.id;
    botId = (await createBrick({ ownerId: user.id, name: 'Sweep Brick' })).id;
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    setComputerProviderForTests(new FakeComputerProvider());
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
    gives.mockReset();
    gives.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await wipe();
    await prisma.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: personId } }).catch(() => undefined);
    await clearGiveBackLimits();
    setComputerProviderForTests(null);
    if (env === undefined) delete process.env.COMPUTER_PROVIDER;
    else process.env.COMPUTER_PROVIDER = env;
  });

  /** Makes the give-back of the jobs in `broken` throw, and records what each sweep tried and, for the ones that work, takes the model call off the books (as the real one does). */
  const tryingEach = (broken: Set<string>) => {
    const tried: string[][] = [];
    gives.mockImplementation(async (jobId: string) => {
      tried[tried.length - 1]?.push(jobId);
      if (broken.has(jobId)) throw new Error('The books are down for this one');
      await prisma.meterEvent.deleteMany({ where: { jobId } });
    });
    return { tried, sweep: async () => { tried.push([]); await sweepComputers(new Date(), 200); } };
  };

  it('201 jobs wait and the 200 that the old rule always took keep failing: the 201st still gets its give-back, within a lap of sweeps', async () => {
    const ids = await failedJobs(201);
    // Oldest-first and newest-first, 100 each, would take ids[0..99] and ids[101..200] on every sweep; the one in the middle is never among them
    const middle = ids[100];
    const { tried, sweep } = tryingEach(new Set(ids.filter((id) => id !== middle)));
    let sweeps = 0;
    while (sweeps < 5 && !tried.flat().includes(middle)) {
      await sweep();
      sweeps++;
    }
    expect(tried.flat()).toContain(middle);
    // Within a lap: 201 jobs, a window of 100 a sweep
    expect(sweeps).toBeLessThanOrEqual(3);
    // ...and it was given back (its call is off the books), while the others, which failed, are still eligible
    expect(await prisma.meterEvent.count({ where: { jobId: middle } })).toBe(0);
    expect(await prisma.meterEvent.count({ where: { personId } })).toBe(200);
  });

  it('every job that matches is tried within a lap, whatever happens to the others, and the lap starts again after it', async () => {
    const ids = await failedJobs(250);
    const { tried, sweep } = tryingEach(new Set(ids));
    for (let index = 0; index < 3; index++) await sweep();
    // 250 jobs, 100 in the window per sweep: three sweeps have tried every one at least once
    expect(new Set(tried.flat()).size).toBe(250);
    const lapOne = tried.flat().length;
    await sweep();
    // The window went round: the next sweep tries jobs again, and the kept place is a job id
    expect(tried.flat().length).toBeGreaterThan(lapOne);
    expect(((await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } }))?.value as { after: string }).after).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a job that has just failed is tried at once, with any number of older jobs that keep failing ahead of the window', async () => {
    const old = await failedJobs(250);
    const { tried, sweep } = tryingEach(new Set(old));
    await sweep();
    const [fresh] = await failedJobs(1);
    await prisma.computerJob.update({ where: { id: fresh }, data: { endedAt: new Date() } });
    await sweep();
    expect(tried[1]).toContain(fresh);
    expect(await prisma.meterEvent.count({ where: { jobId: fresh } })).toBe(0);
  });

  it('with nothing to give back the place goes back to the start', async () => {
    await failedJobs(3);
    const { sweep } = tryingEach(new Set());
    await sweep();
    expect(await prisma.meterEvent.count({ where: { personId } })).toBe(0);
    await sweep();
    expect((await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } }))?.value).toEqual({ after: '' });
  });

  it('one Brick’s own look before its removal tries its jobs from the start, as many as a batch, and never moves the place the sweep stands on', async () => {
    const ids = await failedJobs(150);
    const { tried } = tryingEach(new Set());
    await prisma.appSetting.create({ data: { key: CURSOR_KEY, value: { after: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } } });
    tried.push([]);
    await computerTimeInBooks(botId, new Date());
    // All 150 (more than the sweep's window of 100) in one look, and the place is where it was
    expect(new Set(tried.flat()).size).toBe(150);
    expect((await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } }))?.value).toEqual({ after: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    expect(ids.length).toBe(150);
  });
});
