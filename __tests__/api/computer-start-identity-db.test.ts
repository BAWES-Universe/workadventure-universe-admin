/**
 * GPT round 6, finding 1 (Rule D, identity): a start answered with another start's job (`earlier`) keeps that answer durably, so a retry of it is answered with the SAME job after the job was acknowledged,
 * ended, or the game forgot its key; an older start that was not visible yet loses to the job made after it began; a deliberate second start under a new key still makes its own job. Each case asserts the job
 * ids, the reservations and the answer. Against a real database, through the real POST route where the game would come in. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-start-identity-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { ackStart, finishJob, forgetOldStartMarks, giveComputer, startJob, startedJobFor } from '@/lib/computer';
import { purgeBrick } from '@/lib/brick-purge';
import { GET, POST } from '@/app/api/bots/[id]/computer-jobs/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
// The real clock: a start's attempt beats on it
const NOW = new Date();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
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

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const jobsOf = (sara: Owner) => prisma.computerJob.findMany({ where: { personId: sara.id }, orderBy: { createdAt: 'asc' }, select: { id: true, startKey: true, startAckedAt: true, status: true } });
const roomsOf = (sara: Owner) => prisma.meterReservation.findMany({ where: { personId: sara.id }, select: { reservationKey: true, jobId: true } });
const attemptOf = (sara: Owner, startKey: string) => prisma.computerStartAttempt.findUniqueOrThrow({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey } } });

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
const look = async (sara: Owner, startKey: string) =>
  (await GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(sara.uuid)}&attempt=${startKey}`), { params: Promise.resolve({ id: sara.brickId }) })).json();
const viaLib = (sara: Owner, startKey: string, title: string) => startJob({ botId: sara.brickId, personId: sara.id, title, startKey, acks: true, origin: { kind: 'dm', ref: `!chat-${tag}:example.test` } }, NOW);

run('finding 1 (GPT round 6): one request, one job, through every retry, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
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

  it('1a REPRO through the route pre-check: B gets `earlier A`; A is acknowledged and finished; B is resent with the SAME key: no second job, one reservation, B answers A’s job', async () => {
    const sara = await owner('r1a');
    const KEY_A = key();
    const KEY_B = key();
    const a = await post(sara, KEY_A, 'Fill the visa form');
    expect(a).toMatchObject({ ok: true, job: { status: 'running' } });
    const b = await post(sara, KEY_B, 'Please do the visa form');
    expect(b).toEqual({ ok: false, reason: 'earlier', job: { id: a.job.id, status: 'running', state: 'live', attempt: KEY_A } });
    // Kept before it was answered (on the route's pre-check, before any job): B is answered by A's job, and it acknowledged nothing (1e)
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: a.job.id, aliasAttemptId: null });
    expect((await jobsOf(sara))[0].startAckedAt).toBeNull();
    expect(await ackStart(sara.brickId, sara.id, KEY_A)).toBe(true);
    await finishJob(a.job.id, 'done', minutes(3));
    // The game's short-lived record of B is gone; its redelivery comes with the same key
    const again = await post(sara, KEY_B, 'Please do the visa form');
    expect(again).toMatchObject({ ok: true, job: { id: a.job.id, status: 'done' } });
    const jobs = await jobsOf(sara);
    expect(jobs.map((job) => job.id)).toEqual([a.job.id]);
    const rooms = await roomsOf(sara);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].jobId).toBe(a.job.id);
    // The keyed look says the same job for B (never "no job": the game would start afresh)
    expect((await look(sara, KEY_B)).started).toMatchObject({ id: a.job.id, status: 'done', attempt: KEY_B });
  });

  it('1a through the transaction (the route pre-check passed while A was still deciding): B is answered under the person lock and kept; resent after A’s ack and ending, still A’s job', async () => {
    const sara = await owner('r1a-tx');
    const KEY_A = key();
    const KEY_B = key();
    const a = await viaLib(sara, KEY_A, 'Fill the visa form');
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect(await viaLib(sara, KEY_B, 'Please do the visa form')).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, attempt: KEY_A } });
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: a.job.id });
    await ackStart(sara.brickId, sara.id, KEY_A);
    await finishJob(a.job.id, 'failed', minutes(3), null, 'ours');
    expect(await viaLib(sara, KEY_B, 'Please do the visa form')).toMatchObject({ ok: false, reason: 'broken_start' });
    expect((await jobsOf(sara)).map((job) => job.id)).toEqual([a.job.id]);
    expect(await roomsOf(sara)).toHaveLength(1);
  });

  it('1a while A is still unconfirmed: B’s retry is `earlier A` again (never a job), and its ack confirms nothing of A’s (1e)', async () => {
    const sara = await owner('r1a-unacked');
    const KEY_A = key();
    const KEY_B = key();
    const a = await post(sara, KEY_A, 'Visa');
    await post(sara, KEY_B, 'Visa please');
    expect(await post(sara, KEY_B, 'Visa please')).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, attempt: KEY_A } });
    expect(await ackStart(sara.brickId, sara.id, KEY_B)).toBe(false);
    expect((await jobsOf(sara))[0]).toMatchObject({ id: a.job.id, startAckedAt: null });
    expect(await jobsOf(sara)).toHaveLength(1);
  });

  it('1b REPRO (second order): A began before B but its attempt was not visible when B decided; B is made and acknowledged; A goes on: A is superseded by B’s job and answers it. One job, one reservation', async () => {
    const sara = await owner('r1b');
    const KEY_A = key();
    const KEY_B = key();
    const b = await post(sara, KEY_B, 'Please do the visa form');
    expect(b).toMatchObject({ ok: true });
    await ackStart(sara.brickId, sara.id, KEY_B);
    // A's attempt committed AFTER B decided, though A began first (its row says it began before B's job): it is open and still beating
    const bJob = await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } });
    await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_A, state: 'open', beatAt: new Date(), createdAt: new Date(bJob.createdAt.getTime() - 1_000) } });
    const a = await post(sara, KEY_A, 'Fill the visa form');
    expect(a).toMatchObject({ ok: true, job: { id: b.job.id } });
    expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'superseded', jobId: b.job.id });
    expect((await jobsOf(sara)).map((job) => job.id)).toEqual([b.job.id]);
    expect(await roomsOf(sara)).toHaveLength(1);
    // While B is still unconfirmed the same order answers `earlier B` (it acknowledges nothing)
    const tom = await owner('r1b-unacked');
    const KEY_C = key();
    const KEY_D = key();
    const c = await post(tom, KEY_C, 'Hotel');
    const cJob = await prisma.computerJob.findUniqueOrThrow({ where: { id: c.job.id } });
    await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_D, state: 'open', beatAt: new Date(), createdAt: new Date(cJob.createdAt.getTime() - 1_000) } });
    expect(await post(tom, KEY_D, 'Book the hotel')).toMatchObject({ ok: false, reason: 'earlier', job: { id: c.job.id, attempt: KEY_C } });
    expect(await jobsOf(tom)).toHaveLength(1);
    expect((await jobsOf(tom))[0].startAckedAt).toBeNull();
  });

  it('a start answered while the earlier one had NO job yet waits on THAT attempt: answered with its job once it makes one, and `expired` if it ended with none (the game then starts afresh)', async () => {
    const sara = await owner('r1-alias');
    const KEY_A = key();
    const KEY_B = key();
    // A reached Orbit and is still deciding (open, beating, no job)
    const aAttempt = await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_A, state: 'open', beatAt: new Date(), createdAt: new Date(Date.now() - 1_000) } });
    expect(await viaLib(sara, KEY_B, 'Visa please')).toEqual({ ok: false, reason: 'earlier', job: { id: null, status: null, state: 'starting', attempt: KEY_A } });
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: null, aliasAttemptId: aAttempt.id });
    // The look for B: A is still going on
    expect(await startedJobFor(sara.brickId, sara.id, KEY_B)).toEqual({ inProgress: true });
    const a = await viaLib(sara, KEY_A, 'Visa');
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect(await viaLib(sara, KEY_B, 'Visa please')).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id, attempt: KEY_A } });
    await ackStart(sara.brickId, sara.id, KEY_A);
    expect(await viaLib(sara, KEY_B, 'Visa please')).toMatchObject({ ok: true, job: { id: a.job.id } });
    expect(await jobsOf(sara)).toHaveLength(1);
    // Another person: A ended with no job (it stopped beating and was let go)
    const tom = await owner('r1-alias-dead');
    const deadA = await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_A, state: 'open', beatAt: new Date(), createdAt: new Date(Date.now() - 1_000) } });
    await viaLib(tom, KEY_B, 'Visa please');
    await prisma.computerStartAttempt.update({ where: { id: deadA.id }, data: { state: 'expired' } });
    expect(await viaLib(tom, KEY_B, 'Visa please')).toEqual({ ok: false, reason: 'expired' });
    expect(await jobsOf(tom)).toHaveLength(0);
  });

  it('1a REPRO through the route’s answered-before check: B answered `earlier A`; A acknowledged; a spending rule is now at its limit; B’s retry still answers A’s job (never `rule`). CONTROL: a new key is refused by the rule', async () => {
    const sara = await owner('r1a-rule');
    const KEY_A = key();
    const KEY_B = key();
    const a = await post(sara, KEY_A, 'Fill the visa form');
    expect(a).toMatchObject({ ok: true });
    expect(await post(sara, KEY_B, 'Please do the visa form')).toMatchObject({ ok: false, reason: 'earlier', job: { id: a.job.id } });
    expect(await ackStart(sara.brickId, sara.id, KEY_A)).toBe(true);
    // The rule leaves nothing now
    await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: sara.id, scope: 'bot', botId: sara.brickId, period: 'day', capMicros: BigInt(0), words: 'Nothing more today', createdById: sara.id } });
    expect(await post(sara, KEY_B, 'Please do the visa form')).toMatchObject({ ok: true, job: { id: a.job.id } });
    expect(await post(sara, key(), 'Another task')).toMatchObject({ ok: false, reason: 'rule' });
    expect((await jobsOf(sara)).map((job) => job.id)).toEqual([a.job.id]);
  });

  it('an answer that waits on a start that ended with NO job is swept with it after about a week (it answers `expired` all along); before that, and for a start bound to a job, nothing goes', async () => {
    const tom = await owner('r1-dead-sweep');
    const KEY_A = key();
    const KEY_B = key();
    const deadA = await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_A, state: 'open', beatAt: new Date(), createdAt: new Date(Date.now() - 1_000) } });
    await viaLib(tom, KEY_B, 'Visa please');
    expect(await attemptOf(tom, KEY_B)).toMatchObject({ state: 'answered', aliasAttemptId: deadA.id });
    await prisma.computerStartAttempt.update({ where: { id: deadA.id }, data: { state: 'expired' } });
    // A start that made a job, with an answer bound to it, beside it
    const sara = await owner('r1-dead-sweep-live');
    const a = await post(sara, KEY_A, 'Visa');
    await post(sara, KEY_B, 'Visa please');
    const week = 7 * 24 * 60 * 60_000;
    const left = () => prisma.computerStartAttempt.count({ where: { personId: { in: [tom.id, sara.id] } } });
    await forgetOldStartMarks(new Date(Date.now() + week - 60 * 60_000));
    expect(await left()).toBe(4);
    expect(await viaLib(tom, KEY_B, 'Visa please')).toEqual({ ok: false, reason: 'expired' });
    await forgetOldStartMarks(new Date(Date.now() + week + 60 * 60_000));
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(0);
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: a.job.id });
    expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'made', jobId: a.job.id });
  });

  it('6 CodeRabbit on #1025: a start whose attempt INSERT is delayed past another start’s job still sorts before that job (its time is when it began): it is superseded and makes no second job', async () => {
    const sara = await owner('r6');
    const KEY_A = key();
    const KEY_B = key();
    const original = prisma.computerStartAttempt.create.bind(prisma.computerStartAttempt);
    let delayed = false;
    let b: Awaited<ReturnType<typeof viaLib>> | null = null;
    const spy = jest.spyOn(prisma.computerStartAttempt, 'create').mockImplementation(((args: { data: { startKey: string } }) => {
      if (args.data.startKey !== KEY_A || delayed) return original(args as never);
      delayed = true;
      // A began; before its insert runs, B starts, makes its job and is acknowledged
      return (async () => {
        b = await viaLib(sara, KEY_B, 'Please do the visa form');
        await ackStart(sara.brickId, sara.id, KEY_B);
        return original(args as never);
      })();
    }) as unknown as typeof prisma.computerStartAttempt.create);
    let a;
    try {
      a = await viaLib(sara, KEY_A, 'Fill the visa form');
    } finally {
      spy.mockRestore();
    }
    if (!b || !(b as { ok: boolean }).ok) throw new Error(JSON.stringify(b));
    const bJob = (b as { job: { id: string } }).job;
    expect(a).toMatchObject({ ok: true, job: { id: bJob.id } });
    expect((await jobsOf(sara)).map((job) => job.id)).toEqual([bJob.id]);
    expect(await roomsOf(sara)).toHaveLength(1);
    expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'superseded', jobId: bJob.id });
    // Its time is when it began, not when the insert ran: before B's job
    expect((await attemptOf(sara, KEY_A)).createdAt.getTime()).toBeLessThanOrEqual((await prisma.computerJob.findUniqueOrThrow({ where: { id: bJob.id } })).createdAt.getTime());
  });

  it('11 CodeRabbit on #1025: a start with no ack makes its job and links its attempt in ONE commit: a link that fails leaves no job behind', async () => {
    const sara = await owner('r11');
    const KEY = key();
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: unknown) => {
      if (typeof fn !== 'function') return original(fn, options);
      return original(async (tx: Record<string, unknown>) => {
        const delegate = tx.computerStartAttempt as object;
        const broken = new Proxy(delegate, {
          get: (target, name) => (name === 'updateMany' ? async () => { throw new Error('the link could not be written'); } : Reflect.get(target, name)),
        });
        return (fn as (client: unknown) => unknown)(new Proxy(tx, { get: (target, name) => (name === 'computerStartAttempt' ? broken : Reflect.get(target, name)) }));
      }, options);
    }) as unknown as typeof prisma.$transaction);
    try {
      await expect(startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa', startKey: KEY }, NOW)).rejects.toThrow('the link could not be written');
    } finally {
      spy.mockRestore();
    }
    expect(await jobsOf(sara)).toHaveLength(0);
    expect(await roomsOf(sara)).toHaveLength(0);
    // The same key again makes its job normally and the attempt points at it
    const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa', startKey: KEY }, NOW);
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(await attemptOf(sara, KEY)).toMatchObject({ state: 'made', jobId: again.job.id });
  });

  it('12 CodeRabbit on #1025: an alias is kept for as long as the attempt it follows (through any hops) has a job, past the week; one that leads to no job still goes', async () => {
    const tom = await owner('r12');
    const [KEY_A, KEY_B, KEY_C] = [key(), key(), key()];
    const old = new Date(Date.now() - 9 * 24 * 60 * 60_000);
    const a = await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_A, state: 'open', beatAt: old } });
    const b = await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_B, state: 'answered', aliasAttemptId: a.id, beatAt: old } });
    await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_C, state: 'answered', aliasAttemptId: b.id, beatAt: old } });
    // The answering start then makes its job (as a late start does)
    const sara = await owner('r12-job');
    const made = await post(sara, key(), 'Visa');
    await prisma.computerStartAttempt.update({ where: { id: a.id }, data: { state: 'made', jobId: made.job.id, beatAt: old } });
    await forgetOldStartMarks(new Date());
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(3);
    // A chain that ends in no job is let go after the week
    await prisma.computerStartAttempt.update({ where: { id: a.id }, data: { state: 'expired', jobId: null } });
    await forgetOldStartMarks(new Date());
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(0);
  });

  it('1c the game’s expired-key retry (its record gone, hours later, after the sweep of old marks): the kept answer survives the sweep and the retry makes no second job', async () => {
    const sara = await owner('r1c');
    const KEY_A = key();
    const KEY_B = key();
    const a = await post(sara, KEY_A, 'Visa');
    await post(sara, KEY_B, 'Visa please');
    await ackStart(sara.brickId, sara.id, KEY_A);
    await finishJob(a.job.id, 'done', minutes(3));
    // The sweep runs as if a day had passed: attempts bound to a job (made, answered) stay as long as the job
    await forgetOldStartMarks(minutes(24 * 60));
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: a.job.id });
    expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'made', jobId: a.job.id });
    expect(await post(sara, KEY_B, 'Visa please')).toMatchObject({ ok: true, job: { id: a.job.id } });
    expect(await jobsOf(sara)).toHaveLength(1);
    expect(await roomsOf(sara)).toHaveLength(1);
    // An alias of an attempt that made no job is kept too (its answer is still `expired`, never a fresh job under the old key)
    const tom = await owner('r1c-alias');
    const deadA = await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: KEY_A, state: 'open', beatAt: new Date(), createdAt: new Date(Date.now() - 1_000) } });
    await viaLib(tom, KEY_B, 'Visa please');
    await prisma.computerStartAttempt.update({ where: { id: deadA.id }, data: { state: 'expired', beatAt: minutes(-120) } });
    await prisma.computerStartAttempt.update({ where: { botId_personId_startKey: { botId: tom.brickId, personId: tom.id, startKey: KEY_B } }, data: { beatAt: minutes(-120) } });
    await forgetOldStartMarks(new Date());
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(2);
    expect(await post(tom, KEY_B, 'Visa please')).toEqual({ ok: false, reason: 'expired' });
    expect(await jobsOf(tom)).toHaveLength(0);
    // CONTROL (N15): a lone attempt that made nothing and answers nothing is NOT swept after an hour any more: it is the record that its key was answered, so it stays a week and goes only then
    await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: key(), state: 'expired', beatAt: minutes(-120) } });
    await forgetOldStartMarks(new Date());
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(3);
    await prisma.computerStartAttempt.create({ data: { botId: tom.brickId, personId: tom.id, startKey: key(), state: 'expired', beatAt: minutes(-8 * 24 * 60) } });
    await forgetOldStartMarks(new Date());
    expect(await prisma.computerStartAttempt.count({ where: { personId: tom.id } })).toBe(3);
  });

  it('1d CONTROL: a deliberate second start with the SAME title after the first was acknowledged makes a second job with its own reservation', async () => {
    const sara = await owner('r1d');
    const first = await post(sara, key(), 'Visa form');
    expect(first).toMatchObject({ ok: true });
    await ackStart(sara.brickId, sara.id, (await jobsOf(sara))[0].startKey as string);
    await finishJob(first.job.id, 'done', minutes(3));
    const second = await post(sara, key(), 'Visa form');
    expect(second).toMatchObject({ ok: true, job: { status: 'running' } });
    expect(second.job.id).not.toBe(first.job.id);
    const rooms = await roomsOf(sara);
    expect(rooms.map((room) => room.jobId).sort()).toEqual([first.job.id, second.job.id].sort());
  });

  it('N15: a key answered with a job that is then taken away is NOT forgotten: the attempt stays with no job, and a delayed copy of the start answers `expired` and makes nothing', async () => {
    const sara = await owner('n15-away');
    const KEY_A = key();
    const KEY_B = key();
    const a = await post(sara, KEY_A, 'Visa');
    await post(sara, KEY_B, 'Visa please');
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: a.job.id });
    // The job is made and taken away again (controls not set up, a rule, a purge of it): its attempts and the answers that point at it STAY, with no job
    await prisma.computerJob.delete({ where: { id: a.job.id } });
    expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id } })).toBe(2);
    expect(await attemptOf(sara, KEY_B)).toMatchObject({ state: 'answered', jobId: null });
    // Even after the hour the old cleanup used (it is a week now)
    await forgetOldStartMarks(minutes(120));
    expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id } })).toBe(2);
    // A delayed copy of the answered start, and of the one that made the job: both are `expired`, and nothing is made
    expect(await post(sara, KEY_B, 'Visa please')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await viaLib(sara, KEY_B, 'Visa please')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await jobsOf(sara)).toHaveLength(0);
    // Nothing new was reserved: the only room is the one the deleted job took
    expect((await roomsOf(sara)).every((room) => room.jobId === a.job.id)).toBe(true);
    // N15-a (Opus): a delayed copy of the start that MADE the job, whose attempt now reads `made` with no job, is `expired` too, by the route and the library, and makes no job and no room
    expect(await attemptOf(sara, KEY_A)).toMatchObject({ state: 'made', jobId: null });
    expect(await post(sara, KEY_A, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await viaLib(sara, KEY_A, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await jobsOf(sara)).toHaveLength(0);
    expect((await roomsOf(sara)).every((room) => room.jobId === a.job.id)).toBe(true);
  });

  it('N15-a: the same after the controls are set up again between the take-away and the replay, and for a start that does not ack: a made-and-gone start never runs as a fresh paid job', async () => {
    const sara = await owner('n15-made-gone');
    const KEY_A = key();
    const a = await post(sara, KEY_A, 'Visa');
    await prisma.computerJob.delete({ where: { id: a.job.id } });
    await setUp();
    expect(await post(sara, KEY_A, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await viaLib(sara, KEY_A, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    // Without an ack (the plain keyed path)
    const plain = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa', startKey: KEY_A }, NOW);
    expect(plain).toMatchObject({ ok: false, reason: 'expired' });
    expect(await jobsOf(sara)).toHaveLength(0);
    expect((await roomsOf(sara)).every((room) => room.jobId === a.job.id)).toBe(true);
    // CONTROL: another key is a deliberate new start and makes its job
    expect(await post(sara, key(), 'Visa')).toMatchObject({ ok: true });
  });

  it('N15: a SUPERSEDED start whose answering job is gone, delayed past the old cleanup horizon, still makes no second job', async () => {
    const sara = await owner('n15-superseded');
    const KEY_OLD = key();
    const KEY_NEW = key();
    // The older start was held back; the newer one made the job after it began, which supersedes the older one
    await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY_OLD, state: 'open', beatAt: minutes(-180), createdAt: minutes(-180) } });
    const fresh = await post(sara, KEY_NEW, 'Visa');
    expect(fresh).toMatchObject({ ok: true, job: { status: 'running' } });
    await prisma.computerStartAttempt.update({ where: { botId_personId_startKey: { botId: sara.brickId, personId: sara.id, startKey: KEY_OLD } }, data: { state: 'superseded', jobId: fresh.job.id } });
    await prisma.computerJob.delete({ where: { id: fresh.job.id } });
    // Three hours after its last beat: the old hour-long cleanup would have deleted this row and the delayed start would have made a second job
    await forgetOldStartMarks(NOW);
    expect(await attemptOf(sara, KEY_OLD)).toMatchObject({ state: 'superseded', jobId: null });
    expect(await viaLib(sara, KEY_OLD, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await jobsOf(sara)).toHaveLength(0);
  });

  it('N15: an EXPIRED key two hours later answers `expired` and makes nothing; only a week after its last beat is it let go', async () => {
    const sara = await owner('n15-expired');
    const KEY = key();
    await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: KEY, state: 'expired', beatAt: minutes(-120), createdAt: minutes(-121) } });
    await forgetOldStartMarks(NOW);
    expect(await attemptOf(sara, KEY)).toMatchObject({ state: 'expired', jobId: null });
    expect(await viaLib(sara, KEY, 'Visa')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await jobsOf(sara)).toHaveLength(0);
    // A week and a bit after its last beat, every job-less attempt goes, whatever its state
    for (const state of ['open', 'expired', 'superseded', 'answered']) {
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: key(), state, beatAt: minutes(-8 * 24 * 60) } });
    }
    await forgetOldStartMarks(NOW);
    expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id } })).toBe(1);
    expect(await attemptOf(sara, KEY)).toMatchObject({ state: 'expired' });
  });

  it('N15: an attempt bound to a LIVE job stays however old it is; the Brick’s purge removes every attempt of the Brick, with or without a job', async () => {
    const sara = await owner('n15-purge');
    const live = await post(sara, key(), 'Visa');
    await prisma.computerStartAttempt.updateMany({ where: { jobId: live.job.id }, data: { beatAt: minutes(-30 * 24 * 60) } });
    await forgetOldStartMarks(NOW);
    expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id, jobId: live.job.id } })).toBe(1);
    await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: key(), state: 'expired', beatAt: minutes(-60) } });
    await finishJob(live.job.id, 'done', minutes(1));
    await prisma.computerJob.delete({ where: { id: live.job.id } });
    await prisma.bot.update({ where: { id: sara.brickId }, data: { deletedAt: minutes(-8 * 24 * 60), goneAt: minutes(-60), enabled: false } });
    expect(await purgeBrick(sara.brickId, NOW)).toBe('purged');
    expect(await prisma.computerStartAttempt.count({ where: { botId: sara.brickId } })).toBe(0);
  });
});
