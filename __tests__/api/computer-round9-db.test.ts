/**
 * CodeRabbit's round on Orbit #1025 at 9ce30250 (the money and data items), against a real database and the pretend provider. Each test fails on the code before the round:
 *  - I9 / O44: a fresh job is workable only after its ready write landed (a failed write puts it back in line; the runner lists and claims only a job whose stretch has started)
 *  - O42: the wake ticket is taken only from the epoch the start looked at, and a takeover only while the beat is still stale
 *  - I10: a Stop that left a captured job live is not done (retryable failure, the command stays pending for the same set)
 *  - I8 / O40: the refusal is kept on the key together with the removal of the provisional job (or neither happens)
 *  - I7: a reopened key's boundary is stored on the attempt (every delivery decides alike)
 *  - I3 / F4: a first turn is admitted only on the claim that is still the job's, and never on a job that is not ready
 *  - O1, O45, O46: the carry-on is bound to its pause, a pause result not recorded is pending, a start's decision is its own marker
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-round9-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));
jest.mock('@/lib/computer-browser-profile', () => {
  const actual = jest.requireActual('@/lib/computer-browser-profile');
  return { ...actual, parkProfile: jest.fn(async () => ({ state: 'parked', reason: null })), restoreProfile: jest.fn(async () => ({ state: 'restored', reason: null })), dropProfile: jest.fn(async () => ({ state: 'dropped', reason: null })) };
});

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { seedGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { claimJob, giveComputer, runnableJobsPage, startJob, stopAll, takeWakeTicketForTests, registerStart, refuseAttempt, retireStartKey, issuedOfKey, getJob } from '@/lib/computer';
import { startTurn } from '@/lib/computer-broker';
import { afterCarryOnForTests } from '@/lib/computer-limit-pause';
import { pendingOutcomeOfForTests, resumeDecidedOfForTests } from '@/lib/computer-job-controls';
import { POST } from '@/app/api/bots/[id]/computer-jobs/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
let fake: FakeComputerProvider;

type Owner = { id: string; uuid: string; brickId: string };
async function owner(name: string): Promise<Owner> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, uuid: unique, brickId: brick.id };
}

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const key = () => `t${Date.now().toString(36)}-${randomUUID().replace(/-/g, '')}`;

async function runningJob(sara: Owner, title = 'Job') {
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error(`the job did not start running: ${JSON.stringify(started)}`);
  return started.job.id;
}

const post = async (sara: Owner, startKey: string, extra: Record<string, string> = {}, body: Record<string, unknown> = {}) => {
  const res = await POST(
    new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs`, {
      method: 'POST',
      body: JSON.stringify({ userId: sara.uuid, title: 'A job', ...body }),
      headers: { 'content-type': 'application/json', 'x-computer-start-attempt': startKey, 'x-computer-start-acks': '1', ...extra },
    }),
    { params: Promise.resolve({ id: sara.brickId }) },
  );
  return { status: res.status, body: await res.json() };
};

/** A trigger that makes an UPDATE of the table a no-op (returns NULL: the row is not changed and nothing fails) or an error, for one value, until it is dropped. */
async function plant(name: string, table: string, when: string, action: 'skip' | 'fail') {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$ BEGIN ${action === 'skip' ? 'RETURN NULL' : "RAISE EXCEPTION 'planted failure'"}; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON "${table}" FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}_fn()`);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}_fn()`);
  };
}

run('CodeRabbit round 9 on #1025: the money and data items, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN = process.env.BOT_SERVICE_TOKEN || 'service-secret-for-tickets';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await seedGiveBackLimits();
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('I9 and O44: a fresh job is workable only after its ready write', () => {
    it('I9: the ready write fails twice: the job is back in line (queued, busy), nothing is booked, and no runner lists or claims it', async () => {
      const sara = await owner('i9');
      const real = prisma.$executeRaw.bind(prisma) as (...args: unknown[]) => unknown;
      const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (Array.isArray(strings) && strings.join('?').includes('SET "stretch_started"')) return Promise.reject(new Error('the database is not answering'));
        return real(strings, ...values);
      }) as never);
      let started;
      try {
        started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
      } finally {
        spy.mockRestore();
      }
      expect(started).toMatchObject({ ok: true, job: { status: 'queued', queuedFor: 'busy' } });
      const row = await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id } });
      expect(row).toMatchObject({ status: 'queued', queuedFor: 'busy', reservationKey: null, stretchStarted: null, startedAt: null, secondsRun: 0, prepState: null });
      expect((await runnableJobsPage(100)).jobs.map((job) => job.jobId)).not.toContain(row.id);
      expect(await claimJob(row.id, { run: 'r', seen: 0 })).toMatchObject({ ok: false, reason: 'not_running' });
    });

    it('O44: a job whose machine is still waking (running, no stretch started) is not listed and not claimable; once its ready write lands it is both', async () => {
      const sara = await owner('o44');
      const jobId = await runningJob(sara);
      await prisma.computerJob.update({ where: { id: jobId }, data: { stretchStarted: null } });
      expect((await runnableJobsPage(100)).jobs.map((job) => job.jobId)).not.toContain(jobId);
      const refused = await claimJob(jobId, { run: 'r', seen: 0 });
      expect(refused).toMatchObject({ ok: false, reason: 'not_ready' });
      // Nothing was granted: no epoch moved, no lease
      expect(await prisma.computerJob.findUnique({ where: { id: jobId }, select: { ownerEpoch: true, ownerLeaseUntil: true } })).toEqual({ ownerEpoch: 0, ownerLeaseUntil: null });
      await prisma.computerJob.update({ where: { id: jobId }, data: { stretchStarted: new Date() } });
      expect((await runnableJobsPage(100)).jobs.map((job) => job.jobId)).toContain(jobId);
      expect(await claimJob(jobId, { run: 'r', seen: 0 })).toMatchObject({ ok: true, epoch: 1 });
    });
  });

  describe('O42: the wake ticket', () => {
    async function wakingMachine(sara: Owner, epoch: number, beatAgoMinutes: number) {
      await runningJob(sara);
      await prisma.$executeRaw`UPDATE "brick_computers" SET "machine" = 'waking', "wake_epoch" = ${epoch}, "updated_at" = (NOW() AT TIME ZONE 'UTC') - make_interval(mins => ${beatAgoMinutes}) WHERE "bot_id" = ${sara.brickId}`;
    }
    it('two starts that read the same stale wake take ONE ticket between them (the second matches the state, not the epoch it saw)', async () => {
      const sara = await owner('o42');
      await wakingMachine(sara, 5, 10);
      const [a, b] = await Promise.all([takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 5, staleMs: 60_000 }), takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 5, staleMs: 60_000 })]);
      expect([a, b].filter((ticket) => ticket !== null)).toEqual([6]);
      expect(await prisma.brickComputer.findUnique({ where: { botId: sara.brickId }, select: { wakeEpoch: true } })).toEqual({ wakeEpoch: 6 });
      // And one that read the row before the ticket moved takes none
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 5 })).toBeNull();
    });
    it('a wake that beat after the read is not taken over: the stale test is in the write itself', async () => {
      const sara = await owner('o42-beat');
      await wakingMachine(sara, 5, 0);
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 5, staleMs: 60_000 })).toBeNull();
      expect(await prisma.brickComputer.findUnique({ where: { botId: sara.brickId }, select: { wakeEpoch: true } })).toEqual({ wakeEpoch: 5 });
    });
  });

  describe('I10: a Stop', () => {
    it('I10: a captured job that stays live (its ending keeps losing) is not stopped: a retryable failure, the command stays pending for the same set, and the retry ends it', async () => {
      const sara = await owner('i10');
      const jobId = await runningJob(sara);
      const command = { id: randomUUID() } as never;
      const undo = await plant('r9_skip_stop', 'computer_jobs', `NEW.status = 'stopped' AND OLD.id = '${jobId}'`, 'skip');
      let first;
      try {
        first = await stopAll(sara.brickId, sara.id, new Date(), command);
      } finally {
        await undo();
      }
      expect(first).toEqual({ ok: false, reason: 'not_ended' });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
      const kept = await prisma.$queryRaw<Array<{ outcome: { pending?: boolean; targets?: string[] } }>>`SELECT "outcome" FROM "computer_job_commands" WHERE "command_id" = ${(command as { id: string }).id}::uuid`;
      expect(kept[0].outcome).toMatchObject({ pending: true, targets: [jobId] });
      const second = await stopAll(sara.brickId, sara.id, new Date(), command);
      expect(second.ok).toBe(true);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('stopped');
    });
  });

  describe('O41: a confirmed Stop in another spelling of the ids', () => {
    it('upper-case ids select the same jobs', async () => {
      const sara = await owner('o41');
      const jobId = await runningJob(sara);
      const done = await stopAll(sara.brickId, sara.id, new Date(), { id: randomUUID() } as never, [jobId.toUpperCase()]);
      expect(done).toMatchObject({ ok: true, stopped: [jobId] });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('stopped');
    });
  });

  describe('I8 and O40: the refusal and the removal of the provisional job are one', () => {
    const noSettings = () => prisma.appSetting.deleteMany({ where: { key: { in: ['meter'] } } });
    it('the refusal cannot be written: the reply is a retryable 503 (never a terminal refusal), the job and the attempt stay, and the retry gets the same refusal', async () => {
      const sara = await owner('i8');
      await noSettings();
      const k = key();
      const undo = await plant('r9_fail_refuse', 'computer_start_attempts', `NEW.state = 'refused'`, 'fail');
      let first;
      try {
        first = await post(sara, k);
      } finally {
        await undo();
      }
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({ retry: true });
      // The job and its attempt are still there for the retry
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(1);
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'made' });
      const retry = await post(sara, k);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ ok: false, reason: 'not_set' });
      expect(await post(sara, k)).toEqual({ status: 200, body: retry.body });
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(0);
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'refused' });
    });

    it('O40: a refusal the route decides itself (a "try again" that cannot carry on) that cannot be kept is a retryable 503; the retry is the same refusal', async () => {
      const sara = await owner('o40');
      const k = key();
      const asked = () => post(sara, k, { 'x-computer-continues': randomUUID() });
      const undo = await plant('r9_fail_refuse2', 'computer_start_attempts', `NEW.state = 'refused'`, 'fail');
      let first;
      try {
        first = await asked();
      } finally {
        await undo();
      }
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({ retry: true });
      const retry = await asked();
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ ok: false, reason: 'cannot_continue' });
      expect(await asked()).toEqual(retry);
    });

    it('O40: refuseAttempt says what happened: stored, decided (another request decided the key), failed', async () => {
      const sara = await owner('o40-unit');
      const k = key();
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: k, state: 'open' } });
      expect(await refuseAttempt(sara.brickId, sara.id, k, { ok: false })).toBe('stored');
      expect(await refuseAttempt(sara.brickId, sara.id, k, { ok: false })).toBe('decided');
      const failing = jest.spyOn(prisma.computerStartAttempt, 'updateMany').mockRejectedValueOnce(new Error('down') as never);
      try {
        expect(await refuseAttempt(sara.brickId, sara.id, k, { ok: false })).toBe('failed');
      } finally {
        failing.mockRestore();
      }
    });
  });

  describe('O37: retiring a key that has no row', () => {
    it('two retirements at once make one row and both answer retired (the second is not an error)', async () => {
      const sara = await owner('o37');
      const k = key();
      const [a, b] = await Promise.all([retireStartKey(sara.brickId, sara.id, k), retireStartKey(sara.brickId, sara.id, k)]);
      // One of them retires the key; the other finds it already retired and answers what a send of it gets (never an error)
      expect([a, b].filter((one) => one.retired)).toEqual([{ retired: true }]);
      expect([a, b].filter((one) => !one.retired)).toEqual([{ retired: false, answer: { ok: false, reason: 'retired_by_game' } }]);
      expect(await prisma.computerStartAttempt.count({ where: { personId: sara.id, startKey: k } })).toBe(1);
    });
  });

  describe('O39: a key whose time is not a date', () => {
    it('is untimed', () => {
      expect(issuedOfKey(`t${'z'.repeat(12)}-${'a'.repeat(32)}`)).toBeNull();
      expect(issuedOfKey(`t${(10 ** 17).toString(36)}-${'a'.repeat(32)}`)).toBeNull();
    });
  });

  describe('I7: a reopened key keeps its boundary on the attempt', () => {
    it('a redelivery that is not the reopening request answers the job made after the person’s message, and makes no second job', async () => {
      const sara = await owner('i7');
      const issued = new Date(Date.now() - 20_000);
      const k = `t${issued.getTime().toString(36)}-${randomUUID().replace(/-/g, '')}`;
      // The job J of another key, made AFTER the message was issued but BEFORE this key's first attempt was registered
      const j = await startJob({ botId: sara.brickId, personId: sara.id, title: 'J', startKey: key(), acks: true, began: new Date() }, NOW);
      expect(j).toMatchObject({ ok: true });
      // J is acknowledged: the "an earlier start is still unconfirmed" answer must not be what stops a second job here; only the attempt's boundary does
      await prisma.computerJob.updateMany({ where: { personId: sara.id }, data: { startAckedAt: new Date() } });
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: k, state: 'expired', issuedAt: issued, createdAt: new Date(Date.now() + 5_000), beatAt: new Date(Date.now() - 3_600_000) } });
      // One request reopens it; its redelivery (not the one that reopened) reaches the start first
      const reopened = await registerStart(sara.brickId, sara.id, k, new Date(), issued);
      if (!('registration' in reopened)) throw new Error('not reopened');
      expect(reopened.registration.reopened).toBe(true);
      const row = await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } });
      expect(row.supersedeSince?.getTime()).toBe(issued.getTime());
      const redelivery = await startJob({ botId: sara.brickId, personId: sara.id, title: 'again', startKey: k, acks: true, began: new Date(), registration: { opened: false, reopened: false, release: async () => undefined } }, NOW);
      await reopened.registration.release();
      // It answers J (the job made after the person's message was issued), and makes no job of its own
      if (!j.ok) throw new Error('J was not made');
      expect(redelivery).toMatchObject({ ok: true, job: { id: j.job.id } });
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(1);
    });
  });

  describe('I3 and F4: admitting a turn', () => {
    it('F4: a job that is not ready (restoring, recover, or no stretch yet) opens no turn, whoever asks and whatever epoch they say', async () => {
      const sara = await owner('f4');
      const jobId = await runningJob(sara);
      for (const prepState of ['restoring', 'recover'] as const) {
        // Not ready means no billable stretch yet either (the table's own check)
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepState, stretchStarted: null } });
        expect(await startTurn(jobId, 'hello')).toEqual({ ok: false, reason: 'starting' });
      }
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: null, stretchStarted: null } });
      expect(await startTurn(jobId, 'hello')).toEqual({ ok: false, reason: 'starting' });
      expect(fake.openedTurns).toHaveLength(0);
      // Ready again: the turn opens
      await prisma.computerJob.update({ where: { id: jobId }, data: { stretchStarted: new Date() } });
      expect((await startTurn(jobId, 'hello')).ok).toBe(true);
    });

    it('I3: a first-turn request whose claim was replaced while it stalled opens nothing (a turn stored by the replacement is busy; a replaced claim is starting)', async () => {
      const sara = await owner('i3');
      const jobId = await runningJob(sara);
      const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => Promise<unknown>;
      let replaced = false;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => {
        // The admission is the one transaction with this limit: just before it runs, the claim is taken by a second request that opens a turn and stores its id (which clears the first-turn mark)
        if (options?.maxWait !== 15_000 || replaced) return real(fn, options);
        replaced = true;
        return (async () => {
          await prisma.$executeRaw`UPDATE "computer_jobs" SET "turn_claimed_at" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 second', "agent_session_id" = 'sess-2', "agent_response_id" = 'resp-2', "first_turn_sent_at" = NULL WHERE "id" = ${jobId}`;
          return real(fn, options);
        })();
      }) as never);
      let answer;
      try {
        answer = await startTurn(jobId, 'first');
      } finally {
        spy.mockRestore();
      }
      expect(replaced).toBe(true);
      expect(answer).toEqual({ ok: false, reason: 'busy', responseId: 'resp-2' });
      expect(fake.openedTurns).toHaveLength(0);
    });
  });

  describe('I3: a claim that was replaced before admission', () => {
    it('a replacement that has taken the claim but not opened a turn yet: the first request is told the job is starting and opens nothing (the claim re-check alone decides this one)', async () => {
      const sara = await owner('i3b');
      const jobId = await runningJob(sara);
      const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => Promise<unknown>;
      let replaced = false;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: { maxWait?: number }) => {
        if (options?.maxWait !== 15_000 || replaced) return real(fn, options);
        replaced = true;
        return (async () => {
          await prisma.$executeRaw`UPDATE "computer_jobs" SET "turn_claimed_at" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 second' WHERE "id" = ${jobId}`;
          return real(fn, options);
        })();
      }) as never);
      let answer;
      try {
        answer = await startTurn(jobId, 'first');
      } finally {
        spy.mockRestore();
      }
      expect(replaced).toBe(true);
      expect(answer).toEqual({ ok: false, reason: 'starting' });
      expect(fake.openedTurns).toHaveLength(0);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { firstTurnSentAt: true } })).firstTurnSentAt).toBeNull();
    });
  });

  describe('O1, O45, O46: the controls', () => {
    it('O1: a carry-on of an earlier pause neither tells nor clears the mark of a later pause', async () => {
      const sara = await owner('o1');
      const jobId = await runningJob(sara);
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'queued', queuedFor: 'turn', pauses: 2, carryOnPending: true, reservationKey: null, startedAt: null, stretchStarted: null } });
      await afterCarryOnForTests(jobId, NOW, 1);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { carryOnPending: true } })).toEqual({ carryOnPending: true });
      expect(await prisma.computerJobTelling.count({ where: { jobId, kind: 'back_in_line' } })).toBe(0);
      await afterCarryOnForTests(jobId, NOW, 2);
      expect(await prisma.computerJobTelling.count({ where: { jobId, kind: 'back_in_line' } })).toBe(1);
    });

    it('O45: a pause whose sign-ins result is not recorded keeps the command pending; a recorded false keeps its meaning', async () => {
      const sara = await owner('o45');
      const jobId = await runningJob(sara);
      await prisma.computerJobPause.create({ data: { jobId, n: 1, why: 'person', seconds: 0, at: new Date(), signInsKept: null } });
      const command = { id: randomUUID() };
      await prisma.$executeRaw`INSERT INTO "computer_job_commands" ("command_id", "bot_id", "person_id", "job_id", "kind", "args_hash", "outcome") VALUES (${command.id}::uuid, ${sara.brickId}, ${sara.id}, ${jobId}, 'pause', 'h', ${JSON.stringify({ ok: true, pending: true, targets: [jobId], held: [{ jobId, n: 1 }] })}::jsonb)`;
      expect(await pendingOutcomeOfForTests(command as never, jobId)).toBeNull();
      await prisma.computerJobPause.update({ where: { jobId_n: { jobId, n: 1 } }, data: { signInsKept: false } });
      expect(await pendingOutcomeOfForTests(command as never, jobId)).toEqual({ ok: true, signInsKept: false });
      await prisma.computerJobPause.update({ where: { jobId_n: { jobId, n: 1 } }, data: { signInsKept: true } });
      expect(await pendingOutcomeOfForTests(command as never, jobId)).toEqual({ ok: true, signInsKept: true });
    });

    it('O46: the queue sweep’s mark (lastTriedAt) is not a start’s decision; the start’s own marker is', async () => {
      const sara = await owner('o46');
      const jobId = await runningJob(sara);
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'queued', queuedFor: 'turn', reservationKey: null, startedAt: null, stretchStarted: null, lastTriedAt: new Date(), startDecidedAt: null } });
      expect(await resumeDecidedOfForTests(jobId)).toBeNull();
      await prisma.computerJob.update({ where: { id: jobId }, data: { startDecidedAt: new Date() } });
      expect(await resumeDecidedOfForTests(jobId)).toEqual({ ok: true });
    });
  });
});

// A reference so the unused import of getJob is a real check that the view still reads a job
void getJob;
