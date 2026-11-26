/**
 * A start the game never confirmed (GPT round 4, R1/R1b): the job is made unconfirmed, a new key meets it as `earlier` until the game's own `start-ack` confirms it, and a keyed look-up never confirms.
 * Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-start-ack-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/usage-person', () => ({ resolveUsagePerson: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { NextRequest } from 'next/server';
import { GET as lookRoute } from '@/app/api/bots/[id]/computer-jobs/route';
import { resolveUsagePerson } from '@/lib/usage-person';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { ackStart, earlierUnconfirmedStart, giveComputer, startJob, startedJobFor } from '@/lib/computer';
import { lockPerson } from '@/lib/computer-giveback';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

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
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

let keys = 0;
// Round 8, A2: a start that acks carries its issue time (the moment of the message) in its key
const keyOf = () => `t${Date.now().toString(36)}-ack-${tag}-${++keys}-${randomUUID().slice(0, 8)}`;
const reservationsOf = (jobId: string) => prisma.meterReservation.count({ where: { jobId } });
const jobsOf = (personId: string) => prisma.computerJob.count({ where: { personId } });

/** A person with a Brick that has a computer. */
async function owner(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  return sara;
}
/** One start the way the game makes it when it acks: under its key, in the direct chat it began in, read-only so two may run side by side. */
const start = (sara: { id: string; brickId: string }, title: string, startKey: string, acks = true, at: Date = NOW) =>
  startJob({ botId: sara.brickId, personId: sara.id, title, writes: false, startKey, acks, origin: { kind: 'dm', ref: `!chat-${tag}:example.test` } }, at);

run('a start whose answer the game never confirmed, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    setComputerProviderForTests(new FakeComputerProvider());
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

  it('the closure proof: a start whose reply was lost, a fresh game with no record of its key and a differently worded ask: the earlier job is named with its key, nothing new is made, one reservation; then the game acks and a deliberate second job is its own', async () => {
    const sara = await owner();
    const first = keyOf();
    // The start commits and its reply is lost: the game never acks, and its own record of the key is gone
    const a = await start(sara, 'Visa form', first);
    if (!a.ok) throw new Error('the first start did not start');
    expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id }, select: { startAckedAt: true } })).toEqual({ startAckedAt: null });
    expect(await reservationsOf(a.job.id)).toBe(1);
    // A fresh process mints a NEW key and the person worded the ask differently
    const reworded = await start(sara, 'Fill in my visa application', keyOf());
    expect(reworded).toEqual({ ok: false, reason: 'earlier', job: { id: a.job.id, status: 'running', state: 'live', attempt: first } });
    expect(await jobsOf(sara.id)).toBe(1);
    expect(await reservationsOf(a.job.id)).toBe(1);
    // `earlier` acks nothing: said again it is the same answer
    expect(await start(sara, 'Fill in my visa application', keyOf())).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id } });
    // The game adopts the key, asks for its story (a keyed look) and that confirms the start
    expect(await startedJobFor(sara.brickId, sara.id, first)).toEqual({ id: a.job.id, status: 'running' });
    expect(await ackStart(sara.brickId, sara.id, first)).toBe(true);
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).startAckedAt).not.toBeNull();
    // A deliberate second job (a new message, the same title, a new key) is its own job with its own reservation
    const b = await start(sara, 'Visa form', keyOf());
    if (!b.ok) throw new Error('the second start did not start');
    expect(b.job.id).not.toBe(a.job.id);
    expect(await jobsOf(sara.id)).toBe(2);
    expect(await reservationsOf(a.job.id)).toBe(1);
    expect(await reservationsOf(b.job.id)).toBe(1);
  });

  it('REPRO (GPT third note): the start reply AND the keyed look reply are both lost, the game has no record of the key: a new key is `earlier`, one job, one reservation', async () => {
    const sara = await owner();
    (resolveUsagePerson as jest.Mock).mockResolvedValue({ personId: sara.id, guest: false });
    const first = keyOf();
    const a = await start(sara, 'Visa form', first);
    if (!a.ok) throw new Error('no');
    // The game looks for the job by its key; the real handler answers, and that answer is lost on the way back
    const looked = await lookRoute(new NextRequest(`http://localhost:3333/api/bots/${sara.brickId}/computer-jobs?userId=wa-sara&attempt=${first}`, { method: 'GET' }), { params: Promise.resolve({ id: sara.brickId }) });
    expect(looked.status).toBe(200);
    expect(((await looked.json()) as { started?: { id?: string } }).started?.id).toBe(a.job.id);
    // Reading it, once or twice, confirmed nothing
    await lookRoute(new NextRequest(`http://localhost:3333/api/bots/${sara.brickId}/computer-jobs?userId=wa-sara&attempt=${first}`, { method: 'GET' }), { params: Promise.resolve({ id: sara.brickId }) });
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id }, select: { startAckedAt: true, createdAt: true } })).startAckedAt).toBeNull();
    // A fresh process with no record of the key mints a new one: it must meet the first job, not make another
    expect(await start(sara, 'Fill in my visa application', keyOf())).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, attempt: first } });
    expect(await jobsOf(sara.id)).toBe(1);
    expect(await reservationsOf(a.job.id)).toBe(1);
    // Only the game's own word confirms: after it a deliberate second ask is a second job
    expect(await ackStart(sara.brickId, sara.id, first)).toBe(true);
    expect(await start(sara, 'Fill in my visa application', keyOf())).toMatchObject({ ok: true });
    expect(await jobsOf(sara.id)).toBe(2);
  });

  it('the start’s own key still answers its own job, unconfirmed or not, and its replay is never `earlier`', async () => {
    const sara = await owner();
    const key = keyOf();
    const a = await start(sara, 'Visa form', key);
    if (!a.ok) throw new Error('no');
    const again = await start(sara, 'Visa form', key, true, minutes(30));
    expect(again).toMatchObject({ ok: true, job: { id: a.job.id } });
    expect(await jobsOf(sara.id)).toBe(1);
  });

  it('a lost ack: the next new start meets `earlier` once, the ack confirms, and the following ask starts', async () => {
    const sara = await owner();
    const key = keyOf();
    const a = await start(sara, 'Visa form', key);
    if (!a.ok) throw new Error('no');
    // ok:true answered, the ack failed: the next ask is `earlier` naming the job
    expect(await start(sara, 'Another', keyOf())).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, attempt: key } });
    expect(await ackStart(sara.brickId, sara.id, key)).toBe(true);
    const next = await start(sara, 'Another', keyOf());
    expect(next).toMatchObject({ ok: true });
    expect(await jobsOf(sara.id)).toBe(2);
  });

  it('names the OLDEST unconfirmed job, whatever its status, even one that is over', async () => {
    const sara = await owner();
    const k1 = keyOf();
    const a = await start(sara, 'Visa form', k1);
    if (!a.ok) throw new Error('no');
    await prisma.computerJob.update({ where: { id: a.job.id }, data: { status: 'done', endedAt: NOW, startedAt: NOW } });
    expect(await start(sara, 'Another', keyOf())).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, status: 'done', state: 'done', attempt: k1 } });
    // Only the person's own and only this Brick's: another person's start, and another Brick of the same person, are not blocked
    const omar = await owner('omar');
    expect(await start(omar, 'Visa form', keyOf())).toMatchObject({ ok: true });
  });

  it('names the oldest of several unconfirmed jobs (they can exist when the game acked none of them across a rollback)', async () => {
    const sara = await owner();
    const make = (title: string, startKey: string, at: Date) => prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title, writes: false, startKey, startAckedAt: null, route: 'computer', expectedMicros: BigInt(0), status: 'done', createdAt: at } });
    const newer = await make('Newer', keyOf(), minutes(5));
    const older = await make('Older', 'oldest-key-0001', minutes(1));
    expect(newer.id).not.toBe(older.id);
    expect(await start(sara, 'Another', keyOf(), true, minutes(9))).toEqual({ ok: false, reason: 'earlier', job: { id: older.id, status: 'done', state: 'done', attempt: 'oldest-key-0001' } });
  });

  it('an unconfirmed start blocks only the same person on the same Brick: another Brick of theirs starts freely', async () => {
    const sara = await owner();
    const a = await start(sara, 'Visa form', keyOf());
    if (!a.ok) throw new Error('no');
    const second = await createBrick({ ownerId: sara.id, name: 'Second Brick' });
    await giveComputer(second.id, sara.id);
    expect(await start({ id: sara.id, brickId: second.id }, 'Visa form', keyOf())).toMatchObject({ ok: true });
    expect(await start(sara, 'Another', keyOf())).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id } });
  });

  it('two new starts at once beside an unconfirmed job both answer `earlier` and make nothing; two starts of one new key at once make one job and both answer it', async () => {
    const sara = await owner();
    const a = await start(sara, 'Visa form', keyOf());
    if (!a.ok) throw new Error('no');
    const both = await Promise.all([start(sara, 'One', keyOf()), start(sara, 'Two', keyOf())]);
    expect(both.map((one) => ('reason' in one ? one.reason : 'made'))).toEqual(['earlier', 'earlier']);
    expect(await jobsOf(sara.id)).toBe(1);
    // Nothing earlier to meet: two starts of ONE key at once make one job and both answer it
    const bob = await owner('bob');
    const same = keyOf();
    const twice = await Promise.all([start(bob, 'Visa form', same), start(bob, 'Visa form', same)]);
    expect(twice.every((one) => one.ok)).toBe(true);
    expect(new Set(twice.map((one) => (one.ok ? one.job.id : ''))).size).toBe(1);
    expect(await jobsOf(bob.id)).toBe(1);
  });

  /** A barrier, not a delay: waits (bounded) until a session is blocked on this advisory lock. */
  const blockedOn = async (lockKey: string, signal: { stop: boolean } = { stop: false }): Promise<boolean> => {
    for (let tries = 0; tries < 250 && !signal.stop; tries += 1) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${lockKey})::bigint & 4294967295)`;
      if (rows[0].n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  /** Another start, in the middle of making its job, holds the person's lock and has made its (unconfirmed) job: the test's waiter runs while it holds. Readiness is raced against the holder failing, and the gate is released and both operations drained on every exit. */
  const withStartHoldingTheLock = async (sara: Awaited<ReturnType<typeof owner>>, key: string, waiter: () => Promise<unknown>, check: (answer: unknown) => Promise<void> | void) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let rowMade: () => void = () => undefined;
    const holderRan = new Promise<void>((resolve) => (rowMade = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await lockPerson(tx, sara.id);
        await tx.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Held', writes: false, startKey: key, startAckedAt: null, route: 'computer', expectedMicros: BigInt(0) } });
        rowMade();
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    let waiting: Promise<unknown> = Promise.resolve();
    // The poll can be stopped, and is joined before this returns: it never runs on into the next test or the teardown (CodeRabbit on #1025, 39)
    const signal = { stop: false };
    let polling: Promise<boolean> = Promise.resolve(false);
    try {
      // A holder that fails before it made its row is reported, never waited for
      await Promise.race([holderRan, holder.then(() => Promise.reject(new Error('the holder ended without making its job')))]);
      waiting = waiter();
      // Observe the waiter's own failure at once: it is reported here, not left unhandled until the join
      const settled = waiting.then(
        () => 'done' as const,
        (error) => Promise.reject(error),
      );
      settled.catch(() => undefined);
      // The waiter's own failure is this test's failure at once (not a poll that runs out), and a waiter that finished without ever blocking is reported as that
      polling = blockedOn(`computer:giveback:${sara.id}`, signal);
      const reached = await Promise.race([polling, settled.then(() => 'finished-early' as const)]);
      expect(reached).toBe(true);
      release();
      await holder;
      await check(await waiting);
    } finally {
      signal.stop = true;
      release();
      await Promise.allSettled([holder, waiting, polling]);
    }
  };

  it('is decided under the person’s lock in the transaction that makes the job: a start waiting for the lock sees the unconfirmed job another start committed while it waited', async () => {
    const sara = await owner();
    await withStartHoldingTheLock(
      sara,
      keyOf(),
      () => start(sara, 'Visa form', keyOf()),
      async (answer) => {
        expect(answer).toMatchObject({ ok: false, reason: 'earlier' });
        expect(await jobsOf(sara.id)).toBe(1);
      },
    );
  });

  it('an ack takes only the person’s lock, so its transactions keep the usual 15 s (not the longer wait of a claim that takes the computer’s row)', async () => {
    const sara = await owner();
    const key = keyOf();
    expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', startKey: key }, NOW)).toMatchObject({ ok: true });
    const spy = jest.spyOn(prisma, '$transaction');
    try {
      expect(await ackStart(sara.brickId, sara.id, key)).toBe(true);
      const options = spy.mock.calls.map((call) => call[1]).filter((option) => option !== undefined);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect(option).toEqual({ timeout: 15_000, maxWait: 15_000 });
    } finally {
      spy.mockRestore();
    }
  });

  it('an ack waits for the start that is still deciding under the person’s lock, then confirms the job it made: `true` is never answered with the job left unconfirmed (CodeRabbit)', async () => {
    const sara = await owner();
    const key = keyOf();
    await withStartHoldingTheLock(
      sara,
      key,
      () => ackStart(sara.brickId, sara.id, key),
      async (answer) => {
        expect(answer).toBe(true);
        expect((await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id, startKey: key } })).startAckedAt).not.toBeNull();
      },
    );
  });

  it('names the earlier unconfirmed start for a new key, read only: none for the same key, none once confirmed, none on another Brick (the route asks it before the spend rule)', async () => {
    const sara = await owner();
    const key = keyOf();
    expect(await earlierUnconfirmedStart(sara.brickId, sara.id, keyOf())).toBeNull();
    const a = await start(sara, 'Visa form', key);
    if (!a.ok) throw new Error('no');
    expect(await earlierUnconfirmedStart(sara.brickId, sara.id, keyOf())).toMatchObject({ id: a.job.id, attempt: key });
    expect(await earlierUnconfirmedStart(sara.brickId, sara.id, key)).toBeNull();
    const omar = await owner('omar');
    expect(await earlierUnconfirmedStart(omar.brickId, sara.id, keyOf())).toBeNull();
    // Reading it confirmed nothing
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).startAckedAt).toBeNull();
    await ackStart(sara.brickId, sara.id, key);
    expect(await earlierUnconfirmedStart(sara.brickId, sara.id, keyOf())).toBeNull();
  });

  it('CodeRabbit on #1025 (36): when a concurrent start under the same key made its own job between the read and the answer write, the answer the key durably records is returned, never `earlier` from a write that stored nothing', async () => {
    const sara = await owner();
    const a = await start(sara, 'Visa form', keyOf());
    if (!a.ok) throw new Error('no');
    const keyB = keyOf();
    const real = prisma.computerJob.findFirst.bind(prisma.computerJob) as unknown as (args: { where?: { startAckedAt?: null } }) => Promise<unknown>;
    let inside = false;
    let madeFirst: Awaited<ReturnType<typeof startJob>> | null = null;
    let lookedAt: string | null = null;
    const spy = jest.spyOn(prisma.computerJob, 'findFirst').mockImplementation((async (args: { where?: { startAckedAt?: null } }) => {
      const found = await real(args);
      // The look at the oldest unconfirmed start has been made; now the other request under the same key makes its job first
      if (!inside && args?.where?.startAckedAt === null) {
        inside = true;
        // The look found A's job: a look that found nothing would never reach the write this test is about
        lookedAt = (found as { id?: string } | null)?.id ?? null;
        expect(found).toMatchObject({ id: a.job.id });
        madeFirst = await start(sara, 'Visa form', keyB, false);
      }
      return found;
    }) as never);
    let answer: Awaited<ReturnType<typeof earlierUnconfirmedStart>>;
    try {
      answer = await earlierUnconfirmedStart(sara.brickId, sara.id, keyB);
    } finally {
      spy.mockRestore();
    }
    // Recorded again outside the spy, which an error inside the lookup could have hidden
    expect(lookedAt).toBe(a.job.id);
    expect(madeFirst).toMatchObject({ ok: true });
    // The key records its own job: the start that asked goes on and meets it; it is not told another start came first
    expect(answer).toBeNull();
    expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: keyB } })).toMatchObject({ state: 'made' });
  });

  it('an old game is unchanged: a start without the capability is never blocked, makes a confirmed job, and never an unconfirmed one; rows from before the column never block', async () => {
    const sara = await owner();
    const a = await start(sara, 'Visa form', keyOf(), true);
    if (!a.ok) throw new Error('no');
    // An unconfirmed job is there, and an old game's start (no capability) is not blocked by it
    const old = await start(sara, 'Another', keyOf(), false);
    expect(old).toMatchObject({ ok: true });
    if (!old.ok) throw new Error('no');
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: old.job.id } })).startAckedAt).not.toBeNull();
    // A start with no key at all is the same
    const noKey = await startJob({ botId: sara.brickId, personId: sara.id, title: 'No key', writes: false, acks: true }, NOW);
    expect(noKey).toMatchObject({ ok: true });
    if (!noKey.ok) throw new Error('no');
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: noKey.job.id } })).startAckedAt).not.toBeNull();
    // A job written by a version that does not know the column (it is left out): confirmed by the database default
    const raw = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Old app', writes: false, route: 'computer', expectedMicros: BigInt(0), status: 'done' } });
    expect(raw.startAckedAt).not.toBeNull();
    await prisma.computerJob.update({ where: { id: a.job.id }, data: { startAckedAt: NOW } });
    expect(await start(sara, 'Visa form again', keyOf())).toMatchObject({ ok: true });
  });

  it('an ack is idempotent and learns nothing: said twice it changes nothing more, a key that made no job and another person’s key change nothing', async () => {
    const sara = await owner();
    const omar = await owner('omar');
    const key = keyOf();
    const a = await start(sara, 'Visa form', key);
    if (!a.ok) throw new Error('no');
    expect(await ackStart(sara.brickId, sara.id, keyOf())).toBe(false);
    // Another person's ack of this key (same Brick id, other person) and another Brick's change nothing
    expect(await ackStart(sara.brickId, omar.id, key)).toBe(false);
    expect(await ackStart(omar.brickId, sara.id, key)).toBe(false);
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).startAckedAt).toBeNull();
    expect(await ackStart(sara.brickId, sara.id, key, minutes(1))).toBe(true);
    const acked = (await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).startAckedAt;
    expect(acked).toEqual(minutes(1));
    // Said again: the time is not moved
    expect(await ackStart(sara.brickId, sara.id, key, minutes(9))).toBe(true);
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).startAckedAt).toEqual(acked);
  });
});
