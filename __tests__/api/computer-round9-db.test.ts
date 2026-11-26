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
import { ackStart, claimJob, removalCheckpointForTests, storedStartAnswer, giveComputer, runnableJobsPage, startJob, stopAll, takeWakeTicketForTests, registerStart, refuseAttempt, retireStartKey, issuedOfKey, getJob } from '@/lib/computer';
import { startTurn } from '@/lib/computer-broker';
import { afterCarryOnForTests } from '@/lib/computer-limit-pause';
import { pendingOutcomeOfForTests, resumeDecidedOfForTests } from '@/lib/computer-job-controls';
import { recordResumeDecision } from '@/lib/computer-commands';
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
      // The books: no room is held for the failed start (the one it took was given back), and nothing was charged (CodeRabbit on #1025, N24)
      expect(await prisma.meterReservation.count({ where: { personId: sara.id, state: 'held' } })).toBe(0);
      expect(await prisma.meterReservation.count({ where: { jobId: row.id, state: 'settled' } })).toBe(0);
      expect(await prisma.meterEvent.count({ where: { jobId: row.id } })).toBe(0);
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
    it('a takeover from an outdated epoch is refused even when the beat is stale: only the epoch predicate can refuse it (CodeRabbit on #1025, N20)', async () => {
      const sara = await owner('o42-epoch');
      await wakingMachine(sara, 5, 10);
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 4, staleMs: 60_000 })).toBeNull();
      expect(await prisma.brickComputer.findUnique({ where: { botId: sara.brickId }, select: { wakeEpoch: true } })).toEqual({ wakeEpoch: 5 });
      // CONTROL: the same stale beat with the current epoch is taken over
      expect(await takeWakeTicketForTests(sara.brickId, 'waking', 'waking', { epoch: 5, staleMs: 60_000 })).toBe(6);
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
      // A later job is made before the retry: the retry ends the jobs the first request named, never one made after it (CodeRabbit on #1025, N21)
      const later = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Later' }, NOW);
      if (!later.ok) throw new Error('the later job was not made');
      const second = await stopAll(sara.brickId, sara.id, new Date(), command);
      expect(second.ok).toBe(true);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('stopped');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: later.job.id } })).status).not.toBe('stopped');
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
      // ONE missing job for every ask: the replay is of the same request, before and after the trigger is dropped (CodeRabbit on #1025, N25)
      const missing = randomUUID();
      const asked = () => post(sara, k, { 'x-computer-continues': missing });
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

    it('O40 (Opus): a refusal decided inside beginJob, before any job exists (computers off for this Brick), that cannot be kept is a retryable 503; the attempt stays open and the retry gets the same refusal, stored', async () => {
      const sara = await owner('o40-begin');
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { enabled: false } });
      const k = key();
      const undo = await plant('r9_fail_refuse3', 'computer_start_attempts', `NEW.state = 'refused'`, 'fail');
      let first;
      try {
        first = await post(sara, k);
      } finally {
        await undo();
      }
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({ retry: true });
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(0);
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'open' });
      const retry = await post(sara, k);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ ok: false, reason: 'off' });
      expect(await post(sara, k)).toEqual({ status: 200, body: retry.body });
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'refused' });
    });

    it('N2: a refusal the route decides that loses to another request which made the key’s own job is answered with that job, never the local refusal', async () => {
      const sara = await owner('n2');
      const k = key();
      const real = prisma.computerStartAttempt.updateMany.bind(prisma.computerStartAttempt) as (args: { data?: { state?: string } }) => Promise<unknown>;
      let madeJob: string | null = null;
      // Another request of the key makes the job between this request's look and its refusal write
      const spy = jest.spyOn(prisma.computerStartAttempt, 'updateMany').mockImplementation((async (args: { data?: { state?: string } }) => {
        if (madeJob === null && args.data?.state === 'refused') {
          const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A job', startKey: k, acks: true, began: new Date(), registration: { opened: false, reopened: false, release: async () => undefined } }, NOW);
          if (!other.ok) throw new Error('the other request made no job');
          madeJob = other.job.id;
        }
        return real(args);
      }) as never);
      let answer;
      try {
        answer = await post(sara, k, { 'x-computer-continues': randomUUID() });
      } finally {
        spy.mockRestore();
      }
      expect(madeJob).not.toBeNull();
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, job: { id: madeJob } });
      expect(answer.body).not.toMatchObject({ reason: 'cannot_continue' });
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(1);
    });

    it('N2 (d522f4b3 pass): the stored answer of a key that aliases an acknowledged job still in line only READS it: nothing is tried, no room is reserved, no machine is woken; the answer is that job as it stands', async () => {
      const sara = await owner('n2-readonly');
      await runningJob(sara, 'Busy');
      const kA = key();
      const first = await post(sara, kA);
      expect(first.body).toMatchObject({ ok: true, job: { status: 'queued' } });
      expect(await ackStart(sara.brickId, sara.id, kA)).toBe(true);
      const a = await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id, startKey: kA } });
      // Key B was answered with job A (a start under another key met it)
      const kB = key();
      await prisma.computerStartAttempt.create({ data: { botId: sara.brickId, personId: sara.id, startKey: kB, state: 'answered', jobId: a.id } });
      const before = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.id } });
      const rooms = await prisma.meterReservation.count({ where: { personId: sara.id } });
      const answer = await storedStartAnswer(sara.brickId, sara.id, kB, NOW);
      expect(answer).toMatchObject({ ok: true, job: { id: a.id, status: 'queued' } });
      // Nothing was tried for it: the try writes the line's rotation mark and the start's decision, and may reserve room
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.lastTriedAt).toEqual(before.lastTriedAt);
      expect(after.startDecidedAt).toEqual(before.startDecidedAt);
      expect(after.queuedFor).toEqual(before.queuedFor);
      expect(await prisma.meterReservation.count({ where: { personId: sara.id } })).toBe(rooms);
      // CONTROL: a start under key B (not a lookup) still tries the job it was answered with, as a repeated start of it would. The marker is cleared first, so the POST must SET it (a POST that only read the job would leave it null)
      await prisma.computerJob.update({ where: { id: a.id }, data: { startDecidedAt: null } });
      expect((await post(sara, kB)).body).toMatchObject({ ok: true, job: { id: a.id } });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a.id } })).startDecidedAt).not.toBeNull();
    });

    it('N5 and N17: a refusal for a job that the queue claimed after the decision takes nothing away and stores nothing: the job runs, the attempt stays `made`, and the answer is the job', async () => {
      const sara = await owner('n17');
      await prisma.appSetting.deleteMany({ where: { key: { in: ['meter'] } } });
      const k = key();
      // The queue sweep claims the job after the decision and before the refusal's transaction opens (the claim is committed on its own, as the sweep's would be). The moment is an explicit checkpoint of the code under test
      // (`removalCheckpointForTests`), never a guess made from the text of a function (CodeRabbit on #1025, d522f4b3 pass, N20)
      let claimed = false;
      removalCheckpointForTests.before = async () => {
        claimed = true;
        await prisma.computerJob.updateMany({ where: { personId: sara.id }, data: { status: 'running', queuedFor: null, startedAt: new Date() } });
      };
      let answer;
      try {
        answer = await post(sara, k);
      } finally {
        removalCheckpointForTests.before = null;
      }
      expect(claimed).toBe(true);
      const rows = await prisma.computerJob.findMany({ where: { personId: sara.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('running');
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, job: { id: rows[0].id, status: 'running' } });
      // Rolled back with the delete: the attempt is not a refusal that names a running job
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'made', jobId: rows[0].id });
    });

    it('N5 and N17 (Opus): a job another request took away with its own refusal on the key is answered with that stored refusal, never this request’s own', async () => {
      const sara = await owner('n17-gone');
      await prisma.appSetting.deleteMany({ where: { key: { in: ['meter'] } } });
      const k = key();
      let taken = false;
      removalCheckpointForTests.before = async () => {
        taken = true;
        // The other request removes the job and keeps ITS refusal on the key (a rule, not this request's `not_set`)
        await prisma.computerStartAttempt.updateMany({ where: { personId: sara.id, startKey: k }, data: { state: 'refused', outcome: { ok: false, reason: 'rule', words: 'no visas' } } });
        await prisma.computerJob.deleteMany({ where: { personId: sara.id } });
      };
      let answer;
      try {
        answer = await post(sara, k);
      } finally {
        removalCheckpointForTests.before = null;
      }
      expect(taken).toBe(true);
      expect(answer.body).toMatchObject({ ok: false, reason: 'rule', words: 'no visas' });
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'refused', outcome: { reason: 'rule' } });
    });

    it('N5 and N17 (Opus): a job that is gone with nothing kept on the key answers a retryable 503 not_kept, and stores nothing', async () => {
      const sara = await owner('n17-none');
      await prisma.appSetting.deleteMany({ where: { key: { in: ['meter'] } } });
      const k = key();
      let taken = false;
      removalCheckpointForTests.before = async () => {
        taken = true;
        await prisma.computerJob.deleteMany({ where: { personId: sara.id } });
      };
      let answer;
      try {
        answer = await post(sara, k);
      } finally {
        removalCheckpointForTests.before = null;
      }
      expect(taken).toBe(true);
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ retry: true });
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'made', outcome: null });
    });

    it('N17 (d522f4b3 pass): a refusal found by a REPLAY for a job the game had already acknowledged is kept on the key (decided from the start’s ack mode, not from the acknowledgement): the attempt becomes the refusal and later replays answer it', async () => {
      const sara = await owner('n17-acked');
      // The machine is busy, so the keyed start that acks is made and waits in line (queued), and the game acknowledges it
      await runningJob(sara, 'Busy');
      const k = key();
      const first = await post(sara, k);
      expect(first.body).toMatchObject({ ok: true, job: { status: 'queued' } });
      expect(await ackStart(sara.brickId, sara.id, k)).toBe(true);
      const acked = await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id, startKey: k } });
      expect(acked.startAckedAt).not.toBeNull();
      // A rule the person said has stopped it at the start (it never ran); the key is asked again before the ask that stopped it took it away
      await prisma.computerJob.update({ where: { id: acked.id }, data: { status: 'stopped', endedBy: 'rule', startedAt: null, endedAt: new Date() } });
      const replay = await post(sara, k);
      expect(replay.body).toMatchObject({ ok: false, reason: 'rule' });
      expect(await prisma.computerJob.count({ where: { personId: sara.id, startKey: k } })).toBe(0);
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'refused', outcome: { ok: false, reason: 'rule' } });
      // Later replays reproduce the refusal from the stored record (never `retired`, never a new job)
      expect((await post(sara, k)).body).toMatchObject({ ok: false, reason: 'rule' });
      expect(await prisma.computerJob.count({ where: { personId: sara.id, startKey: k } })).toBe(0);
    });

    it('N17 (d522f4b3 pass) CONTROL: a start that does NOT ack keeps no refusal on its key: the refusal found for its job is answered locally and its attempt is left as it was', async () => {
      const sara = await owner('n17-noack');
      await runningJob(sara, 'Busy');
      const k = key();
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Plain', startKey: k }, NOW);
      expect(first.ok).toBe(true);
      const job = await prisma.computerJob.findFirstOrThrow({ where: { personId: sara.id, startKey: k } });
      await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'stopped', endedBy: 'rule', startedAt: null, endedAt: new Date() } });
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Plain', startKey: k }, NOW);
      expect(again).toMatchObject({ ok: false, reason: 'rule' });
      expect(await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } })).toMatchObject({ state: 'made', outcome: null, issuedAt: null });
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
      // A safe integer that is beyond what a Date can hold reaches the Date guard (10 ** 17 would fail the safe-integer check before it); the last moment a Date holds is a moment (CodeRabbit on #1025, N19)
      expect(Number.isSafeInteger(8_640_000_000_000_001)).toBe(true);
      expect(issuedOfKey(`t${(8_640_000_000_000_001).toString(36)}-${'a'.repeat(32)}`)).toBeNull();
      expect(issuedOfKey(`t${(8_640_000_000_000_000).toString(36)}-${'a'.repeat(32)}`)?.getTime()).toBe(8_640_000_000_000_000);
      // Not a safe integer: refused before it is a Date
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
      try {
        expect(reopened.registration.reopened).toBe(true);
        const row = await prisma.computerStartAttempt.findFirstOrThrow({ where: { personId: sara.id, startKey: k } });
        expect(row.supersedeSince?.getTime()).toBe(issued.getTime());
        const redelivery = await startJob({ botId: sara.brickId, personId: sara.id, title: 'again', startKey: k, acks: true, began: new Date(), registration: { opened: false, reopened: false, release: async () => undefined } }, NOW);
        // It answers J (the job made after the person's message was issued), and makes no job of its own
        if (!j.ok) throw new Error('J was not made');
        expect(redelivery).toMatchObject({ ok: true, job: { id: j.job.id } });
        expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(1);
      } finally {
        // Let go even when an assertion above fails: the registration's beat would otherwise go on writing into later tests (CodeRabbit on #1025, N9)
        await reopened.registration.release();
      }
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

    it('O46 and N21: neither the queue sweep’s mark (lastTriedAt) nor its own decision for the same place in line (startDecidedAt) is a Resume’s decision; only what the Resume’s own start recorded on its command is', async () => {
      const sara = await owner('o46');
      const jobId = await runningJob(sara);
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'queued', queuedFor: 'turn', reservationKey: null, startedAt: null, stretchStarted: null, lastTriedAt: new Date(), startDecidedAt: null } });
      const command = { id: randomUUID() };
      await prisma.$executeRaw`INSERT INTO "computer_job_commands" ("command_id", "bot_id", "job_id", "person_id", "kind", "args_hash", "outcome", "stretch", "created_at") VALUES (${command.id}::uuid, ${sara.brickId}, ${jobId}, ${sara.id}, 'resume', 'h', '{"ok":true,"pending":true}'::jsonb, 0, NOW())`;
      expect(await resumeDecidedOfForTests(command, jobId)).toBeNull();
      // A try that is not this Resume's (the sweep's) decides for the same place in line: it is not this Resume's decision
      await prisma.computerJob.update({ where: { id: jobId }, data: { startDecidedAt: new Date() } });
      expect(await resumeDecidedOfForTests(command, jobId)).toBeNull();
      // The Resume's own start records what it came to, once
      await recordResumeDecision(command.id, jobId, 0);
      expect(await resumeDecidedOfForTests(command, jobId)).toEqual({ ok: true });
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepState: 'recover', stretchStarted: null } });
      await recordResumeDecision(command.id, jobId, 0);
      expect(await resumeDecidedOfForTests(command, jobId)).toEqual({ ok: true });
    });
  });
});

// A reference so the unused import of getJob is a real check that the view still reads a job
void getJob;
