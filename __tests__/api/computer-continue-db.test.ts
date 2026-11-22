/**
 * "Try again" carries on (piece 8 of the computer controls): a new job in the old job's agent conversation, against a real database. Each money rule has its control: a continuation is a NEW job with its own
 * reservation, receipt and start key; one continuation per old job, ever; only a job that failed as ours or that we ended qualifies, never the person's own Stop or Cancel. Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-continue-db.test.ts --runInBand
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
import { Agent37Error } from '@/lib/agent37/client';
import { ackStart, finishJob, giveComputer, runnableJobs, startJob, stopJobFor } from '@/lib/computer';
import { prepareJob, startTurn } from '@/lib/computer-broker';
import { carriedOnFrom, carryOnFrom, retryCandidate } from '@/lib/computer-continue';
import { continuableEnding, CONTINUES_AFTER } from '@/lib/computer-values';
import { GET, POST } from '@/app/api/bots/[id]/computer-jobs/route';
import { pauseCapability, resumeCapability } from '@/lib/capability-pause';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
// The real clock (as computer-db and the broker suite): a failed start ends its job at the real now
const NOW = new Date();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
/** The pretend provider's price: 6,000 micros a minute, so 5 minutes are 30,000. */
const PER_MINUTE = 6_000;
let fake: FakeComputerProvider;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: unique, brickId: brick.id };
}

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.updateMany({ where: { personId: { in: people } }, data: { continuesJobId: null } });
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerStartAttempt.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

const jobOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
const timeEvents = (jobId: string) => prisma.meterEvent.findMany({ where: { jobId, kind: 'computer_time' }, orderBy: { eventId: 'asc' } });
const roomsOf = (jobId: string) => prisma.meterReservation.findMany({ where: { reservationKey: { startsWith: `computer:job:${jobId}:` } } });
const key = () => `k_${randomUUID().replace(/-/g, '')}`;

/** A person with a Brick with a computer, and one job that ran from NOW and reached its agent (its conversation is `sess-<title>`). */
async function ranOnce(name: string, title = 'Visa form') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title }, NOW);
  if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
  await prisma.computerJob.update({ where: { id: started.job.id }, data: { agentSessionId: `sess-${title}` } });
  return { sara, jobId: started.job.id };
}

/** Ends a job the way the record would have it, for the endings that need no machine: nobody answered, our pool cut it off, the month or a limit ended it. */
const endedAs = (jobId: string, endedBy: string, at: Date = minutes(5)) => prisma.computerJob.update({ where: { id: jobId }, data: { status: 'stopped', endedBy, endedAt: at, reservationKey: null, stretchStarted: null } });

/** A job that failed as ours (the runner said so and it was given back): `ended_by = 'error'`. */
async function failedAsOurs(name: string) {
  const ran = await ranOnce(name);
  await finishJob(ran.jobId, 'failed', minutes(5), null, 'ours');
  const job = await jobOf(ran.jobId);
  if (job.status !== 'failed' || job.endedBy !== 'error') throw new Error(`the job did not fail as ours: ${job.status} ${job.endedBy}`);
  return ran;
}

const tryAgain = (sara: { id: string; brickId: string }, from: string, at: Date = minutes(6), extra: { startKey?: string; acks?: boolean; title?: string } = {}) =>
  startJob({ botId: sara.brickId, personId: sara.id, title: extra.title ?? 'Visa form', continuesJobId: from, ...(extra.startKey ? { startKey: extra.startKey } : {}), ...(extra.acks ? { acks: true } : {}) }, at);

run('"try again" carries on in the same conversation (piece 8), in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
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

  describe('a continuation is a NEW job: its own reservation, receipt and key, in the old job’s conversation', () => {
    it('after a failure of ours, "try again" makes a new job linked to the old one, with the old conversation, a reservation of its own, and the answer says it carried on', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-new');
      const before = { events: await timeEvents(old), rooms: await roomsOf(old), row: await jobOf(old) };
      const k = key();
      const again = await tryAgain(sara, old, minutes(6), { startKey: k });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.continued).toBe(true);
      expect(again.job.id).not.toBe(old);
      expect(again.job.status).toBe('running');
      const job = await jobOf(again.job.id);
      expect(job).toMatchObject({ continuesJobId: old, agentSessionId: 'sess-Visa form', agentResponseId: null, startKey: k, personId: sara.id, botId: sara.brickId, status: 'running' });
      // Its OWN room, made for it now: never the old job's key
      const rooms = await roomsOf(again.job.id);
      expect(rooms).toHaveLength(1);
      expect(rooms[0].state).toBe('held');
      expect(job.reservationKey).toBe(rooms[0].reservationKey);
      expect(before.rooms.map((room) => room.reservationKey)).not.toContain(job.reservationKey);
      // The old job is left exactly as it ended: its room, its receipt, its ending
      expect(await roomsOf(old)).toEqual(before.rooms);
      expect(await timeEvents(old)).toEqual(before.events);
      expect(await jobOf(old)).toMatchObject({ status: before.row.status, endedBy: before.row.endedBy, endedAt: before.row.endedAt, agentSessionId: 'sess-Visa form' });
    });

    it('the continuation is charged ONCE, on its own receipt, for its own time only: the old job’s receipt is never written again', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-money');
      const oldEvents = await timeEvents(old);
      const again = await tryAgain(sara, old, minutes(6));
      if (!again.ok) throw new Error('no continuation');
      await finishJob(again.job.id, 'done', minutes(11));
      const events = await timeEvents(again.job.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: `computer:${again.job.id}:time`, quantity: BigInt(300), costMicros: BigInt(5 * PER_MINUTE), personId: sara.id });
      expect(await timeEvents(old)).toEqual(oldEvents);
      // Its own room is settled at its own five minutes, once
      const rooms = await roomsOf(again.job.id);
      expect(rooms).toHaveLength(1);
      expect(rooms[0]).toMatchObject({ state: 'settled', settledMicros: BigInt(5 * PER_MINUTE) });
    });

    it('the ending keeps the agent conversation id on the old job (it is how "try again" carries on), and the runner is told which job it carries on from', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-keeps');
      expect((await jobOf(old)).agentSessionId).toBe('sess-Visa form');
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no continuation');
      const listed = (await runnableJobs(200)).find((job) => job.jobId === again.job.id);
      expect(listed).toMatchObject({ continuesJobId: old, hasTurn: false });
      // An ordinary job says it carries on from nothing
      const other = await ranOnce('c-keeps-other');
      expect((await runnableJobs(200)).find((job) => job.jobId === other.jobId)).toMatchObject({ continuesJobId: null });
    });
  });

  describe('one continuation per old job, ever', () => {
    it('the same "try again" delivered again (the same start key) is the same job: no second job, no second reservation', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-redeliver');
      const k = key();
      const first = await tryAgain(sara, old, minutes(6), { startKey: k });
      const second = await tryAgain(sara, old, minutes(6), { startKey: k });
      if (!first.ok || !second.ok) throw new Error('no continuation');
      expect(second.job.id).toBe(first.job.id);
      expect(second.continued).toBe(true);
      expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(1);
      expect(await roomsOf(first.job.id)).toHaveLength(1);
    });

    it('a second "try again" of the same job under a NEW key (another message) finds the job the first made, whatever it came to, and makes nothing', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-second');
      const first = await tryAgain(sara, old, minutes(6), { startKey: key() });
      if (!first.ok) throw new Error('no continuation');
      const second = await tryAgain(sara, old, minutes(7), { startKey: key() });
      expect(second).toMatchObject({ ok: true, continued: true, job: { id: first.job.id } });
      // ...also once it is over
      await finishJob(first.job.id, 'done', minutes(8));
      const third = await tryAgain(sara, old, minutes(9), { startKey: key() });
      expect(third.ok && third.job.id).toBe(first.job.id);
      expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(1);
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(2);
      expect(await roomsOf(first.job.id)).toHaveLength(1);
    });

    it('two "try again" asks at the same moment make ONE job between them (the unique index), and both are answered with it', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-race');
      const [a, b] = await Promise.all([tryAgain(sara, old, minutes(6), { startKey: key() }), tryAgain(sara, old, minutes(6), { startKey: key() })]);
      if (!a.ok || !b.ok) throw new Error(`a start was refused: ${JSON.stringify([a, b])}`);
      expect(a.job.id).toBe(b.job.id);
      expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(1);
      expect(await prisma.computerJob.count({ where: { personId: sara.id } })).toBe(2);
    });

    it('the database itself refuses a second job that carries on the same one', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-index');
      const first = await tryAgain(sara, old);
      if (!first.ok) throw new Error('no continuation');
      await expect(prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Visa form', continuesJobId: old } })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('which jobs carry on: only a failure of ours or an ending we made; the person’s own Stop is a fresh job', () => {
    it.each(CONTINUES_AFTER.filter((how) => how !== 'error'))('a job ended by us (%s) carries on', async (how) => {
      const { sara, jobId: old } = await ranOnce(`c-ours-${how}`);
      await stopJobFor(sara.brickId, sara.id, minutes(5));
      await endedAs(old, how);
      const again = await tryAgain(sara, old);
      expect(again).toMatchObject({ ok: true, continued: true });
      if (again.ok) expect((await jobOf(again.job.id)).continuesJobId).toBe(old);
    });

    it('after the person’s own Stop, "try again" is a fresh job: no link, no conversation, not said to carry on', async () => {
      const { sara, jobId: old } = await ranOnce('c-person');
      await stopJobFor(sara.brickId, sara.id, minutes(5));
      expect((await jobOf(old)).endedBy).toBe('person');
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no job');
      expect(again.continued).toBeUndefined();
      expect(await jobOf(again.job.id)).toMatchObject({ continuesJobId: null, agentSessionId: null });
      expect(again.job.id).not.toBe(old);
    });

    it.each([
      ['a failure the agent itself gave (the person’s)', async (jobId: string) => void (await finishJob(jobId, 'failed', minutes(5), 'It could not find the form', 'agent'))],
      ['a job that finished', async (jobId: string) => void (await finishJob(jobId, 'done', minutes(5)))],
      ['a computer turned off', async (jobId: string) => void (await endedAs(jobId, 'off'))],
    ])('after %s, it is a fresh job', async (_what, end) => {
      const { sara, jobId: old } = await ranOnce(`c-fresh-${++made}`);
      await end(old);
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no job');
      expect(again.continued).toBeUndefined();
      expect(await jobOf(again.job.id)).toMatchObject({ continuesJobId: null, agentSessionId: null });
    });

    it('a job that is still going on is never carried on (asked for one, the start is a fresh job beside it in line)', async () => {
      const { sara, jobId: live } = await ranOnce('c-live');
      const again = await tryAgain(sara, live);
      if (!again.ok) throw new Error('no job');
      expect(again.continued).toBeUndefined();
      expect(again.job.id).not.toBe(live);
      expect(await jobOf(again.job.id)).toMatchObject({ continuesJobId: null, agentSessionId: null });
      expect(await jobOf(live)).toMatchObject({ status: 'running' });
    });

    it('another person’s job, or another Brick’s, is never carried on', async () => {
      const { jobId: theirs } = await failedAsOurs('c-theirs');
      const mine = await person('c-mine');
      await giveComputer(mine.brickId, mine.id);
      const again = await tryAgain(mine, theirs);
      if (!again.ok) throw new Error('no job');
      expect(again.continued).toBeUndefined();
      expect(await jobOf(again.job.id)).toMatchObject({ continuesJobId: null, agentSessionId: null });
      expect(await prisma.computerJob.count({ where: { continuesJobId: theirs } })).toBe(0);
    });

    it('a job that never reached its agent has no conversation to carry on: a fresh job', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-nosession');
      await prisma.computerJob.update({ where: { id: old }, data: { agentSessionId: null } });
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no job');
      expect(again.continued).toBeUndefined();
      expect((await jobOf(again.job.id)).continuesJobId).toBeNull();
    });

    it('the one list of endings that carry on', () => {
      expect([...CONTINUES_AFTER].sort()).toEqual(['allowance', 'error', 'pool', 'rule', 'unanswered']);
      expect(continuableEnding('stopped', 'person')).toBe(false);
      expect(continuableEnding('failed', null)).toBe(false);
      expect(continuableEnding('done', null)).toBe(false);
      expect(continuableEnding('running', 'error')).toBe(false);
      expect(continuableEnding('failed', 'error')).toBe(true);
    });
  });

  describe('every guard of a start applies to a continuation', () => {
    it('an earlier start of the person’s that the game has not confirmed answers `earlier` and makes no continuation', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-earlier');
      const unconfirmed = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Shop', startKey: key(), acks: true }, minutes(6));
      if (!unconfirmed.ok) throw new Error('the earlier start was refused');
      const again = await tryAgain(sara, old, minutes(7), { startKey: key(), acks: true });
      expect(again).toMatchObject({ ok: false, reason: 'earlier', job: { id: unconfirmed.job.id } });
      expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(0);
    });

    it('a continuation that is not confirmed yet is answered as the earlier job to a second "try again" under another key, never as a second job', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-earlier-own');
      const k1 = key();
      const first = await tryAgain(sara, old, minutes(6), { startKey: k1, acks: true });
      if (!first.ok) throw new Error('no continuation');
      const second = await tryAgain(sara, old, minutes(7), { startKey: key(), acks: true });
      expect(second).toMatchObject({ ok: false, reason: 'earlier', job: { id: first.job.id, attempt: k1 } });
      // Once confirmed, the same ask finds it as the job it is
      await ackStart(sara.brickId, sara.id, k1);
      const third = await tryAgain(sara, old, minutes(8), { startKey: key(), acks: true });
      expect(third).toMatchObject({ ok: true, continued: true, job: { id: first.job.id } });
      expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(1);
    });

    it('computers paused by the team: no continuation starts, like any start', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-paused');
      await pauseCapability('computers', sara.id);
      try {
        expect(await tryAgain(sara, old)).toEqual({ ok: false, reason: 'paused' });
        expect(await prisma.computerJob.count({ where: { continuesJobId: old } })).toBe(0);
      } finally {
        await resumeCapability('computers', sara.id);
      }
    });

    it('the month used up: the continuation waits in line with its work saved, like any start, and is still the one continuation', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-month');
      await saveMeterSettings({ memberAllowanceMicros: 1, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      const again = await tryAgain(sara, old, minutes(6), { startKey: key() });
      expect(again).toMatchObject({ ok: true, continued: true, job: { status: 'queued', queuedFor: 'allowance' } });
      if (again.ok) expect(await roomsOf(again.job.id)).toHaveLength(0);
    });
  });

  describe('the look the game makes before it asks (retry candidate)', () => {
    it('names the person’s latest ended job when it carries on, and none once it was carried on', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-look');
      expect(await retryCandidate(sara.brickId, sara.id)).toMatchObject({ id: old, title: 'Visa form', how: 'error' });
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no continuation');
      expect(await retryCandidate(sara.brickId, sara.id)).toBeNull();
      // The continuation itself, once it failed as ours, is the next one to carry on
      await prisma.computerJob.update({ where: { id: again.job.id }, data: { agentSessionId: 'sess-Visa form' } });
      await finishJob(again.job.id, 'failed', minutes(9), null, 'ours');
      expect(await retryCandidate(sara.brickId, sara.id)).toMatchObject({ id: again.job.id });
      expect(await carriedOnFrom(again.job.id)).toEqual([old]);
    });

    it('names none after the person’s own Stop, and none when a newer job finished (they moved on)', async () => {
      const stopped = await ranOnce('c-look-stop');
      await stopJobFor(stopped.sara.brickId, stopped.sara.id, minutes(5));
      expect(await retryCandidate(stopped.sara.brickId, stopped.sara.id)).toBeNull();
      const { sara, jobId: old } = await failedAsOurs('c-look-newer');
      const newer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Shop' }, minutes(6));
      if (!newer.ok) throw new Error('no job');
      expect(await retryCandidate(sara.brickId, sara.id)).toMatchObject({ id: old });
      await finishJob(newer.job.id, 'done', minutes(8));
      expect(await retryCandidate(sara.brickId, sara.id)).toBeNull();
    });

    it('never names another person’s job', async () => {
      const { jobId } = await failedAsOurs('c-look-theirs');
      const other = await person('c-look-other');
      expect(await retryCandidate(other.brickId, other.id)).toBeNull();
      expect(jobId).toBeTruthy();
    });

    it('carryOnFrom decides from the record alone', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-decide');
      expect(await carryOnFrom(sara.brickId, sara.id, old)).toEqual({ link: { continuesJobId: old, agentSessionId: 'sess-Visa form' } });
      expect(await carryOnFrom(sara.brickId, sara.id, randomUUID())).toEqual({ fresh: 'not_found' });
      expect(await carryOnFrom(sara.brickId, randomUUID(), old)).toEqual({ fresh: 'not_theirs' });
      // A job still going on is never carried on, even one whose record already names an ending of ours and a conversation
      const live = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Shop' }, minutes(6));
      if (!live.ok) throw new Error('no job');
      await prisma.computerJob.update({ where: { id: live.job.id }, data: { endedBy: 'error', agentSessionId: 'sess-Shop' } });
      expect(await carryOnFrom(sara.brickId, sara.id, live.job.id)).toEqual({ fresh: 'live' });
    });

    it('names none, and carries none on, when the job never reached its agent (no conversation)', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-look-nosession');
      await prisma.computerJob.update({ where: { id: old }, data: { agentSessionId: null } });
      expect(await retryCandidate(sara.brickId, sara.id)).toBeNull();
      expect(await carryOnFrom(sara.brickId, sara.id, old)).toEqual({ fresh: 'no_conversation' });
    });
  });

  describe('the conversation on the machine', () => {
    const RELAY = 'https://bot-server.example.test';

    it('a continuation’s key is also written under the id of every job it carries on from, so a call that names the old job’s tag goes with the NEW key; an ordinary job writes only its own', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-alias');
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no continuation');
      const prepared = await prepareJob(again.job.id, RELAY, minutes(6));
      expect(prepared.ok).toBe(true);
      const command = fake.commands.at(-1)?.command ?? '';
      const token = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(command)?.[1] ?? '';
      expect(token).not.toBe('');
      expect(command).toContain(`"$d/jobs/${again.job.id}.json"`);
      expect(command).toContain(`"$d/jobs/${old}.json"`);
      // The SAME key goes under both ids (never the old job's, which ended with it)
      const writes = [...command.matchAll(/printf '%s' '(\{[^']*\})' > "\$d\/jobs\/([A-Za-z0-9-]+)\.json\.new"/g)].map((m) => ({ id: m[2], token: /"token":"([^"]+)"/.exec(m[1])?.[1] }));
      expect(writes).toEqual(expect.arrayContaining([{ id: again.job.id, token }, { id: old, token }]));
      // An ordinary job
      const other = await ranOnce('c-alias-other');
      await prepareJob(other.jobId, RELAY, minutes(6));
      const plain = fake.commands.at(-1)?.command ?? '';
      expect([...plain.matchAll(/"\$d\/jobs\/([A-Za-z0-9-]+)\.json"/g)].map((m) => m[1])).toEqual([other.jobId]);
    });

    it('the first turn of a continuation goes on in the old conversation', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-turn');
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no continuation');
      const turn = await startTurn(again.job.id, 'carry on');
      expect(turn.ok).toBe(true);
      expect(fake.openedTurns.at(-1)?.input.sessionId).toBe('sess-Visa form');
    });

    it('a computer that no longer has the conversation (404): the continuation lets its copy of the id go, so its next turn starts a conversation of its own; an ordinary job keeps its own', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-404');
      const again = await tryAgain(sara, old);
      if (!again.ok) throw new Error('no continuation');
      fake.openTurn = async () => {
        throw new Agent37Error(404, 'not_found', 'no such session');
      };
      expect(await startTurn(again.job.id, 'carry on')).toEqual({ ok: false, reason: 'failed' });
      expect((await jobOf(again.job.id)).agentSessionId).toBeNull();
      // The old job's own record is untouched
      expect((await jobOf(old)).agentSessionId).toBe('sess-Visa form');
      const other = await ranOnce('c-404-other');
      expect(await startTurn(other.jobId, 'next')).toEqual({ ok: false, reason: 'failed' });
      expect((await jobOf(other.jobId)).agentSessionId).toBe('sess-Visa form');
    });
  });

  describe('the route', () => {
    const post = (brickId: string, body: object, headers: Record<string, string> = {}) =>
      POST(new NextRequest(`http://orbit.test/api/bots/${brickId}/computer-jobs`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }), { params: Promise.resolve({ id: brickId }) });

    it('the header X-Computer-Continues carries on the named job, says `continued`, and a header that is no id is refused', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-route');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: sara.id } });
      const bad = await post(sara.brickId, { userId: user.uuid, title: 'Visa form' }, { 'x-computer-continues': 'not an id!' });
      expect(bad.status).toBe(400);
      const res = await post(sara.brickId, { userId: user.uuid, title: 'Visa form' }, { 'x-computer-continues': old, 'x-computer-start-attempt': key() });
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, continued: true });
      expect((await jobOf(body.job.id)).continuesJobId).toBe(old);
      // Without the header: an ordinary start, no `continued`
      await finishJob(body.job.id, 'done', minutes(9));
      const plain = await (await post(sara.brickId, { userId: user.uuid, title: 'Shop' })).json();
      expect(plain.ok).toBe(true);
      expect(plain.continued).toBeUndefined();
    });

    it('GET with retry=1 names the job "try again" would carry on (and only then)', async () => {
      const { sara, jobId: old } = await failedAsOurs('c-route-get');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: sara.id } });
      const get = (query: string) => GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(user.uuid)}${query}`), { params: Promise.resolve({ id: sara.brickId }) });
      const asked = await (await get('&retry=1')).json();
      expect(asked.retry).toMatchObject({ id: old, title: 'Visa form', how: 'error' });
      const plain = await (await get('')).json();
      expect(plain.retry).toBeUndefined();
      const stranger = await person('c-route-stranger');
      const theirs = await (await GET(new NextRequest(`http://orbit.test/api/bots/${sara.brickId}/computer-jobs?userId=${encodeURIComponent(stranger.uuid)}&retry=1`), { params: Promise.resolve({ id: sara.brickId }) })).json();
      expect(theirs.retry).toBeNull();
    });
  });
});
