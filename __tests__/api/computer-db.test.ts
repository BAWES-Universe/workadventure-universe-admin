/**
 * A Brick's computer against a real database (game #2000, Brick 9), with the PRETEND provider: what only the database can show.
 * Giving a computer makes no machine. Two jobs started at the same moment make one computer and one writer. Room comes from the
 * meter's allowance and goes back; used up it queues and "Ask for more" is the only way on. Watching wakes nothing. Pay and submit
 * are never Brick's; a retry never does an outside effect twice. Delete and turn-off stop everything. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { memoryStore } from '../helpers/archive-store';
import { setArchiveStoreForTests } from '@/lib/computer-archives';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { sweepPurges } from '@/lib/brick-purge';
import { confirmChatPurges } from '@/lib/brick-purge';
import { saveServerLimits } from '@/lib/bot-limits';
import * as meter from '@/lib/meter';

// The books' own writer, wrapped so a test can make one write fail and every other one run as it always does
const actualRecord = jest.requireActual('@/lib/meter').recordMeterEvent as typeof meter.recordMeterEvent;
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn(actual.recordMeterEvent) };
});
import { saveMeterSettings, getMeterSettings } from '@/lib/meter';
import { diskRoomKey, envelopeIn, releaseRoom, reserveDiskRoom } from '@/lib/meter-allowance';
import { currentEnvelope } from '@/lib/meter-allowance';
import { activityFor } from '@/lib/task-receipts';
import { recordGrant } from '@/lib/meter-grants';
import { STEP_LABEL_FALLBACK } from '@/lib/computer-redact';
import { mintJobToken, TOKEN_LIFE_MS, TOKEN_RENEW_EVERY_SECONDS, verifyJobToken } from '@/lib/computer-token';
import { startStateOf } from '@/lib/computer-values';
import { CLAIM_MS, dbImageStore } from '@/lib/agent37/image';
import { checkScreen, openScreen, screenTicket } from '@/lib/computer-screen';
import { CONTROL_TIMING } from '@/lib/computer-control';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { pauseJob } from '@/lib/computer-job-controls';
import { controlInternals } from '@/lib/computer';
import { setPowerTimingForTests } from '@/lib/computer-power';
import {
  computerView,
  continueWindDown,
  fillInDetails,
  detailsKey,
  dismissComputerNotice,
  finishJob,
  giveComputer,
  handBack,
  isWindingDown,
  liftWindDown,
  planEffect,
  renewJob,
  getJob,
  reportProgress,
  requestHandover,
  settleEffect,
  startJob,
  startedJobFor,
  startFenceOf,
  START_MARK_MS,
  startMarkTiming,
  startWindDown,
  stopJobFor,
  sweepComputers,
  windDownStatus,
  takeOver,
  turnOffComputer,
} from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
// Rows get their own times from the database's clock and from `@updatedAt` (now): the tests' clock starts at the real now, so "ten minutes later" is later than those rows whatever day it is run
const NOW = new Date();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
// The database stamps a machine's last change and a Brick's last look with the real clock, and the sweep reads them against the `now` it is given
// (the test's own, earlier than the real one): the rows are put back to the test's clock before a sweep, so the test never depends on the day it runs
const backdate = async (botIds: string[]) => {
  await prisma.brickComputer.updateMany({ where: { botId: { in: botIds } }, data: { updatedAt: NOW } });
  await prisma.bot.updateMany({ where: { id: { in: botIds } }, data: { updatedAt: NOW } });
};
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string): Promise<{ id: string; brickId: string }> {
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
  await prisma.computerStartMark.deleteMany({});
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
};

/** The Brick's days are over and the sweep purges it for good (what the owner's page and the bot server's sweep both do). */
const purge = async (brickId: string, ownerId: string, at: Date) => {
  await prisma.bot.update({ where: { id: brickId }, data: { goneAt: at } });
  return removeGoneBricks(at, ownerId);
};

const woke = () => provider.calls.filter((call) => call.name === 'create' || call.name === 'wake').length;

run('a Brick’s computer, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    // Screen tickets are signed with it
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
    // The waits of a change of hands are short here: the order is what is tested, not real seconds
    Object.assign(CONTROL_TIMING, { openLeaseMs: 60, inputLeaseMs: 60, pollMs: 10, joinMs: 4000 });
  });
  beforeEach(async () => {
    await wipe();
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    setArchiveStoreForTests(memoryStore().store);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
    setArchiveStoreForTests(null);
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('giving a computer', () => {
    it('makes no machine and calls the provider for nothing: a new account with no job makes zero computer calls', async () => {
      const sara = await person('sara');
      const given = await giveComputer(sara.brickId, sara.id);
      expect(given.ok && given.view).toMatchObject({ available: true, on: true, machine: 'none', job: null, queued: [] });
      expect(provider.calls).toEqual([]);
      // Reading it never makes or wakes anything either
      await computerView(sara.brickId, sara.id);
      expect(provider.calls).toEqual([]);
    });

    it('is the same computer when asked twice, and there is no per-person switch: every member can', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await giveComputer(sara.brickId, sara.id);
      await giveComputer(sara.brickId, sara.id);
      expect(await prisma.brickComputer.count({ where: { botId: sara.brickId } })).toBe(1);
      const other = await giveComputer(omar.brickId, omar.id);
      expect(other.ok).toBe(true);
    });

    it('is only for the owner of a Brick: someone else, a room bot and a Brick that is not there are the same "not found"', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      expect(await giveComputer(sara.brickId, omar.id)).toEqual({ ok: false, reason: 'not_found' });
      expect(await computerView(sara.brickId, omar.id)).toBeNull();
      expect(await turnOffComputer(sara.brickId, omar.id)).toBeNull();
      expect(await giveComputer(randomUUID(), sara.id)).toEqual({ ok: false, reason: 'not_found' });
      expect(await startJob({ botId: sara.brickId, personId: omar.id, title: 'x' })).toEqual({ ok: false, reason: 'not_owner' });
      expect((await screenTicket(sara.brickId, omar.id)).ok).toBe(false);
    });

    it('is not open on a server with no provider: nothing is made and the page can say so', async () => {
      const sara = await person('sara');
      setComputerProviderForTests(null);
      process.env.COMPUTER_PROVIDER = '';
      expect(await giveComputer(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'not_open' });
      expect((await computerView(sara.brickId, sara.id))?.available).toBe(false);
      process.env.COMPUTER_PROVIDER = 'fake';
      setComputerProviderForTests(provider);
    });

    it('is refused while the meter’s controls are not set up, and leaves no job behind', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'x' }, NOW)).toEqual({ ok: false, reason: 'not_set' });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      expect(provider.calls).toEqual([]);
    });
  });

  describe('a job', () => {
    it('makes the machine once at the first real need, wakes it, and holds the person’s room', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      expect(started.ok && started.job).toMatchObject({ status: 'running', title: 'Visa form', writes: true, control: 'brick' });
      // The machine is made, woken, and listed once as the job begins (the files that were there before, so the message can name what it saved elsewhere)
      expect(provider.calls.map((call) => call.name)).toEqual(['create', 'wake', 'exec']);
      const view = await computerView(sara.brickId, sara.id, NOW);
      expect(view).toMatchObject({ machine: 'working', job: { status: 'running' } });
      expect((await currentEnvelope(NOW)).reservedMicros).toBeGreaterThan(0);
    });

    it('lets two jobs started at the same moment make ONE computer and ONE writer: the second waits its turn', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const both = await Promise.all([startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW), startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW)]);
      const statuses = both.map((one) => (one.ok ? one.job.status : 'no')).sort();
      expect(statuses).toEqual(['queued', 'running']);
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
      const queued = both.find((one) => one.ok && one.job.status === 'queued');
      expect(queued && queued.ok && queued.job.queuedFor).toBe('turn');
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, writes: true, status: { in: ['running', 'waiting'] } } })).toBe(1);
    });

    it('is held by the database too: a second running writer cannot be written at all', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      await expect(prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'sneaky', status: 'running', writes: true } })).rejects.toThrow();
      // Work proven read-only may overlap
      await expect(prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'look', status: 'running', writes: false } })).resolves.toBeTruthy();
    });

    it('F: two read-only jobs run side by side on the same machine, with nothing woken twice', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const one = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look one', writes: false }, NOW);
      // The first reader really runs, and it is the one that woke the machine (so a second reader that runs without a wake is on that wake, not on a machine that was awake already)
      if (!one.ok) throw new Error('the first reader did not start');
      expect(one.job.status).toBe('running');
      const before = woke();
      expect(before).toBeGreaterThan(0);
      const look = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look two', writes: false }, NOW);
      if (!look.ok) throw new Error('the second reader did not start');
      expect(look.job.status).toBe('running');
      expect(woke()).toBe(before);
      // Two distinct jobs, both still running side by side
      expect(look.job.id).not.toBe(one.job.id);
      const both = await prisma.computerJob.findMany({ where: { botId: sara.brickId }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true } });
      expect(both).toEqual([
        { id: one.job.id, status: 'running' },
        { id: look.job.id, status: 'running' },
      ]);
    });

    it('F: a reader is running and a writer is asked: the writer waits its turn in line (queued `turn`) and starts when the reader ends', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look', writes: false }, NOW);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'write', writes: true }, NOW);
      if (!reader.ok || !writer.ok) throw new Error('did not start');
      expect(reader.job.status).toBe('running');
      expect(writer.job.status).toBe('queued');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: writer.job.id } })).toMatchObject({ status: 'queued', queuedFor: 'turn' });
      await sweepComputers(minutes(1));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: writer.job.id } })).status).toBe('queued');
      await finishJob(reader.job.id, 'done', minutes(2));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: writer.job.id } })).toMatchObject({ status: 'running', queuedFor: null });
    });

    it('F: a writer is running and a reader is asked: the reader waits its turn in line (queued `turn`) and starts when the writer ends', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'write', writes: true }, NOW);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look', writes: false }, NOW);
      if (!reader.ok || !writer.ok) throw new Error('did not start');
      expect(writer.job.status).toBe('running');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).toMatchObject({ status: 'queued', queuedFor: 'turn' });
      await sweepComputers(minutes(1));
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).status).toBe('queued');
      await finishJob(writer.job.id, 'done', minutes(2));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).toMatchObject({ status: 'running', queuedFor: null });
    });

    it('F: two readers, one paused: nothing is put away or emptied while the other works, no job is claimed in between, and the browser is emptied once after the other ends, before the line moves', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const one = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look one', writes: false }, NOW);
      const two = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look two', writes: false }, NOW);
      if (!one.ok || !two.ok) throw new Error('did not start');
      expect([one.job.status, two.job.status]).toEqual(['running', 'running']);
      const actions = () => provider.commands.map((entry) => /ACTION="([a-z]+)"/.exec(entry.command)?.[1]).filter(Boolean);
      expect((await pauseJob(sara.brickId, sara.id, one.job.id, minutes(1))).ok).toBe(true);
      // The other keeps working untouched: no park, no clear
      expect(actions()).toEqual([]);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: two.job.id } })).toMatchObject({ status: 'running' });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: one.job.id, parkPendingWipe: true });
      expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: one.job.id, n: 1 } } })).signInsKept).toBe(false);
      // A job asked for in the meantime is not claimed while the wipe waits
      const three = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look three', writes: false }, minutes(2));
      if (!three.ok) throw new Error('the third reader was not made');
      expect(three.job.status).toBe('queued');
      await sweepComputers(minutes(2));
      expect(actions()).toEqual([]);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: three.job.id } })).status).toBe('queued');
      // The other ends: the browser is emptied once, the marker and the wipe go, and only then does the job in line start. The clear is held at a checkpoint: while it is under way the job in line is still queued
      let clearStarted: () => void = () => undefined;
      const clearing = new Promise<void>((resolve) => (clearStarted = resolve));
      let letClearGo: () => void = () => undefined;
      const clearGate = new Promise<void>((resolve) => (letClearGo = resolve));
      provider.execAnswer = async (command) => {
        if (!/ACTION="clear"/.test(command)) return {};
        clearStarted();
        await clearGate;
        return { stdout: 'cleared=1\n' };
      };
      const ending = finishJob(two.job.id, 'done', minutes(3));
      try {
        // (a finish that ends before it reaches the clear rejects the wait, with its own error)
        await Promise.race([clearing, ending.then(() => Promise.reject(new Error('the finish ended before the browser was cleared')))]);
        expect(actions().filter((action) => action === 'clear')).toHaveLength(1);
        // The wipe is still pending and the third reader is still queued: the line does not move before the browser is empty
        expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: one.job.id, parkPendingWipe: true });
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: three.job.id } })).toMatchObject({ status: 'queued' });
      } finally {
        letClearGo();
        await ending;
      }
      expect(actions().filter((action) => action === 'clear')).toHaveLength(1);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: three.job.id } })).status).toBe('running');
    });

    it('when it finishes, counts what ran once in the meter’s books, settles the room, saves the files, rests, and the next job runs', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!first.ok || !second.ok) throw new Error('did not start');
      expect(second.job.status).toBe('queued');
      await finishJob(first.job.id, 'done', minutes(5));
      await finishJob(first.job.id, 'done', minutes(9));
      const events = await prisma.meterEvent.findMany({ where: { kind: 'computer_time', personKey: `person:${sara.id}` } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: `computer:${first.job.id}:time`, pool: 'computer', unit: 'second', quantity: BigInt(300), costMicros: BigInt(30_000), basis: 'estimated' });
      const reservations = await prisma.meterReservation.findMany({ where: { personKey: `person:${sara.id}` }, orderBy: { createdAt: 'asc' } });
      expect(reservations[0]).toMatchObject({ state: 'settled' });
      const view = await computerView(sara.brickId, sara.id, minutes(5));
      // The next job in line has the machine now
      expect(view?.job?.id).toBe(second.job.id);
      expect(view?.files.savedAt).not.toBeNull();
      expect(view?.month?.leftFraction).toBeCloseTo(0.97, 2);
    });

    it('an end that finds the job\'s seconds moved since it read them (a take-over and a hand-back) is worked out again on what is there, and never writes the smaller count over the newer', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await prisma.computerJob.update({ where: { id: job.job.id }, data: { secondsRun: 100 } });
      // After the end read the job and before it wrote: a take-over recorded 300 seconds and a hand-back put it running again (the status is as it was). A finish writes its ending under the job's cutoff lock, so the
      // moment is made by holding that lock: the finish has read the job and waits for it; what the holder writes is what the finish finds when it gets the lock
      const lockKey = `computer-call-cutoff:${job.job.id}`;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
          locked();
          await released;
          await tx.computerJob.update({ where: { id: job.job.id }, data: { secondsRun: 300, stretchStarted: minutes(1) } });
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
      let finishing: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([lockTaken, holder.then(() => Promise.reject(new Error('the holder ended before it took the lock')))]);
        finishing = finishJob(job.job.id, 'done', minutes(2));
        // Observed from the moment it starts: a rejection before it reaches the lock fails the poll with its own error, never an unhandled rejection reported first
        let finishFailure: { error: unknown } | null = null;
        finishing.catch((error) => {
          finishFailure = { error };
        });
        let waiting = false;
        for (let tries = 0; tries < 250 && !waiting; tries += 1) {
          if (finishFailure) throw (finishFailure as { error: unknown }).error;
          waiting = (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${lockKey}, 0)`)[0].n > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        release();
        await holder;
        await finishing;
      } finally {
        release();
        await Promise.allSettled([holder, finishing]);
      }
      const ended = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } });
      expect(ended.status).toBe('done');
      // The 300 recorded, and the minute since the stretch began: never the 100 and the two minutes from the first read
      expect(ended.secondsRun).toBe(360);
      const events = await prisma.meterEvent.findMany({ where: { eventId: `computer:${job.job.id}:time` } });
      expect(events[0]?.quantity).toBe(BigInt(360));
    });

    it('rests the machine when the last job is over, and keeps the disk: nothing is removed or reset', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('resting');
      // The list as the job began, then at its end: its own output folder to hand over what it made (the file card), where its browser went, the files for Files, and the browser cleared
      expect(provider.calls.map((call) => call.name)).toEqual(['create', 'wake', 'exec', 'exec', 'exec', 'exec', 'exec', 'saveFiles', 'rest']);
      // A second job wakes the SAME machine: never a second one
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).providerRef).toBe(`fake-${sara.brickId}`);
    });

    it('clears the browser once the last job is over, before the machine rests, and not while another job still holds it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, NOW);
      if (!first.ok || !second.ok) throw new Error('did not start');
      expect(second.job.status).toBe('running');
      await finishJob(first.job.id, 'done', minutes(1));
      // The reader still holds the machine: its browser is not cleared under it
      expect(provider.commands.filter((entry) => entry.command === 'universe-clean')).toHaveLength(0);
      await finishJob(second.job.id, 'done', minutes(2));
      expect(provider.commands.filter((entry) => entry.command === 'universe-clean')).toHaveLength(1);
      const names = provider.calls.map((call) => call.name);
      expect(names.indexOf('exec')).toBeLessThan(names.indexOf('rest'));
    });

    it('lists what is on the computer when the last job ends, for the Files list, and keeps the last list when a later listing fails', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      provider.execAnswer = (command) => (command === 'universe-files' ? { stdout: '12\t1794679965.5\tvisa/form.pdf\n3\t1794679000\tnotes.txt\n' } : {});
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect((await computerView(sara.brickId, sara.id))?.files.list).toBeNull();
      await finishJob(job.job.id, 'done', minutes(1));
      const list = (await computerView(sara.brickId, sara.id))?.files.list;
      expect(list?.items.map((entry) => entry.path)).toEqual(['visa/form.pdf', 'notes.txt']);
      provider.execAnswer = () => ({ exitCode: 1 });
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      if (!second.ok) throw new Error('no');
      await finishJob(second.job.id, 'done', minutes(3));
      expect((await computerView(sara.brickId, sara.id))?.files.list?.items).toHaveLength(2);
    });

    it('a clean that fails never holds up the end of the job: the machine still rests', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      provider.failExec = true;
      await finishJob(job.job.id, 'done', minutes(1));
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('resting');
    });

    it('reports its steps and nothing else about a finished job changes them', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await reportProgress(job.job.id, { stepDone: 2, stepTotal: 5, label: 'Your visa form' })).toMatchObject({ stepDone: 2, stepTotal: 5, stepLabel: 'Your visa form' });
      await finishJob(job.job.id, 'done', minutes(1));
      expect(await reportProgress(job.job.id, { stepDone: 4 })).toMatchObject({ stepDone: 2, status: 'done' });
    });
  });

  describe('a step label never keeps or shows a secret', () => {
    const KEY = `cjt_${'Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5Nm7Aq9'.slice(0, 43)}`;
    const SHAPES = [`T=${KEY} + 7 commands`, `curl -H "Authorization: Bearer ${KEY}" https://relay.example.test/v1/models`, 'git clone https://someone:pw@example.test/o/r.git', 'export OPENAI_API_KEY=sk-proj-abcdefghijkl1234 && run', 'Checking service\nPASSWORD=hunter2 curl https://example.test', 'Checking service\tPASSWORD=hunter2 curl https://example.test'];

    it('is replaced by a plain phrase when written, in what is stored and in everything that is told back (the job, the Brick’s computer view)', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      for (const label of SHAPES) {
        expect((await reportProgress(job.job.id, { stepDone: 1, stepTotal: 3, label }))?.stepLabel).toBe(STEP_LABEL_FALLBACK);
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).stepLabel).toBe(STEP_LABEL_FALLBACK);
        expect(JSON.stringify(await computerView(sara.brickId, sara.id))).not.toMatch(/cjt_|Bearer|pw@|sk-proj|OPENAI|hunter2/);
      }
      // An honest label is kept as it was said, and a label taken away is taken away
      expect((await reportProgress(job.job.id, { stepDone: 2, label: 'Filling in your visa form' }))?.stepLabel).toBe('Filling in your visa form');
      expect((await reportProgress(job.job.id, { stepDone: 2, label: null }))?.stepLabel).toBeNull();
    });

    it('is cleaned again when read: a label stored before the rule (written straight into the row) never shows', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await prisma.computerJob.update({ where: { id: job.job.id }, data: { stepLabel: SHAPES[0], stepDone: 1 } });
      const view = await computerView(sara.brickId, sara.id);
      expect(JSON.stringify(view)).not.toContain('cjt_');
      expect(JSON.stringify(view)).toContain(STEP_LABEL_FALLBACK);
      expect((await getJob(job.job.id))?.stepLabel).toBe(STEP_LABEL_FALLBACK);
    });
  });

  describe('the allowance', () => {
    it('queues a job whose person has used theirs up, with nothing started or woken, and "Ask for more" is the one way on', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 50_000 });
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      expect(started.ok && started.job).toMatchObject({ status: 'queued', queuedFor: 'allowance' });
      expect(provider.calls).toEqual([]);
    });

    it('starts it by itself when extra usage is given, and a gift or extra to bill both lift it', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 50_000 });
      await giveComputer(sara.brickId, sara.id);
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      await recordGrant({ grantKey: `g-${tag}`, personId: sara.id, settlement: 'gift', multiplier: 5, startsAt: minutes(-60), endsAt: minutes(24 * 60), givenById: 'admin' });
      expect(await sweepComputers(minutes(1))).toMatchObject({ started: 1 });
      expect((await computerView(sara.brickId, sara.id, minutes(1)))?.job).toMatchObject({ status: 'running' });
    });

    it('says "wait in line", with nothing to ask for, when every computer is busy', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await setUp({ atOnceAll: 1 });
      await giveComputer(sara.brickId, sara.id);
      await giveComputer(omar.brickId, omar.id);
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const waiting = await startJob({ botId: omar.brickId, personId: omar.id, title: 'B' }, NOW);
      expect(waiting.ok && waiting.job).toMatchObject({ status: 'queued', queuedFor: 'busy' });
    });

    it('pauses a running job safely when its room cannot be renewed: what ran is counted as its own stretch, nothing is held, nothing new starts', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 70_000 });
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await renewJob(job.job.id, minutes(5))).toEqual({ ok: false, reason: 'paused', why: 'allowance' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } });
      expect(after).toMatchObject({ status: 'queued', queuedFor: 'paused', pausedWhy: 'allowance', endedBy: null, reservationKey: null, pauses: 1 });
      // The stretch so far is charged under the pause's own event; the job's own ending event is for the stretch after it carries on
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${job.job.id}:time:1` } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${job.job.id}:time` } })).toBe(0);
      expect(await prisma.meterReservation.count({ where: { jobId: job.job.id, state: 'held' } })).toBe(0);
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('resting');
    });

    it('renewing a job that is still in line is fine, not over', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 50_000 });
      await giveComputer(sara.brickId, sara.id);
      const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!queued.ok) throw new Error('no');
      expect(queued.job.status).toBe('queued');
      expect(await renewJob(queued.job.id, minutes(1))).toEqual({ ok: true, renewInSeconds: 60 });
    });

    it('tells a runner to renew inside the life of its key, however large the room is, and the key is still alive at that moment', async () => {
      await setUp({ renewMinutes: 60, memberAllowanceMicros: 5_000_000 });
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const token = await mintJobToken(job.job.id, 'model', NOW);
      if (!token.ok) throw new Error('no key');
      const first = await renewJob(job.job.id, NOW);
      expect(first).toEqual({ ok: true, renewInSeconds: TOKEN_RENEW_EVERY_SECONDS });
      expect(TOKEN_RENEW_EVERY_SECONDS).toBe(360);
      expect(TOKEN_RENEW_EVERY_SECONDS * 1000).toBeLessThan(TOKEN_LIFE_MS);
      // At the moment the runner asks again the key is still good, and the renewal brings it on
      const later = new Date(NOW.getTime() + TOKEN_RENEW_EVERY_SECONDS * 1000);
      expect(await verifyJobToken(token.token, 'model', later)).toMatchObject({ ok: true });
      const again = await renewJob(job.job.id, later);
      expect(again).toEqual({ ok: true, renewInSeconds: TOKEN_RENEW_EVERY_SECONDS });
    });

    it('lets only one sweep start the image build at a time, and a start that died is taken over after a while', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'computer-image' } });
      const now = new Date('2026-11-15T12:00:00Z');
      const both = await Promise.all([dbImageStore.claim!('h1', now), dbImageStore.claim!('h1', now)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await dbImageStore.claim!('h1', new Date(now.getTime() + 1000))).toBeNull();
      // Its build was never recorded: after the wait another sweep may start it, keeping the count of failures
      expect(await dbImageStore.claim!('h1', new Date(now.getTime() + CLAIM_MS + 1000))).toMatchObject({ state: 'building', buildId: null });
      // New content is never held back by an older start
      expect(await dbImageStore.claim!('h2', new Date(now.getTime() + CLAIM_MS + 2000))).toMatchObject({ hash: 'h2' });
      await prisma.appSetting.deleteMany({ where: { key: 'computer-image' } });
    });

    it('does not start a second build of content that is already building, ready, or failed and still waiting', async () => {
      const key = 'computer-image';
      const now = new Date('2026-11-15T12:00:00Z');
      const put = async (value: Record<string, unknown>) => {
        await prisma.appSetting.deleteMany({ where: { key } });
        await prisma.appSetting.create({ data: { key, value: value as never } });
      };
      const base = { hash: 'h1', revision: null, startedAt: new Date(now.getTime() - 60_000).toISOString(), failures: 0, error: null };
      // Another sweep recorded its build id after this one read the setting
      await put({ ...base, state: 'building', buildId: 'b-1' });
      expect(await dbImageStore.claim!('h1', now)).toBeNull();
      await put({ ...base, state: 'ready', buildId: 'b-1', revision: 3 });
      expect(await dbImageStore.claim!('h1', now)).toBeNull();
      // A failed build waits out its time, counted from when it failed
      await put({ ...base, state: 'failed', buildId: 'b-1', failures: 1, failedAt: new Date(now.getTime() - 60_000).toISOString() });
      expect(await dbImageStore.claim!('h1', now)).toBeNull();
      await put({ ...base, state: 'failed', buildId: 'b-1', failures: 1, failedAt: new Date(now.getTime() - 6 * 60_000).toISOString() });
      expect(await dbImageStore.claim!('h1', now)).toMatchObject({ state: 'building', buildId: null, failures: 1 });
      // Changed content is never held back by an older build
      await put({ ...base, state: 'ready', buildId: 'b-1', revision: 3 });
      expect(await dbImageStore.claim!('h2', now)).toMatchObject({ hash: 'h2' });
      await prisma.appSetting.deleteMany({ where: { key } });
    });

    it('keeps a renewing job going while there is room, and gives every held room back when a job ends or lapses', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await renewJob(job.job.id, minutes(5))).toEqual({ ok: true, renewInSeconds: 240 });
      // It never renewed again: its room lapses, and the sweep stops it safely and settles what ran
      expect(await sweepComputers(minutes(60))).toMatchObject({ stopped: 1 });
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}`, state: 'held' } })).toBe(0);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });
  });

  describe('a job that failed on our side', () => {
    const timeOf = (jobId: string) => prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${jobId}:time` } });

    it('is not taken from the person’s month: what it ran stays in the books as our cost, written against nobody', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'failed', minutes(5), null, 'ours');
      const event = await timeOf(job.job.id);
      // The five minutes and their cost are still there (the provider bills them), but not under the person
      expect(event).toMatchObject({ kind: 'computer_time', pool: 'computer', quantity: BigInt(300), costMicros: BigInt(30_000), personKey: 'unknown', personId: null, jobId: job.job.id });
      expect(event.detail).toMatchObject({ givenBack: true, forPersonId: sara.id, status: 'failed', endedBy: 'error' });
      // Their month is whole, and the room that was held is settled, not left held
      expect((await computerView(sara.brickId, sara.id, minutes(5)))?.month?.leftFraction).toBe(1);
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}`, state: 'held' } })).toBe(0);
      // Our own exposure is unchanged: the pool still counts what the provider billed
      expect((await currentEnvelope(minutes(5))).unsettledMicros).toBeGreaterThanOrEqual(30_000);
    });

    it('shows in Activity as refunded, with no amount taken', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'failed', minutes(5), null, 'ours');
      const [item] = await activityFor(sara.id);
      expect(item).toMatchObject({ title: 'Visa form', state: 'refunded', spentMicros: null });
      expect(item.lines).toEqual([{ label: 'Computer, 5 minutes', note: 'Nothing' }]);
    });

    it('is the same when the worker was lost: a job whose room lapsed is stopped by the sweep and not charged to the person', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await sweepComputers(minutes(60))).toMatchObject({ stopped: 1 });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'error' });
      expect((await timeOf(job.job.id)).personKey).toBe('unknown');
      expect((await computerView(sara.brickId, sara.id, minutes(60)))?.month?.leftFraction).toBe(1);
      // Activity says the same for a job stopped by an error as for one that failed: refunded, nothing taken
      const [item] = await activityFor(sara.id);
      expect(item).toMatchObject({ title: 'A', state: 'refunded', spentMicros: null });
      expect(item.lines).toEqual([{ label: 'Computer, 1 hour', note: 'Nothing' }]);
    });

    it('is written the same way when the sweep writes it later, and a job that ran fine or was stopped by the person is still theirs', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const failed = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!failed.ok) throw new Error('no');
      // The first write of its time fails; the sweep writes it again, and the decision is the same
      (meter.recordMeterEvent as jest.Mock).mockRejectedValueOnce(new Error('books down'));
      await finishJob(failed.job.id, 'failed', minutes(4), null, 'ours');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${failed.job.id}:time` } })).toBe(0);
      await sweepComputers(minutes(10));
      expect((await timeOf(failed.job.id)).personKey).toBe('unknown');

      const done = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(11));
      if (!done.ok) throw new Error('no');
      await finishJob(done.job.id, 'done', minutes(16));
      expect(await timeOf(done.job.id)).toMatchObject({ personKey: `person:${sara.id}`, personId: sara.id });
      expect((await timeOf(done.job.id)).detail).not.toHaveProperty('givenBack');

      const stopped = await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, minutes(17));
      if (!stopped.ok) throw new Error('no');
      await stopJobFor(sara.brickId, sara.id, minutes(20));
      expect((await timeOf(stopped.job.id)).personKey).toBe(`person:${sara.id}`);
      // Only the two the person had are taken: 5 and 3 minutes of 6,000 millionths
      expect((await computerView(sara.brickId, sara.id, minutes(20)))?.month?.leftFraction).toBeCloseTo(1 - 48_000 / 1_000_000, 3);
      // And Activity agrees: the one that failed is refunded, the ones the person had are done, with what they took
      const items = await activityFor(sara.id);
      expect(items.find((item) => item.title === 'A')).toMatchObject({ state: 'refunded', spentMicros: null });
      expect(items.find((item) => item.title === 'B')).toMatchObject({ state: 'done', spentMicros: 30_000 });
      expect(items.find((item) => item.title === 'C')).toMatchObject({ state: 'done', spentMicros: 18_000 });
    });
  });

  describe('Stop and turning it off', () => {
    it('Stop ends the job, keeps the work so far and counts what ran', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await reportProgress(job.job.id, { stepDone: 2, stepTotal: 5 });
      const view = await stopJobFor(sara.brickId, sara.id, minutes(2));
      expect(view).toMatchObject({ machine: 'resting', job: null });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person', stepDone: 2, secondsRun: 120 });
    });

    it('Turn off stops everything at once, saves the files, keeps them, and the next job says Computer is off', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      const view = await turnOffComputer(sara.brickId, sara.id, minutes(3));
      expect(view).toMatchObject({ on: false, machine: 'stopped', job: null, queued: [] });
      expect(view?.files.savedAt).not.toBeNull();
      expect(view?.files.bytes).toBe(provider.filesBytes);
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['queued', 'running', 'waiting'] } } })).toBe(0);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'off' });
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, minutes(4))).toEqual({ ok: false, reason: 'off' });
      expect((await currentEnvelope(minutes(4))).reservedMicros).toBe(0);
    });

    it('Turn off closes the door first: a job asked for while the work is being stopped is refused, and nothing is left running', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      let asked: Awaited<ReturnType<typeof startJob>> | null = null;
      const save = provider.saveFiles.bind(provider);
      provider.saveFiles = async (ref: string) => {
        // While the first job is being saved and ended, another job asks and the sweep runs
        if (!asked) {
          asked = await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, minutes(3));
          await sweepComputers(minutes(3));
        }
        return save(ref);
      };
      await turnOffComputer(sara.brickId, sara.id, minutes(3));
      expect(asked).toEqual({ ok: false, reason: 'off' });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['queued', 'running', 'waiting'] } } })).toBe(0);
      expect((await currentEnvelope(minutes(4))).reservedMicros).toBe(0);
    });

    it('a job that starts while the machine is being put to rest finds it awake and working, never resting under it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      let starting: ReturnType<typeof startJob> | null = null;
      const rest = provider.rest.bind(provider);
      provider.rest = async (ref: string) => {
        // The next job starts at the very moment the rest is being done. It runs beside the rest, as a second request does: since post-0.5.0 B it waits for the sleep to return before it wakes the
        // machine, so awaiting it from inside the sleep call would wait on itself
        if (!starting) starting = startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
        return rest(ref);
      };
      await finishJob(a.job.id, 'done', minutes(1));
      expect(await starting).toMatchObject({ ok: true });
      const view = await computerView(sara.brickId, sara.id, minutes(3));
      expect(view?.job).not.toBeNull();
      expect(view?.machine).toBe('working');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      // The last call on the machine is a wake, not a rest
      const names = provider.calls.map((call) => call.name).filter((name) => name === 'wake' || name === 'rest');
      expect(names[names.length - 1]).toBe('wake');
    });

    it('keeps the room of a person who is at the keyboard: the sweep renews it before it lapses, and a job that went quiet still stops', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await takeOver(sara.brickId, sara.id, minutes(1));
      // Well past the 10 minutes of the first room, a sweep every minute: the person is still working on it
      for (let at = 2; at <= 35; at++) await sweepComputers(minutes(at));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'waiting', control: 'person' });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      // Handed back, Brick's own job renews its own room: when it goes quiet it is stopped as before
      await handBack(sara.brickId, sara.id);
      await sweepComputers(minutes(60));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'error' });
    });

    it('keeps the room of a job that asked the person to take over, until they come', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await requestHandover(a.job.id, 'details', minutes(1));
      for (let at = 2; at <= 35; at++) await sweepComputers(minutes(at));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'waiting', control: 'brick' });
      expect((await takeOver(sara.brickId, sara.id, minutes(36))).ok).toBe(true);
    });

    it('a job that asked the person to take over and got no answer ends after the wait a super admin set, is told so, and the line moves on', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      await requestHandover(a.job.id, 'details', minutes(1));
      // Inside the wait (an hour until a super admin changes it) the room keeps being renewed and the job stays
      for (let at = 2; at <= 58; at += 2) await sweepComputers(minutes(at));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'waiting', control: 'brick' });
      // Past it the job ends as unanswered, its room is settled to what it held, and the next job in line has the machine
      await sweepComputers(minutes(62));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'running' });
      expect(await prisma.meterReservation.count({ where: { jobId: a.job.id, state: 'held' } })).toBe(0);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${a.job.id}:time` } })).toBe(1);
      // What the job's runner hears when it asks to renew: it ended because nobody answered
      expect(await renewJob(a.job.id, minutes(63))).toEqual({ ok: false, reason: 'unanswered' });
    });

    it('a change of the wait counts at once, for a job already waiting, with no deploy', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await requestHandover(a.job.id, 'details', minutes(1));
      for (let at = 2; at <= 20; at += 2) await sweepComputers(minutes(at));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'waiting' });
      expect(await prisma.meterReservation.count({ where: { jobId: a.job.id, state: 'held' } })).toBe(1);
      await saveServerLimits({ bricks: { computerWait: 15 } }, 'admin');
      await sweepComputers(minutes(21));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'unanswered' });
      // Its reserved room is released, and the time it held is counted once: consumed time is not refunded
      expect(await prisma.meterReservation.count({ where: { jobId: a.job.id, state: 'held' } })).toBe(0);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${a.job.id}:time` } })).toBe(1);
    });

    it('once the person has taken over, the wait does not end the job: it is theirs', async () => {
      // A month big enough for two hours at the keyboard: only the wait is under test
      await setUp({ memberAllowanceMicros: 100_000_000 });
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await requestHandover(a.job.id, 'details', minutes(1));
      for (let at = 2; at <= 130; at += 2) {
        // They come at 30 minutes, well inside the wait, and stay at the keyboard long past it
        if (at === 30) await takeOver(sara.brickId, sara.id, minutes(at));
        await sweepComputers(minutes(at));
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: a.job.id } })).toMatchObject({ status: 'waiting', control: 'person' });
    });

    it('one start that breaks fails one job: the jobs behind it stay in line for the next sweep instead of failing one after another', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const queued = [await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW), await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, NOW), await startJob({ botId: sara.brickId, personId: sara.id, title: 'D' }, NOW)];
      if (!a.ok || queued.some((job) => !job.ok)) throw new Error('no');
      const ids = queued.map((job) => (job.ok ? job.job.id : ''));
      // The provider is down for every wake from now on
      const down = jest.spyOn(provider, 'wake').mockRejectedValue(new Error('The provider is down'));
      await finishJob(a.job.id, 'done', minutes(1));
      down.mockRestore();
      const statuses = await prisma.computerJob.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } });
      expect(statuses.map((job) => job.status)).toEqual(['failed', 'queued', 'queued']);
      // And the next sweep gives the next one its turn, now that the provider is back
      expect((await sweepComputers(minutes(2))).started).toBe(1);
    });

    it('a Brick with a long line cannot crowd the others out of the sweep: every Brick still gets its turn', async () => {
      const sara = await person('sara');
      const tom = await person('tom');
      await giveComputer(sara.brickId, sara.id);
      await giveComputer(tom.brickId, tom.id);
      const long = new Date(NOW.getTime() - 60 * 60_000);
      // Sara's line is longer than one sweep looks at, and all of it is older than Tom's job
      await prisma.computerJob.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ botId: sara.brickId, personId: sara.id, title: `S${i}`, status: 'queued', queuedFor: 'busy', createdAt: new Date(long.getTime() + i) })) });
      const lone = await prisma.computerJob.create({ data: { botId: tom.brickId, personId: tom.id, title: 'T', status: 'queued', queuedFor: 'busy', createdAt: NOW } });
      const swept = await sweepComputers(minutes(1));
      expect(swept.started).toBeGreaterThanOrEqual(2);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: lone.id } })).toMatchObject({ status: 'running' });
    });

    it('a tap approves what the person was looking at: details that changed since are not approved by an old screen', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!started.ok) throw new Error('no');
      const jobId = started.job.id;
      const old = { what: 'Your name', where: 'visa-portal.example' };
      await requestHandover(jobId, 'details', minutes(1), old);
      await takeOver(sara.brickId, sara.id);
      await handBack(sara.brickId, sara.id);
      // Brick names something new while a page opened before is still on screen
      const fresh = { what: 'Your passport number', where: 'other-portal.example' };
      await requestHandover(jobId, 'details', minutes(2), fresh);
      await takeOver(sara.brickId, sara.id);
      expect(await fillInDetails(sara.brickId, sara.id, old)).toEqual({ ok: false, reason: 'changed' });
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
      const ok = await fillInDetails(sara.brickId, sara.id, fresh);
      expect(ok.ok && ok.job.detailsToFill).toEqual([{ key: detailsKey(fresh.what, fresh.where), ...fresh }]);
    });

    it('an approval is the same kind and still unspent: another kind on the key, or a failed row nobody approved again, is not one', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!started.ok) throw new Error('no');
      const jobId = started.job.id;
      expect(await planEffect(jobId, { key: 'k1', kind: 'send' })).toEqual({ ok: true, already: false });
      expect(await settleEffect(jobId, 'k1', 'failed', 'not sent')).toBe(true);
      await requestHandover(jobId, 'details', minutes(1));
      await takeOver(sara.brickId, sara.id);
      // The failed send row is not the person's approval of an upload, nor of details
      expect(await planEffect(jobId, { key: 'k1', kind: 'upload' })).toEqual({ ok: false, reason: 'hand_over_first' });
      expect(await planEffect(jobId, { key: 'k1', kind: 'details' })).toEqual({ ok: false, reason: 'hand_over_first' });
      expect(await prisma.computerEffect.findFirstOrThrow({ where: { jobId, effectKey: 'k1' } })).toMatchObject({ kind: 'send', state: 'failed' });
      // A key used for one kind is never reused for another, either
      await handBack(sara.brickId, sara.id);
      expect(await planEffect(jobId, { key: 'k1', kind: 'publish' })).toMatchObject({ ok: false, reason: 'look_up' });
    });

    it('an effect is never planned for a job still in line: it has no room and no machine yet', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      expect(b.job.status).toBe('queued');
      expect(await planEffect(b.job.id, { key: 'e1', kind: 'send' })).toEqual({ ok: false, reason: 'job_over' });
      expect(await prisma.computerEffect.count({ where: { jobId: b.job.id } })).toBe(0);
    });

    it('a job queued while the Brick is being deleted never wakes the machine', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      // The Brick is marked deleted, but this job was made after the stop listed its jobs: it is still in line
      await prisma.bot.update({ where: { id: sara.brickId }, data: { deletedAt: NOW, goneAt: minutes(60 * 24 * 30), enabled: false } });
      // Its ending is closed (its files were handed over): a finished job whose ending is still open keeps the machine awake for its hand-over
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { status: 'done', endedAt: NOW, endClosedAt: NOW } });
      const before = woke();
      await sweepComputers(minutes(1));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'deleted' });
      // The job itself wakes nothing. The only wake there may be is cold storage's own, to read the folder of a deleted Brick before its computer is
      // removed (it comes with a pack-away's `prepack`), and the machine is never left working
      const prepacked = provider.calls.some((call) => call.name === 'prepack');
      expect(woke()).toBe(prepacked ? before + 1 : before);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).not.toBe('working');
      // Its room was never held (the check comes before anything is reserved for the machine), and none is left for it
      expect(await prisma.meterReservation.count({ where: { jobId: b.job.id, state: 'held' } })).toBe(0);
    });

    it('two sweeps at the same moment give a job one room, and the one that lost does not take it from the one that won', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      await finishJob(a.job.id, 'done', minutes(1));
      const settled = await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } });
      expect(settled.status).toBe('running');
      expect(settled.reservationKey).not.toBeNull();
      const room = await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: settled.reservationKey as string } });
      expect(room.state).toBe('held');
      await Promise.all([sweepComputers(minutes(2)), sweepComputers(minutes(2))]);
      expect((await prisma.meterReservation.findUniqueOrThrow({ where: { reservationKey: settled.reservationKey as string } })).state).toBe('held');
    });

    it('a Brick turned off while its machine was still being made does not end up awake with nobody holding it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const create = provider.create.bind(provider);
      provider.create = async (botId: string) => {
        // The owner turns the computer off at the moment the machine is being made
        await turnOffComputer(sara.brickId, sara.id, minutes(1));
        return create(botId);
      };
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      expect(started.ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).not.toBe('working');
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['queued', 'running', 'waiting'] } } })).toBe(0);
      const last = provider.calls.map((call) => call.name).filter((name) => ['wake', 'rest', 'stop'].includes(name));
      expect(['rest', 'stop']).toContain(last[last.length - 1]);
      expect((await currentEnvelope(minutes(2))).reservedMicros).toBe(0);
    });

    it('taking over steps in on every job working on the machine (readers run side by side): none is left running under Brick', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'W', writes: false }, NOW);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'R', writes: false }, NOW);
      if (!writer.ok || !reader.ok) throw new Error('no');
      expect((await takeOver(sara.brickId, sara.id, minutes(1))).ok).toBe(true);
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId }, orderBy: { createdAt: 'asc' } });
      expect(jobs.map((job) => [job.status, job.control])).toEqual([['waiting', 'person'], ['waiting', 'person']]);
      await handBack(sara.brickId, sara.id);
      expect((await prisma.computerJob.findMany({ where: { botId: sara.brickId } })).map((job) => job.status)).toEqual(['running', 'running']);
    });

    it('the sweep rests a machine that works while nobody holds it, and writes a job’s computer time the books missed', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      // A stop that broke half way: the job is over, its time never reached the books, and the machine still works
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { status: 'done', endedBy: null, endedAt: minutes(5), secondsRun: 300, stretchStarted: null } });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      await backdate([sara.brickId]);
      await sweepComputers(minutes(10));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      const events = await prisma.meterEvent.findMany({ where: { eventId: `computer:${a.job.id}:time` } });
      expect(events).toHaveLength(1);
      expect(Number(events[0].quantity)).toBe(300);
      // Run again: the same event, never a second
      await sweepComputers(minutes(11));
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${a.job.id}:time` } })).toBe(1);
    });

    it('the sweep gives every Brick a turn, even when the ones in front are all blocked', async () => {
      const blocked = [];
      for (const name of ['b1', 'b2', 'b3']) {
        const one = await person(name);
        await giveComputer(one.brickId, one.id);
        const w = await startJob({ botId: one.brickId, personId: one.id, title: 'W' }, NOW);
        const q = await startJob({ botId: one.brickId, personId: one.id, title: 'Q' }, NOW);
        if (!w.ok || !q.ok) throw new Error('no');
        blocked.push(q.job.id);
      }
      const free = await person('free');
      await giveComputer(free.brickId, free.id);
      // Its job is in line with nobody in front of it, made after every blocked one
      const lone = await prisma.computerJob.create({ data: { botId: free.brickId, personId: free.id, title: 'F', status: 'queued', queuedFor: 'busy', createdAt: new Date(Date.now() + 60_000) } });
      // One Brick per page: the three blocked Bricks fill three pages, and the free one still gets its turn
      const swept = await sweepComputers(minutes(1), 1);
      expect(swept.started).toBe(1);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: lone.id } })).toMatchObject({ status: 'running' });
      for (const id of blocked) expect(await prisma.computerJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'queued' });
    });

    it('a run of deleted Bricks whose books cannot be written does not keep the ones behind them from being removed', async () => {
      const sara = await person('sara');
      const names = ['d1', 'd2', 'd3', 'd4'];
      const bricks: string[] = [];
      for (const name of names) {
        const brick = await createBrick({ ownerId: sara.id, name: `${name} of Sara` });
        bricks.push(brick.id);
      }
      // The first three ran a job whose time never reached the books; the last has no computer
      for (const id of bricks.slice(0, 3)) {
        await giveComputer(id, sara.id);
        const job = await startJob({ botId: id, personId: sara.id, title: 'A' }, NOW);
        if (!job.ok) throw new Error('no');
        await finishJob(job.job.id, 'done', minutes(1));
        await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${job.job.id}:time` } });
      }
      for (const [i, id] of bricks.entries()) {
        await deleteBrick(id, sara.id, minutes(2));
        await prisma.bot.update({ where: { id }, data: { goneAt: new Date(minutes(3).getTime() + i) } });
      }
      const blocked = new Set(bricks.slice(0, 3));
      (meter.recordMeterEvent as jest.Mock).mockImplementation(async (input: { botId?: string }) => {
        if (input.botId && blocked.has(input.botId)) throw new Error('The books are down');
        return actualRecord(input as never);
      });
      try {
        // One Brick to a page: the three that wait fill three pages, and the fourth is still removed
        const removed = await removeGoneBricks(minutes(10), sara.id, 1);
        expect(removed).toEqual([bricks[3]]);
        expect(await prisma.bot.count({ where: { id: { in: bricks.slice(0, 3) } } })).toBe(3);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
    });

    it('across sweeps, Bricks that stay blocked go behind the ones not tried yet, so a Brick further back still gets its turn', async () => {
      const blocked = [];
      for (const name of ['c1', 'c2', 'c3']) {
        const one = await person(name);
        await giveComputer(one.brickId, one.id);
        await startJob({ botId: one.brickId, personId: one.id, title: 'W' }, NOW);
        const q = await startJob({ botId: one.brickId, personId: one.id, title: 'Q' }, NOW);
        if (!q.ok) throw new Error('no');
        blocked.push(q.job.id);
      }
      // The line's try at each Q (when it was made) is on record; these Bricks have not been looked at by a sweep yet, as the lone Brick below has not
      await prisma.computerJob.updateMany({ where: { id: { in: blocked } }, data: { lastTriedAt: null } });
      const free = await person('free');
      await giveComputer(free.brickId, free.id);
      const lone = await prisma.computerJob.create({ data: { botId: free.brickId, personId: free.id, title: 'F', status: 'queued', queuedFor: 'busy', createdAt: new Date(Date.now() + 60_000) } });
      // A sweep reads three Bricks, one to a page: the three blocked ones in front use all of it, every time it ran before
      expect((await sweepComputers(minutes(1), 1, 3)).started).toBe(0);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: lone.id } })).toMatchObject({ status: 'queued' });
      // The next sweep starts with the Brick not tried yet
      expect((await sweepComputers(minutes(2), 1, 3)).started).toBe(1);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: lone.id } })).toMatchObject({ status: 'running' });
    });

    it('across sweeps, deleted Bricks that wait go behind the ones not looked at yet, so one further back is still removed', async () => {
      const sara = await person('sara');
      const bricks: string[] = [];
      for (const name of ['e1', 'e2', 'e3', 'e4']) bricks.push((await createBrick({ ownerId: sara.id, name: `${name} of Sara` })).id);
      for (const id of bricks.slice(0, 3)) {
        await giveComputer(id, sara.id);
        const job = await startJob({ botId: id, personId: sara.id, title: 'A' }, NOW);
        if (!job.ok) throw new Error('no');
        await finishJob(job.job.id, 'done', minutes(1));
        await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${job.job.id}:time` } });
      }
      for (const [i, id] of bricks.entries()) {
        await deleteBrick(id, sara.id, minutes(2));
        await prisma.bot.update({ where: { id }, data: { goneAt: new Date(minutes(3).getTime() + i) } });
      }
      await backdate(bricks);
      const blocked = new Set(bricks.slice(0, 3));
      (meter.recordMeterEvent as jest.Mock).mockImplementation(async (input: { botId?: string }) => {
        if (input.botId && blocked.has(input.botId)) throw new Error('The books are down');
        return actualRecord(input as never);
      });
      try {
        // A sweep reads three Bricks, one to a page: the three that wait use all of it
        expect(await removeGoneBricks(minutes(10), sara.id, 1, 3)).toEqual([]);
        // The next one starts with the Brick not looked at yet
        expect(await removeGoneBricks(minutes(11), sara.id, 1, 3)).toEqual([bricks[3]]);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
    });

    it('a machine whose rest failed is rested by a later sweep, and one left claimed for rest by a stopped server is let go and rested too', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      // A rest that threw can still land for the provider's margin (shortened here): the row stays `resting`, claimed, and the stuck-rest sweep lets it go only once nothing of ours can land
      setPowerTimingForTests({ marginMs: 100 });
      try {
        provider.failNext.rest = true;
        await finishJob(a.job.id, 'done', minutes(1));
        const resting = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
        expect(resting.machine).toBe('resting');
        // The rest's own operation closes by itself once the margin is past: waited for on the operation's `done_at` (a bounded poll), not guessed from a delay, so a slow database cannot make the sweep find it still open
        const closeBy = Date.now() + 10_000;
        for (;;) {
          const open = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM computer_power_ops WHERE provider_ref = ${resting.providerRef} AND done_at IS NULL`;
          if (Number(open[0].n) === 0) break;
          if (Date.now() > closeBy) throw new Error('The rest that threw never closed its operation');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        setPowerTimingForTests(null);
      }
      await backdate([sara.brickId]);
      await sweepComputers(minutes(10));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      expect(provider.calls.filter((call) => call.name === 'rest')).toHaveLength(2);
      // A rest that finished is not claimed any more: later sweeps never rest it again, however long it stays
      await sweepComputers(minutes(30));
      await sweepComputers(minutes(60));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      expect(provider.calls.filter((call) => call.name === 'rest')).toHaveLength(2);
      // A rest claimed and never finished (the server stopped there) is let go after a while and rested again
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting', restClaimedAt: minutes(60) } });
      await sweepComputers(minutes(62));
      expect(provider.calls.filter((call) => call.name === 'rest')).toHaveLength(2);
      // This sweep lets the stale claim go (the machine works again, stamped now); the next one, once it has been idle a little, rests it
      await sweepComputers(minutes(80));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).restClaimedAt).toBeNull();
      await backdate([sara.brickId]);
      await sweepComputers(minutes(90));
      expect(provider.calls.filter((call) => call.name === 'rest')).toHaveLength(3);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).restClaimedAt).toBeNull();
    });

    it('a machine that rested fully is left alone by every later sweep, and a new job wakes it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await finishJob(a.job.id, 'done', minutes(1));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      for (const at of [10, 20, 40, 90]) await sweepComputers(minutes(at));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      expect(provider.calls.filter((call) => call.name === 'rest')).toHaveLength(1);
      const wakesBefore = provider.calls.filter((call) => call.name === 'wake').length;
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(100));
      expect(b.ok && b.job.status).toBe('running');
      expect(provider.calls.filter((call) => call.name === 'wake').length).toBe(wakesBefore + 1);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
    });

    it('a Brick whose computer time never reached the books is not removed until it has: the time is written first, and kept if it cannot be', async () => {
      const sara = await person('sara');
      const brick = await createBrick({ ownerId: sara.id, name: 'Gone Brick' });
      await giveComputer(brick.id, sara.id);
      const job = await startJob({ botId: brick.id, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(5));
      // The write at the end failed: the books have nothing for it
      await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${job.job.id}:time` } });
      await deleteBrick(brick.id, sara.id, minutes(6));
      await prisma.bot.update({ where: { id: brick.id }, data: { goneAt: minutes(7) } });
      // The books still cannot be written: the Brick waits, its jobs with it
      (meter.recordMeterEvent as jest.Mock).mockRejectedValueOnce(new Error('The books are down'));
      expect(await removeGoneBricks(minutes(10), sara.id)).toEqual([]);
      expect(await prisma.bot.count({ where: { id: brick.id } })).toBe(1);
      expect(await prisma.computerJob.count({ where: { botId: brick.id } })).toBe(1);
      // Written now, then removed
      expect(await removeGoneBricks(minutes(11), sara.id)).toEqual([brick.id]);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${job.job.id}:time` } })).toBe(1);
      expect(await prisma.bot.count({ where: { id: brick.id } })).toBe(0);
    });

    it('a rest that finished while the sweep was letting go of a stale claim is not undone by it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await finishJob(a.job.id, 'done', minutes(1));
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting', restClaimedAt: minutes(1) } });
      const original = prisma.brickComputer.findMany.bind(prisma.brickComputer);
      const spy = jest.spyOn(prisma.brickComputer, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => {
        const result = original(...args);
        if ((args[0]?.where as { machine?: string } | undefined)?.machine !== 'resting') return result;
        // The sweep has seen the stale claim; the rest then finishes and clears it
        return result.then(async (rows) => {
          spy.mockRestore();
          await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { restClaimedAt: null } });
          return rows;
        });
      }) as typeof prisma.brickComputer.findMany);
      const rests = provider.calls.filter((call) => call.name === 'rest').length;
      await sweepComputers(minutes(30));
      spy.mockRestore();
      await sweepComputers(minutes(40));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
      expect(provider.calls.filter((call) => call.name === 'rest').length).toBe(rests);
    });

    it('computer time the books missed is written however old it is, and newer jobs never push an older one out', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const at = minutes(60 * 24 * 12);
      const made = [];
      for (const [name, daysAgo] of [['old', 10], ['newer1', 2], ['newer2', 1]] as const) {
        made.push(await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: name, status: 'done', reservationKey: `k-${name}-${made.length}`, startedAt: new Date(at.getTime() - 11 * 86_400_000), endedAt: new Date(at.getTime() - daysAgo * 86_400_000), secondsRun: 120 } }));
      }
      // Two a sweep: the oldest first, so the ten day old one is written by the first sweep and the others by the second
      await sweepComputers(at, 2);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${made[0].id}:time` } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { eventId: { in: made.map((job) => `computer:${job.id}:time`) } } })).toBe(2);
      await sweepComputers(at, 2);
      expect(await prisma.meterEvent.count({ where: { eventId: { in: made.map((job) => `computer:${job.id}:time`) } } })).toBe(3);
    });

    it('a job still in line cannot be finished: only one that started can be done or failed', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!a.ok || !b.ok) throw new Error('no');
      expect(b.job.status).toBe('queued');
      expect(await finishJob(b.job.id, 'done', minutes(1))).toMatchObject({ status: 'queued' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'queued', endedAt: null });
      await finishJob(a.job.id, 'done', minutes(2));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'running' });
    });

    it('never says a save happened that did not: a failed save leaves the last saved day as it was', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await finishJob(a.job.id, 'done', minutes(1));
      const saved = (await computerView(sara.brickId, sara.id))?.files.savedAt;
      expect(saved).not.toBeNull();
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      provider.failSaves = true;
      const view = await turnOffComputer(sara.brickId, sara.id, minutes(3));
      expect(view?.files.savedAt).toEqual(saved);
      // The machine still stops: only the claim of a save is withheld
      expect(view?.machine).toBe('stopped');
    });
  });

  describe('a start that breaks, and a restore', () => {
    it('fails the job with its room given back; a machine that was never made is not called broken, and the next job tries again', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      provider.failNext.create = true;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('none');
      expect((await currentEnvelope(NOW)).reservedMicros).toBe(0);
    });

    it('brings a broken computer back from its last saved copy and says which day that was; nothing is made again', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await finishJob(a.job.id, 'done', minutes(1));
      const savedAt = (await computerView(sara.brickId, sara.id))?.files.savedAt;
      provider.failNext.wake = true;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2))).toEqual({ ok: false, reason: 'broken_start' });
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('broken');
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, minutes(3));
      expect(again.ok && again.restoredFrom).toEqual(savedAt);
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
    });
  });

  describe('clearing the browser after a job', () => {
    it('a job that starts while it is cleared waits for it, so its browser is never cleared under it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!first.ok) throw new Error('no');
      let resolved = false;
      let resolvedWhileCleaning: boolean | null = null;
      let pending: ReturnType<typeof startJob> | null = null;
      provider.execAnswer = async (command: string) => {
        if (command === 'universe-clean') {
          pending = startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(1));
          void pending.then(() => {
            resolved = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 700));
          resolvedWhileCleaning = resolved;
        }
        return {};
      };
      await finishJob(first.job.id, 'done', minutes(1));
      const second = await pending!;
      expect(resolvedWhileCleaning).toBe(false);
      expect(second.ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
    });

    it('is not run while another cleanup holds the machine, and a claim that was never let go is taken over', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!first.ok) throw new Error('no');
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { cleanClaimedAt: new Date() } });
      await finishJob(first.job.id, 'done', minutes(1));
      expect(provider.commands.filter((entry) => entry.command === 'universe-clean')).toHaveLength(0);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      if (!second.ok) throw new Error('no');
      // CodeRabbit on #1025 (14): a start never takes the machine while another cleanup holds it, even after its wait: the job stays in line
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: second.job.id } })).toMatchObject({ status: 'queued' });
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { cleanClaimedAt: new Date(Date.now() - 10 * 60_000) } });
      // A claim nobody let go is taken over: the line starts the job, and its own ending cleans
      await sweepComputers(minutes(3));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: second.job.id } })).toMatchObject({ status: 'running' });
      await finishJob(second.job.id, 'done', minutes(4));
      expect(provider.commands.filter((entry) => entry.command === 'universe-clean')).toHaveLength(1);
    });
  });

  describe('handing over', () => {
    async function waitingJob(writes = true) {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', writes }, NOW);
      if (!job.ok) throw new Error('no');
      return { sara, jobId: job.job.id };
    }

    it('nothing starts under Brick’s hands while the person has the machine: a job asked for then waits until they hand back', async () => {
      const { sara, jobId } = await waitingJob(false);
      await takeOver(sara.brickId, sara.id);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(1));
      expect(reader.ok && reader.job.status).toBe('queued');
      await sweepComputers(minutes(2));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.ok ? reader.job.id : '' } })).toMatchObject({ status: 'queued' });
      await handBack(sara.brickId, sara.id);
      await sweepComputers(minutes(3));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.ok ? reader.job.id : '' } })).toMatchObject({ status: 'running' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'running', control: 'brick' });
    });

    it('a take over that found nothing running, with a job starting before it moves the waiting one, still leaves nothing under Brick’s hands', async () => {
      // The waiting job only reads: a read-only job may start beside it (a waiting WRITER would keep the injected reader out of admission, and the race would never happen)
      const { sara, jobId } = await waitingJob(false);
      await requestHandover(jobId, 'details', minutes(1));
      // The reader's start is admitted (the machine is Brick's) and stands at its claim of the machine, where it waits for the Brick's line lock that a fixture transaction holds: the take over then runs from start to end, looks for
      // running jobs and finds none, and only then does the claim go on and the reader run
      let locked: () => void = () => undefined;
      const gotLock = new Promise<void>((resolve) => (locked = resolve));
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`computer:line:${sara.brickId}`}, 0))`;
          locked();
          await hold;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      // What the take over's look for running jobs found (through a spy that calls through)
      const lookedAt: number[] = [];
      const original = prisma.computerJob.findMany.bind(prisma.computerJob);
      const spy = jest.spyOn(prisma.computerJob, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => {
        const result = original(...args);
        if ((args[0]?.where as { status?: string; botId?: string } | undefined)?.status !== 'running' || (args[0]?.where as { botId?: string }).botId !== sara.brickId) return result;
        return result.then((rows) => {
          lookedAt.push(rows.length);
          return rows;
        });
      }) as typeof prisma.computerJob.findMany);
      let reading: ReturnType<typeof startJob> = Promise.resolve({ ok: false, reason: 'off' });
      try {
        // A holder that fails before it takes the lock ends the wait with its own error
        await Promise.race([gotLock, holder.then(() => Promise.reject(new Error('the holder ended before it took the lock')))]);
        let reached = false;
        const met = new Promise<void>((resolve) => {
          controlInternals.onLineBusy = (botId) => {
            if (botId === sara.brickId) {
              reached = true;
              resolve();
            }
          };
        });
        reading = startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(2));
        // The reader is at the claim: the seam says it found the line lock held (it keeps trying for it, a try-lock), and it has neither been refused nor started
        await Promise.race([met, reading.then(() => Promise.reject(new Error('the reader ended before it reached its claim')))]);
        expect(reached).toBe(true);
        await takeOver(sara.brickId, sara.id, minutes(2));
        // The take over looked for running jobs, found none (the reader is not running yet), and the waiting job is the person's
        expect(lookedAt.length).toBeGreaterThan(0);
        expect(lookedAt.every((found) => found === 0)).toBe(true);
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'waiting', control: 'person' });
      } finally {
        controlInternals.onLineBusy = () => undefined;
        spy.mockRestore();
        release();
        await Promise.allSettled([holder, reading]);
      }
      // The reader's claim now goes through (it was started: not refused, not left in line), and it joins the person instead of running under Brick's hands
      const read = await reading;
      if (!read.ok) throw new Error('the injected reader was refused');
      expect(read.job.status).toBe('waiting');
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
      expect(jobs.filter((job) => job.status === 'running')).toEqual([]);
      expect(jobs.find((job) => job.id === jobId)).toMatchObject({ status: 'waiting', control: 'person' });
      expect(jobs.find((job) => job.id === read.job.id)).toMatchObject({ status: 'waiting', control: 'person' });
    });

    it('a take over and a job starting at the same moment never leave a job running under Brick’s hands while the person has the machine', async () => {
      for (let round = 0; round < 6; round++) {
        const { sara, jobId } = await waitingJob();
        const [, reader] = await Promise.all([takeOver(sara.brickId, sara.id, minutes(1)), startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(1))]);
        expect(reader.ok).toBe(true);
        const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
        const theirs = jobs.some((job) => job.status === 'waiting' && job.control === 'person');
        expect(theirs).toBe(true);
        expect(jobs.filter((job) => job.status === 'running')).toEqual([]);
        expect(jobs.find((job) => job.id === jobId)).toMatchObject({ status: 'waiting', control: 'person' });
      }
    });

    it('a details tap is not claimed when the person handed the machine back after the job was read', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      const key = asked.ok ? asked.job.detailsToFill[0].key : '';
      const read = prisma.computerJob.findUnique.bind(prisma.computerJob);
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementationOnce(((...args: Parameters<typeof read>) =>
        read(...args).then(async (row) => {
          // The job was read with the person in control; they hand it back before the tap is claimed
          await handBack(sara.brickId, sara.id);
          return row;
        })) as never);
      try {
        expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: false, reason: 'hand_over_first' });
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: key } } })).state).toBe('approved');
    });

    it('a details tap spent by a failed try is not claimed again by a try that read the row before it failed', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      const key = asked.ok ? asked.job.detailsToFill[0].key : '';
      const approved = await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: key } } });
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: false });
      expect(await settleEffect(jobId, key, 'failed', 'the form did not take it')).toBe(true);
      // The second try read the row while it was still approved: the claim finds it failed, and without a new tap that is not theirs
      const read = jest.spyOn(prisma.computerEffect, 'findUnique').mockResolvedValueOnce(approved);
      expect(await planEffect(jobId, { key, kind: 'details' })).toMatchObject({ ok: false, reason: 'look_up' });
      read.mockRestore();
      expect((await prisma.computerEffect.findUniqueOrThrow({ where: { jobId_effectKey: { jobId, effectKey: key } } })).state).toBe('failed');
    });

    it('what and where are kept apart whatever they contain, and two different pairs never share a key', async () => {
      const { sara, jobId } = await waitingJob();
      const tricky = { what: 'Your name → attacker.example', where: 'visa.example' };
      await requestHandover(jobId, 'details', minutes(1), tricky);
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, tricky);
      expect(asked.ok && asked.job.detailsToFill).toEqual([{ key: detailsKey(tricky.what, tricky.where), ...tricky }]);
      // "A:B" with "C" and "A" with "B:C" used to be one key
      expect(detailsKey('A:B', 'C')).not.toEqual(detailsKey('A', 'B:C'));
      expect(detailsKey('A', 'B')).toEqual(detailsKey('A', 'B'));
    });

    it('with two jobs in the person’s hands after a take over, the tap goes to the one that named something, even when an older one named nothing (readers run side by side)', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, NOW);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Write', writes: false }, NOW);
      if (!reader.ok || !writer.ok) throw new Error('no');
      const ready = { what: 'Your name', where: 'visa-portal.example' };
      await requestHandover(writer.job.id, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id, minutes(2));
      // The read-only job was only working: it is theirs now too, and named nothing
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).toMatchObject({ status: 'waiting', control: 'person', readyWhat: null });
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      expect(asked.ok).toBe(true);
      expect(await prisma.computerEffect.count({ where: { jobId: writer.job.id, kind: 'details', state: 'approved' } })).toBe(1);
      expect(await prisma.computerEffect.count({ where: { jobId: reader.job.id } })).toBe(0);
    });

    it('with two jobs that both named something, the tap goes to the one the screen showed', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, NOW);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Write', writes: false }, NOW);
      if (!reader.ok || !writer.ok) throw new Error('no');
      const first = { what: 'Your name', where: 'visa-portal.example' };
      const second = { what: 'Your passport number', where: 'other-portal.example' };
      await requestHandover(writer.job.id, 'details', minutes(1), first);
      await requestHandover(reader.job.id, 'details', minutes(1), second);
      await takeOver(sara.brickId, sara.id, minutes(2));
      expect((await fillInDetails(sara.brickId, sara.id, second)).ok).toBe(true);
      expect(await prisma.computerEffect.count({ where: { jobId: reader.job.id, state: 'approved' } })).toBe(1);
      expect(await prisma.computerEffect.count({ where: { jobId: writer.job.id } })).toBe(0);
    });

    it('a job that joins the person while they hand back is not left in their hands with nobody to hand it back', async () => {
      const { sara, jobId } = await waitingJob(false);
      await requestHandover(jobId, 'details', minutes(1));
      const originalCount = prisma.computerJob.count.bind(prisma.computerJob);
      const originalTransaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      // Only the job starting is looked at: the take over and the hand back the test makes in between look at the same rows themselves
      let acting = false;
      let tookOver = false;
      // The job has just taken its place on the machine (its claim committed, one job claimed): the person takes over now, so the job's own check for them came too early
      const update = jest.spyOn(prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
        const out = (await originalTransaction(...args)) as { ok?: boolean; count?: number } | null;
        if (!acting && !tookOver && out && out.ok === true && out.count === 1) {
          tookOver = true;
          acting = true;
          await takeOver(sara.brickId, sara.id, minutes(2));
          acting = false;
        }
        return out;
      }) as unknown as typeof prisma.$transaction);
      let handedBack = false;
      const count = jest.spyOn(prisma.computerJob, 'count').mockImplementation(((...args: Parameters<typeof originalCount>) => {
        const where = (args[0]?.where ?? {}) as { status?: string; control?: string };
        const result = originalCount(...args);
        if (acting || !tookOver || handedBack || where.status !== 'waiting' || where.control !== 'person') return result;
        handedBack = true;
        // It claimed its place and saw the person had the machine: the person hands back now
        return result.then(async (found) => {
          acting = true;
          await handBack(sara.brickId, sara.id);
          acting = false;
          count.mockRestore();
          return found;
        });
      }) as typeof prisma.computerJob.count);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(2));
      update.mockRestore();
      count.mockRestore();
      expect(reader.ok).toBe(true);
      expect(handedBack).toBe(true);
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
      expect(jobs.filter((job) => job.status === 'waiting' && job.control === 'person')).toEqual([]);
      expect(jobs.filter((job) => job.status === 'running').length).toBe(2);
    });

    it('a tap from a page that showed nothing approves nothing', async () => {
      const { sara, jobId } = await waitingJob();
      await requestHandover(jobId, 'details', minutes(1), { what: 'Your details', where: 'Step 1' });
      await takeOver(sara.brickId, sara.id);
      expect(await fillInDetails(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'changed' });
      expect(await fillInDetails(sara.brickId, sara.id, null)).toEqual({ ok: false, reason: 'changed' });
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
    });

    it('waits for the person before their details, holds the machine for them, and Take over and Hand back are theirs only', async () => {
      const { sara, jobId } = await waitingJob();
      const omar = await person('omar');
      expect(await requestHandover(jobId, 'details', minutes(1))).toMatchObject({ status: 'waiting', waitingFor: 'details', control: 'brick' });
      expect(await takeOver(sara.brickId, omar.id)).toEqual({ ok: false, reason: 'not_found' });
      expect(await takeOver(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { control: 'person', status: 'waiting' } });
      // Asked twice it is the same
      expect(await takeOver(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { control: 'person' } });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { control: 'brick', status: 'running', waitingFor: null } });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { status: 'running' } });
    });

    it('lets the person take over while the job is still working: it waits for them, the stretch so far is counted, and hand back carries on', async () => {
      const { sara, jobId } = await waitingJob();
      const taken = await takeOver(sara.brickId, sara.id, minutes(2));
      expect(taken).toMatchObject({ ok: true, job: { status: 'waiting', control: 'person', waitingFor: null } });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ secondsRun: 120 });
      // Asked twice it is the same and counts nothing more
      expect(await takeOver(sara.brickId, sara.id, minutes(3))).toMatchObject({ ok: true, job: { control: 'person' } });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ secondsRun: 120 });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { status: 'running', control: 'brick' } });
    });

    it('clears what Brick named once the details were put in (or confirmed not), so the tap is spent', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      const key = asked.ok ? asked.job.detailsToFill[0].key : '';
      await planEffect(jobId, { key, kind: 'details' });
      expect(await settleEffect(jobId, key, 'done', 'step 1')).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ readyWhat: null, readyWhere: null });
      expect(await fillInDetails(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'nothing_ready' });
    });

    it('CodeRabbit on #1025 (13): settling the details that were put in clears THAT prompt only: a newer prompt the runner registered meanwhile stays for the person', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      const key = asked.ok ? asked.job.detailsToFill[0].key : '';
      await planEffect(jobId, { key, kind: 'details' });
      // The runner names the next thing to put in before the settlement of the first lands
      await prisma.computerJob.update({ where: { id: jobId }, data: { readyWhat: 'Your address', readyWhere: 'Step 2' } });
      expect(await settleEffect(jobId, key, 'done', 'step 1')).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ readyWhat: 'Your address', readyWhere: 'Step 2' });
    });

    it('a tap after details were confirmed not put in approves the same key again, so Brick can try once more', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', minutes(1), ready);
      await takeOver(sara.brickId, sara.id);
      const first = await fillInDetails(sara.brickId, sara.id, ready);
      const key = first.ok ? first.job.detailsToFill[0].key : '';
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: false });
      expect(await settleEffect(jobId, key, 'failed', 'the form did not take it')).toBe(true);
      // The person hands back, Brick names the same thing again and the person taps again
      await handBack(sara.brickId, sara.id);
      await requestHandover(jobId, 'details', minutes(2), ready);
      await takeOver(sara.brickId, sara.id);
      const second = await fillInDetails(sara.brickId, sara.id, ready);
      expect(second.ok && second.job.detailsToFill.map((item) => item.key)).toEqual([key]);
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: false });
    });

    it('nothing is waiting, nothing to take over', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      expect(await takeOver(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'nothing_waiting' });
      expect(await handBack(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'nothing_waiting' });
      expect(await fillInDetails(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'not_in_control' });
    });

    it('never pays or submits: those are the person’s, with or without a take over', async () => {
      const { sara, jobId } = await waitingJob();
      expect(await planEffect(jobId, { key: 'pay-1', kind: 'pay' })).toEqual({ ok: false, reason: 'person_only' });
      expect(await planEffect(jobId, { key: 'submit-1', kind: 'submit' })).toEqual({ ok: false, reason: 'person_only' });
      await requestHandover(jobId, 'pay', minutes(1));
      await takeOver(sara.brickId, sara.id);
      expect(await planEffect(jobId, { key: 'pay-1', kind: 'pay' })).toEqual({ ok: false, reason: 'person_only' });
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
    });

    it('hands over BEFORE details and uploads: they are refused until the person took over and asked', async () => {
      const { sara, jobId } = await waitingJob();
      expect(await planEffect(jobId, { key: 'd1', kind: 'details' })).toEqual({ ok: false, reason: 'hand_over_first' });
      expect(await planEffect(jobId, { key: 'u1', kind: 'upload' })).toEqual({ ok: false, reason: 'hand_over_first' });
      await requestHandover(jobId, 'details', minutes(1));
      // Waiting is not enough: the mouse must be theirs
      expect(await planEffect(jobId, { key: 'd1', kind: 'details' })).toEqual({ ok: false, reason: 'hand_over_first' });
      await takeOver(sara.brickId, sara.id);
      // Theirs now, but they have not tapped "Fill in my details": a key nobody approved is not planned
      expect(await planEffect(jobId, { key: 'd1', kind: 'details' })).toEqual({ ok: false, reason: 'hand_over_first' });
      expect(await planEffect(jobId, { key: 'u1', kind: 'upload' })).toEqual({ ok: false, reason: 'hand_over_first' });
      expect(await prisma.computerEffect.count({ where: { jobId } })).toBe(0);
    });

    it('"Fill in my details" approves exactly what Brick named and where, once; Brick claims it once, and a retry looks up what happened', async () => {
      const { sara, jobId } = await waitingJob();
      const ready = { what: 'Your name, passport number, date of birth and nationality', where: 'visa-portal.example' };
      const named = await requestHandover(jobId, 'details', minutes(1), ready);
      expect(named).toMatchObject({ waitingFor: 'details', ready });
      // Before the person took over there is nothing to approve
      expect(await fillInDetails(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'not_in_control' });
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      const key = detailsKey(ready.what, ready.where);
      expect(asked.ok && asked.job.detailsToFill).toEqual([{ key, what: ready.what, where: ready.where }]);
      // Asked twice, still one
      const again = await fillInDetails(sara.brickId, sara.id, ready);
      expect(again.ok && again.job.detailsToFill).toHaveLength(1);
      const claims = await Promise.all([planEffect(jobId, { key, kind: 'details' }), planEffect(jobId, { key, kind: 'details' })]);
      expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
      expect(claims.filter((claim) => !claim.ok && claim.reason === 'look_up')).toHaveLength(1);
      expect(await settleEffect(jobId, key, 'done', 'visa-portal.example/apply step 1')).toBe(true);
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: 'done', evidence: 'visa-portal.example/apply step 1' });
      expect((await computerView(sara.brickId, sara.id))?.job?.detailsToFill).toEqual([]);
    });

    it('fills in nothing Brick did not name: with nothing ready the tap does nothing, and handing back forgets what was named', async () => {
      const { sara, jobId } = await waitingJob();
      await requestHandover(jobId, 'details', minutes(1));
      await takeOver(sara.brickId, sara.id);
      expect(await fillInDetails(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'nothing_ready' });
      await requestHandover(jobId, 'details', minutes(2), { what: 'Your details', where: 'Step 1' });
      expect((await handBack(sara.brickId, sara.id)).ok && true).toBe(true);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ readyWhat: null, readyWhere: null });
    });

    it('never does an outside effect twice: a retry of a send whose answer was lost looks it up, and only a confirmed failure may be tried again', async () => {
      const { jobId } = await waitingJob();
      expect(await planEffect(jobId, { key: 'pr-1', kind: 'publish', evidence: 'draft pull request' })).toEqual({ ok: true, already: false });
      // The "created" answer was lost: the retry finds the first, and must look up what happened
      expect(await planEffect(jobId, { key: 'pr-1', kind: 'publish' })).toEqual({ ok: false, reason: 'look_up', evidence: 'draft pull request' });
      expect(await settleEffect(jobId, 'pr-1', 'failed')).toBe(true);
      expect(await planEffect(jobId, { key: 'pr-1', kind: 'publish' })).toEqual({ ok: true, already: false });
      expect(await settleEffect(jobId, 'pr-1', 'done', 'pull request 12')).toBe(true);
      expect(await settleEffect(jobId, 'pr-1', 'failed')).toBe(false);
      expect(await planEffect(jobId, { key: 'pr-1', kind: 'publish' })).toMatchObject({ ok: true, already: 'done' });
      expect(await prisma.computerEffect.count({ where: { jobId, effectKey: 'pr-1' } })).toBe(1);
    });

    it('plans nothing for a job that is over', async () => {
      const { jobId } = await waitingJob();
      await finishJob(jobId, 'done', minutes(1));
      expect(await planEffect(jobId, { key: 'k', kind: 'send' })).toEqual({ ok: false, reason: 'job_over' });
    });
  });

  describe('whether a start that timed out on the caller’s side reached Orbit: by the start’s own key (game #2114)', () => {
    const keyOf = () => randomUUID();
    const ref = (name: string) => `dm-${name}-${tag}`;
    async function started(name: string, title: string, startKey: string | null = keyOf()) {
      const sara = await person(name);
      await giveComputer(sara.brickId, sara.id);
      const made = await startJob({ botId: sara.brickId, personId: sara.id, title, startKey, origin: { kind: 'dm', ref: ref(name) } }, NOW);
      if (!made.ok) throw new Error('no');
      return { sara, jobId: made.job.id, startKey };
    }
    /** Holds the start at its first read of the Brick's computer (before its job exists) until `go` is called; `there` settles when it is there, or fails with the start's own answer if it ended first. */
    const holdStartAtItsReads = (start: () => Promise<unknown>) => {
      let reached: () => void = () => undefined;
      const at = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let go: () => void = () => undefined;
      const goOn = new Promise<void>((resolve) => {
        go = resolve;
      });
      const real = prisma.brickComputer.findUnique.bind(prisma.brickComputer);
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementationOnce(((args: never) => {
        reached();
        return goOn.then(() => real(args));
      }) as never);
      const running = start();
      const there = Promise.race([at, running.then((answer) => Promise.reject(new Error(`the start ended before its reads: ${JSON.stringify(answer)}`)))]);
      return { there, go, running, spy };
    };

    it('answers the job that start made, with its status: the key alone says which start', async () => {
      const { sara, jobId, startKey } = await started('sam', 'Visa form');
      expect(await startedJobFor(sara.brickId, sara.id, startKey!)).toEqual({ id: jobId, status: 'running' });
      // A key nobody started with is a miss
      expect(await startedJobFor(sara.brickId, sara.id, keyOf())).toBeNull();
    });

    it('GPT round 4 R1: a start that committed and whose answer was lost is recovered by its key at ANY later time, in any state: the lookup and a replay both give the original job, never a second job or a second room', async () => {
      const first = await started('rox', 'Visa form');
      const key = first.startKey!;
      const rooms = () => prisma.meterReservation.count({ where: { jobId: first.jobId } });
      expect(await rooms()).toBe(1);
      const read = async (at: Date) => {
        const found = await startedJobFor(first.sara.brickId, first.sara.id, key, at);
        return found && !('inProgress' in found) ? { ...found, state: startStateOf(found.status) } : found;
      };
      const replay = async (at: Date, title = 'Visa form') => startJob({ botId: first.sara.brickId, personId: first.sara.id, title, startKey: key, origin: { kind: 'dm', ref: ref('rox') } }, at);
      // The caller gave up after ten minutes and later asks again: the job is still the one that key made, live
      const later = [minutes(11), minutes(60), minutes(3 * 24 * 60), minutes(40 * 24 * 60)];
      for (const at of later) {
        expect(await read(at)).toEqual({ id: first.jobId, status: 'running', state: 'live' });
        // The replay is the original answer, even with the title reworded (the key says which start, not the words)
        expect(await replay(at, 'A reworded visa form')).toMatchObject({ ok: true, job: { id: first.jobId, title: 'Visa form' } });
      }
      expect(await prisma.computerJob.count({ where: { botId: first.sara.brickId } })).toBe(1);
      expect(await rooms()).toBe(1);
      // The job ends (done): the same key still says so, and a replay still answers that job, with no new room and nothing written
      await finishJob(first.jobId, 'done', minutes(5));
      const settled = await prisma.meterEvent.count({ where: { jobId: first.jobId } });
      for (const at of later) {
        expect(await read(at)).toEqual({ id: first.jobId, status: 'done', state: 'done' });
        expect(await replay(at)).toMatchObject({ ok: true, job: { id: first.jobId, status: 'done' } });
      }
      expect(await prisma.computerJob.count({ where: { botId: first.sara.brickId } })).toBe(1);
      expect(await rooms()).toBe(1);
      expect(await prisma.meterEvent.count({ where: { jobId: first.jobId } })).toBe(settled);
      // An ended (stopped or failed) job reads as ended
      const second = await started('ray', 'Visa form');
      await finishJob(second.jobId, 'failed', minutes(5), 'It gave up', 'agent');
      const found = await startedJobFor(second.sara.brickId, second.sara.id, second.startKey!, minutes(3 * 24 * 60));
      expect(found).toMatchObject({ id: second.jobId });
      expect(['stopped', 'failed']).toContain((found as { status: string }).status);
      expect(startStateOf((found as { status: string }).status)).toBe('ended');
      // A second deliberate ask, even with the very same title, has its own key and is its own job
      const deliberate = await startJob({ botId: first.sara.brickId, personId: first.sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('rox') } }, minutes(12));
      expect(deliberate).toMatchObject({ ok: true });
      expect(await prisma.computerJob.count({ where: { botId: first.sara.brickId } })).toBe(2);
    });

    it('GPT round 4 R1: a start that was refused made no job, so its key finds none, and the same key asked again gets the same refusal at any later time (never a job)', async () => {
      const sara = await person('rix');
      // The computer is not given: the start is refused
      const key = keyOf();
      const ask = (at: Date) => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: key, origin: { kind: 'dm', ref: ref('rix') } }, at);
      expect(await ask(NOW)).toEqual({ ok: false, reason: 'off' });
      expect(await startedJobFor(sara.brickId, sara.id, key, minutes(11))).toBeNull();
      expect(await ask(minutes(3 * 24 * 60))).toEqual({ ok: false, reason: 'off' });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
      // It is given afterwards: the same key now makes the one job, and keeps answering it
      await giveComputer(sara.brickId, sara.id);
      const made = await ask(minutes(3 * 24 * 60 + 1));
      expect(made).toMatchObject({ ok: true });
      const again = await ask(minutes(3 * 24 * 60 + 2));
      expect(again).toMatchObject({ ok: true, job: { id: (made as { job: { id: string } }).job.id } });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(1);
    });

    it('never answers an OLDER job of the same chat and title for a start that made none: only the job the key made counts', async () => {
      const first = await started('sol', 'Visa form');
      // A second start of the same chat and title, just now, with its own key, that made no job (it never arrived, or was refused): the first start's job is not its answer
      const secondKey = keyOf();
      expect(await startedJobFor(first.sara.brickId, first.sara.id, secondKey)).toBeNull();
      expect(await startedJobFor(first.sara.brickId, first.sara.id, first.startKey!)).toEqual({ id: first.jobId, status: 'running' });
      // And when the second start made its job, its key answers that one, and the first key still answers the first
      const second = await startJob({ botId: first.sara.brickId, personId: first.sara.id, title: 'Visa form', startKey: secondKey, origin: { kind: 'dm', ref: ref('sol') } }, NOW);
      if (!second.ok) throw new Error('no');
      expect(await startedJobFor(first.sara.brickId, first.sara.id, secondKey)).toMatchObject({ id: second.job.id });
      expect(second.job.id).not.toBe(first.jobId);
      expect(await startedJobFor(first.sara.brickId, first.sara.id, first.startKey!)).toMatchObject({ id: first.jobId });
    });

    it('never answers another person’s or another Brick’s job, and the same key from two people is two starts', async () => {
      const a = await started('sia', 'Visa form');
      const b = await started('sib', 'Visa form', a.startKey);
      expect(b.jobId).not.toBe(a.jobId);
      expect(await startedJobFor(a.sara.brickId, b.sara.id, a.startKey!)).toBeNull();
      expect(await startedJobFor(b.sara.brickId, a.sara.id, a.startKey!)).toBeNull();
      expect(await startedJobFor(a.sara.brickId, a.sara.id, a.startKey!)).toEqual({ id: a.jobId, status: 'running' });
      expect(await startedJobFor(b.sara.brickId, b.sara.id, a.startKey!)).toEqual({ id: b.jobId, status: 'running' });
    });

    it('a start repeated with the same key answers the job it already made: never a second job, nor a second room', async () => {
      const { sara, jobId, startKey } = await started('sid', 'Visa form');
      // The repeat does not even try to save a job: it finds the one that key made first
      const create = jest.spyOn(prisma.computerJob, 'create');
      let again;
      try {
        again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sid') } }, NOW);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
      expect(again).toMatchObject({ ok: true, job: { id: jobId } });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(1);
      // A start with ANOTHER key for the same chat and title is another start: it is its own job (or waits in line behind this one)
      const other = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('sid') } }, NOW);
      expect(other).toMatchObject({ ok: true });
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(2);
    });

    it('two starts with the same key at the same moment make ONE job and both answer it', async () => {
      const sara = await person('sie');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const ask = () => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sie') } }, NOW);
      const [one, two, three] = await Promise.all([ask(), ask(), ask()]);
      for (const answer of [one, two, three]) expect(answer).toMatchObject({ ok: true });
      const ids = new Set([one, two, three].map((answer) => (answer as { job: { id: string } }).job.id));
      expect(ids.size).toBe(1);
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(1);
    });

    it('a start that is about to save its job when another start with the same key saves it first answers that job: the key is unique, and the loser finds the winner', async () => {
      const sara = await person('sig');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const ask = () => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sig') } }, NOW);
      // The first start is held after it found no job of this key and before it saves its own (its read of whether computers are paused is the second read of that setting)
      let reads = 0;
      let reached: () => void = () => undefined;
      const at = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let go: () => void = () => undefined;
      const goOn = new Promise<void>((resolve) => {
        go = resolve;
      });
      const real = prisma.appSetting.findUnique.bind(prisma.appSetting);
      const spy = jest.spyOn(prisma.appSetting, 'findUnique').mockImplementation(((args: never) => {
        reads += 1;
        if (reads !== 2) return real(args);
        reached();
        return goOn.then(() => real(args));
      }) as never);
      let first: Promise<unknown> = Promise.resolve();
      try {
        first = ask();
        await Promise.race([at, first.then((answer) => Promise.reject(new Error(`the first start ended early: ${JSON.stringify(answer)}`)))]);
        // The second start with the same key runs through and saves the job while the first waits
        const second = await ask();
        expect(second).toMatchObject({ ok: true });
        go();
        const answer = await first;
        expect(answer).toMatchObject({ ok: true, job: { id: (second as { job: { id: string } }).job.id } });
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(1);
      } finally {
        go();
        spy.mockRestore();
        await Promise.allSettled([first]);
      }
    });

    it('answers "in progress" while a start with the key is still reading, and the job once it is saved: a retry can never make a second job', async () => {
      const sara = await person('sev');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sev') } }, NOW));
      try {
        await held.there;
        // The start has made no job yet: this is NOT a miss
        expect(await startedJobFor(sara.brickId, sara.id, startKey)).toEqual({ inProgress: true });
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
        // Another key is not held back by it
        expect(await startedJobFor(sara.brickId, sara.id, keyOf())).toBeNull();
        expect(await prisma.computerStartMark.count()).toBe(1);
        held.go();
        const made = await held.running;
        if (!(made as { ok: boolean }).ok) throw new Error('the start did not run');
        expect(await startedJobFor(sara.brickId, sara.id, startKey)).toMatchObject({ id: (made as { job: { id: string } }).job.id });
        // Nothing is left behind once the job is saved
        expect(await prisma.computerStartMark.count()).toBe(0);
      } finally {
        held.go();
        held.spy.mockRestore();
        await Promise.allSettled([held.running]);
      }
    });

    it('a start that takes longer than its mark’s life is still "in progress" for as long as it can make its job (the mark is renewed while it works): never a miss that sends the game to start again with a new key', async () => {
      const sara = await person('slo');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const lived = { ...startMarkTiming };
      // A mark lives 0.6 s and is renewed every 0.15 s here; the start is held for 1.6 s, well past the old life
      startMarkTiming.lifeMs = 600;
      startMarkTiming.beatMs = 150;
      const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('slo') } }, NOW));
      try {
        await held.there;
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        // The job is not saved yet and the start can still make it: not a miss, at any time after the mark's first life
        expect(await startedJobFor(sara.brickId, sara.id, startKey)).toEqual({ inProgress: true });
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
        held.go();
        const made = await held.running;
        if (!(made as { ok: boolean }).ok) throw new Error('the start did not run');
        // It ended: no mark is left, and no beat brings one back
        expect(await prisma.computerStartMark.count()).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await prisma.computerStartMark.count()).toBe(0);
        expect(await startedJobFor(sara.brickId, sara.id, startKey)).toMatchObject({ id: (made as { job: { id: string } }).job.id });
      } finally {
        Object.assign(startMarkTiming, lived);
        held.go();
        held.spy.mockRestore();
        await Promise.allSettled([held.running]);
      }
    });

    describe('the renewal of a start’s mark ends with the start', () => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const lived = { ...startMarkTiming };
      beforeEach(() => {
        startMarkTiming.lifeMs = 600;
        startMarkTiming.beatMs = 40;
      });
      afterEach(() => {
        Object.assign(startMarkTiming, lived);
        jest.restoreAllMocks();
      });

      // Waits until a condition holds, looking every 10 ms, and fails when it does not within the deadline (never a fixed sleep for something that has to happen)
      const until = async (what: string, holds: () => boolean, deadlineMs = 10_000) => {
        const end = Date.now() + deadlineMs;
        while (!holds()) {
          if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
          await sleep(10);
        }
      };

      it('when the job is saved: no renewal runs after startJob returns, and none brings the mark back', async () => {
        const sara = await person('sbe');
        await giveComputer(sara.brickId, sara.id);
        const renew = jest.spyOn(prisma.computerStartMark, 'updateMany');
        const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('sbe') } }, NOW));
        try {
          // The start is inside its mocked read (its mark is made and its first reads are done): only then are the renewals counted
          await held.there;
          // While the start works the mark is renewed (so the check below can fail)
          await until('two renewals of the mark while the start works', () => renew.mock.calls.length >= 2);
          held.go();
          const made = (await held.running) as { ok: boolean };
          expect(made.ok).toBe(true);
          const after = renew.mock.calls.length;
          // Ten beats would fit in this wait
          await sleep(400);
          expect(renew.mock.calls.length).toBe(after);
          expect(await prisma.computerStartMark.count()).toBe(0);
        } finally {
          // Whatever failed above, the start is let go and finished, so no timer outlives the test
          held.go();
          held.spy.mockRestore();
          await Promise.allSettled([held.running]);
        }
      });

      it('when the start throws before it saved a job: the same, no renewal after it, no mark left', async () => {
        const sara = await person('sbf');
        await giveComputer(sara.brickId, sara.id);
        const renew = jest.spyOn(prisma.computerStartMark, 'updateMany');
        let go: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (go = resolve));
        let entered: () => void = () => undefined;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementationOnce((() => {
          entered();
          return gate.then(() => Promise.reject(new Error('The database went away')));
        }) as never);
        const running = startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('sbf') } }, NOW);
        const outcome = running.then(() => 'ended', (error: Error) => error.message);
        try {
          // Inside the read that will fail: the mark is made, and only now are the renewals counted
          await inside;
          await until('two renewals of the mark while the start works', () => renew.mock.calls.length >= 2);
          go();
          expect(await outcome).toBe('The database went away');
          const after = renew.mock.calls.length;
          await sleep(400);
          expect(renew.mock.calls.length).toBe(after);
          expect(await prisma.computerStartMark.count()).toBe(0);
          expect(await prisma.computerJob.count({ where: { botId: sara.brickId } })).toBe(0);
        } finally {
          go();
          await Promise.allSettled([outcome]);
        }
      });

      it('a mark is dated by the app’s clock, not the database’s: moving the app’s clock moves it', async () => {
        const sara = await person('sbg');
        await giveComputer(sara.brickId, sara.id);
        const later = new Date('2031-03-04T05:06:07.000Z');
        // Only the clock is moved: the timers and the database run as they are
        jest.useFakeTimers({ now: later, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
        // The mark is written WITH the app's time (the database's own default is never what it is dated by)
        const create = jest.spyOn(prisma.computerStartMark, 'create');
        const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('sbg') } }, NOW));
        try {
          await held.there;
          expect(create).toHaveBeenCalledTimes(1);
          expect((create.mock.calls[0][0] as { data: { startedAt?: Date } }).data.startedAt?.getTime()).toBe(later.getTime());
          const [mark] = await prisma.computerStartMark.findMany();
          expect(mark.startedAt.getTime()).toBe(later.getTime());
        } finally {
          jest.useRealTimers();
          held.go();
          held.spy.mockRestore();
          await Promise.allSettled([held.running]);
        }
      });
    });

    it('an older job of the same chat and title is not the answer while a second start of it is going on: "in progress", and then the second start’s own job', async () => {
      const first = await started('sez', 'Visa form');
      const secondKey = keyOf();
      const held = holdStartAtItsReads(() => startJob({ botId: first.sara.brickId, personId: first.sara.id, title: 'Visa form', startKey: secondKey, origin: { kind: 'dm', ref: ref('sez') } }, NOW));
      try {
        await held.there;
        expect(await startedJobFor(first.sara.brickId, first.sara.id, secondKey)).toEqual({ inProgress: true });
        held.go();
        const second = await held.running;
        if (!(second as { ok: boolean }).ok) throw new Error('the second start did not run');
        expect(await startedJobFor(first.sara.brickId, first.sara.id, secondKey)).toMatchObject({ id: (second as { job: { id: string } }).job.id });
        expect((second as { job: { id: string } }).job.id).not.toBe(first.jobId);
      } finally {
        held.go();
        held.spy.mockRestore();
        await Promise.allSettled([held.running]);
      }
    });

    it('is a miss again once the start ended without a job (refused, or failed): nothing is held for ever, and a start that fails leaves no mark', async () => {
      const sara = await person('sew');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementationOnce((() => Promise.reject(new Error('the database went away'))) as never);
      try {
        await expect(startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sew') } }, NOW)).rejects.toThrow('the database went away');
      } finally {
        spy.mockRestore();
      }
      expect(await startedJobFor(sara.brickId, sara.id, startKey)).toBeNull();
      expect(await prisma.computerStartMark.count()).toBe(0);
      // The same key sent again makes the job (the first start made none)
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey, origin: { kind: 'dm', ref: ref('sew') } }, NOW)).toMatchObject({ ok: true });
      // A start that is refused (the computer is off): the same
      const off = await person('sex');
      const offKey = keyOf();
      expect(await startJob({ botId: off.brickId, personId: off.id, title: 'Visa form', startKey: offKey, origin: { kind: 'dm', ref: ref('sex') } }, NOW)).toMatchObject({ ok: false, reason: 'off' });
      expect(await startedJobFor(off.brickId, off.id, offKey)).toBeNull();
      expect(await prisma.computerStartMark.count()).toBe(0);
    });

    it('a start with no key keeps no mark and takes no key: it is never asked about', async () => {
      const sara = await person('sey');
      await giveComputer(sara.brickId, sara.id);
      const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', origin: { kind: 'dm', ref: ref('sey') } }, NOW));
      try {
        await held.there;
        expect(await prisma.computerStartMark.count()).toBe(0);
        held.go();
        await held.running;
      } finally {
        held.go();
        held.spy.mockRestore();
        await Promise.allSettled([held.running]);
      }
      // Two starts with no key are two jobs (they did not say they were one): this is what the old callers did
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, startKey: null } })).toBe(1);
    });

    it('a mark whose start died stops counting after its life, and the sweep deletes the old ones: a dead start is a miss, never "in progress" for ever', async () => {
      const sara = await person('sfa');
      await giveComputer(sara.brickId, sara.id);
      const startKey = keyOf();
      const fence = startFenceOf(sara.brickId, sara.id, startKey);
      const mark = await prisma.computerStartMark.create({ data: { fence } });
      expect(await startedJobFor(sara.brickId, sara.id, startKey)).toEqual({ inProgress: true });
      // Past its life: it no longer says anything
      await prisma.computerStartMark.update({ where: { id: mark.id }, data: { startedAt: new Date(Date.now() - START_MARK_MS - 1_000) } });
      expect(await startedJobFor(sara.brickId, sara.id, startKey)).toBeNull();
      // Deleted by the sweep once it is old, never while it is young
      const young = await prisma.computerStartMark.create({ data: { fence } });
      await sweepComputers(new Date());
      expect(await prisma.computerStartMark.count({ where: { id: mark.id } })).toBe(1);
      await prisma.computerStartMark.update({ where: { id: mark.id }, data: { startedAt: new Date(Date.now() - 2 * 3_600_000) } });
      await sweepComputers(new Date());
      expect(await prisma.computerStartMark.count({ where: { id: mark.id } })).toBe(0);
      expect(await prisma.computerStartMark.count({ where: { id: young.id } })).toBe(1);
    });

    it('a start in progress holds no transaction and no lock while it reads: nothing under a connection waits for another connection', async () => {
      const sara = await person('seb');
      await giveComputer(sara.brickId, sara.id);
      const transaction = jest.spyOn(prisma, '$transaction');
      const held = holdStartAtItsReads(() => startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', startKey: keyOf(), origin: { kind: 'dm', ref: ref('seb') } }, NOW));
      try {
        await held.there;
        expect(transaction).not.toHaveBeenCalled();
        held.go();
        await held.running;
      } finally {
        held.go();
        held.spy.mockRestore();
        transaction.mockRestore();
        await Promise.allSettled([held.running]);
      }
    });
  });

  describe('telling the person how a job ended', () => {
    // A job that waited for a person who never came, and one that stopped when the month ran out: only these two are told
    async function unansweredJob(sara: { id: string; brickId: string }) {
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      await requestHandover(a.job.id, 'details', minutes(1));
      await sweepComputers(minutes(62));
      return a.job.id;
    }

    it('says nothing for a Brick that never ran a job, or whose job is still going', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      expect((await computerView(sara.brickId, sara.id))?.notice).toBeNull();
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      expect((await computerView(sara.brickId, sara.id))?.notice).toBeNull();
    });

    it('says a handover ended because nobody answered, naming the job', async () => {
      const sara = await person('sara');
      const jobId = await unansweredJob(sara);
      expect((await computerView(sara.brickId, sara.id, minutes(63)))?.notice).toMatchObject({ jobId, how: 'unanswered' });
    });

    it('shows the job paused for the month when a running job could not renew its room (it waits, so there is no ending to tell)', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 70_000 });
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await renewJob(job.job.id, minutes(5));
      const view = await computerView(sara.brickId, sara.id, minutes(6));
      expect(view?.notice).toBeNull();
      expect(view?.queued.map((one) => [one.id, one.queuedFor, one.pausedWhy])).toEqual([[job.job.id, 'paused', 'allowance']]);
    });

    it('says nothing for a job that finished, failed or was stopped by the person', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const done = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!done.ok) throw new Error('no');
      await finishJob(done.job.id, 'done', minutes(2));
      expect((await computerView(sara.brickId, sara.id, minutes(3)))?.notice).toBeNull();
      const failed = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(4));
      if (!failed.ok) throw new Error('no');
      await finishJob(failed.job.id, 'failed', minutes(5), null, 'ours');
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.notice).toBeNull();
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'C' }, minutes(7));
      await stopJobFor(sara.brickId, sara.id, minutes(8));
      expect((await computerView(sara.brickId, sara.id, minutes(9)))?.notice).toBeNull();
    });

    it('takes the notice away when a new job comes, so it never shows for an old job', async () => {
      const sara = await person('sara');
      await unansweredJob(sara);
      expect((await computerView(sara.brickId, sara.id, minutes(63)))?.notice).not.toBeNull();
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(64));
      expect((await computerView(sara.brickId, sara.id, minutes(65)))?.notice).toBeNull();
      // And when that job ends in a way that says nothing, the old ending does not come back
      const later = await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId, title: 'B' } });
      await finishJob(later.id, 'done', minutes(66));
      expect((await computerView(sara.brickId, sara.id, minutes(67)))?.notice).toBeNull();
    });

    it('dismiss takes the notice away for good, on every read, and asked twice changes nothing', async () => {
      const sara = await person('sara');
      const jobId = await unansweredJob(sara);
      const dismissed = await dismissComputerNotice(sara.brickId, sara.id, jobId, minutes(63));
      expect(dismissed.ok && dismissed.view.notice).toBeNull();
      expect((await computerView(sara.brickId, sara.id, minutes(64)))?.notice).toBeNull();
      expect((await dismissComputerNotice(sara.brickId, sara.id, jobId, minutes(65))).ok).toBe(true);
      expect((await computerView(sara.brickId, sara.id, minutes(66)))?.notice).toBeNull();
    });

    it('dismiss names the ending it was shown for: a newer ending is not dismissed by a tap meant for an older one', async () => {
      const sara = await person('sara');
      const first = await unansweredJob(sara);
      await dismissComputerNotice(sara.brickId, sara.id, first, minutes(63));
      // A second job ends unanswered later
      const b = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(70));
      if (!b.ok) throw new Error('no');
      await requestHandover(b.job.id, 'details', minutes(71));
      await sweepComputers(minutes(140));
      expect((await computerView(sara.brickId, sara.id, minutes(141)))?.notice).toMatchObject({ jobId: b.job.id, how: 'unanswered' });
      // A late tap for the first one changes nothing: the second ending is still told
      await dismissComputerNotice(sara.brickId, sara.id, first, minutes(142));
      expect((await computerView(sara.brickId, sara.id, minutes(143)))?.notice).toMatchObject({ jobId: b.job.id });
    });

    it('lets only the Brick\'s owner dismiss', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      const jobId = await unansweredJob(sara);
      expect(await dismissComputerNotice(sara.brickId, omar.id, jobId, minutes(63))).toEqual({ ok: false, reason: 'not_found' });
      expect((await computerView(sara.brickId, sara.id, minutes(64)))?.notice).toMatchObject({ jobId });
    });
  });

  describe('deleting the Brick', () => {
    it('stops its work at once, keeps its files, and Undo gives the Brick back without starting anything again', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!job.ok || !queued.ok) throw new Error('no');
      await deleteBrick(sara.brickId, sara.id, minutes(1));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'deleted' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'deleted' });
      const row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
      expect(row).toMatchObject({ machine: 'stopped', filesSavedAt: expect.any(Date) });
      expect((await currentEnvelope(minutes(1))).reservedMicros).toBe(0);
      const before = provider.calls.length;
      await undoBrickDelete(sara.brickId, sara.id, minutes(2));
      expect(provider.calls.length).toBe(before);
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['queued', 'running', 'waiting'] } } })).toBe(0);
    });

    it('Stop still ends a job that went from running to waiting between the read and the end', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const read = prisma.computerJob.findUnique.bind(prisma.computerJob);
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementationOnce(((...args: Parameters<typeof read>) =>
        read(...args).then(async (row) => {
          // The job asks the person to take over right after it was read as running
          await prisma.computerJob.update({ where: { id: job.job.id }, data: { status: 'waiting', waitingFor: 'details' } });
          return row;
        })) as never);
      try {
        await stopJobFor(sara.brickId, sara.id, minutes(2));
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
      expect(await prisma.meterReservation.count({ where: { personKey: `person:${sara.id}`, state: 'held' } })).toBe(0);
    });

    it('Stop ends a job waiting for the allowance too, so it never starts later', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 50_000 });
      await giveComputer(sara.brickId, sara.id);
      const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!queued.ok) throw new Error('no');
      const view = await stopJobFor(sara.brickId, sara.id, minutes(1));
      expect(view?.queued).toEqual([]);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
    });

    it('Stop with a job running and another in line ends both without the one in line ever starting', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const running = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const inLine = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!running.ok || !inLine.ok) throw new Error('no');
      const before = provider.calls.length;
      const view = await stopJobFor(sara.brickId, sara.id, minutes(1));
      expect(view?.queued).toEqual([]);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: running.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'person' });
      const second = await prisma.computerJob.findUniqueOrThrow({ where: { id: inLine.job.id } });
      expect(second).toMatchObject({ status: 'stopped', endedBy: 'person' });
      // It never held the machine, so it has no time to count and the room it was waiting for was never taken
      expect(second.secondsRun).toBe(0);
      expect(second.reservationKey).toBeNull();
      expect(provider.calls.slice(before).filter((call) => call.name === 'wake')).toEqual([]);
      expect((await currentEnvelope(minutes(1))).reservedMicros).toBe(0);
    });

    it('a second start that fails does not rewrite the state of a machine another job is using', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: false }, NOW);
      if (!first.ok) throw new Error('no');
      // The first job is still waking the machine when the second one asks and its wake breaks
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking' } });
      // ...a wake older than a start can take (no start is behind it any more), so the second start wakes the machine itself
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "bot_id" = ${sara.brickId}`;
      provider.failNext.wake = true;
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, minutes(1));
      expect(second).toEqual({ ok: false, reason: 'broken_start' });
      // The wake that failed may have started the machine, so it is stopped under the start's own ticket (Opus on #1040); the first job is not ended by the second start's failure
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machine: 'stopped' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.job.id } })).toMatchObject({ status: 'running' });
    });

    it('purging a Brick removes its machine and its saved files with NO copy made first, and the level of what is kept goes to 0 (audit F08)', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      provider.filesBytes = 1_000_000_000;
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      await deleteBrick(sara.brickId, sara.id, minutes(2));
      const newest = async () => Number((await prisma.meterEvent.findFirstOrThrow({ where: { botId: sara.brickId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }] })).quantity);
      expect(await newest()).toBe(5_000_000_000);
      const saves = provider.calls.filter((call) => call.name === 'saveFiles').length;
      expect(await purge(sara.brickId, sara.id, minutes(3))).toEqual([sara.brickId]);
      // The purge is finished, and the line that nothing is kept written, when the bot server has also cleared the Brick's chat rooms
      await confirmChatPurges([sara.brickId], minutes(3));
      // No new copy of the files was made to erase them
      expect(provider.calls.filter((call) => call.name === 'saveFiles')).toHaveLength(saves);
      expect(provider.calls.filter((call) => call.name === 'remove')).toEqual([expect.objectContaining({ ref: `fake-${sara.brickId}` })]);
      expect(provider.calls.filter((call) => call.name === 'deleteSavedCopy')).toEqual([expect.objectContaining({ ref: sara.brickId })]);
      expect(await newest()).toBe(0);
      expect(await prisma.bot.count({ where: { id: sara.brickId } })).toBe(0);
      expect(await prisma.brickComputer.count({ where: { botId: sara.brickId } })).toBe(0);
      // Asked again nothing is asked of the provider
      const calls = provider.calls.length;
      expect(await removeGoneBricks(minutes(4), sara.id)).toEqual([]);
      expect(provider.calls.length).toBe(calls);
    });

    it('a machine or saved copy that cannot be deleted now never holds the purge: the Brick is gone, and each outside deletion is tried again with its note kept', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      provider.filesBytes = 1_000_000_000;
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      await deleteBrick(sara.brickId, sara.id, minutes(2));
      const newest = async () => Number((await prisma.meterEvent.findFirstOrThrow({ where: { botId: sara.brickId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }] })).quantity);
      provider.failRemove = true;
      provider.failDeleteCopy = true;
      expect(await purge(sara.brickId, sara.id, minutes(3))).toEqual([sara.brickId]);
      // Gone from Orbit at once; the note says what is left outside, and the books still count what is still kept
      expect(await prisma.bot.count({ where: { id: sara.brickId } })).toBe(0);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machinePending: true, copyPending: true, attempts: 1, doneAt: null, providerRef: `fake-${sara.brickId}` });
      expect(await newest()).toBe(5_000_000_000);
      // Not due yet: the sweep leaves it alone until its wait is over (the sweeps here look at this Brick only: another test's purge note that is due must not count)
      const calls = provider.calls.length;
      await sweepPurges(minutes(3), [sara.brickId]);
      expect(provider.calls.length).toBe(calls);
      // The provider works again but the bucket does not: only what is left is tried, and the machine is not asked again
      provider.failRemove = false;
      await sweepPurges(minutes(10), [sara.brickId]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machinePending: false, copyPending: true, attempts: 2, doneAt: null });
      expect(await newest()).toBe(5_000_000_000);
      provider.failDeleteCopy = false;
      await confirmChatPurges([sara.brickId], minutes(10));
      await sweepPurges(minutes(60), [sara.brickId]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date), providerRef: null });
      expect(await newest()).toBe(0);
    });

    it('writes what is kept for the machine (its disk, and its saved copy) to the books when it changes, so the pool counts it (audit F4)', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      provider.filesBytes = 0;
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      const kept = () => prisma.meterEvent.findMany({ where: { botId: sara.brickId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }] });
      // Made: its disk. The rest that follows saves a copy (the pretend one is empty): the level did not change, so nothing more is written
      const first = await kept();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ kind: 'stored_bytes', pool: 'computer', payerKind: 'universe', botId: sara.brickId, personId: sara.id, quantity: BigInt(4_000_000_000), unit: 'byte' });
      // The pool's envelope carries the kept disk: 4 GB at the storage price
      const envelope = async () => (await envelopeIn(prisma, new Date(), { ...(await getMeterSettings()), storageMicrosPerGbMonth: 90_000 })).keptStorageMicros;
      expect(await envelope()).toBe(360_000);
      // A saved copy of 1 GB in our own storage is kept as well: the level is the disk and the copy
      provider.filesBytes = 1_000_000_000;
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(5));
      if (!second.ok) throw new Error('no');
      await finishJob(second.job.id, 'done', minutes(6));
      expect((await kept()).map((event) => Number(event.quantity))).toEqual([4_000_000_000, 5_000_000_000]);
      expect(await envelope()).toBe(450_000);
      // The Brick is deleted for good: the disk and the copy are both gone, and the line says so once, when the provider and the bucket have confirmed it
      await deleteBrick(sara.brickId, sara.id, minutes(7));
      expect(await purge(sara.brickId, sara.id, minutes(8))).toEqual([sara.brickId]);
      await confirmChatPurges([sara.brickId], minutes(8));
      expect((await kept()).map((event) => Number(event.quantity))).toEqual([4_000_000_000, 5_000_000_000, 0]);
      expect(await envelope()).toBe(0);
      // Asked again, nothing is written twice
      await removeGoneBricks(minutes(9));
      expect(await kept()).toHaveLength(3);
    });

    it('holds the disk of a machine that is not made yet in the pool before making it: a pool that cannot carry it makes no machine and the job waits (hard stop)', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      // The job's own room (10 minutes, 60,000) fits under the ceiling; a month of the 4 GB disk (360,000) does not
      await setUp({ poolCeilingMicros: 200_000, storageMicrosPerGbMonth: 90_000 });
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      expect(started.ok && started.job).toMatchObject({ status: 'queued', queuedFor: 'pool' });
      expect(provider.calls.filter((call) => call.name === 'create')).toEqual([]);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).providerRef).toBeNull();
      // Nothing stays held: not the job's room, not the disk's
      expect(await prisma.meterReservation.count({ where: { state: 'held' } })).toBe(0);
      // Room in the pool: the same job runs, the machine is made, and the disk's room is given back (the disk now counts as kept storage)
      await setUp({ poolCeilingMicros: 1_000_000, storageMicrosPerGbMonth: 90_000 });
      expect((await sweepComputers(minutes(1))).started).toBeGreaterThanOrEqual(1);
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
      expect(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } })).toBe(0);
      expect(await prisma.meterEvent.count({ where: { botId: sara.brickId, kind: 'stored_bytes', quantity: BigInt(4_000_000_000) } })).toBe(1);
    });

    it('keeps each job\'s own disk room: two jobs of one Brick starting together each hold theirs while the machine is made, and a try giving back its own never frees the other\'s', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      await setUp({ poolCeilingMicros: 10_000_000, storageMicrosPerGbMonth: 90_000 });
      await giveComputer(sara.brickId, sara.id);
      const heldAtCreate: number[] = [];
      const create = provider.create.bind(provider);
      provider.create = async (botId: string) => {
        heldAtCreate.push(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } }));
        return create(botId);
      };
      await Promise.all([startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW), startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW)]);
      // The machine is made once, and its disk's room was held while it was made
      expect(heldAtCreate).toHaveLength(1);
      expect(heldAtCreate[0]).toBeGreaterThanOrEqual(1);
      expect(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } })).toBe(0);
      // Rooms of two tries of one Brick are two rooms: giving back one leaves the other held
      await reserveDiskRoom({ botId: sara.brickId, jobId: 'job-a', bytes: 4_000_000_000 }, NOW);
      await reserveDiskRoom({ botId: sara.brickId, jobId: 'job-b', bytes: 4_000_000_000 }, NOW);
      await releaseRoom({ key: diskRoomKey(sara.brickId, 'job-b') }, NOW);
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: diskRoomKey(sara.brickId, 'job-a') } })).toMatchObject({ state: 'held' });
      // Two tries to start the same job's machine (Sentry): the one that lost gives back its own room, never the one the winner is making a machine under
      await reserveDiskRoom({ botId: sara.brickId, jobId: 'job-c', bytes: 4_000_000_000, attempt: 1 }, NOW);
      await reserveDiskRoom({ botId: sara.brickId, jobId: 'job-c', bytes: 4_000_000_000, attempt: 2 }, NOW);
      await releaseRoom({ key: diskRoomKey(sara.brickId, 'job-c', 2) }, NOW);
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: diskRoomKey(sara.brickId, 'job-c', 1) } })).toMatchObject({ state: 'held' });
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: diskRoomKey(sara.brickId, 'job-c', 2) } })).toMatchObject({ state: 'released' });
    });

    it('lets the sweep give back a disk room that lapsed (the server stopped between taking it and giving it back), and leaves one still good alone', async () => {
      const sara = await person('sara');
      await setUp({ poolCeilingMicros: 10_000_000, storageMicrosPerGbMonth: 90_000 });
      const hold = (key: string, expiresAt: Date) =>
        prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'system:disk', personId: null, botId: sara.brickId, jobId: null, amountMicros: BigInt(360_000), state: 'held', expiresAt } });
      await hold(diskRoomKey(sara.brickId, 'lapsed'), new Date(NOW.getTime() - 60_000));
      await hold(diskRoomKey(sara.brickId, 'fresh'), new Date(NOW.getTime() + 600_000));
      expect((await currentEnvelope(NOW)).reservedMicros + 0).toBeGreaterThan(0);
      await sweepComputers(NOW);
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: diskRoomKey(sara.brickId, 'lapsed') } })).toMatchObject({ state: 'released' });
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: diskRoomKey(sara.brickId, 'fresh') } })).toMatchObject({ state: 'held' });
    });

    it('keeps a disk room that lapsed while its job is still starting the machine, and gives it back once the job is over or the hard stop has passed', async () => {
      const sara = await person('sara');
      await setUp({ poolCeilingMicros: 10_000_000, storageMicrosPerGbMonth: 90_000 });
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!started.ok) throw new Error('no');
      // The machine of this Brick is not made yet in this picture (the provider is still making it): its record has no machine
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { providerRef: null, machine: 'none' } });
      const hold = (key: string, createdAt: Date) =>
        prisma.meterReservation.create({ data: { reservationKey: key, personKey: 'system:disk', personId: null, botId: sara.brickId, jobId: null, amountMicros: BigInt(360_000), state: 'held', expiresAt: new Date(NOW.getTime() - 60_000), createdAt } });
      const mine = diskRoomKey(sara.brickId, started.job.id, NOW.getTime());
      await hold(mine, new Date(NOW.getTime() - 10 * 60_000));
      // The machine is still being made (the job runs): the room lapsed by its own clock but is kept
      await sweepComputers(NOW);
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: mine } })).toMatchObject({ state: 'held' });
      // Held for longer than the hard stop: given back whatever the job does
      await sweepComputers(minutes(40));
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: mine } })).toMatchObject({ state: 'released' });
      // The job is over: its room goes at the next sweep
      const other = diskRoomKey(sara.brickId, started.job.id, NOW.getTime() + 1);
      await hold(other, new Date(minutes(50).getTime() - 60_000));
      await prisma.computerJob.update({ where: { id: started.job.id }, data: { status: 'done', endedAt: minutes(50) } });
      await sweepComputers(minutes(50));
      expect(await prisma.meterReservation.findUnique({ where: { reservationKey: other } })).toMatchObject({ state: 'released' });
    });

    it('keeps the disk room of a machine that was made while the books would not take its disk, until the sweep has written it, and only then gives the room back', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      await setUp({ poolCeilingMicros: 10_000_000, storageMicrosPerGbMonth: 90_000 });
      await giveComputer(sara.brickId, sara.id);
      // The machine is made and the job runs, but the books refuse the line for the disk: the job is not failed for that
      (meter.recordMeterEvent as jest.Mock).mockImplementation(async (event: { kind: string }, ...rest: unknown[]) => {
        if (event.kind === 'stored_bytes') throw new Error('The books are down');
        return (actualRecord as (...args: unknown[]) => unknown)(event, ...rest);
      });
      let started;
      try {
        started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
        expect(started.ok && started.job.status).toBe('running');
        const heldDisk = () => prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } });
        // The disk is in no line, so its room is still held: the pool still counts it
        expect(await heldDisk()).toBe(1);
        expect(await prisma.meterEvent.count({ where: { botId: sara.brickId, kind: 'stored_bytes' } })).toBe(0);
        // The room lapses and the books are still down: the sweep keeps it
        await sweepComputers(minutes(20));
        expect(await heldDisk()).toBe(1);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
      // The books work again: the sweep writes the line first, then gives the room back
      await sweepComputers(minutes(21));
      // The level counts the disk and whatever copy the job's end saved: the disk is in it
      const level = await prisma.meterEvent.findMany({ where: { botId: sara.brickId, kind: 'stored_bytes' } });
      expect(level).toHaveLength(1);
      expect(Number(level[0].quantity)).toBeGreaterThanOrEqual(4_000_000_000);
      expect(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } })).toBe(0);
    });

    it('does not count the disk room as a job running, or against the person’s allowance, and gives it back when the making fails', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      await setUp({ poolCeilingMicros: 10_000_000, storageMicrosPerGbMonth: 90_000, atOnceAll: 1 });
      await giveComputer(sara.brickId, sara.id);
      provider.failNext.create = true;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect(await prisma.meterReservation.count({ where: { state: 'held' } })).toBe(0);
      // The one place for a job at a time (atOnceAll 1) was not taken by the disk: the next job starts
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(1));
      expect(next.ok && next.job.status).toBe('running');
      expect(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } })).toBe(0);
    });

    it('removes the machine for good without saving its files first: a save that would fail changes nothing about the erasure', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      await deleteBrick(sara.brickId, sara.id, minutes(2));
      provider.failSaves = true;
      provider.failNext.saveFiles = true;
      expect(await purge(sara.brickId, sara.id, minutes(3))).toEqual([sara.brickId]);
      await confirmChatPurges([sara.brickId], minutes(3));
      expect(provider.calls.filter((call) => call.name === 'remove')).toHaveLength(1);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date) });
    });
  });
  describe('the team’s wind-down', () => {
    it('closes the door first: no new job starts and no computer is given, and every job and machine is ended and proven stopped', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await giveComputer(sara.brickId, sara.id);
      await giveComputer(omar.brickId, omar.id);
      const running = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const waiting = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      const other = await startJob({ botId: omar.brickId, personId: omar.id, title: 'C' }, NOW);
      if (!running.ok || !waiting.ok || !other.ok) throw new Error('did not start');
      const status = await startWindDown('team@example.test', minutes(3));
      expect(status).toMatchObject({ on: true, by: 'team@example.test', jobsLeft: 0, machinesLeft: 0 });
      for (const id of [running.job.id, waiting.job.id, other.job.id]) expect(await prisma.computerJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'stopped', endedBy: 'off', agentResponseId: null });
      // The time that ran is counted, and the room is settled
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${running.job.id}:time` } })).toBe(1);
      expect(await prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:' } } })).toBe(0);
      // Both machines are not running any more, and the files stay
      expect(await provider.awake(`fake-${sara.brickId}`)).toBe(false);
      expect(await provider.awake(`fake-${omar.brickId}`)).toBe(false);
      expect((await computerView(sara.brickId, sara.id))?.files.savedAt).not.toBeNull();
      // Nothing new starts, nothing is given, and a machine that was never made is never made
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'D' }, minutes(4))).toEqual({ ok: false, reason: 'not_open' });
      const lena = await person('lena');
      expect(await giveComputer(lena.brickId, lena.id)).toEqual({ ok: false, reason: 'not_open' });
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(2);
    });

    it('is proven machine by machine: a stop that did not take leaves the machine for the next sweep, which finishes it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const ref = `fake-${sara.brickId}`;
      provider.stuckAwake.add(ref);
      // The rest after the job also leaves it up, so the machine is still billed
      const status = await startWindDown('team@example.test', minutes(1));
      expect(status.machinesLeft).toBe(1);
      // Not proved asleep: nothing may use it, and it is still counted and tried again
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopping');
      provider.stuckAwake.delete(ref);
      await sweepComputers(minutes(2));
      expect(await windDownStatus()).toMatchObject({ on: true, jobsLeft: 0, machinesLeft: 0 });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
    });

    it('a stop that is refused leaves the machine to be stopped again, never left resting or recorded as stopped', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const ref = `fake-${sara.brickId}`;
      // Ending the last job rests the machine; the stop that follows is refused and the machine stays up
      provider.failNext.stop = true;
      provider.stuckAwake.add(ref);
      await startWindDown('team@example.test', minutes(1));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopping');
      expect((await windDownStatus()).machinesLeft).toBe(1);
      provider.stuckAwake.delete(ref);
      await continueWindDown(minutes(2));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
      expect((await windDownStatus()).machinesLeft).toBe(0);
    });

    it('a look that cannot say whether the machine runs (an undocumented status) does not stop the wind-down: the machine is still stopped', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const ref = `fake-${sara.brickId}`;
      const look = provider.awake.bind(provider);
      provider.awake = async () => {
        throw new Error('status hibernating');
      };
      try {
        provider.calls.length = 0;
        await startWindDown('team@example.test', minutes(1));
        expect(provider.calls.filter((call) => call.name === 'stop' && call.ref === ref).length).toBeGreaterThan(0);
      } finally {
        provider.awake = look;
      }
    });

    it('a Brick whose return from cold storage holds the claim is left to the return: its machine is not saved or stopped under it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const ref = `fake-${sara.brickId}`;
      // The return made its computer and wrote it down; it is now filling it from the copy
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'restoring', packStage: 'returning', packClaimId: 'claim-1', packClaimedAt: new Date(), providerRef: ref } });
      await startWindDown('team@example.test', minutes(1));
      await continueWindDown(minutes(2));
      expect(provider.calls.filter((call) => call.name === 'stop' || call.name === 'saveFiles')).toEqual([]);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machine: 'restoring', packStage: 'returning', providerRef: ref });
      // Once the return is over and the machine is awake, the wind-down stops it
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'waking', packStage: null, packClaimId: null, packClaimedAt: null } });
      await continueWindDown(minutes(3));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
    });

    it('a machine that is awake and not ready is stopped, and stopped again by the sweep when that did not take', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const ref = `fake-${sara.brickId}`;
      provider.failNext.ready = true;
      provider.failNext.stop = true;
      provider.stuckAwake.add(ref);
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect(provider.calls.filter((call) => call.name === 'stop')).toHaveLength(1);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopping');
      provider.stuckAwake.delete(ref);
      await sweepComputers(minutes(2));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
    });

    it('a machine that is awake and not ready, and goes to sleep, is left asleep', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      provider.failNext.ready = true;
      expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW)).toEqual({ ok: false, reason: 'broken_start' });
      expect(provider.calls.filter((call) => call.name === 'stop')).toHaveLength(1);
      expect(await provider.awake(`fake-${sara.brickId}`)).toBe(false);
    });

    it('a job that was in line when it started does not start in a sweep, and the keys of a job it ended are refused', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, NOW);
      if (!first.ok || !second.ok) throw new Error('no');
      const minted = await mintJobToken(first.job.id, 'model', minutes(0));
      if (!minted.ok) throw new Error('no key');
      await startWindDown('team@example.test', minutes(1));
      expect(await verifyJobToken(minted.token, 'model', minutes(2))).toMatchObject({ ok: false });
      await sweepComputers(minutes(2));
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, status: { in: ['queued', 'running', 'waiting'] } } })).toBe(0);
      expect(await prisma.computerJobToken.count({ where: { jobId: { in: [first.job.id, second.job.id] }, revokedAt: null } })).toBe(0);
    });

    it('asked twice is the same, and lifting it opens the door again: a stopped machine wakes for the next job', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const first = await startWindDown('team@example.test', minutes(1));
      const second = await startWindDown('someone-else@example.test', minutes(2));
      expect(second.since).toBe(first.since);
      expect(second.by).toBe('team@example.test');
      expect(await isWindingDown()).toBe(true);
      expect((await liftWindDown('team@example.test')).on).toBe(false);
      const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(3));
      expect(again.ok && again.job.status).toBe('running');
      expect(await provider.awake(`fake-${sara.brickId}`)).toBe(true);
    });
  });
  describe('the screen, through the bot server', () => {
    const secret = process.env.BOT_SERVICE_TOKEN;
    beforeAll(() => {
      process.env.BOT_SERVICE_TOKEN = 'a-test-service-token';
    });
    afterAll(() => {
      if (secret === undefined) delete process.env.BOT_SERVICE_TOKEN;
      else process.env.BOT_SERVICE_TOKEN = secret;
    });

    it('gives the owner a ticket for a computer that works, opens it once with a link made for that socket, and wakes nothing', async () => {
      const sara = await person('sara');
      const omar = await person('omar');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await screenTicket(sara.brickId, omar.id, 'watch', NOW)).toEqual({ ok: false, reason: 'not_found' });
      const ticket = await screenTicket(sara.brickId, sara.id, 'watch', NOW);
      if (!ticket.ok) throw new Error('no ticket');
      const woke = provider.calls.filter((call) => call.name === 'wake' || call.name === 'create').length;
      const opened = await openScreen(ticket.ticket, minutes(0.5));
      expect(opened).toMatchObject({ ok: true, mode: 'watch' });
      expect(opened.ok && opened.upstream).toContain('computer.pretend.invalid');
      expect(provider.calls.filter((call) => call.name === 'wake' || call.name === 'create')).toHaveLength(woke);
      // After the job ends the machine rests: no ticket, no open, and an open socket is told to close
      expect(await checkScreen(ticket.ticket, minutes(0.6))).toEqual({ ok: true, mode: 'watch' });
      await finishJob(job.job.id, 'done', minutes(1));
      expect(await screenTicket(sara.brickId, sara.id, 'watch', minutes(2))).toEqual({ ok: false, reason: 'resting' });
      expect(await openScreen(ticket.ticket, minutes(0.9))).toEqual({ ok: false, reason: 'resting' });
      expect(await checkScreen(ticket.ticket, minutes(1.2))).toEqual({ ok: false, reason: 'resting' });
      expect(provider.calls.filter((call) => call.name === 'wake' || call.name === 'create')).toHaveLength(woke);
    });

    it('a ticket opens a socket for 60 seconds only, and a forged, changed or someone else’s ticket opens nothing', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      const ticket = await screenTicket(sara.brickId, sara.id, 'watch', NOW);
      if (!ticket.ok) throw new Error('no ticket');
      expect(await openScreen(ticket.ticket, new Date(NOW.getTime() + 61_000))).toEqual({ ok: false, reason: 'expired' });
      // An open socket is not cut by its ticket's 60 seconds
      expect(await checkScreen(ticket.ticket, minutes(5))).toEqual({ ok: true, mode: 'watch' });
      const [prefix, body, signature] = ticket.ticket.split('.');
      const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), m: 'input', j: 'x', g: 0 })).toString('base64url');
      for (const bad of [`${prefix}.${other}.${signature}`, `${prefix}.${body}.${signature.slice(0, -2)}AA`, 'nonsense', '', null, 42, `x.${body}.${signature}`]) {
        expect(await openScreen(bad, NOW)).toEqual({ ok: false, reason: 'invalid' });
        expect(await checkScreen(bad, NOW)).toEqual({ ok: false, reason: 'invalid' });
      }
      // A socket is never kept longer than two hours
      expect(await checkScreen(ticket.ticket, new Date(NOW.getTime() + 2 * 60 * 60 * 1000 + 61_000))).toEqual({ ok: false, reason: 'too_long' });
    });

    it('input is only for the person who has taken over, and only for that take over: a hand back or a new take over kills the old ticket', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      await requestHandover(job.job.id, 'signin', minutes(1));
      await takeOver(sara.brickId, sara.id, minutes(1));
      const input = await screenTicket(sara.brickId, sara.id, 'input', minutes(1));
      if (!input.ok) throw new Error('no input ticket');
      expect(await openScreen(input.ticket, minutes(1.2))).toMatchObject({ ok: true, mode: 'input' });
      await handBack(sara.brickId, sara.id);
      expect(await checkScreen(input.ticket, minutes(2))).toEqual({ ok: false, reason: 'not_taken_over' });
      expect(await openScreen(input.ticket, minutes(1.3))).toEqual({ ok: false, reason: 'not_taken_over' });
      // The same job taken over again is a new take over: the old ticket stays dead
      await takeOver(sara.brickId, sara.id, minutes(3));
      expect(await checkScreen(input.ticket, minutes(3))).toEqual({ ok: false, reason: 'not_taken_over' });
      const again = await screenTicket(sara.brickId, sara.id, 'input', minutes(3));
      expect(again.ok).toBe(true);
    });
  });
});
