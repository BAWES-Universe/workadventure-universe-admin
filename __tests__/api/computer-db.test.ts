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
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { saveServerLimits } from '@/lib/bot-limits';
import * as meter from '@/lib/meter';

// The books' own writer, wrapped so a test can make one write fail and every other one run as it always does
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn(actual.recordMeterEvent) };
});
import { saveMeterSettings } from '@/lib/meter';
import { currentEnvelope } from '@/lib/meter-allowance';
import { recordGrant } from '@/lib/meter-grants';
import { mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { checkScreen, openScreen, screenTicket } from '@/lib/computer-screen';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import {
  computerView,
  fillInDetails,
  detailsKey,
  dismissComputerNotice,
  finishJob,
  giveComputer,
  handBack,
  isWindingDown,
  liftWindDown,
  planEffect,
  removeMachineBeforeDelete,
  renewJob,
  reportProgress,
  requestHandover,
  settleEffect,
  startJob,
  startWindDown,
  stopJobFor,
  sweepComputers,
  windDownStatus,
  takeOver,
  turnOffComputer,
  watchComputer,
} from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
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
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
};

const woke = () => provider.calls.filter((call) => call.name === 'create' || call.name === 'wake').length;

run('a Brick’s computer, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
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
      expect((await watchComputer(sara.brickId, omar.id)).ok).toBe(false);
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
      expect(provider.calls.map((call) => call.name)).toEqual(['create', 'wake']);
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

    it('lets a read-only job run beside the writer, on the same machine, with nothing woken twice', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'write' }, NOW);
      const before = woke();
      const look = await startJob({ botId: sara.brickId, personId: sara.id, title: 'look', writes: false }, NOW);
      expect(look.ok && look.job.status).toBe('running');
      expect(woke()).toBe(before);
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

    it('rests the machine when the last job is over, and keeps the disk: nothing is removed or reset', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      expect((await computerView(sara.brickId, sara.id))?.machine).toBe('resting');
      expect(provider.calls.map((call) => call.name)).toEqual(['create', 'wake', 'exec', 'exec', 'saveFiles', 'rest']);
      // A second job wakes the SAME machine: never a second one
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).providerRef).toBe(`fake-${sara.brickId}`);
    });

    it('clears the browser once the last job is over, before the machine rests, and not while another job still holds it', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A', writes: true }, NOW);
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

    it('stops a running job safely when its room cannot be renewed: what ran is counted, nothing new starts', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 70_000 });
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await renewJob(job.job.id, minutes(5))).toEqual({ ok: false, reason: 'allowance' });
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: job.job.id } });
      expect(after).toMatchObject({ status: 'stopped', endedBy: 'allowance' });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${job.job.id}:time` } })).toBe(1);
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

  describe('Stop, Watch and turning it off', () => {
    it('shows the screen only of a computer that works, and watching never wakes a machine', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      expect(await watchComputer(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'resting' });
      expect(provider.calls).toEqual([]);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect((await watchComputer(sara.brickId, sara.id)).ok).toBe(true);
      await stopJobFor(sara.brickId, sara.id, minutes(1));
      const before = woke();
      // An old link, a refresh and a reconnect: nothing wakes
      for (let i = 0; i < 3; i++) expect(await watchComputer(sara.brickId, sara.id)).toEqual({ ok: false, reason: 'resting' });
      expect(woke()).toBe(before);
    });

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
      let started: Awaited<ReturnType<typeof startJob>> | null = null;
      const rest = provider.rest.bind(provider);
      provider.rest = async (ref: string) => {
        // The next job starts at the very moment the rest is being done
        if (!started) started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
        return rest(ref);
      };
      await finishJob(a.job.id, 'done', minutes(1));
      expect(started).toMatchObject({ ok: true });
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
      await prisma.computerJob.update({ where: { id: a.job.id }, data: { status: 'done', endedAt: NOW } });
      const before = woke();
      await sweepComputers(minutes(1));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: b.job.id } })).toMatchObject({ status: 'stopped', endedBy: 'deleted' });
      expect(woke()).toBe(before);
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

    it('taking over steps in on every job working on the machine, the reader beside the writer too: none is left running under Brick', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'W' }, NOW);
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

    it('a run of deleted Bricks whose files cannot be saved does not keep the ones behind them from being removed', async () => {
      const sara = await person('sara');
      const names = ['d1', 'd2', 'd3', 'd4'];
      const bricks: string[] = [];
      for (const name of names) {
        const brick = await createBrick({ ownerId: sara.id, name: `${name} of Sara` });
        bricks.push(brick.id);
      }
      // The first three have a machine whose files cannot be saved; the last has no computer
      provider.failSaves = true;
      for (const id of bricks.slice(0, 3)) {
        await giveComputer(id, sara.id);
        const job = await startJob({ botId: id, personId: sara.id, title: 'A' }, NOW);
        if (!job.ok) throw new Error('no');
        await finishJob(job.job.id, 'done', minutes(1));
      }
      for (const [i, id] of bricks.entries()) {
        await deleteBrick(id, sara.id, minutes(2));
        await prisma.bot.update({ where: { id }, data: { goneAt: new Date(minutes(3).getTime() + i) } });
      }
      // One Brick to a page: the three that wait fill three pages, and the fourth is still removed
      const removed = await removeGoneBricks(minutes(10), sara.id, 1);
      expect(removed).toEqual([bricks[3]]);
      expect(await prisma.bot.count({ where: { id: { in: bricks.slice(0, 3) } } })).toBe(3);
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
      provider.failSaves = true;
      for (const id of bricks.slice(0, 3)) {
        await giveComputer(id, sara.id);
        const job = await startJob({ botId: id, personId: sara.id, title: 'A' }, NOW);
        if (!job.ok) throw new Error('no');
        await finishJob(job.job.id, 'done', minutes(1));
      }
      for (const [i, id] of bricks.entries()) {
        await deleteBrick(id, sara.id, minutes(2));
        await prisma.bot.update({ where: { id }, data: { goneAt: new Date(minutes(3).getTime() + i) } });
      }
      // A sweep reads three Bricks, one to a page: the three that wait use all of it
      expect(await removeGoneBricks(minutes(10), sara.id, 1, 3)).toEqual([]);
      // The next one starts with the Brick not looked at yet
      expect(await removeGoneBricks(minutes(11), sara.id, 1, 3)).toEqual([bricks[3]]);
    });

    it('a machine whose rest failed is rested by a later sweep, and one left claimed for rest by a stopped server is let go and rested too', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const a = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!a.ok) throw new Error('no');
      provider.failNext.rest = true;
      await finishJob(a.job.id, 'done', minutes(1));
      // The rest failed: the machine is still awake, so it is not marked as resting (the sweep only looks at ones that work)
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
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
      await sweepComputers(minutes(80));
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

  describe('handing over', () => {
    async function waitingJob() {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!job.ok) throw new Error('no');
      return { sara, jobId: job.job.id };
    }

    it('nothing starts under Brick’s hands while the person has the machine: a job asked for then waits until they hand back', async () => {
      const { sara, jobId } = await waitingJob();
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
      const { sara, jobId } = await waitingJob();
      await requestHandover(jobId, 'details', minutes(1));
      // The take over has looked for running jobs and found none; a read-only job starts right then
      const original = prisma.computerJob.findMany.bind(prisma.computerJob);
      let started: Awaited<ReturnType<typeof startJob>> | null = null;
      const spy = jest.spyOn(prisma.computerJob, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => {
        const result = original(...args);
        if (started === null && (args[0]?.where as { status?: string } | undefined)?.status === 'running') {
          started = { ok: false, reason: 'off' };
          return result.then(async (rows) => {
            spy.mockRestore();
            started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(2));
            return rows;
          });
        }
        return result;
      }) as typeof prisma.computerJob.findMany);
      await takeOver(sara.brickId, sara.id, minutes(2));
      spy.mockRestore();
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
      expect(jobs.filter((job) => job.status === 'running')).toEqual([]);
      expect(jobs.find((job) => job.id === jobId)).toMatchObject({ status: 'waiting', control: 'person' });
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

    it('with two jobs in the person’s hands after a take over, the tap goes to the one that named something: the writer, even when a read-only one is older and named nothing', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, NOW);
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Write' }, NOW);
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
      const writer = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Write' }, NOW);
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
      const { sara, jobId } = await waitingJob();
      await requestHandover(jobId, 'details', minutes(1));
      const original = prisma.computerJob.count.bind(prisma.computerJob);
      let calls = 0;
      const spy = jest.spyOn(prisma.computerJob, 'count').mockImplementation(((...args: Parameters<typeof original>) => {
        const where = (args[0]?.where ?? {}) as { status?: string; control?: string; id?: unknown };
        const result = original(...args);
        if (where.status !== 'waiting' || where.control !== 'person') return result;
        calls++;
        if (calls === 1) {
          // The job has passed the first look: the person takes over now
          return result.then(async (found) => {
            await takeOver(sara.brickId, sara.id, minutes(2));
            return found;
          });
        }
        if (calls === 2) {
          // It claimed its place and saw the person had the machine: the person hands back now
          return result.then(async (found) => {
            await handBack(sara.brickId, sara.id);
            spy.mockRestore();
            return found;
          });
        }
        return result;
      }) as typeof prisma.computerJob.count);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, minutes(2));
      spy.mockRestore();
      expect(reader.ok).toBe(true);
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

    it('says the month ran out when a running job could not renew its room', async () => {
      const sara = await person('sara');
      await setUp({ memberAllowanceMicros: 70_000 });
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await renewJob(job.job.id, minutes(5));
      expect((await computerView(sara.brickId, sara.id, minutes(6)))?.notice).toMatchObject({ jobId: job.job.id, how: 'month' });
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
      await finishJob(failed.job.id, 'failed', minutes(5));
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
      provider.failNext.wake = true;
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'B', writes: false }, minutes(1));
      expect(second).toEqual({ ok: false, reason: 'broken_start' });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ machine: 'waking' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: first.job.id } })).toMatchObject({ status: 'running' });
    });

    it('once a machine was removed, says so at once: a retried delete does not save a copy of a machine that is gone', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      expect(await removeMachineBeforeDelete(sara.brickId)).toBe(true);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ providerRef: null, machine: 'none' });
      const calls = provider.calls.length;
      expect(await removeMachineBeforeDelete(sara.brickId)).toBe(true);
      expect(provider.calls.length).toBe(calls);
    });

    it('removes the machine for good only after its files were saved; a save that failed leaves it for the next sweep', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      await finishJob(job.job.id, 'done', minutes(1));
      provider.failNext.saveFiles = true;
      expect(await removeMachineBeforeDelete(sara.brickId)).toBe(false);
      expect(provider.calls.some((call) => call.name === 'remove')).toBe(false);
      expect(await removeMachineBeforeDelete(sara.brickId)).toBe(true);
      expect(provider.calls.filter((call) => call.name === 'remove')).toHaveLength(1);
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
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      provider.stuckAwake.delete(ref);
      await sweepComputers(minutes(2));
      expect(await windDownStatus()).toMatchObject({ on: true, jobsLeft: 0, machinesLeft: 0 });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
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
