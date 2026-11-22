/**
 * The runner's committed word that a computer job is to end (GPT round 4, R2): kept before the runner gives up, so a replacement runner or the sweep completes the finish and nothing else runs on the job meanwhile.
 * Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-finish-intent-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { ackStart, giveComputer, startJob, startedJobFor } from '@/lib/computer';
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
const keyOf = () => `ack-key-${tag}-${++keys}-${randomUUID().slice(0, 8)}`;
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

  it('the start’s own key still answers its own job, unconfirmed or not, and its replay is never `earlier`', async () => {
    const sara = await owner();
    const key = keyOf();
    const a = await start(sara, 'Visa form', key);
    if (!a.ok) throw new Error('no');
    const again = await start(sara, 'Visa form', key, true, minutes(30));
    expect(again).toMatchObject({ ok: true, job: { id: a.job.id } });
    expect(await jobsOf(sara.id)).toBe(1);
  });

  it('a lost ack: the next new start meets `earlier` once, the keyed look (which the game makes after it) confirms, and the following ask starts', async () => {
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

  it('is decided under the person’s lock in the transaction that makes the job: a start waiting for the lock sees the unconfirmed job another start committed while it waited', async () => {
    const sara = await owner();
    const lockKey = `computer:giveback:${sara.id}`;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let rowMade: () => void = () => undefined;
    const holderRan = new Promise<void>((resolve) => (rowMade = resolve));
    // Another start, in the middle of making its job, holds the person's lock
    const holder = prisma.$transaction(
      async (tx) => {
        await lockPerson(tx, sara.id);
        await tx.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Held', writes: false, startKey: keyOf(), startAckedAt: null, route: 'computer', expectedMicros: BigInt(0) } });
        rowMade();
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    await holderRan;
    const waiting = start(sara, 'Visa form', keyOf());
    // A barrier, not a delay: wait (bounded) until a session is blocked on that lock
    let blocked = false;
    for (let tries = 0; tries < 250 && !blocked; tries += 1) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${lockKey})::bigint & 4294967295)`;
      blocked = rows[0].n > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
    release();
    await holder;
    expect(await waiting).toMatchObject({ ok: false, reason: 'earlier' });
    expect(await jobsOf(sara.id)).toBe(1);
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
