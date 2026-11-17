/**
 * The daily check of our books against the provider's bill, against a real database. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-reconcile-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { setComputerProviderForTests, FakeComputerProvider, type ComputerProvider, type ProviderDay } from '@/lib/computer-provider';
import { reconcileCheck, reconcileComputers } from '@/lib/computer-reconcile';
import { computerReadiness } from '@/lib/computer-readiness';
import { sweepComputers } from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-16T05:00:00Z');
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function brickWithMachine(ref: string): Promise<string> {
  const unique = `rec-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name: 'rec' } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: 'Brick' });
  await prisma.brickComputer.create({ data: { botId: brick.id, provider: 'real', providerRef: ref, machine: 'resting' } });
  return brick.id;
}

async function job(botId: string, personId: string, startedAt: string, endedAt: string | null, secondsRun: number) {
  await prisma.computerJob.create({ data: { botId, personId, title: 'J', status: endedAt ? 'done' : 'running', startedAt: new Date(startedAt), endedAt: endedAt ? new Date(endedAt) : null, secondsRun, ...(endedAt ? {} : { stretchStarted: new Date(startedAt) }) } });
}

/** A provider that has a bill and nothing else. */
function billing(bill: (day: string) => ProviderDay | Error) {
  const asked: string[] = [];
  const provider = {
    kind: 'real',
    microsPerMinute: () => 110,
    maintain: async () => undefined,
    dayUsage: async (day: string) => {
      asked.push(day);
      const answer = bill(day);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as ComputerProvider;
  return { provider, asked };
}

const quiet = (day: string, ref: string, botId: string, over: Partial<ProviderDay['instances'][number]> = {}): ProviderDay => ({
  day,
  totalMicros: 500,
  instances: [{ ref, kind: 'brick', botId, totalMicros: 500, computeMicros: 500, awakeMinutes: 0, expectedMicros: 500, ...over }],
});

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  // Every test makes its own Brick with the machine 'm1'. The books read the machine's owner from whichever row comes back last, so a machine
  // left by an earlier test is a second owner of 'm1' that only the database's row order decides between (it depends on what ran before)
  await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
  await prisma.computerReconcile.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: 'computer-reconcile-tried' } });
};

run('the daily check of our books against the provider’s bill, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    (Sentry.captureMessage as jest.Mock).mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('writes one row for the last settled day when the books match, says nothing to Sentry, and does not ask again for a day it has', async () => {
    const botId = await brickWithMachine('m1');
    const { provider, asked } = billing((day) => quiet(day, 'm1', botId));
    const first = await reconcileComputers(NOW, provider);
    expect(first).toMatchObject({ checked: ['2026-11-15'], drift: [], failed: false });
    expect(asked).toEqual(['2026-11-15']);
    const row = await prisma.computerReconcile.findUniqueOrThrow({ where: { day: '2026-11-15' } });
    expect(row).toMatchObject({ status: 'ok', agentTotalMicros: BigInt(500), gapMicros: BigInt(0) });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(await reconcileComputers(new Date(NOW.getTime() + 3_600_000), provider)).toMatchObject({ checked: [], skipped: 'not_yet' });
    expect(asked).toEqual(['2026-11-15']);
  });

  it('reads the minutes our jobs held a machine from the part of each job that falls in the day, so a job across midnight is not all on one day', async () => {
    const botId = await brickWithMachine('m1');
    const owner = (await prisma.bot.findUniqueOrThrow({ where: { id: botId }, select: { ownerId: true } })).ownerId as string;
    // 22:00 on the 14th to 02:00 on the 15th: 4 hours held, 2 of them on the 15th
    await job(botId, owner, '2026-11-14T22:00:00Z', '2026-11-15T02:00:00Z', 4 * 3600);
    // Awake 130 minutes on the 15th: 120 booked, and the 20-minute room for a start and stop covers the rest
    const { provider } = billing((day) => quiet(day, 'm1', botId, { awakeMinutes: 130 }));
    const result = await reconcileComputers(NOW, provider);
    expect(result.drift).toEqual([]);
    const row = await prisma.computerReconcile.findUniqueOrThrow({ where: { day: '2026-11-15' } });
    expect(row).toMatchObject({ ourMinutes: 120, agentMinutes: 130, status: 'ok' });
  });

  it('writes the findings as drift, keeps them with the day, and tells Sentry once', async () => {
    const botId = await brickWithMachine('m1');
    const { provider } = billing((day) => quiet(day, 'm1', botId, { awakeMinutes: 600, totalMicros: 90_000, computeMicros: 80_000, expectedMicros: 80_000 }));
    const result = await reconcileComputers(NOW, provider);
    expect(result.drift).toEqual(['2026-11-15']);
    const row = await prisma.computerReconcile.findUniqueOrThrow({ where: { day: '2026-11-15' } });
    expect(row.status).toBe('drift');
    const kinds = (row.findings as Array<{ kind: string }>).map((finding) => finding.kind).sort();
    expect(kinds).toEqual(['managed_spend', 'unbooked_time']);
    expect(Number(row.gapMicros)).toBeGreaterThan(10_000);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('finds a Brick machine none of our records points to', async () => {
    const botId = await brickWithMachine('m1');
    const { provider } = billing((day) => quiet(day, 'lost1', botId));
    await reconcileComputers(NOW, provider);
    const row = await prisma.computerReconcile.findUniqueOrThrow({ where: { day: '2026-11-15' } });
    expect(row.findings).toMatchObject([{ kind: 'unknown_machine', ref: 'lost1' }]);
  });

  it('writes no day for a bill it could not read, tries again after a while and not before, and then writes it', async () => {
    const botId = await brickWithMachine('m1');
    let fail = true;
    const { provider, asked } = billing((day) => (fail ? new Error('Agent37 could not be reached') : quiet(day, 'm1', botId)));
    expect(await reconcileComputers(NOW, provider)).toMatchObject({ failed: true, checked: [] });
    expect(await prisma.computerReconcile.count()).toBe(0);
    fail = false;
    expect(await reconcileComputers(new Date(NOW.getTime() + 60_000), provider)).toMatchObject({ skipped: 'waiting' });
    expect(asked).toHaveLength(1);
    expect(await reconcileComputers(new Date(NOW.getTime() + 16 * 60_000), provider)).toMatchObject({ checked: ['2026-11-15'] });
  });

  it('catches up the days that were missed, oldest first, from the newest day it has', async () => {
    const botId = await brickWithMachine('m1');
    await prisma.computerReconcile.create({ data: { day: '2026-11-12', agentTotalMicros: BigInt(0), agentBrickMicros: BigInt(0), ourMinutes: 0, agentMinutes: 0, status: 'ok', gapMicros: BigInt(0), findings: [] } });
    const { provider, asked } = billing((day) => quiet(day, 'm1', botId));
    const result = await reconcileComputers(NOW, provider);
    expect(result.checked).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
    expect(asked).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
  });

  it('writes a day once when two runs meet', async () => {
    const botId = await brickWithMachine('m1');
    const { provider } = billing((day) => quiet(day, 'm1', botId));
    await Promise.all([reconcileComputers(NOW, provider), reconcileComputers(NOW, provider)]);
    expect(await prisma.computerReconcile.count()).toBe(1);
  });

  it('does nothing for a provider with no bill (the pretend one)', async () => {
    expect(await reconcileComputers(NOW, new FakeComputerProvider())).toMatchObject({ skipped: 'no_bill' });
    expect(await reconcileComputers(NOW, null)).toMatchObject({ skipped: 'no_bill' });
    expect(await prisma.computerReconcile.count()).toBe(0);
  });

  it('is part of every sweep, and a bill that cannot be read never stops the sweep', async () => {
    const botId = await brickWithMachine('m1');
    // The sweep asks for the provider the server has: a real one here, with the stand-in as the one that is shared
    delete process.env.COMPUTER_PROVIDER;
    process.env.AGENT37_API_KEY = 'a-key-that-is-never-used';
    try {
      const good = billing((day) => quiet(day, 'm1', botId));
      setComputerProviderForTests(good.provider);
      await sweepComputers(NOW);
      expect(good.asked).toEqual(['2026-11-15']);
      await wipe();
      const broken = billing(() => new Error('down'));
      setComputerProviderForTests(broken.provider);
      await expect(sweepComputers(NOW)).resolves.toBeDefined();
      expect(broken.asked).toEqual(['2026-11-15']);
    } finally {
      delete process.env.AGENT37_API_KEY;
      process.env.COMPUTER_PROVIDER = 'fake';
    }
  });

  it('is done last in a sweep: the renewals, releases and starts that cannot wait come before it, and a bill that is slow to answer does not hold them', async () => {
    await brickWithMachine('m1');
    delete process.env.COMPUTER_PROVIDER;
    process.env.AGENT37_API_KEY = 'a-key-that-is-never-used';
    const order: string[] = [];
    const reservations = jest.spyOn(prisma.meterReservation, 'findMany').mockImplementation((() => {
      order.push('reservations');
      return Promise.resolve([]);
    }) as never);
    try {
      const slow = { kind: 'real', microsPerMinute: () => 110, maintain: async () => undefined, dayUsage: async () => { order.push('bill'); return new Promise<ProviderDay>(() => undefined); } } as unknown as ComputerProvider;
      setComputerProviderForTests(slow);
      await sweepComputers(NOW, undefined, undefined, 50);
      expect(order.indexOf('reservations')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('bill')).toBeGreaterThan(order.lastIndexOf('reservations'));
    } finally {
      reservations.mockRestore();
      delete process.env.AGENT37_API_KEY;
      process.env.COMPUTER_PROVIDER = 'fake';
    }
  });

  it('is on the team’s readiness page: not yet compared, matched, and did not match', async () => {
    const botId = await brickWithMachine('m1');
    expect(await reconcileCheck()).toMatchObject({ name: 'books and bill', ok: true, detail: expect.stringContaining('not been compared') });
    await reconcileComputers(NOW, billing((day) => quiet(day, 'm1', botId)).provider);
    expect(await reconcileCheck()).toMatchObject({ ok: true, detail: expect.stringContaining('matched') });
    await prisma.computerReconcile.deleteMany({});
    await reconcileComputers(NOW, billing((day) => quiet(day, 'm1', botId, { totalMicros: 9_000 })).provider);
    expect(await reconcileCheck()).toMatchObject({ ok: false, detail: expect.stringContaining('did not match') });
    setComputerProviderForTests(new FakeComputerProvider());
    const readiness = await computerReadiness();
    expect(readiness.checks.map((check) => check.name)).toContain('books and bill');
    expect(readiness.ready).toBe(false);
  });
});
