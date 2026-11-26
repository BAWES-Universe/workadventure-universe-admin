/**
 * What a Brick's computer may ask of Orbit, against a real database (build handoff v2, section 5): its key, and a model call's
 * room and books. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-calls-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-calls', () => {
  const actual = jest.requireActual('@/lib/computer-calls');
  return { ...actual, giveBackModelCalls: jest.fn(actual.giveBackModelCalls) };
});

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { currentEnvelope, heldRoom, poolStatusNow, releaseRoom, USUAL_CALL_ROOM_MICROS } from '@/lib/meter-allowance';
import { computerReadiness, poolCheck } from '@/lib/computer-readiness';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, finishJob, giveComputer, handBack, renewJob, requestHandover, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { activityFor } from '@/lib/task-receipts';
import { TOKEN_LIFE_MS, forgetOldTokens, mintJobToken, revokeJobTokens, verifyJobToken } from '@/lib/computer-token';
import { recordMeterEvent } from '@/lib/meter';
import { reportsToTell } from '@/lib/computer-report';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { authorizeModelCall, callRoomKey, cutoffEndsFinished, cutoffLockKey, endStuckCutoffs, forgetMeterNotSetAlert, giveBackModelCalls, releaseModelCall, settleModelCall } from '@/lib/computer-calls';
import { POOL_CUTOFF_CALL, admitLockKey, hasOwnKeyCall, hasPoolRefusals, readFaultRows, recordCallAdmission, recordFaults, recordOwnKeyCall, recordPoolCutoff, recordPoolRefusal } from '@/lib/computer-faults';

/** Holds (or fails) the slow end of a job at its first look at the job's whole row (the first read `endJob` makes: no `select`, no `include`), before it writes anything: the end of a job that is slow, or whose database went away. Put back with `mockRestore`. */
const atTheEnd = (handler: (read: () => Promise<unknown>) => Promise<unknown>) => {
  const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as (args: unknown) => Promise<unknown>;
  let used = false;
  return jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { select?: unknown; include?: unknown }) => {
    if (!used && !args.select && !args.include) {
      used = true;
      return handler(() => real(args));
    }
    return real(args);
  }) as never);
};

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

/** A refusal that decides a cutoff is ANSWERED first and the job is ended after (Sentry, lib/computer-calls): this asks, then waits for that end, so a test reads the job as it is once everything has run. */
const authorizeSettled = (...args: Parameters<typeof authorizeModelCall>) => authorizeModelCall(...args).then(async (answer) => {
  await cutoffEndsFinished();
  return answer;
});

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

/** A pretend minute costs 6,000 millionths; 10 minutes of room is 60,000. */
const setUp = (over: Record<string, number | null> = {}) =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, ...over }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

/** A person with a Brick that has a job running on the pretend machine. */
async function running(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}

run('what a computer may ask of Orbit, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    forgetMeterNotSetAlert();
    (Sentry.captureMessage as jest.Mock).mockClear();
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

  describe('the key a job’s computer holds', () => {
    it('is made once for a running job, kept only as a digest, and says who it is for from Orbit’s own records', async () => {
      const { sara, jobId } = await running();
      const minted = await mintJobToken(jobId, 'model', NOW);
      expect(minted.ok && minted.token.startsWith('cjt_')).toBe(true);
      const token = (minted as { token: string }).token;
      const stored = await prisma.computerJobToken.findMany({ where: { jobId } });
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(await verifyJobToken(token, 'model', NOW)).toMatchObject({ ok: true, jobId, botId: sara.brickId, personId: sara.id });
    });

    it('is not made for a job that is over, queued or not there', async () => {
      const { jobId } = await running();
      await finishJob(jobId, 'done', NOW);
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      expect(await mintJobToken(randomUUID(), 'model', NOW)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('is refused when it is wrong, was never made, or is for another scope: the same answer for all', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await verifyJobToken(`${minted.token}x`, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken('cjt_nothing', 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken('not-a-key', 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      expect(await verifyJobToken(minted.token, 'lifecycle' as never, NOW)).toEqual({ ok: false, reason: 'refused' });
    });

    it('runs out after 15 minutes, and the job’s lease renews it', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await verifyJobToken(minted.token, 'model', new Date(NOW.getTime() + TOKEN_LIFE_MS - 1000))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', new Date(NOW.getTime() + TOKEN_LIFE_MS + 1000))).ok).toBe(false);
      // The lease is renewed 8 minutes in: the key lives 15 minutes from there
      expect((await renewJob(jobId, minutes(8))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', minutes(20))).ok).toBe(true);
      expect((await verifyJobToken(minted.token, 'model', minutes(24))).ok).toBe(false);
    });

    it('ends with the job', async () => {
      const { jobId } = await running();
      const minted = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await finishJob(jobId, 'done', NOW);
      expect(await verifyJobToken(minted.token, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
    });

    it('ends when the person takes over, and a key made before a hand back stays refused (the fence)', async () => {
      const { sara, jobId } = await running();
      const before = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await verifyJobToken(before.token, 'model', NOW)).toEqual({ ok: false, reason: 'refused' });
      // While the person has the machine Brick is not admitted: no key is made for it (audit F02: the agent and the person are never authorized together)
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      await handBack(sara.brickId, sara.id);
      const after = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await verifyJobToken(after.token, 'model', NOW)).ok).toBe(true);
      const job = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.controlGeneration).toBe(2);
    });

    it('cannot be used for another person’s job by naming it: authority comes from the key alone', async () => {
      const a = await running('sara');
      const b = await running('omar');
      const mine = (await mintJobToken(a.jobId, 'model', NOW)) as { token: string };
      const verified = await verifyJobToken(mine.token, 'model', NOW);
      expect(verified).toMatchObject({ ok: true, jobId: a.jobId, personId: a.sara.id });
      expect(verified.ok && verified.jobId).not.toBe(b.jobId);
    });

    it('old ended keys are forgotten, good ones are not', async () => {
      const { jobId } = await running();
      const live = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: 0, digest: 'a'.repeat(64), expiresAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000) } });
      expect(await forgetOldTokens(NOW)).toBe(1);
      expect((await verifyJobToken(live.token, 'model', NOW)).ok).toBe(true);
    });
  });

  describe('a model call', () => {
    /** The first look at the cutoff of the next request (the first of the 15 s transactions it makes): `onLook` runs before that look starts, and may hold it, or make it fail by throwing. */
    const atNextLook = (onLook: () => Promise<void>) => {
      const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: { maxWait?: number }) => Promise<unknown>;
      let taken = false;
      return jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: { maxWait?: number }) => {
        if (options?.maxWait === 15_000 && !taken) {
          taken = true;
          return onLook().then(() => real(fn, options));
        }
        return real(fn, options);
      }) as never);
    };
    const lookFails = () => atNextLook(() => Promise.reject(new Error('the database went away')));
    const call = (token: string, callId: string, estimateMicros = 5_000) => authorizeSettled({ token, callId, estimateMicros, payer: 'universe' }, NOW);

    it('GPT round 6, finding 8: the stretch it belongs to is stamped on its room INSIDE the transaction that checked the key, under the job’s cutoff lock (never after it, where a pause could land between the two)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // Every statement the admission sends, in order, with the transaction it was sent on (CodeRabbit on #1025, 27): the client handed to each transaction's callback is wrapped, and its own raw calls are logged under that
      // transaction's number and forwarded to the original method bound to that same client, so nothing is rebound to the root client. 
      // `of`: for a `DONE` entry, the position in this list of the entry that started the query it completes (CodeRabbit on #1025, N23)
      type Entry = { tx: number; what: string; values?: unknown[]; of?: number };
      const log: Entry[] = [];
      // Prisma queries are lazy: a query is sent only when it is awaited (its `then` is called), not when the method is called. So an entry is logged when the query STARTS EXECUTING (its first `then`), and a `DONE ` entry
      // when it has come back: the lock being taken is the `DONE` of its query, and the key's look must START after it (CodeRabbit on #1025, 12)
      const lazily = (tx: number, what: string, values: unknown[] | undefined, start: () => PromiseLike<unknown>) => {
        let run: Promise<unknown> | undefined;
        const go = () =>
          (run ??= (() => {
            const began = log.push({ tx, what, values }) - 1;
            return Promise.resolve(start()).then((result) => {
              log.push({ tx, what: `DONE ${what}`, of: began });
              return result;
            });
          })());
        return {
          then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => go().then(onFulfilled, onRejected),
          catch: (onRejected?: (reason: unknown) => unknown) => go().catch(onRejected),
          finally: (onFinally?: () => void) => go().finally(onFinally),
        };
      };
      let transactions = 0;
      const realTx = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
      const sql = (statement: unknown): string => (Array.isArray(statement) ? statement.join('?') : statement && typeof statement === 'object' && 'strings' in statement ? (statement as { strings: string[] }).strings.join('?') : String(statement));
      // (The root client's own `$executeRaw` is NOT spied on: a transaction's client inherits it, so a spy there would be reached by the transaction's calls and run them on the root client.) A stamp sent on the root client
      // is never logged under a transaction, so it is found by no transaction below
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        const first = args[0];
        if (typeof first !== 'function') return realTx(...args);
        const wrapped = async (tx: object) => {
          const id = ++transactions;
          log.push({ tx: id, what: 'BEGIN' });
          const client = new Proxy(tx, {
            get(target, property) {
              const value = Reflect.get(target, property, target) as unknown;
              if ((property === '$executeRaw' || property === '$queryRaw') && typeof value === 'function') {
                return (...raws: unknown[]) => lazily(id, sql(raws[0]), raws.slice(1), () => (value as (...inner: unknown[]) => PromiseLike<unknown>).apply(target, raws));
              }
              // The look at the key is a model call, not raw SQL: it is recorded in the same trace, so the order of the lock, the key and the stamp is read from one list
              if (property === 'computerJobToken' && value && typeof value === 'object') {
                return new Proxy(value as object, {
                  get(delegate, method) {
                    const inner = Reflect.get(delegate, method, delegate) as unknown;
                    if (method !== 'findUnique' || typeof inner !== 'function') return inner;
                    return (...asked: unknown[]) => lazily(id, 'computerJobToken.findUnique', undefined, () => (inner as (...more: unknown[]) => PromiseLike<unknown>).apply(delegate, asked));
                  },
                });
              }
              return value;
            },
          });
          try {
            return await (first as (client: unknown) => Promise<unknown>)(client);
          } finally {
            log.push({ tx: id, what: 'END' });
          }
        };
        return realTx(wrapped, ...args.slice(1));
      }) as never);
      try {
        expect(await call(token, 'c1', 5_000)).toMatchObject({ ok: true });
      } finally {
        spy.mockRestore();
      }
      const stamps = log.filter((entry) => entry.what.includes('"job_stretch"') && !entry.what.startsWith('DONE '));
      expect(stamps).toHaveLength(1);
      const stamp = stamps[0];
      // The stamp was sent on a transaction's own client, never on the root client...
      expect(stamp.tx).toBeGreaterThan(0);
      const stampAt = log.indexOf(stamp);
      const inThatTransaction = log.slice(0, stampAt).filter((entry) => entry.tx === stamp.tx);
      expect(inThatTransaction[0]).toEqual({ tx: stamp.tx, what: 'BEGIN' });
      // ...which took THIS job's cutoff lock before the look at the key and the stamp, on the same transaction (the lock a pause takes, so an admission and a pause are ordered exactly, never by two clocks)...
      const lockAt = log.findIndex((entry) => entry.tx === stamp.tx && entry.what.includes('pg_advisory_xact_lock') && !entry.what.startsWith('DONE ') && entry.values?.includes(cutoffLockKey(jobId)));
      // The lock is TAKEN (the completion of THAT very lock query has come back, not of another advisory lock beside it) before the key's look starts executing, and the stamp starts after the look has come back
      const lockTakenAt = log.findIndex((entry) => entry.of === lockAt);
      const keyAt = log.findIndex((entry) => entry.tx === stamp.tx && entry.what === 'computerJobToken.findUnique');
      const keyBackAt = log.findIndex((entry) => entry.tx === stamp.tx && entry.what === 'DONE computerJobToken.findUnique');
      expect(lockAt).toBeGreaterThan(0);
      expect(lockTakenAt).toBeGreaterThan(lockAt);
      expect(keyAt).toBeGreaterThan(lockTakenAt);
      expect(keyBackAt).toBeGreaterThan(keyAt);
      expect(stampAt).toBeGreaterThan(keyBackAt);
      expect(inThatTransaction.some((entry) => entry.what === 'END')).toBe(false);
      // ...and the stamp is written before that transaction commits
      expect(log.findIndex((entry) => entry.tx === stamp.tx && entry.what === 'END')).toBeGreaterThan(stampAt);
      expect(await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') }, select: { jobStretch: true } })).toEqual({ jobStretch: 0 });
    });

    it('takes room before it is sent, and settles to what it cost: the books and the room agree', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const before = (await currentEnvelope(NOW)).reservedMicros;
      const authorized = await call(token, 'c1', 5_000);
      expect(authorized).toMatchObject({ ok: true, jobId, botId: sara.brickId, personId: sara.id, reservedMicros: 5_000 });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(before + 5_000);
      await settleModelCall(jobId, 'c1', { costMicros: 1_200, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai', tokens: { input: 9000, output: 100 } }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c1` } });
      expect(event).toMatchObject({ kind: 'model_call', pool: 'computer', payerKind: 'universe', route: 'universe-ai', jobId, personKey: `person:${sara.id}`, basis: 'measured' });
      expect(Number(event.costMicros)).toBe(1_200);
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } });
      expect(room).toMatchObject({ state: 'settled' });
      expect(Number(room.settledMicros)).toBe(1_200);
    });

    it('says so when a call cost more than the room held for it, and the extra counts from then on (audit F9)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await call(token, 'c-over', 1_000)).toMatchObject({ ok: true, reservedMicros: 1_000 });
      await settleModelCall(jobId, 'c-over', { costMicros: 1_800, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c-over` } });
      expect(Number(event.costMicros)).toBe(1_800);
      expect(event.detail).toMatchObject({ overrunMicros: 800 });
      // A call that stayed inside its room says nothing of the kind
      expect(await call(token, 'c-fine', 1_000)).toMatchObject({ ok: true });
      await settleModelCall(jobId, 'c-fine', { costMicros: 900, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c-fine` } })).detail).not.toHaveProperty('overrunMicros');
    });

    it('is the same call when asked twice, and a settled call is not another', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const first = await call(token, 'c1');
      const again = await call(token, 'c1');
      expect(first.ok && again.ok).toBe(true);
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toBe(1);
      await settleModelCall(jobId, 'c1', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'provider' }, NOW);
      await settleModelCall(jobId, 'c1', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'provider' }, NOW);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:c1` } })).toBe(1);
      expect(await call(token, 'c1')).toEqual({ ok: false, reason: 'refused' });
    });

    it('is refused with the reason when the person’s allowance has no room: nothing is reserved', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // 60,000 of the 1,000,000 allowance is the job's own room: a call that asks for more than what is left is refused
      expect(await call(token, 'big', 2_000_000)).toEqual({ ok: false, reason: 'allowance' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'big') } })).toBe(0);
    });

    it('pauses the job right there as the person’s when it is refused for their allowance, so a failed turn after it can never end it as ours and give back what it ran', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // 900,000 of the 1,000,000 allowance goes on the job's own calls (60,000 more is its own room)
      expect(await call(token, 'spent', 900_000)).toMatchObject({ ok: true });
      await settleModelCall(jobId, 'spent', { costMicros: 900_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      expect(await call(token, 'more', 100_000)).toEqual({ ok: false, reason: 'allowance' });
      // The month ran out: the job pauses and waits (piece 3 of the controls), it does not end
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null });
      const month = async () => (await computerView(sara.brickId, sara.id, NOW))?.month?.leftFraction as number;
      expect(await month()).toBeLessThan(0.2);
      // The runner's three failed turns on the refusal try to end it "failed, ours": it no longer owns the job (the pause moved the owner), so nothing is ended or given back
      await finishJob(jobId, 'failed', NOW, 'Three turns failed', 'ours');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:spent` } })).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      expect(await month()).toBeLessThan(0.2);
      await sweepComputers(minutes(30));
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:spent` } })).toMatchObject({ personKey: `person:${sara.id}` });
      expect(await month()).toBeLessThan(0.2);
    });

    it('is refused with "pool" when the platform ceiling has no room, never "ask for more"', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await setUp({ poolCeilingMicros: 70_000 });
      // Refused for its own size: there is room for a smaller call, so the pool is not full
      expect(await call(token, 'c1', 50_000)).toEqual({ ok: false, reason: 'pool', full: false });
    });

    it('says the pool is FULL only when it has no room even for the smallest call (so the relay can tell our full pool from a call too big for the room left)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      // The job already holds its first stretch (60,000): a ceiling at exactly that leaves nothing for any call
      await setUp({ poolCeilingMicros: 60_000 });
      expect(await call(token, 'c1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
      // (a job none of whose calls was ever authorized is stopped by its second refusal: this one is asked as a job that had a call)
      expect(await call(token, 'c1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
      // One millionth of room left: a bigger call is refused for its size, not because the pool is full
      await setUp({ poolCeilingMicros: 60_001 });
      expect(await call(token, 'c3', 2)).toEqual({ ok: false, reason: 'pool', full: false });
    });

    describe('the pool, as the readiness check reads it', () => {
      const poolCheckNow = async (at: Date = NOW) => poolCheck(await poolStatusNow(at), at);

      it('is green while a call of the usual size fits and red once it would be refused, with every part said; the refusal and the check agree', async () => {
        // Empty: room for a call of the usual size
        await setUp({ poolCeilingMicros: 1_000_000, reserveMicros: 100_000 });
        const empty = await poolStatusNow(NOW);
        expect(empty).toMatchObject({ ceilingMicros: 1_000_000, totalMicros: 100_000, reserveMicros: 100_000, committedMicros: 0, reservedMicros: 0, leftMicros: 900_000, refusing: false, lapsed: { count: 0, micros: 0, oldestLapsedAt: null } });
        expect(await poolCheckNow()).toMatchObject({ name: 'pool', ok: true });
        // A job holding its first stretch (60,000) and a ceiling that leaves less than a usual call: red, and a real call of that size is refused for the pool
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 + USUAL_CALL_ROOM_MICROS - 1, reserveMicros: 0 });
        const full = await poolStatusNow(NOW);
        expect(full).toMatchObject({ reservedMicros: 60_000, leftMicros: USUAL_CALL_ROOM_MICROS - 1, refusing: true });
        const red = await poolCheckNow();
        expect(red).toMatchObject({ name: 'pool', ok: false });
        expect(red?.detail).toContain('would be refused for the pool');
        expect(red?.detail).toMatch(/held for steps \$0\.06/);
        expect(await authorizeSettled({ token, callId: 'big', estimateMicros: USUAL_CALL_ROOM_MICROS, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
        // One millionth more room and the same call fits, and the check is green again
        await setUp({ poolCeilingMicros: 60_000 + USUAL_CALL_ROOM_MICROS, reserveMicros: 0 });
        expect((await poolStatusNow(NOW))?.refusing).toBe(false);
        expect(await poolCheckNow()).toMatchObject({ ok: true });
        expect((await authorizeSettled({ token, callId: 'fits', estimateMicros: USUAL_CALL_ROOM_MICROS, payer: 'universe' }, NOW)).ok).toBe(true);
      });

      it('says the kept storage, the recorded-and-not-settled spend and the chat apart, and counts the holds that ran out and were never settled (how many, how much, how long ago the oldest ran out): a leak shows here', async () => {
        await setUp({ poolCeilingMicros: 10_000_000, reserveMicros: 500_000, storageMicrosPerGbMonth: 20_000 });
        const { jobId } = await running();
        // A hold that ran out two hours ago and a newer one that ran out ten minutes ago, neither settled nor released
        const hold = (key: string, expiresAt: Date, amountMicros: number) => prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'person:x', jobId, amountMicros, state: 'held', expiresAt, createdAt: minutes(-300) } });
        await hold(`${callRoomKey(jobId, 'old')}`, minutes(-120), 7_000);
        await hold(`${callRoomKey(jobId, 'newer')}`, minutes(-10), 3_000);
        const brickId = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).botId;
        const event = (eventId: string, kind: string, pool: 'computer' | 'chat', costMicros: number | null, extra: Record<string, unknown> = {}) =>
          recordMeterEvent({ eventId, kind, pool, occurredAt: NOW, personKey: 'person:x', personId: null, botId: null, brick: false, payerKind: 'universe', payerPersonId: null, route: null, jobId: null, quantity: 1, unit: 'call', costMicros, basis: 'measured', sourceRef: eventId, detail: null, ...extra } as never);
        // A disk of 2 GB is kept: 2 x $0.02 a month
        await event(`ev-disk-${tag}`, 'stored_bytes', 'computer', null, { botId: brickId, quantity: 2_000_000_000, unit: 'byte' });
        await event(`ev-unsettled-${tag}`, 'model_call', 'computer', 4_000);
        await event(`ev-chat-${tag}`, 'model_call', 'chat', 9_000);
        const status = await poolStatusNow(NOW);
        expect(status?.lapsed).toMatchObject({ count: 2, micros: 10_000, oldestLapsedAt: minutes(-120) });
        expect(status?.chatMicros).toBe(9_000);
        expect(status?.reserveMicros).toBe(500_000);
        // The lapsed room is inside the unsettled sum `fits` reads, and the check says it apart from the spend that is only not settled yet
        expect(status!.unsettledMicros).toBe(4_000 + 10_000);
        const check = poolCheck(status, NOW);
        expect(check.detail).toContain('held rooms that ran out and were never settled or given up $0.01 (2, the oldest ran out 2 h ago)');
        expect(check.detail).toContain('recorded and not settled $0.004');
        expect(check.detail).toContain('chat $0.009 is kept apart');
        expect(check.detail).toContain('reserve $0.50');
        expect(check.detail).toContain('kept storage $0.04');
        expect(status?.keptStorageMicros).toBe(40_000);
      });

      it('counts the holds that ran out from the very rows the unsettled spend counts them from: a hold released while the pool is being read can never leave "recorded and not settled" negative (CodeRabbit)', async () => {
        await setUp({ poolCeilingMicros: 10_000_000, reserveMicros: 0 });
        const { jobId } = await running();
        const key = callRoomKey(jobId, 'gone');
        await prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'person:x', jobId, amountMicros: 10_000, state: 'held', expiresAt: minutes(-120), createdAt: minutes(-300) } });
        // The hold is released while the pool is being read, before the envelope reads the reservations: with two independent reads, the lapsed holds were counted by one (10,000) and the other saw none (0 unsettled)
        const real = prisma.meterReservation.findMany.bind(prisma.meterReservation);
        const readers = jest.spyOn(prisma.meterReservation, 'findMany').mockImplementation(((args: never) =>
          new Promise((resolve) => setTimeout(resolve, 300))
            .then(() => prisma.meterReservation.updateMany({ where: { reservationKey: key }, data: { state: 'released', closedAt: NOW } }))
            .then(() => real(args))) as never);
        const status = await poolStatusNow(NOW);
        readers.mockRestore();
        expect(status!.unsettledMicros - status!.lapsed.micros).toBeGreaterThanOrEqual(0);
        expect(poolCheck(status, NOW).detail).not.toMatch(/-\$|\$-/);
      });

      it('is part of the readiness: not ready while a new call would be refused, and the parts are given beside the checks', async () => {
        const { jobId } = await running();
        expect(jobId).toBeTruthy();
        await setUp({ poolCeilingMicros: 60_000, reserveMicros: 0 });
        const answer = await computerReadiness();
        expect(answer.ready).toBe(false);
        expect(answer.checks.find((check) => check.name === 'pool')).toMatchObject({ ok: false });
        expect(answer.pool).toMatchObject({ ceilingMicros: 60_000, refusing: true });
      });
    });

    describe('a job every call of which is refused for our own pool (dev staging: pool refusals, every turn failing)', () => {
      const poolRows = (jobId: string) => prisma.computerJobFault.findMany({ where: { jobId, callId: { startsWith: 'orbit:pool:' } }, orderBy: { callId: 'asc' } });
      const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      const timeOf = (jobId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } });
      /** A barrier, not a delay: waits (bounded) until some session is blocked on THIS job's cutoff lock, so a test goes on only once the thing under test is really waiting for it. */
      // A request that is started and then waited for at a lock is observed from the moment it starts: if it rejects before it reaches the lock, the poll fails with ITS error (never an unhandled rejection reported first, and never "the lock was not reached")
      let requestFailure: { error: unknown } | null = null;
      const observe = <T>(request: Promise<T>): Promise<T> => {
        requestFailure = null;
        request.catch((error) => {
          requestFailure = requestFailure ?? { error };
        });
        return request;
      };
      const waitingOnLock = async (key: string): Promise<boolean> => {
        for (let tries = 0; tries < 250; tries += 1) {
          if (requestFailure) throw (requestFailure as { error: unknown }).error;
          const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`;
          if (rows[0].n > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };
      const waitingOnCutoffLock = (jobId: string): Promise<boolean> => waitingOnLock(cutoffLockKey(jobId));
      /**
       * A lock (the job's cutoff lock, or a call's admission lock) held by a transaction, as another request would hold it while it decides. `ready` settles once the lock is held, or REJECTS when the fixture transaction failed before that (so a test never waits for ever on a
       * lock that was never taken); `release()` lets the transaction go on to `work`; `done` is the transaction itself.
       */
      const holdLock = (key: string, work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) => {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked: () => void = () => undefined;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const done = prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          locked();
          await released;
          await work(tx);
        });
        const ready = Promise.race([
          lockTaken,
          done.then(() => {
            throw new Error('the fixture transaction ended without holding the lock');
          }),
        ]);
        return { ready, release, done };
      };
      const holdCutoffLock = (jobId: string, work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) => holdLock(cutoffLockKey(jobId), work);

      it('the barrier of the lock tests ends at once when the fixture transaction fails before it holds the lock, and its cleanup still runs (it never waits for ever, CodeRabbit)', async () => {
        const { jobId } = await running();
        const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((() => Promise.reject(new Error('the fixture could not start'))) as never);
        let failed: unknown = null;
        try {
          const cutoff = holdCutoffLock(jobId, async () => undefined);
          try {
            await cutoff.ready;
          } catch (error) {
            failed = error;
          } finally {
            cutoff.release();
            await Promise.allSettled([cutoff.done]);
          }
        } finally {
          spy.mockRestore();
        }
        expect(failed).toMatchObject({ message: 'the fixture could not start' });
      });

      it('keeps a confirmed fault of ours for each refused call (a retried call once) and stops the job on the second: ended as pool, given back, never counted, in the words the person is told', async () => {
        const { sara, jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        // The first refused call: kept as a fault of ours, the job still running (a first turn may be one unlucky moment)
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'fault', reason: 'pool_busy', source: 'orbit', turn: null, run: null, providerStatus: 503 }]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // The same call asked again (a retry) is the same call: still one row, still running
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toHaveLength(1);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // A second call refused: every call this job made was refused, so it stops here, as ours
        expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toHaveLength(2);
        // The decision is kept, once, with the end of the keys: the record every later step stands on
        expect(await prisma.computerJobFault.findMany({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toMatchObject([{ kind: 'answered', reason: 'pool_cutoff', source: 'orbit' }]);
        const ended = await jobOf(jobId);
        expect(ended).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false, endNote: POOL_BUSY_WORDS });
        // Given back in full by Orbit's own decision, which counts for nothing against the person's bound
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
        expect((await timeOf(jobId)).personKey).toBe('unknown');
        // Whatever the runner says after it changes nothing (a job that is over is not ended again)
        await finishJob(jobId, 'failed', NOW, 'Three turns failed', 'agent');
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        // What the person reads: the Activity line and the report in chat
        const seen = (await activityFor(sara.id)).find((item) => item.id === `act_job_${jobId}`);
        expect(seen?.outcomeText).toBe('Stopped: our computers were busy, and its time was given back');
        const told = (await reportsToTell(50, minutes(60 * 24))).find((report) => report.jobId === jobId);
        expect(told).toMatchObject({ kind: 'failed', givenBack: true, why: POOL_BUSY_WORDS });
      });

      it('is given back at the goodwill cap too (it uses none of it)', async () => {
        // A bound of nothing: a goodwill give-back would be refused for the cap at once; this one is ours and never asks
        await seedGiveBackLimits({ goodwillPerPersonPerMonth: 0 });
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        await call(token, 'c1', 1_000);
        await call(token, 'c2', 1_000);
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false });
        expect((await timeOf(jobId)).personKey).toBe('unknown');
      });

      it('never stops a job that has had a call authorized (a refusal in the middle of its work is left to the relay and the job’s own renewal), and keeps no row of its own for it', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        expect((await call(token, 'ok-1')).ok).toBe(true);
        await setUp({ poolCeilingMicros: 60_000 });
        for (const id of ['c1', 'c2', 'c3', 'c4']) expect(await call(token, id, 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('counts a call refused because its route is paused (our decision) the same way', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // One person's job had a provider failure on the route in the window: with a bound of one person, new work on it waits
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const paused = (id: string) => authorizeSettled({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route: 'universe-ai/slow' }, NOW);
        expect(await paused('c1')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', route: 'universe-ai/slow' }]);
        expect(await paused('c2')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        expect(await jobOf(other.jobId)).toMatchObject({ status: 'running' });
      });

      it('a refusal for the call’s own SIZE (the room left is smaller than the call asks, the pool not full) is no fault of ours: no row, and never a stop, however many such calls (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // One millionth of room is left: a call of two is refused for its size, and so is the next, and the next
        await setUp({ poolCeilingMicros: 60_001 });
        for (const id of ['s1', 's2', 's3']) expect(await call(token, id, 2)).toEqual({ ok: false, reason: 'pool', full: false });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // A pool with no room even for the smallest call IS ours: kept, and the second stops the job
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await call(token, 'f1', 1)).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await poolRows(jobId)).toHaveLength(1);
      });

      it('a call on the person’s own key that was authorized counts as an authorized call: two platform-funded refusals after it never stop the job (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // Authorized, its report not here yet: it left only the marker
        expect(await authorizeSettled({ token, callId: 'own-1', estimateMicros: 5_000, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
        await setUp({ poolCeilingMicros: 60_000 });
        for (const id of ['c1', 'c2', 'c3']) expect(await call(token, id, 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toEqual([]);
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('Sentry: the refusal that decides the cutoff is ANSWERED while the slow end of the job is still pending (the relay never waits for the cleanup); the job is ended after, as ours', async () => {
        const { jobId } = await running('eve');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool', full: true });
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const hold = atTheEnd((read) => gate.then(read));
        try {
          // The second refusal decides the cutoff, and the end of the job waits at its first write: the answer must still come
          const answer = await Promise.race([authorizeModelCall({ token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW), new Promise<string>((resolve) => setTimeout(() => resolve('waited for the end of the job'), 4_000))]);
          expect(answer).toEqual({ ok: false, reason: 'pool', full: true });
          // The decision stands (keys ended) while the job is not ended yet...
          expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          // ...and when the cleanup goes on it is ended as ours, once
          open();
          await cutoffEndsFinished();
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        } finally {
          open();
          await cutoffEndsFinished();
          hold.mockRestore();
        }
      });

      it('CodeRabbit 12: when the caller says how to run work after its response (the route gives Next’s `after`), the end of the job waits for it: nothing ends the job until that callback runs, and then it ends as ours; if the callback cannot be set up the end is started at once, never lost', async () => {
        const decide = async (name: string) => {
          const { jobId } = await running(name);
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          return { jobId, token };
        };
        await setUp({ poolCeilingMicros: 60_000 });
        const first = await decide('gus');
        expect(await authorizeModelCall({ token: first.token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool', full: true });
        const queued: Array<() => Promise<void>> = [];
        try {
          expect(await authorizeModelCall({ token: first.token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW, (task) => queued.push(task))).toEqual({ ok: false, reason: 'pool', full: true });
          // The decision stands and the end is handed over, not run: the job is still on until the response has gone out
          expect(await prisma.computerJobToken.count({ where: { jobId: first.jobId, revokedAt: null } })).toBe(0);
          expect(queued).toHaveLength(1);
          expect(await jobOf(first.jobId)).toMatchObject({ status: 'running' });
          await queued.shift()!();
          expect(await jobOf(first.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        } finally {
          // CodeRabbit D: a task still queued when an assertion failed is run (each is taken off the queue first, so cleanup never runs one twice), or the next wait for the ends would never finish and time out an unrelated test
          for (let task = queued.shift(); task; task = queued.shift()) await task();
        }
        await cutoffEndsFinished();
        // `after` that cannot be set up (no request to follow): the end is started at once
        const second = await decide('hal');
        expect(await authorizeModelCall({ token: second.token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool', full: true });
        expect(
          await authorizeModelCall({ token: second.token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW, () => {
            throw new Error('no request scope');
          }),
        ).toEqual({ ok: false, reason: 'pool', full: true });
        await cutoffEndsFinished();
        expect(await jobOf(second.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
      });

      /** A transaction that holds a lock taken by `hashtext(name)` (the pool's, a job's relay-reach), as another request would, with a barrier on the lock table (no timer) that says when a session is waiting for it. */
      const holdHashLock = (name: string) => {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked: () => void = () => undefined;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const done = prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
            locked();
            await released;
          },
          { timeout: 15_000, maxWait: 15_000 },
        );
        const ready = Promise.race([
          lockTaken,
          done.then(() => {
            throw new Error('the fixture transaction ended without holding the lock');
          }),
        ]);
        const waiting = async (): Promise<boolean> => {
          for (let tries = 0; tries < 250; tries += 1) {
            if (requestFailure) throw (requestFailure as { error: unknown }).error;
            const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtext(${name})::bigint`;
            if (rows[0].n > 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return false;
        };
        return { ready, release, done, waiting };
      };
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      it('CodeRabbit A: a call on the person’s own key that a decided pool cutoff refuses leaves no own-key marker (the cutoff’s lock is taken, and the decision is read under it, BEFORE the marker is written)', async () => {
        // The race itself: the call has passed its first look at the key and waits for the cutoff's lock while the cutoff decides (records it and ends the keys), then commits
        const { jobId } = await running('ivy');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        const cutoff = holdCutoffLock(jobId, async (tx) => {
          await revokeJobTokens(jobId, NOW, undefined, tx);
          await recordPoolCutoff(tx, jobId, NOW);
        });
        let own: Promise<unknown> = Promise.resolve();
        try {
          await cutoff.ready;
          own = observe(authorizeModelCall({ token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }, NOW));
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          cutoff.release();
          await cutoff.done;
          expect(await own).toEqual({ ok: false, reason: 'refused' });
        } finally {
          cutoff.release();
          await Promise.allSettled([cutoff.done, own]);
        }
        expect(await hasOwnKeyCall(prisma, jobId)).toBe(false);
        // The decision alone refuses it, whatever state the key is in (the check does not lean on the key having been ended)
        const second = await running('jon');
        const alive = (await mintJobToken(second.jobId, 'model', NOW)) as { token: string };
        await recordPoolCutoff(prisma, second.jobId, NOW);
        expect(await prisma.computerJobToken.count({ where: { jobId: second.jobId, revokedAt: null } })).toBe(1);
        expect(await authorizeModelCall({ token: alive.token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }, NOW)).toEqual({ ok: false, reason: 'refused' });
        expect(await hasOwnKeyCall(prisma, second.jobId)).toBe(false);
        // No cutoff decided: authorized, with its marker, as before
        const third = await running('kai');
        const good = (await mintJobToken(third.jobId, 'model', NOW)) as { token: string };
        expect(await authorizeModelCall({ token: good.token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
        expect(await hasOwnKeyCall(prisma, third.jobId)).toBe(true);
      });

      it('CodeRabbit B4 (own key): while the job’s browser is being restored or its sign-ins are unproven (prepState set), a call on the person’s own key is refused and leaves no marker, no admission and no renewal of the hold, as a funded call is', async () => {
        for (const state of ['recover', 'restoring']) {
          const { jobId } = await running(`prep-${state}`);
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: state, stretchStarted: null, ownerLeaseUntil: new Date(NOW.getTime() + 10_000) } });
          expect(await authorizeModelCall({ token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }, NOW)).toEqual({ ok: false, reason: 'refused' });
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(false);
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: { startsWith: 'orbit:admit:' } } })).toBe(0);
          expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 10_000));
          // Once the state is cleared the same call is authorized
          await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: null } });
          expect(await authorizeModelCall({ token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }, NOW)).toMatchObject({ ok: true, reservedMicros: null });
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(true);
        }
      });

      it('CodeRabbit D11 (own key): the hold an own-key call renews runs 90 s from the time read AFTER the waits for the locks, not from the time the request began', async () => {
        const { jobId } = await running('hal');
        const { token } = (await mintJobToken(jobId, 'model')) as { token: string };
        await prisma.computerJob.update({ where: { id: jobId }, data: { ownerLeaseUntil: new Date(Date.now() + 10_000) } });
        const cutoff = holdCutoffLock(jobId, async () => undefined);
        let call: Promise<unknown> = Promise.resolve();
        let waitEnded = Number.NaN;
        try {
          await cutoff.ready;
          call = observe(authorizeModelCall({ token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }));
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          await sleep(400);
          // The wait ends here: the lock is let go, and the time the request reads after it is later than this
          waitEnded = Date.now();
          cutoff.release();
          await cutoff.done;
          expect(await call).toMatchObject({ ok: true, reservedMicros: null });
        } finally {
          cutoff.release();
          await Promise.allSettled([cutoff.done, call]);
        }
        const lease = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerLeaseUntil as Date;
        // 90 s after the wait ended, not 90 s after the request began (which was at least 400 ms earlier)
        expect(waitEnded).not.toBeNaN();
        expect(lease.getTime()).toBeGreaterThanOrEqual(waitEnded + 90_000);
      });

      // The key stays good through the fixture and the request's first look; only once the request is seen waiting at its lock does it run out (after the request began, and before the time it reads after the lock is let go)
      const expireWhileWaiting = async (jobId: string) => {
        await prisma.computerJobToken.updateMany({ where: { jobId }, data: { expiresAt: new Date(Date.now() + 150) } });
        await sleep(300);
      };

      it('CodeRabbit B (own key): the key is looked at again with the time read AFTER the wait for the cutoff’s lock: a key that ran out while the call waited is refused, and no marker is kept', async () => {
        const own = await running('lee');
        const ownKey = (await mintJobToken(own.jobId, 'model')) as { token: string };
        const cutoff = holdCutoffLock(own.jobId, async () => undefined);
        let ownCall: Promise<unknown> = Promise.resolve();
        try {
          await cutoff.ready;
          ownCall = observe(authorizeModelCall({ token: ownKey.token, callId: 'own-1', estimateMicros: 1, payer: 'own-key' }));
          expect(await waitingOnCutoffLock(own.jobId)).toBe(true);
          await expireWhileWaiting(own.jobId);
          cutoff.release();
          await cutoff.done;
          expect(await ownCall).toEqual({ ok: false, reason: 'refused' });
        } finally {
          cutoff.release();
          await Promise.allSettled([cutoff.done, ownCall]);
        }
        expect(await hasOwnKeyCall(prisma, own.jobId)).toBe(false);
      });

      it('CodeRabbit B (funded, no refusal on record): the key ran out while the room waited for the pool’s lock: refused, and the room is not left held', async () => {
        const funded = await running('mia');
        const fundedKey = (await mintJobToken(funded.jobId, 'model')) as { token: string };
        const pool = holdHashLock('meter:pool');
        let fundedCall: Promise<unknown> = Promise.resolve();
        try {
          await pool.ready;
          fundedCall = observe(authorizeModelCall({ token: fundedKey.token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }));
          expect(await pool.waiting()).toBe(true);
          await expireWhileWaiting(funded.jobId);
          pool.release();
          await pool.done;
          expect(await fundedCall).toEqual({ ok: false, reason: 'refused' });
        } finally {
          pool.release();
          await Promise.allSettled([pool.done, fundedCall]);
        }
        expect((await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(funded.jobId, 'c1') } }))?.state ?? 'none').not.toBe('held');
      });

      it('CodeRabbit B (funded, a refusal on record): the key ran out while the call waited for the cutoff’s lock: refused, and the room is not left held', async () => {
        const refused = await running('ned');
        const refusedKey = (await mintJobToken(refused.jobId, 'model')) as { token: string };
        await prisma.computerJobFault.create({ data: { jobId: refused.jobId, turn: null, run: null, callId: 'orbit:pool:c0', kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
        const wait = holdCutoffLock(refused.jobId, async () => undefined);
        let refusedCall: Promise<unknown> = Promise.resolve();
        try {
          await wait.ready;
          refusedCall = observe(authorizeModelCall({ token: refusedKey.token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' }));
          expect(await waitingOnCutoffLock(refused.jobId)).toBe(true);
          await expireWhileWaiting(refused.jobId);
          wait.release();
          await wait.done;
          expect(await refusedCall).toEqual({ ok: false, reason: 'refused' });
        } finally {
          wait.release();
          await Promise.allSettled([wait.done, refusedCall]);
        }
        expect((await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(refused.jobId, 'c1') } }))?.state ?? 'none').not.toBe('held');
      });

      it('CodeRabbit C: a finish for a job with a committed pool cutoff ends it as ours (pool: given back, never counted), whatever the runner says: the end the cutoff owes is not lost to the runner’s own finish', async () => {
        await setUp({ poolCeilingMicros: 60_000 });
        for (const [name, outcome, cause] of [['oli', 'done', undefined], ['pat', 'failed', 'agent'], ['quin', 'failed', 'ours']] as const) {
          const { jobId } = await running(name);
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
          // The second refusal decides it; the end is handed over, and has NOT run when the runner's finish arrives
          const queued: Array<() => Promise<void>> = [];
          expect(await authorizeModelCall({ token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW, (task) => queued.push(task))).toMatchObject({ ok: false, reason: 'pool' });
          try {
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(1);
            expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
            await finishJob(jobId, outcome, NOW, outcome === 'failed' ? 'Three turns failed' : null, cause);
          } finally {
            for (let task = queued.shift(); task; task = queued.shift()) await task();
          }
          await cutoffEndsFinished();
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false, endNote: POOL_BUSY_WORDS });
          expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
          expect((await timeOf(jobId)).personKey).toBe('unknown');
        }
      });

      it('CodeRabbit C: a cutoff that commits between the finish’s look and its write wins: the finish writes its ending under the cutoff lock, reads the decision under it, and ends the job as pool', async () => {
        const { jobId } = await running('rae');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // The finish found nothing decided; the cutoff commits (its record and the end of the keys) while the finish waits for the lock
        const cutoff = holdCutoffLock(jobId, async (tx) => {
          await revokeJobTokens(jobId, NOW, undefined, tx);
          await recordPoolCutoff(tx, jobId, NOW);
        });
        let finishing: Promise<unknown> = Promise.resolve();
        try {
          await cutoff.ready;
          finishing = observe(finishJob(jobId, 'done', NOW));
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          cutoff.release();
          await cutoff.done;
          await finishing;
        } finally {
          cutoff.release();
          await Promise.allSettled([cutoff.done, finishing]);
        }
        expect(token).toBeTruthy();
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', endNote: POOL_BUSY_WORDS });
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
        // And the other way round: a finish that wrote its ending first stands, and a cutoff that comes after decides nothing for a job that is over
        const done = await running('sid');
        const key = (await mintJobToken(done.jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await authorizeModelCall({ token: key.token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
        await finishJob(done.jobId, 'done', NOW);
        expect(await authorizeModelCall({ token: key.token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'refused' });
        expect(await prisma.computerJobFault.count({ where: { jobId: done.jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
        expect(await jobOf(done.jobId)).toMatchObject({ status: 'done' });
      });

      it.each([
        ['agent'],
        ['ours'],
      ] as const)('CodeRabbit C (Opus): a cutoff that commits between a FAILED finish’s look and its write wins on the judged branch too (runner hint %s): the job ends as stopped/pool with Orbit’s own orbit_fault decision, never charged and never judged by the runner’s word', async (cause) => {
        const { jobId } = await running(`jud-${cause}`);
        // The finish found nothing decided; the cutoff commits (its record and the end of the keys) while the finish waits for the cutoff's lock in the transaction that decides and writes its ending
        const cutoff = holdCutoffLock(jobId, async (tx) => {
          await revokeJobTokens(jobId, NOW, undefined, tx);
          await recordPoolCutoff(tx, jobId, NOW);
        });
        let finishing: Promise<unknown> = Promise.resolve();
        try {
          await cutoff.ready;
          finishing = observe(finishJob(jobId, 'failed', NOW, 'Three turns failed', cause));
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          cutoff.release();
          await cutoff.done;
          await finishing;
        } finally {
          cutoff.release();
          await Promise.allSettled([cutoff.done, finishing]);
        }
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false, endNote: POOL_BUSY_WORDS });
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
        expect((await timeOf(jobId)).personKey).toBe('unknown');
      });

      it('CodeRabbit C: a cutoff that was waiting for its lock while the job ended decides nothing for it: the ending that came first stands, and no decision is kept for a job that is over', async () => {
        const { jobId } = await running('tom');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool' });
        // The second refusal would decide it, and waits for the lock; the job is over (a finish took the lock first) by the time it has it
        const finish = holdCutoffLock(jobId, async (tx) => {
          await tx.computerJob.update({ where: { id: jobId }, data: { status: 'done', endedAt: NOW } });
        });
        let second: Promise<unknown> = Promise.resolve();
        try {
          await finish.ready;
          second = observe(authorizeModelCall({ token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW));
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          finish.release();
          await finish.done;
          expect(await second).toMatchObject({ ok: false, reason: 'pool', full: true });
        } finally {
          finish.release();
          await Promise.allSettled([finish.done, second]);
        }
        await cutoffEndsFinished();
        expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
        expect(await jobOf(jobId)).toMatchObject({ status: 'done' });
      });

      it('Sentry: when the end that follows the answer fails, Sentry is still told once (pool_cutoff_end) and the answer was the same', async () => {
        const { jobId } = await running('fay');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await authorizeModelCall({ token, callId: 'c1', estimateMicros: 1_000, payer: 'universe' }, NOW)).toMatchObject({ ok: false, reason: 'pool', full: true });
        (Sentry.captureMessage as jest.Mock).mockClear();
        const hold = atTheEnd(() => Promise.reject(new Error('the database went away')));
        try {
          expect(await authorizeModelCall({ token, callId: 'c2', estimateMicros: 1_000, payer: 'universe' }, NOW)).toEqual({ ok: false, reason: 'pool', full: true });
          await cutoffEndsFinished();
        } finally {
          hold.mockRestore();
        }
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect((Sentry.captureMessage as jest.Mock).mock.calls[0][1]).toMatchObject({ level: 'error', tags: { area: 'computer', step: 'pool_cutoff_end' }, extra: { jobId } });
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
      });

      it('a call that comes in while the job is still being ended by a cutoff is refused at once: the keys ended with the decision, not with the slow end of the job (CodeRabbit)', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // The route `slow` is paused for new work (our decision); `fast` has room
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const on = (route: string, id: string) => authorizeModelCall({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route }, NOW);
        expect(await on('universe-ai/slow', 'c1')).toEqual({ ok: false, reason: 'pool', full: true });
        // The second refusal is the cutoff; its slow end is held at the first write it makes to the job
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const hold = atTheEnd((read) => gate.then(read));
        let cutoff: Promise<unknown> = Promise.resolve();
        try {
          cutoff = on('universe-ai/slow', 'c2');
          for (let tries = 0; tries < 100 && !(await prisma.computerJobToken.count({ where: { jobId, revokedAt: { not: null } } })); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
          // The decision is durable (the keys ended) while the job is not ended yet: a call on the route with room is refused, nothing held
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          expect(await on('universe-ai/fast', 'c3')).toEqual({ ok: false, reason: 'refused' });
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c3') } })).toBeNull();
          open();
          expect(await cutoff).toEqual({ ok: false, reason: 'pool', full: true });
          await cutoffEndsFinished();
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        } finally {
          // Always: the gate is opened, the started work is joined and the spy is put back, even when an assertion above failed (and a failure here never hides that one)
          open();
          await Promise.allSettled([cutoff]);
          hold.mockRestore();
        }
      });

      it('the cutoff holds its lock for database steps only: not one provider call is made, and no other transaction is needed, while the job’s lock is held (Sentry)', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        // Every call the provider gets asks, from another connection, whether the job's cutoff lock is free (a lock held by a transaction answers false)
        const asked: boolean[] = [];
        const fake = new FakeComputerProvider();
        const watching = new Proxy(fake, {
          get: (target, name, receiver) => {
            const value = Reflect.get(target, name, receiver);
            if (typeof value !== 'function' || !['rest', 'wake', 'stop', 'exec', 'saveFiles', 'cancelTurn', 'ready', 'watch', 'awake'].includes(String(name))) return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              const free = await prisma.$queryRaw<{ free: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0)) AS free`;
              asked.push(free[0].free);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        setComputerProviderForTests(watching);
        const on = (id: string) => authorizeSettled({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route: 'universe-ai/slow' }, NOW);
        expect(await on('c1')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await on('c2')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        // The job's end did reach the provider, and the lock was free every time
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.every(Boolean)).toBe(true);
        setComputerProviderForTests(new FakeComputerProvider());
      });

      it('an authorization that finds the cutoff deciding waits for its lock, then finds its key ended: the call is refused and its room goes back (the lock held by the decision, ended by it)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        // A pool refusal of ours is kept for the job, as a first refusal leaves it
        await prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: 'orbit:pool:c0', kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
        // The cutoff, as another request runs it: its lock taken, its count made, its keys not ended yet
        const cutoff = holdCutoffLock(jobId, (tx) => tx.computerJobToken.updateMany({ where: { jobId, revokedAt: null }, data: { revokedAt: NOW } }));
        let authorization: Promise<unknown> = Promise.resolve();
        try {
          await cutoff.ready;
          let answered = false;
          authorization = call(token, 'c1').then((answer) => {
            answered = true;
            return answer;
          });
          // The call's room is taken at once (the pool is not what waits)...
          for (let tries = 0; tries < 100 && !(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c1') } })); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toMatchObject({ state: 'held' });
          // ...and the authorization is then really waiting on THIS job's lock (a barrier on the lock itself, not a delay): the answer waits for the decision
          expect(await waitingOnCutoffLock(jobId)).toBe(true);
          expect(answered).toBe(false);
          cutoff.release();
          await cutoff.done;
          expect(await authorization).toEqual({ ok: false, reason: 'refused' });
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toMatchObject({ state: 'released' });
        } finally {
          // Always: the decision is let go, and everything that was started is joined, even when the fixture or an assertion above failed
          cutoff.release();
          await Promise.allSettled([cutoff.done, authorization]);
        }
      });

      describe('a cutoff that was decided but could not end the job (Opus: the job would run on with dead keys)', () => {
        const poolRefusal = (jobId: string, callId: string, at: Date = NOW) => prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: `orbit:pool:${callId}`, kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at } });

        it('the sweep ends it as ours, once: time given back and never counted, and Sentry is told when the end failed (a second sweep changes nothing)', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          // The second refusal decides the cutoff (the keys end), and the end of the job fails once, at its first write
          (Sentry.captureMessage as jest.Mock).mockClear();
          const hold = atTheEnd(() => Promise.reject(new Error('the database went away')));
          expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          hold.mockRestore();
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
          expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
          expect((Sentry.captureMessage as jest.Mock).mock.calls[0][1]).toMatchObject({ level: 'error', tags: { area: 'computer', step: 'pool_cutoff_end' }, extra: { jobId } });
          // Not at once: the request that decided it is left its moment to end the job itself
          await sweepComputers(minutes(1));
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          // The sweep after that ends it as ours
          await sweepComputers(minutes(5));
          const ended = await jobOf(jobId);
          expect(ended).toMatchObject({ status: 'stopped', endedBy: 'pool', runnerFault: false, endNote: POOL_BUSY_WORDS });
          expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
          expect((await timeOf(jobId)).personKey).toBe('unknown');
          // Said twice it changes nothing
          const events = await prisma.meterEvent.count({ where: { jobId } });
          expect(await endStuckCutoffs(minutes(6), 50)).toBe(0);
          await sweepComputers(minutes(6));
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', endedAt: ended.endedAt });
          expect(await prisma.meterEvent.count({ where: { jobId } })).toBe(events);
          expect(await prisma.computerGiveBackDecision.count({ where: { jobId } })).toBe(1);
        });

        it('stands on the decision that was kept and on nothing else: refusals with no decision, a decision still within its moment and a job that is over are left alone', async () => {
          // Two refusals kept, however they came, but no decision: not a cutoff (the sweep never infers one from rows)
          const undecided = await running('una');
          await poolRefusal(undecided.jobId, 'a');
          await poolRefusal(undecided.jobId, 'b');
          // Decided a minute ago: the request that decided it is left its moment to end the job itself
          const fresh = await running('fay');
          await recordPoolCutoff(prisma, fresh.jobId, minutes(4));
          // Decided, and the job is over already (it ended first: a finish after a decision ends as pool, and a cutoff decides nothing for a job that is over, so the record is written after the end here)
          const over = await running('ovo');
          await finishJob(over.jobId, 'done', NOW);
          await recordPoolCutoff(prisma, over.jobId, NOW);
          expect(await endStuckCutoffs(minutes(5), 50)).toBe(0);
          for (const id of [undecided.jobId, fresh.jobId]) expect(await jobOf(id)).toMatchObject({ status: 'running' });
          expect(await jobOf(over.jobId)).toMatchObject({ status: 'done' });
        });

        it('is ended from the decision whatever else the job holds: a key made after it, a call marker, a reservation never hold the sweep back (CodeRabbit)', async () => {
          const { jobId } = await running();
          const job = await jobOf(jobId);
          await recordPoolCutoff(prisma, jobId, NOW);
          // A live key (however it came to be), the marker of a call on the person's own key, and a room held for a call: none of it is a reason to leave a decided job running
          await prisma.computerJobToken.create({ data: { jobId, scope: 'model', generation: job.controlGeneration, digest: `d-${randomUUID()}`, expiresAt: minutes(60) } });
          await recordOwnKeyCall(prisma, jobId, NOW);
          await prisma.meterReservation.create({ data: { reservationKey: callRoomKey(jobId, 'held'), personKey: `person:${job.personId}`, personId: job.personId, jobId, amountMicros: 5_000, state: 'held', expiresAt: minutes(60), createdAt: NOW } });
          expect(await endStuckCutoffs(minutes(5), 50)).toBe(1);
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });

        it('reads who is decided BEFORE it cuts the batch: jobs that are not one never use up its places (CodeRabbit)', async () => {
          // Three older jobs with a refusal each (the shape of one that is nearly a cutoff), and a newer job whose cutoff was decided
          for (const name of ['o1', 'o2', 'o3']) await poolRefusal((await running(name)).jobId, 'a');
          const decided = await running('dec');
          await recordPoolCutoff(prisma, decided.jobId, NOW);
          expect(await endStuckCutoffs(minutes(5), 1)).toBe(1);
          expect(await jobOf(decided.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });

        it('a job waiting past its time for its person that Orbit already decided to end for its own capacity is ended as ours, not as unanswered, even inside the cutoff’s moment (CodeRabbit)', async () => {
          const { jobId } = await running();
          await requestHandover(jobId, 'details', minutes(1));
          // Decided a minute before the sweep: still inside the moment the sweep for stuck cutoffs leaves to the request that decided it
          await recordPoolCutoff(prisma, jobId, minutes(61));
          await sweepComputers(minutes(62));
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool', endNote: POOL_BUSY_WORDS });
          expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'given', basis: 'orbit_fault', reason: 'pool_cut_off' });
        });

        it('a job waiting past its time with no decision on record still ends as unanswered', async () => {
          const { jobId } = await running();
          await requestHandover(jobId, 'details', minutes(1));
          await sweepComputers(minutes(62));
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
        });
      });

      describe('the cutoff and the calls around it (CodeRabbit review of 2d69e8bc)', () => {
        /** A transaction whose write of the decision fails, as a database that went away at that moment would. */
        const decisionFails = (tx: Record<string, unknown>) =>
          new Proxy(tx, {
            get: (target, name) => {
              const value = (target as Record<string | symbol, unknown>)[name];
              if (name !== 'computerJobFault') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
              const model = value as Record<string, unknown>;
              return new Proxy(model, {
                get: (m, key) => {
                  if (key === 'createMany') return (args: { data?: { callId?: string }[] }) => (args.data?.[0]?.callId === POOL_CUTOFF_CALL ? Promise.reject(new Error('the database went away')) : (m.createMany as (a: unknown) => unknown)(args));
                  const fn = m[key as string];
                  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(m) : fn;
                },
              });
            },
          });

        it('the decision is made in the very transaction that ends the keys: when it cannot be kept, nothing of it stands (the keys stay good, the second refusal is not counted)', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: { maxWait?: number }) => Promise<unknown>;
          const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Record<string, unknown>) => unknown, options?: { maxWait?: number }) => (options?.maxWait === 15_000 ? real((tx: Record<string, unknown>) => fn(decisionFails(tx)), options) : real(fn, options))) as never);
          try {
            expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          } finally {
            spy.mockRestore();
          }
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          // Not one part of the decision stands: the key is good, no decision is kept, and the refusal of this call is not counted
          expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(1);
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
          expect(await poolRows(jobId)).toHaveLength(1);
          // Asked again it decides, all at once
          expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(1);
        });

        it('a call on the person’s own key is not authorized unless its marker is kept: a marker that could not be written is a refusal, and asked again it is authorized', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          const own = () => authorizeSettled({ token, callId: 'own-1', estimateMicros: 5_000, payer: 'own-key' }, NOW);
          // The marker is kept in a transaction of its own (under the lock a finish takes): that transaction fails once
          const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('the database went away') as never);
          let refused: unknown;
          try {
            refused = await own();
          } finally {
            spy.mockRestore();
          }
          expect(refused).toEqual({ ok: false, reason: 'refused' });
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(false);
          expect((await own()).ok).toBe(true);
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(true);
        });

        it('a wait for the cutoff’s lock that fails is a failed check: the call is refused and the room it took goes back, never a call authorized past a cutoff that may have won', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: 'orbit:pool:c0', kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
          const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: { maxWait?: number }) => Promise<unknown>;
          // Only the FIRST lock wait fails (the cutoff's); the step that gives the room back is a transaction of its own and goes through
          let failed = false;
          const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: { maxWait?: number }) => {
            if (options?.maxWait === 15_000 && !failed) {
              failed = true;
              return Promise.reject(new Error('could not wait for the lock'));
            }
            return real(fn, options);
          }) as never);
          let answer: unknown;
          try {
            answer = await call(token, 'c1');
          } finally {
            spy.mockRestore();
          }
          expect(answer).toEqual({ ok: false, reason: 'refused' });
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toMatchObject({ state: 'released' });
        });

        it('a look at the cutoff that is REJECTED is cleaned up like a no: the room this request took goes back, and the room a replay already held stays', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          // A new call: its look at the cutoff is rejected (the database did not answer)
          let spy = lookFails();
          let answer: unknown;
          try {
            answer = await call(token, 'c1');
          } finally {
            spy.mockRestore();
          }
          expect(answer).toEqual({ ok: false, reason: 'refused' });
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toMatchObject({ state: 'released' });
          // A call that holds its room is asked again, and the look is rejected: the first request's hold is left to it
          expect((await call(token, 'c2')).ok).toBe(true);
          spy = lookFails();
          try {
            answer = await call(token, 'c2');
          } finally {
            spy.mockRestore();
          }
          expect(answer).toEqual({ ok: false, reason: 'refused' });
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c2') } })).toMatchObject({ state: 'held' });
        });

        describe('a request that took a call’s room and a request that asked again for the same call (CodeRabbit)', () => {
          const roomOf = (jobId: string, callId: string) => prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, callId) } });
          /** The creator's look at the cutoff is held where the test says, and then fails: the first look at the job's refusals of ours is the creator's (the replay is asked after it has taken its room). */
          /** Waits for the creator to reach its look, or fails with the first request's own answer when it ended without reaching it (so a test never waits for ever and its cleanup runs). */
          const creatorAtLook = (gate: { atLook: Promise<void> }, first: Promise<unknown>) =>
            Promise.race([
              gate.atLook,
              first.then(
                (answer) => Promise.reject(new Error(`the first request ended before its look at the cutoff: ${JSON.stringify(answer)}`)),
                (error) => Promise.reject(error),
              ),
            ]);
          const holdCreatorsLook = () => {
            let reached: () => void = () => undefined;
            const atLook = new Promise<void>((resolve) => {
              reached = resolve;
            });
            let go: (fails: boolean) => void = () => undefined;
            const goOn = new Promise<boolean>((resolve) => {
              go = resolve;
            });
            const spy = atNextLook(() => {
              reached();
              return goOn.then((fails) => (fails ? Promise.reject(new Error('the database went away')) : undefined));
            });
            return { atLook, go, spy };
          };

          it('the room the first request took stays held for a call another request was authorized for, even when the first request then finds the call does not stand: no authorized call is left without its room, and the call settles', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            const gate = holdCreatorsLook();
            let first: Promise<unknown> = Promise.resolve();
            try {
              first = call(token, 'c1');
              await creatorAtLook(gate, first);
              // The room is the first request's, and it is deciding. The same call is asked again and is authorized
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
              const again = await call(token, 'c1');
              expect(again.ok).toBe(true);
              // Now the first request's look fails: it answers refused, but the room belongs to the call that was authorized
              gate.go(true);
              expect(await first).toEqual({ ok: false, reason: 'refused' });
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
              // The authorized call runs and settles against the room it was given, once
              expect(await settleModelCall(jobId, 'c1', { costMicros: 3_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: true });
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'settled' });
            } finally {
              gate.go(true);
              gate.spy.mockRestore();
              await Promise.allSettled([first]);
            }
          });

          it('a room nobody used is still given back: the first request finds the call does not stand and no other request was answered with it', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            const gate = holdCreatorsLook();
            let first: Promise<unknown> = Promise.resolve();
            try {
              first = call(token, 'c1');
              await creatorAtLook(gate, first);
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
              gate.go(true);
              expect(await first).toEqual({ ok: false, reason: 'refused' });
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'released' });
            } finally {
              gate.go(true);
              gate.spy.mockRestore();
              await Promise.allSettled([first]);
            }
          });

          it('a request that asks again for a call whose room was given back meanwhile is not authorized: its answer is kept only while the room is still held', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            expect((await call(token, 'c1')).ok).toBe(true);
            // The room is given back between the asking-again request's reserve and its admission (its own look at the cutoff is where the first request's give-back lands)
            const spy = atNextLook(() => releaseModelCall(jobId, 'c1', NOW).then(() => undefined));
            let answer: unknown;
            try {
              answer = await call(token, 'c1');
            } finally {
              spy.mockRestore();
            }
            expect(answer).toEqual({ ok: false, reason: 'refused' });
            expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'released' });
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1); // the first request's own admission only: the refused replay adds none
          });

          it('CodeRabbit on #1025 (24): a replay whose room is gone is refused before anything is written: no admission, no stretch stamp, no renewal of the owner’s hold', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            expect((await call(token, 'c1')).ok).toBe(true);
            const heldUntil = new Date(NOW.getTime() + 10_000);
            await prisma.computerJob.update({ where: { id: jobId }, data: { ownerLeaseUntil: heldUntil } });
            // The first request's admission is forgotten and its room has run out, as it would have by the time the replay gets the lock
            await prisma.computerJobFault.deleteMany({ where: { jobId, callId: { startsWith: 'orbit:admit:' } } });
            await prisma.meterReservation.update({ where: { reservationKey: callRoomKey(jobId, 'c1') }, data: { expiresAt: new Date(NOW.getTime() - 1_000), jobStretch: null } });
            expect(await call(token, 'c1')).toEqual({ ok: false, reason: 'refused' });
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: { startsWith: 'orbit:admit:' } } })).toBe(0);
            expect((await roomOf(jobId, 'c1'))?.jobStretch).toBeNull();
            expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerLeaseUntil).toEqual(heldUntil);
          });

          it('CodeRabbit on #1025 (24): a replay whose room still stands is admitted once and keeps the first admission’s stretch number', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            expect((await call(token, 'c1')).ok).toBe(true);
            const stretch = (await roomOf(jobId, 'c1'))?.jobStretch;
            expect(typeof stretch).toBe('number');
            // The job's current stretch moves on (the token and the held room are as they were): a replay that wrote the stretch again would write this one
            await prisma.computerJob.update({ where: { id: jobId }, data: { pauses: (stretch as number) + 1, ownerLeaseUntil: new Date(NOW.getTime() + 10_000) } });
            expect((await call(token, 'c1')).ok).toBe(true);
            expect((await roomOf(jobId, 'c1'))?.jobStretch).toBe(stretch);
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1);
            expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).ownerLeaseUntil).toEqual(new Date(NOW.getTime() + 90_000));
          });

          it('a request that asks again and waits for the call’s lock while the person takes the machine is refused: its key was checked before the wait, and the room is left as it was (CodeRabbit)', async () => {
            const { sara, jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            expect((await call(token, 'c1')).ok).toBe(true);
            // Another request holds the call's lock (admitting, or giving the room back)
            const lock = holdLock(admitLockKey(jobId, 'c1'), async () => undefined);
            let again: Promise<unknown> = Promise.resolve();
            try {
              await lock.ready;
              again = observe(call(token, 'c1'));
              expect(await waitingOnLock(admitLockKey(jobId, 'c1'))).toBe(true);
              // While it waits, the person takes the machine: the control generation moves and the key ends. The room is still held
              await takeOver(sara.brickId, sara.id, NOW);
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
              lock.release();
              await lock.done;
              expect(await again).toEqual({ ok: false, reason: 'refused' });
              // Nothing was kept for it, and the room is as the first request left it
              expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1); // the first request's own admission only: the refused replay adds none
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
            } finally {
              lock.release();
              await Promise.allSettled([lock.done, again]);
            }
          });

          it('a request that asks again for a call whose room runs out while it waits for the lock is not authorized: the time is read after the wait, not before it (CodeRabbit)', async () => {
            const { jobId } = await running();
            // The real clock (nothing fixed): the key is made now, and the room is good for an hour
            const { token } = (await mintJobToken(jobId, 'model')) as { token: string };
            const ask = () => authorizeSettled({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' });
            expect((await ask()).ok).toBe(true);
            const lock = holdLock(admitLockKey(jobId, 'c1'), async () => undefined);
            let again: Promise<unknown> = Promise.resolve();
            try {
              await lock.ready;
              again = observe(ask());
              // It started while the room was good, and is now really waiting for the lock (had it been refused at once it would never wait)
              expect(await waitingOnLock(admitLockKey(jobId, 'c1'))).toBe(true);
              // Only now does the room run out: at a moment after the request began and before the lock is let go
              await prisma.meterReservation.update({ where: { reservationKey: callRoomKey(jobId, 'c1') }, data: { expiresAt: new Date() } });
              lock.release();
              await lock.done;
              expect(await again).toEqual({ ok: false, reason: 'refused' });
              expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1); // the first request's own admission only: the refused replay adds none
            } finally {
              lock.release();
              await Promise.allSettled([lock.done, again]);
            }
          });

          it('a room that runs out while the key is being looked at under the lock is not admitted: the time is read again after that look (CodeRabbit)', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model')) as { token: string };
            const ask = () => authorizeSettled({ token, callId: 'c1', estimateMicros: 5_000, payer: 'universe' });
            expect((await ask()).ok).toBe(true);
            // The room runs out while the replay is looking at the key under the call's lock (its own transaction's look is where that is made to happen)
            const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => Promise<unknown>;
            let looks = 0;
            const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => {
              if (options?.maxWait !== 15_000) return real(fn, options);
              return real((tx) =>
                fn(
                  new Proxy(tx as object, {
                    get(target, property, receiver) {
                      if (property !== 'computerJobToken') return Reflect.get(target, property, receiver);
                      return {
                        findUnique: async (args: never) => {
                          const row = await (target as { computerJobToken: { findUnique: (a: never) => Promise<unknown> } }).computerJobToken.findUnique(args);
                          looks += 1;
                          // The one look is the admission's, under the cutoff lock and the call's lock: the room runs out right after it, and the time read after it finds the room gone
                          if (looks === 1) await prisma.meterReservation.update({ where: { reservationKey: callRoomKey(jobId, 'c1') }, data: { expiresAt: new Date() } });
                          return row;
                        },
                      };
                    },
                  }),
                ),
              options);
            }) as never);
            let answer: unknown;
            try {
              answer = await ask();
            } finally {
              spy.mockRestore();
            }
            // Two looks under the lock: the admission's, and the token looked at again once the pool lock is held (CodeRabbit O36); the room ran out after the first, and the refusal comes from the room check that follows
            expect(looks).toBe(2);
            expect(answer).toEqual({ ok: false, reason: 'refused' });
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1); // the first request's own admission only: the refused replay adds none
          });

          it('a request that asks again reads the key only through the pool outside its transaction: under the call’s lock every read is the transaction’s, so requests waiting for a second connection never wait for each other (CodeRabbit)', async () => {
            const { jobId } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            expect((await call(token, 'c1')).ok).toBe(true);
            const pooled = jest.spyOn(prisma.computerJobToken, 'findUnique');
            const brick = jest.spyOn(prisma.brickComputer, 'findUnique');
            try {
              expect((await call(token, 'c1')).ok).toBe(true);
              // Through the pool: only the check on entry. The two that follow (the admission's final check under the cutoff lock, and the one under the call's lock) are each the transaction's own
              expect(pooled).toHaveBeenCalledTimes(1);
              expect(brick).toHaveBeenCalledTimes(1);
            } finally {
              pooled.mockRestore();
              brick.mockRestore();
            }
            // And the replay was admitted all the same, with its marker
            expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1);
          });

          describe('giving a room back when the look for a request admitted meanwhile fails (CodeRabbit)', () => {
            /**
             * A refusal at the cutoff (its lock wait fails, the first of the 15 s transactions), then the releases of its room. `inside(n, tx)` is called with the number of the release and the release's own transaction: for the first
             * release the look for a marker (`computerJobFault.count`) is made to fail INSIDE the transaction, after the admission lock was taken, so the whole transaction is rolled back and the retry is what releases the room.
             */
            const refusedThenReleases = async (beforeFailing?: (jobId: string) => Promise<void>) => {
              const { jobId } = await running();
              const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
              await prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: 'orbit:pool:c0', kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
              const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => Promise<unknown>;
              let waits = 0;
              let lockTakenBeforeFailing = false;
              const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => {
                if (options?.maxWait !== 15_000) return real(fn, options);
                waits += 1;
                if (waits === 1) return Promise.reject(new Error('could not wait for the lock'));
                if (waits > 2) return real(fn, options);
                // The first release: its look for the marker fails inside the transaction
                return real((tx) => {
                  let locked = false;
                  const failing = new Proxy(tx as object, {
                    get(target, property, receiver) {
                      if (property === '$executeRaw') return (...args: unknown[]) => { locked = true; return (target as { $executeRaw: (...a: unknown[]) => unknown }).$executeRaw(...args); };
                      if (property === 'computerJobFault') {
                        return {
                          ...(target as { computerJobFault: object }).computerJobFault,
                          count: async () => {
                            lockTakenBeforeFailing = locked;
                            await beforeFailing?.(jobId);
                            throw new Error('the database went away');
                          },
                        };
                      }
                      return Reflect.get(target, property, receiver);
                    },
                  });
                  return fn(failing);
                }, options);
              }) as never);
              let answer: unknown;
              try {
                answer = await call(token, 'c1');
              } finally {
                spy.mockRestore();
              }
              return { jobId, answer, releases: waits - 1, lockTakenBeforeFailing };
            };

            it('a look that fails INSIDE the release is tried again: the room of a refused call is released, never left counted against the pool until it lapses', async () => {
              const { jobId, answer, releases, lockTakenBeforeFailing } = await refusedThenReleases();
              expect(answer).toEqual({ ok: false, reason: 'refused' });
              // The first release had taken the admission lock when its look failed (the whole transaction was undone), and the second one released the room
              expect(lockTakenBeforeFailing).toBe(true);
              expect(releases).toBe(2);
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'released' });
            });

            it('the marker is looked for again on every attempt: a request admitted between the attempts keeps the room', async () => {
              const { jobId, answer, releases } = await refusedThenReleases(async (job) => {
                // A replay is answered with the call's authorization before the failed release ends
                await recordCallAdmission(prisma, job, 'c1', NOW);
              });
              expect(answer).toEqual({ ok: false, reason: 'refused' });
              expect(releases).toBe(2);
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'held' });
            });
          });

          it('the pool’s accounting is whole after the two requests: one room held for the call, counted once, and given back once it settles', async () => {
            const { jobId, sara } = await running();
            const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
            // What the job already holds before the call (its own first stretch): the call's room is counted on top of it, once
            const baseline = await heldRoom(sara.id, NOW);
            const gate = holdCreatorsLook();
            let first: Promise<unknown> = Promise.resolve();
            try {
              first = call(token, 'c1', 7_000);
              await creatorAtLook(gate, first);
              expect((await call(token, 'c1', 7_000)).ok).toBe(true);
              gate.go(true);
              await first;
              expect(await prisma.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') } } })).toBe(1);
              expect(Number((await roomOf(jobId, 'c1'))!.amountMicros)).toBe(7_000);
              expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:c1' } })).toBe(1);
              // The room is counted once: exactly the call's own room more than before the request, and none of it left once the call settled
              expect((await heldRoom(sara.id, NOW)) - baseline).toBe(7_000);
              await settleModelCall(jobId, 'c1', { costMicros: 3_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
              expect(await roomOf(jobId, 'c1')).toMatchObject({ state: 'settled' });
              expect((await heldRoom(sara.id, NOW)) - baseline).toBe(0);
            } finally {
              gate.go(true);
              gate.spy.mockRestore();
              await Promise.allSettled([first]);
            }
          });
        });

        it('a room that was given back is not a call that was authorized: a job whose first call was rejected after it took its room is still stopped as ours once every call it makes is refused for the pool (CodeRabbit)', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          // Its first call takes a room, then the look at the cutoff is rejected: the call is refused and the room goes back (a `released` row stays)
          const spy = lookFails();
          try {
            expect(await call(token, 'c0')).toEqual({ ok: false, reason: 'refused' });
          } finally {
            spy.mockRestore();
          }
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c0') } })).toMatchObject({ state: 'released' });
          // Then the pool has no room for any call: two calls refused, and the job is stopped, as ours, as it would be had the first call never been made
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });

        it('a refusal that a later authorized call recovered does not count toward the cutoff: refuse, recover, give the room back, then ONE new refusal leaves the job running; two live refusals still end it (Sentry)', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          // One refusal for our capacity
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          // Capacity returns and a call is authorized: the refusal is retired. Its room is then given back with no priced call, so the job has no authorized call on record
          await setUp({ poolCeilingMicros: 100_000_000 });
          expect((await call(token, 'c2')).ok).toBe(true);
          expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'answered', reason: 'pool_recovered' }]);
          await releaseModelCall(jobId, 'c2', NOW);
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c2') } })).toMatchObject({ state: 'released' });
          // ONE new refusal: one live refusal only, so no cutoff (the retired row is not counted)
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c3', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:pool:c3', kind: 'fault' } })).toBe(1);
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          expect(await recordPoolRefusal(prisma, jobId, 'c3')).toBe(1);
          // The second live refusal still ends it, as before
          expect(await call(token, 'c4', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          await cutoffEndsFinished();
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });

        it('N13 (d522f4b3 pass): the retirement of recovered pool refusals commits WITH the admission: when it cannot be written the call is refused (never admitted with the refusal still a fault), its room goes back, and a NEW call id is admitted and retires it', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          await setUp({ poolCeilingMicros: 100_000_000 });
          // A database that refuses to retire the refusal (a real write failure, not a mock of the function)
          await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION n13_fail_retire() RETURNS trigger AS $$ BEGIN IF NEW."reason" = 'pool_recovered' THEN RAISE EXCEPTION 'n13 planted failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
          await prisma.$executeRawUnsafe('CREATE TRIGGER n13_fail_retire BEFORE UPDATE ON "computer_job_faults" FOR EACH ROW EXECUTE FUNCTION n13_fail_retire()');
          try {
            expect(await call(token, 'c2')).toEqual({ ok: false, reason: 'refused' });
          } finally {
            await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS n13_fail_retire ON "computer_job_faults"');
            await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS n13_fail_retire()');
          }
          // Not admitted, the refusal still counts, the room went back
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:pool:c1', kind: 'fault' } })).toBe(1);
          expect(await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, 'c2') } })).toMatchObject({ state: 'released' });
          // Asked again with the database working: admitted, and the refusal is retired in the same step
          expect((await call(token, 'c3')).ok).toBe(true);
          expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'answered', reason: 'pool_recovered' }]);
        });

        it('recordPoolRefusal answers how many refusals still count: a retired one is not among them', async () => {
          const { jobId } = await running();
          await prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: 'orbit:pool:old', kind: 'answered', reason: 'pool_recovered', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
          expect(await recordPoolRefusal(prisma, jobId, 'c1')).toBe(1);
          expect(await recordPoolRefusal(prisma, jobId, 'c1')).toBe(1);
          expect(await recordPoolRefusal(prisma, jobId, 'c2')).toBe(2);
        });

        it('controls that were never set up are OUR misconfiguration: answered as ours (the pool, full), told to Sentry once, and never a capacity refusal: no marker is kept and it never counts toward a cutoff', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
          for (const id of ['c1', 'c2', 'c3']) expect(await call(token, id)).toEqual({ ok: false, reason: 'pool', full: true });
          expect(await poolRows(jobId)).toEqual([]);
          expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          // Said to Sentry once for all three calls (the controls are named), and again only after its wait
          expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
          expect((Sentry.captureMessage as jest.Mock).mock.calls[0][1]).toMatchObject({ level: 'error', tags: { area: 'computer', step: 'meter_not_set' } });
          const later = (await mintJobToken(jobId, 'model', minutes(20))) as { token: string };
          expect(await authorizeSettled({ token: later.token, callId: 'c4', estimateMicros: 5_000, payer: 'universe' }, minutes(20))).toEqual({ ok: false, reason: 'pool', full: true });
          expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
        });

        it('no model key is made for a job after its cutoff was decided, even when the job could not be ended; the sweep ends it all the same', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          const hold = atTheEnd(() => Promise.reject(new Error('the database went away')));
          try {
            expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          } finally {
            hold.mockRestore();
          }
          expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
          // A prepare asks for a key now: none is made (the job is going to be ended), and a call with an older key is refused too
          expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
          expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
          // A key of another scope is not touched by it
          expect((await mintJobToken(jobId, 'git', NOW)).ok).toBe(true);
          await sweepComputers(minutes(5));
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });

        it('a key made while the decision is being made waits for it and finds it: it is ended at once and never given out (the lock, not a delay)', async () => {
          const { jobId } = await running();
          await prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId: 'orbit:pool:c0', kind: 'fault', reason: 'pool_busy', source: 'orbit', route: null, providerStatus: 503, at: NOW } });
          // The cutoff, as another request runs it: its lock taken, its decision not kept yet
          const cutoff = holdCutoffLock(jobId, (tx) => recordPoolCutoff(tx, jobId, NOW));
          let minted: Promise<unknown> = Promise.resolve();
          try {
            await cutoff.ready;
            minted = observe(mintJobToken(jobId, 'model', NOW));
            expect(await waitingOnCutoffLock(jobId)).toBe(true);
            cutoff.release();
            await cutoff.done;
            expect(await minted).toEqual({ ok: false, reason: 'not_running' });
            expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
          } finally {
            cutoff.release();
            await Promise.allSettled([cutoff.done, minted]);
          }
        });

        it('a row the relay sends under a call id like one of ours is the relay’s: it is kept under its own key, never counted as a refusal of ours, never retired as one, and never in the place of one (CodeRabbit)', async () => {
          const { sara, jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          const row = (callId: string, kind: 'fault' | 'answered', reason: string) => ({ callId, kind, reason, source: 'universe-ai' as const, route: null, providerStatus: 503, turn: null, run: null, at: NOW });
          // The relay, first, says a fault of ours under the id Orbit will use for its refusal of call c1, and an answered row under the id of Orbit's own-key marker
          expect(await recordFaults(sara.brickId, jobId, [row('orbit:pool:c1', 'fault', 'pool_busy'), row('orbit:own-key-call', 'answered', 'own_key_call')])).toMatchObject({ stored: 2, conflicts: 0 });
          expect((await prisma.computerJobFault.findMany({ where: { jobId }, orderBy: { callId: 'asc' } })).map((r) => r.callId)).toEqual(['relay:orbit:own-key-call', 'relay:orbit:pool:c1']);
          // Neither is Orbit's: no refusal counted, no marker of a call on the person's own key
          expect(await hasPoolRefusals(prisma, jobId)).toBe(false);
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(false);
          // Orbit's own refusal of the same call is kept beside it, and counts once
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', source: 'orbit', kind: 'fault' }]);
          // Capacity recovers: only Orbit's row is retired, the relay's own row stays a fault of ours that a ruling still reads
          await setUp({ poolCeilingMicros: 100_000_000 });
          expect((await call(token, 'c2')).ok).toBe(true);
          expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'answered', reason: 'pool_recovered' }]);
          expect(await prisma.computerJobFault.findUnique({ where: { jobId_callId: { jobId, callId: 'relay:orbit:pool:c1' } } })).toMatchObject({ kind: 'fault', reason: 'pool_busy', source: 'universe-ai' });
          expect(await readFaultRows(prisma, jobId, null)).toMatchObject([{ callId: 'relay:orbit:pool:c1', cls: 'ours' }]);
        });

        it('provenance is the source of a row, not only its call id: a row of the relay under an id like one of ours (kept before the keys were told apart) is never counted, never retired, never the marker', async () => {
          const { jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          const legacy = (callId: string, kind: string, source: string, reason: string) => prisma.computerJobFault.create({ data: { jobId, turn: null, run: null, callId, kind, reason, source, route: null, providerStatus: 503, at: NOW } });
          await legacy('orbit:pool:old', 'fault', 'universe-ai', 'pool_busy');
          await legacy('orbit:own-key-call', 'answered', 'own-key', 'own_key_call');
          expect(await hasPoolRefusals(prisma, jobId)).toBe(false);
          expect(await hasOwnKeyCall(prisma, jobId)).toBe(false);
          // Capacity is back: nothing of the relay's is retired
          expect((await call(token, 'c1')).ok).toBe(true);
          expect(await prisma.computerJobFault.findUnique({ where: { jobId_callId: { jobId, callId: 'orbit:pool:old' } } })).toMatchObject({ kind: 'fault', reason: 'pool_busy' });
        });

        it('a job that waited past its time, with a cutoff deciding at that very moment, is ended by the cutoff: the sweep waits for the job’s lock and reads the decision under it (the lock, not a delay)', async () => {
          const { jobId } = await running();
          await requestHandover(jobId, 'details', minutes(1));
          const cutoff = holdCutoffLock(jobId, (tx) => recordPoolCutoff(tx, jobId, minutes(61)));
          let sweeping: Promise<unknown> = Promise.resolve();
          try {
            await cutoff.ready;
            sweeping = observe(sweepComputers(minutes(62)));
            expect(await waitingOnCutoffLock(jobId)).toBe(true);
            cutoff.release();
            await cutoff.done;
            await sweeping;
            expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
          } finally {
            cutoff.release();
            await Promise.allSettled([cutoff.done, sweeping]);
          }
        });

        it('a relay row that looks like the marker of a call on the person’s own key does not stop a cutoff: the job is stopped on its second refusal as ours', async () => {
          const { sara, jobId } = await running();
          const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
          await recordFaults(sara.brickId, jobId, [{ callId: 'orbit:own-key-call', kind: 'answered', reason: 'own_key_call', source: 'own-key', route: null, providerStatus: null, turn: null, run: null, at: NOW }]);
          await setUp({ poolCeilingMicros: 60_000 });
          expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await call(token, 'c2', 1_000)).toMatchObject({ ok: false, reason: 'pool', full: true });
          expect(await jobOf(jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        });
      });

      it('a call authorized before the cutoff counted is seen by it: the job is not stopped (the other half of the same race)', async () => {
        const other = await running('cam');
        await seedGiveBackLimits({ pauseMinRuns: 1 });
        const { jobId } = await running('dee');
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await prisma.computerJobFault.create({ data: { jobId: other.jobId, turn: 1, callId: 'p1', kind: 'uncertain', reason: 'provider_5xx', source: 'universe-ai', route: 'universe-ai/slow', at: NOW } });
        const on = (route: string, id: string) => authorizeSettled({ token, callId: id, estimateMicros: 5_000, payer: 'universe', route }, NOW);
        expect(await on('universe-ai/slow', 'c1')).toEqual({ ok: false, reason: 'pool', full: true });
        // A call on the route with room is authorized (and the first refusal recovers); the second refusal then finds an authorized call
        expect((await on('universe-ai/fast', 'c2')).ok).toBe(true);
        expect(await on('universe-ai/slow', 'c3')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await on('universe-ai/slow', 'c4')).toEqual({ ok: false, reason: 'pool', full: true });
        expect(await jobOf(jobId)).toMatchObject({ status: 'running' });
        // No decision was ever kept for a job whose authorization won before the cutoff
        expect(await prisma.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL } })).toBe(0);
      });

      it('a refusal that capacity recovered from stops deciding the turns after it: the row is retired when a later call is authorized, so a turn that failed for the agent’s own reason is not ours (CodeRabbit)', async () => {
        const { jobId } = await running();
        const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
        await setUp({ poolCeilingMicros: 60_000 });
        expect(await call(token, 'c1', 1_000)).toMatchObject({ ok: false, reason: 'pool' });
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'fault' }]);
        // Capacity is back: the next call is authorized, and the refusal stops counting (kept as evidence, read by no ruling)
        await setUp({ poolCeilingMicros: 100_000_000 });
        expect((await call(token, 'c2')).ok).toBe(true);
        expect(await poolRows(jobId)).toMatchObject([{ callId: 'orbit:pool:c1', kind: 'answered', reason: 'pool_recovered' }]);
        // A later turn fails for the agent's own reason: not a fault of ours
        await finishJob(jobId, 'failed', NOW, 'It gave up', 'agent', [5]);
        expect(await prisma.computerGiveBackDecision.findUnique({ where: { jobId } })).toMatchObject({ state: 'refused', basis: 'agent_ended' });
      });

      it('is judged job by job: one job’s refusals never stop another', async () => {
        const a = await running('ann');
        const b = await running('bea');
        const keyA = ((await mintJobToken(a.jobId, 'model', NOW)) as { token: string }).token;
        await setUp({ poolCeilingMicros: 60_000 });
        await call(keyA, 'c1', 1_000);
        expect(await poolRows(b.jobId)).toEqual([]);
        await call(keyA, 'c2', 1_000);
        expect(await jobOf(a.jobId)).toMatchObject({ status: 'stopped', endedBy: 'pool' });
        expect(await jobOf(b.jobId)).toMatchObject({ status: 'running' });
      });
    });

    it('is not another job running: a call does not use up the jobs allowed at once', async () => {
      await setUp({ atOnceMember: 1, atOnceAll: 1 });
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect((await call(token, 'c1')).ok).toBe(true);
      expect((await call(token, 'c2')).ok).toBe(true);
      expect((await currentEnvelope(NOW)).jobsRunning).toBe(1);
    });

    it('is refused for a key that ended, with nothing reserved', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await call(token, 'c1')).toEqual({ ok: false, reason: 'refused' });
      expect(await prisma.meterReservation.count({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).toBe(0);
    });

    it('is refused for a call id or an estimate that is not one', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      expect(await call(token, 'has space')).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'x'.repeat(81))).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'c1', 0)).toEqual({ ok: false, reason: 'refused' });
      expect(await call(token, 'c2', 1.5)).toEqual({ ok: false, reason: 'refused' });
    });

    it('settles at the room held when the price is unknown, never at 0, and records it as unknown', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'c1', 7_000);
      await settleModelCall(jobId, 'c1', { costMicros: null, basis: 'unknown', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:c1` } });
      expect(event.costMicros).toBeNull();
      expect(event.basis).toBe('unknown');
      expect(Number((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).settledMicros)).toBe(7_000);
    });

    it('a call on the owner’s own key takes no room from the pool, and is recorded as paid by them', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const before = (await currentEnvelope(NOW)).reservedMicros;
      const authorized = await authorizeSettled({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
      expect(authorized).toMatchObject({ ok: true, reservedMicros: null });
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(before);
      await settleModelCall(jobId, 'k1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:k1` } });
      expect(event).toMatchObject({ payerKind: 'person', payerPersonId: sara.id, basis: 'paid_by_other', pool: 'computer' });
      // The platform's computer pool does not count it
      const universeCost = await prisma.meterEvent.aggregate({ where: { pool: 'computer', payerKind: 'universe', kind: 'model_call' }, _sum: { costMicros: true } });
      expect(Number(universeCost._sum.costMicros ?? 0)).toBe(0);
    });

    it('is settled even after the job ended: a call that finished late is still counted', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late', 5_000);
      await finishJob(jobId, 'done', NOW);
      expect(await settleModelCall(jobId, 'late', { costMicros: 300, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai', cutShort: true }, NOW)).toEqual({ ok: true });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:late` } })).toBe(1);
    });

    it('settling a call nobody authorized writes nothing', async () => {
      const { jobId } = await running();
      expect(await settleModelCall(jobId, 'ghost', { costMicros: 100, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: false, reason: 'unknown_call' });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:ghost` } })).toBe(0);
    });

    it('gives the room back when the call was never sent', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'c1', 5_000);
      await releaseModelCall(jobId, 'c1', NOW);
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'c1') } })).state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:c1` } })).toBe(0);
    });

    it('the sweep settles room held for a call that never reported back, as unknown at the room held', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'lost', 9_000);
      await sweepComputers(minutes(30));
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'lost') } });
      expect(room.state).toBe('settled');
      expect(Number(room.settledMicros)).toBe(9_000);
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:lost` } });
      expect(event).toMatchObject({ basis: 'unknown', costMicros: null });
    });

    it('CodeRabbit on #1025 (26): a lapsed room whose call was never admitted (its refusal could not give the room back) is released, never settled as the person’s unknown usage', async () => {
      const { jobId, sara } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'refused', 9_000);
      await call(token, 'admitted', 9_000);
      // The first call is the one a refusal left held: its admission is not kept
      await prisma.computerJobFault.deleteMany({ where: { jobId, callId: 'orbit:admit:refused' } });
      await sweepComputers(minutes(30));
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'refused') } })).state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:refused` } })).toBe(0);
      // An admitted call that never reported is unknown usage, as before
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'admitted') } })).state).toBe('settled');
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:admitted` } })).toMatchObject({ basis: 'unknown', costMicros: null });
      void sara;
    });

    it('CodeRabbit on #1025 (D7): a NEW room that was released between its reservation and its admission is not admitted: the room is looked at under the pool lock for every call, the answer is `refused`, and no admission is left', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const realTx = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
      let fired = false;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        const first = args[0];
        if (typeof first !== 'function') return realTx(...args);
        const wrapped = (tx: object) =>
          (first as (client: unknown) => Promise<unknown>)(
            new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property, target) as unknown;
                if (property !== '$executeRaw' || typeof value !== 'function') return value;
                return async (...raws: unknown[]) => {
                  // The admission's own transaction starts with the job's cutoff lock: the room is given back by someone else at that very moment (a release that committed before the admission looked)
                  if (!fired && raws.slice(1).includes(cutoffLockKey(jobId))) {
                    fired = true;
                    await releaseRoom({ key: callRoomKey(jobId, 'late-new') }, minutes(1));
                  }
                  return (value as (...inner: unknown[]) => unknown).apply(target, raws);
                };
              },
            }),
          );
        return realTx(wrapped, ...args.slice(1));
      }) as never);
      let answer: unknown;
      try {
        answer = await call(token, 'late-new', 5_000);
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect(answer).toMatchObject({ ok: false, reason: 'refused' });
      expect(await prisma.computerJobFault.count({ where: { jobId, callId: 'orbit:admit:late-new' } })).toBe(0);
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'late-new') } })).state).toBe('released');
    });

    it('CodeRabbit on #1025 (A13): a lapsed room whose admission could not be READ is left for the next sweep: neither released nor booked as the person’s unknown usage; the next sweep, reading it, decides', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'unread', 9_000);
      // Not admitted (its refusal could not give the room back)
      await prisma.computerJobFault.deleteMany({ where: { jobId, callId: 'orbit:admit:unread' } });
      const realTx = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        const first = args[0];
        if (typeof first !== 'function') return realTx(...args);
        const wrapped = (tx: object) =>
          (first as (client: unknown) => Promise<unknown>)(
            new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property, target) as unknown;
                if (property !== 'computerJobFault') return value;
                return new Proxy(value as object, {
                  get(model, method) {
                    const original = Reflect.get(model, method, model) as unknown;
                    if (method !== 'count') return original;
                    return (where: { where?: { callId?: unknown } }) =>
                      typeof where?.where?.callId === 'string' && where.where.callId.startsWith('orbit:admit:') ? Promise.reject(new Error('the admission could not be read')) : (original as (a: unknown) => unknown).call(model, where);
                  },
                });
              },
            }),
          );
        return realTx(wrapped, ...args.slice(1));
      }) as never);
      try {
        await sweepComputers(minutes(30));
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'unread') } })).state).toBe('held');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:unread` } })).toBe(0);
      // The next sweep reads it: never admitted, so the room goes back and nothing is booked
      await sweepComputers(minutes(31));
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'unread') } })).state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:unread` } })).toBe(0);
    });

    it('CodeRabbit on #1025 (D6): an admission that commits while the sweep decides to release a lapsed room is seen: the sweep waits on the call’s admission lock, finds the admission, and settles the room as the usage it is (never released from under an admitted call)', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'racy', 9_000);
      await prisma.computerJobFault.deleteMany({ where: { jobId, callId: 'orbit:admit:racy' } });
      // Another request is admitting this call right now: it holds the call's admission lock
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${admitLockKey(jobId, 'racy')}, 0))`;
        locked();
        await gate;
        await recordCallAdmission(tx, jobId, 'racy', minutes(29));
      });
      const holderEnded = holder.then(
        () => undefined,
        () => undefined,
      );
      let sweeping: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([lockTaken, holder]);
        sweeping = sweepComputers(minutes(30));
        sweeping.catch(() => undefined);
        // The sweep reaches the call's lock and waits for it (a bounded wait for that checkpoint)
        let waiting = false;
        for (let tries = 0; tries < 250 && !waiting; tries += 1) {
          const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${admitLockKey(jobId, 'racy')}, 0)`;
          waiting = rows[0].n > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'racy') } })).state).toBe('held');
      } finally {
        release();
        await Promise.allSettled([holderEnded, sweeping]);
      }
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'racy') } })).state).toBe('settled');
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:racy` } })).toMatchObject({ basis: 'unknown', costMicros: null });
    });

    it('a report that comes after the sweep wrote the call as unknown replaces the unknown figure, and never a figure that was written', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late', 9_000);
      await sweepComputers(minutes(30));
      const facts = { costMicros: 4_000, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const };
      expect(await settleModelCall(jobId, 'late', facts, minutes(31))).toEqual({ ok: true });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late` } })).toMatchObject({ basis: 'measured', costMicros: BigInt(4_000) });
      // A second report, even with another figure, leaves what was written
      expect(await settleModelCall(jobId, 'late', { ...facts, costMicros: 7_000 }, minutes(32))).toEqual({ ok: true });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late` } })).toMatchObject({ costMicros: BigInt(4_000) });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:late` } })).toBe(1);
    });

    it('a late report that cost more than the room held keeps the overrun beside the figure', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'late-over', 9_000);
      await sweepComputers(minutes(30));
      const facts = { costMicros: 12_000, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const };
      expect(await settleModelCall(jobId, 'late-over', facts, minutes(31))).toEqual({ ok: true });
      const event = await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:late-over` } });
      expect(event).toMatchObject({ basis: 'measured', costMicros: BigInt(12_000) });
      expect(event.detail).toMatchObject({ overrunMicros: 3_000 });
    });

    it('settles the room at the cost the books hold for the call, also when a report is sent again with another figure after the first one wrote the event and did not settle', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'again', 9_000);
      // The first report wrote its event (4,000) and stopped before the room was settled
      await recordMeterEvent({ eventId: `computer:${jobId}:call:again`, kind: 'model_call', pool: 'computer', occurredAt: NOW, personKey: `person:${(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).personId}`, personId: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).personId, botId: (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).botId, brick: true, payerKind: 'universe', route: 'universe-ai', jobId, quantity: 1, unit: 'call', costMicros: 4_000, basis: 'measured', sourceRef: `computer_jobs:${jobId}`, payerPersonId: null, detail: null });
      expect(await settleModelCall(jobId, 'again', { costMicros: 1_000, basis: 'measured', payer: { kind: 'universe' }, route: 'universe-ai' }, NOW)).toEqual({ ok: true });
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'again') } });
      expect(room.state).toBe('settled');
      // The books say 4,000, so that is what the room settles at, not the 1,000 of the second report
      expect(Number(room.settledMicros)).toBe(4_000);
    });

    it('the sweep gives back room held for a call whose job is gone, instead of finding it again on every sweep', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await call(token, 'orphan', 7_000);
      await prisma.computerJob.delete({ where: { id: jobId } });
      await sweepComputers(minutes(30));
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: callRoomKey(jobId, 'orphan') } });
      expect(room.state).toBe('released');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${jobId}:call:orphan` } })).toBe(0);
    });
  });

  describe('the model calls of a job that failed on our side', () => {
    const facts = (costMicros: number) => ({ costMicros, basis: 'measured' as const, payer: { kind: 'universe' as const }, route: 'universe-ai' as const });
    const callEvent = (jobId: string, callId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:call:${callId}` } });
    /** A call that was sent and settled while the job ran. */
    const settledCall = async (jobId: string, callId: string, cost: number) => {
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId, estimateMicros: 5_000, payer: 'universe' }, NOW);
      await settleModelCall(jobId, callId, facts(cost), NOW);
    };

    it('are not taken from the person’s month, and stay in the books as our own cost, written against nobody', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await settledCall(jobId, 'c2', 3_000);
      // While it runs they are the person's
      expect((await callEvent(jobId, 'c1')).personKey).toBe(`person:${sara.id}`);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      for (const [callId, cost] of [['c1', 1_200], ['c2', 3_000]] as const) {
        const event = await callEvent(jobId, callId);
        expect(event).toMatchObject({ kind: 'model_call', pool: 'computer', payerKind: 'universe', personKey: 'unknown', personId: null, jobId, costMicros: BigInt(cost) });
        expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id });
      }
      // Their month is whole, the calls' room is settled (not left held), and our exposure still counts what the providers billed
      expect((await computerView(sara.brickId, sara.id, minutes(5)))?.month?.leftFraction).toBe(1);
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}`, state: 'held' } })).toBe(0);
      expect((await currentEnvelope(minutes(5))).unsettledMicros).toBeGreaterThanOrEqual(30_000 + 4_200);
      // Asked again, it changes nothing more
      const [item] = await activityFor(sara.id);
      expect(item).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('stay the person’s when the runner says the job failed with no cause, or that the agent gave up or ran out of turns: only a cause that is ours gives back', async () => {
      for (const cause of [undefined, null, 'agent'] as const) {
        const { sara, jobId } = await running();
        await settledCall(jobId, 'c1', 1_200);
        await finishJob(jobId, 'failed', minutes(5), 'The agent gave up', cause);
        expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
        await sweepComputers(minutes(30));
        expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
        expect(await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `computer:${jobId}:time` } })).toMatchObject({ personId: sara.id });
        await prisma.computerJob.deleteMany({ where: { id: jobId } });
      }
    });

    it('are written against nobody when the report comes after the job failed (a call that finished late)', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId: 'late', estimateMicros: 5_000, payer: 'universe' }, NOW);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      expect(await settleModelCall(jobId, 'late', { ...facts(2_500), cutShort: true }, minutes(6))).toEqual({ ok: true });
      const event = await callEvent(jobId, 'late');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(2_500) });
      expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id, cutShort: true });
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBe(1);
    });

    it('are given back when the worker was lost: the sweep stops the job, and the call it never heard back from is written against nobody too', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'done1', 1_000);
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'stopped', endedBy: 'error' });
      expect(await callEvent(jobId, 'done1')).toMatchObject({ personKey: 'unknown', personId: null });
      expect(await callEvent(jobId, 'lost')).toMatchObject({ personKey: 'unknown', personId: null, costMicros: null, basis: 'unknown' });
      expect((await computerView(sara.brickId, sara.id, minutes(60)))?.month?.leftFraction).toBe(1);
    });

    it('one job whose give-back throws does not skip the others of the sweep’s batch: it is said, and the rest are still given back', async () => {
      const first = await running('sara');
      const second = await running('tom');
      for (const { jobId } of [first, second]) {
        await settledCall(jobId, 'c1', 1_200);
        await finishJob(jobId, 'failed', minutes(5), null, 'ours');
        // The give-back of the end did not go through (or a call was recorded in the same moment): the call is still written against the person
        await prisma.meterEvent.updateMany({ where: { jobId, kind: 'model_call' }, data: { personKey: `person:${jobId === first.jobId ? first.sara.id : second.sara.id}`, personId: jobId === first.jobId ? first.sara.id : second.sara.id } });
      }
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      (giveBackModelCalls as jest.Mock).mockClear();
      (giveBackModelCalls as jest.Mock).mockRejectedValueOnce(new Error('The books are down'));
      await sweepComputers(minutes(30));
      logged.mockRestore();
      const calls = (giveBackModelCalls as jest.Mock).mock.calls.map((c) => c[0] as string);
      // Both were tried: the one that threw did not end the batch
      expect([...calls].sort()).toEqual([first.jobId, second.jobId].sort());
      const [thrown, rest] = calls;
      expect(await callEvent(rest, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
      // The one that failed is still the person's, so the next sweep finds it again and gives it back
      expect((await callEvent(thrown, 'c1')).personKey).not.toBe('unknown');
      await sweepComputers(minutes(31));
      expect(await callEvent(thrown, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
    });

    it('a report that replaces an unknown figure keeps the call given back', async () => {
      const { jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      await settleModelCall(jobId, 'lost', facts(4_000), minutes(61));
      const event = await callEvent(jobId, 'lost');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(4_000), basis: 'measured' });
      expect(event.detail).toMatchObject({ givenBack: true });
    });

    it('a report that read the job as still running does not wipe a give-back made in the meantime, and still drops what the sweep guessed', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId: 'lost', estimateMicros: 9_000, payer: 'universe' }, NOW);
      await sweepComputers(minutes(60));
      // The sweep wrote it as unknown, cut short, and given back
      expect((await callEvent(jobId, 'lost')).detail).toMatchObject({ givenBack: true, cutShort: true });
      // A report that read the job while it still ran (so it carries no give-back of its own) comes after
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementationOnce(((args: never) => real({ ...(args as object), where: { id: jobId } }).then((job: unknown) => ({ ...(job as object), status: 'running', endedBy: null }))) as never);
      await settleModelCall(jobId, 'lost', { ...facts(4_000), tokens: { input: 10, output: 2 } }, minutes(61));
      spy.mockRestore();
      const event = await callEvent(jobId, 'lost');
      expect(event).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(4_000), basis: 'measured' });
      expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id, tokens: { input: 10, output: 2 } });
      // This report was not cut short, so the sweep's own mark is gone
      expect(event.detail).not.toHaveProperty('cutShort');
    });

    it('stay the person’s when the job ran fine or the person stopped it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const done = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!done.ok) throw new Error('no');
      await settledCall(done.job.id, 'c1', 1_200);
      await finishJob(done.job.id, 'done', minutes(5));
      expect(await callEvent(done.job.id, 'c1')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      expect((await callEvent(done.job.id, 'c1')).detail).not.toHaveProperty('givenBack');

      const stopped = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(6));
      if (!stopped.ok) throw new Error('no');
      await settledCall(stopped.job.id, 'c2', 700);
      await stopJobFor(sara.brickId, sara.id, minutes(9));
      expect(await callEvent(stopped.job.id, 'c2')).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      // Their month has both jobs' calls and minutes taken from it
      const left = (await computerView(sara.brickId, sara.id, minutes(9)))?.month?.leftFraction ?? 1;
      expect(left).toBeLessThan(1 - (1_200 + 700) / 1_000_000);
    });

    it('do not touch a call on the owner’s own key (it was never the platform’s cost or the person’s allowance)', async () => {
      const { sara, jobId } = await running();
      const { token } = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await authorizeSettled({ token, callId: 'k1', estimateMicros: 1, payer: 'own-key' }, NOW);
      await settleModelCall(jobId, 'k1', { costMicros: 900, basis: 'measured', payer: { kind: 'person', personId: sara.id }, route: 'own-key' }, NOW);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      expect(await callEvent(jobId, 'k1')).toMatchObject({ payerKind: 'person', payerPersonId: sara.id, personKey: `person:${sara.id}` });
    });

    it('are found by a later sweep when the give-back at the end did not go through, and Activity does not say refunded until then', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      // Put it back as it would be had the give-back write failed
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.month?.leftFraction).toBeLessThan(1);
      // A call that still draws from the month is something taken: not "nothing taken"
      expect((await activityFor(sara.id))[0].state).not.toBe('refunded');
      await sweepComputers(minutes(7));
      expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: 'unknown', personId: null, costMicros: BigInt(1_200) });
      expect((await computerView(sara.brickId, sara.id, minutes(7)))?.month?.leftFraction).toBe(1);
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('are found by a sweep however long after the job failed, so a person is never left charged for them', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      await sweepComputers(minutes(5 + 40 * 24 * 60));
      expect(await callEvent(jobId, 'c1')).toMatchObject({ personKey: 'unknown', personId: null });
    });

    it('is the receipt’s state even when the job is not among the newest jobs listed: the receipts and the jobs are each cut to the newest few', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const older = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Older' }, NOW);
      if (!older.ok) throw new Error('no');
      await finishJob(older.job.id, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: older.job.id, title: 'Older', category: 'computer', state: 'done', chargedMicros: BigInt(30_000), payerKind: 'person', payerPersonId: sara.id, startedAt: minutes(10), endedAt: minutes(20) } });
      // A newer job than the older one (but ended before the receipt did) takes the only place in the job list of one
      const newer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Newer' }, minutes(12));
      if (!newer.ok) throw new Error('no');
      await finishJob(newer.job.id, 'done', minutes(15));
      const items = await activityFor(sara.id, 1);
      // The receipt is the newest line, though its job was cut from the job list by the limit
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ title: 'Older', state: 'refunded', spentMicros: null });
    });

    it('a receipt already stored as refunded does not read as refunded while a platform-paid call of the job is still on the person', async () => {
      const { sara, jobId } = await running();
      await settledCall(jobId, 'c1', 1_200);
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Visa form', category: 'computer', state: 'refunded', payerKind: 'person', payerPersonId: sara.id, startedAt: NOW, endedAt: minutes(5) } });
      await prisma.meterEvent.updateMany({ where: { eventId: `computer:${jobId}:call:c1` }, data: { personKey: `person:${sara.id}`, personId: sara.id, detail: {} } });
      expect((await activityFor(sara.id))[0].state).toBe('done');
      await sweepComputers(minutes(7));
      expect((await activityFor(sara.id))[0]).toMatchObject({ state: 'refunded', spentMicros: null });
    });

    it('is the receipt’s own state too: a job with a receipt of its own whose time was given back shows as refunded, not with the charge the receipt stored', async () => {
      const { sara, jobId } = await running();
      await finishJob(jobId, 'failed', minutes(5), null, 'ours');
      await prisma.taskReceipt.create({ data: { botId: sara.brickId, personId: sara.id, taskKey: jobId, title: 'Visa form', category: 'computer', state: 'done', chargedMicros: BigInt(30_000), payerKind: 'person', payerPersonId: sara.id, startedAt: NOW, endedAt: minutes(5) } });
      const items = await activityFor(sara.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ title: 'Visa form', state: 'refunded', spentMicros: null });
    });

  });
});
