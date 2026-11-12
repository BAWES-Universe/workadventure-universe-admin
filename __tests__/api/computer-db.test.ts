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
import { deleteBrick, undoBrickDelete } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { currentEnvelope } from '@/lib/meter-allowance';
import { recordGrant } from '@/lib/meter-grants';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import {
  computerView,
  fillInDetails,
  finishJob,
  giveComputer,
  handBack,
  planEffect,
  removeMachineBeforeDelete,
  renewJob,
  reportProgress,
  requestHandover,
  settleEffect,
  startJob,
  stopJobFor,
  sweepComputers,
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
  await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
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
      expect(provider.calls.map((call) => call.name)).toEqual(['create', 'wake', 'saveFiles', 'rest']);
      // A second job wakes the SAME machine: never a second one
      await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(2));
      expect(provider.calls.filter((call) => call.name === 'create')).toHaveLength(1);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).providerRef).toBe(`fake-${sara.brickId}`);
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
      expect(await renewJob(queued.job.id, minutes(1))).toEqual({ ok: true });
    });

    it('keeps a renewing job going while there is room, and gives every held room back when a job ends or lapses', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
      if (!job.ok) throw new Error('no');
      expect(await renewJob(job.job.id, minutes(5))).toEqual({ ok: true });
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
      await requestHandover(jobId, 'details', minutes(1), { what: 'Your details', where: 'Step 1' });
      await takeOver(sara.brickId, sara.id);
      const asked = await fillInDetails(sara.brickId, sara.id);
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
      const first = await fillInDetails(sara.brickId, sara.id);
      const key = first.ok ? first.job.detailsToFill[0].key : '';
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: false });
      expect(await settleEffect(jobId, key, 'failed', 'the form did not take it')).toBe(true);
      // The person hands back, Brick names the same thing again and the person taps again
      await handBack(sara.brickId, sara.id);
      await requestHandover(jobId, 'details', minutes(2), ready);
      await takeOver(sara.brickId, sara.id);
      const second = await fillInDetails(sara.brickId, sara.id);
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
      const asked = await fillInDetails(sara.brickId, sara.id);
      const key = `details:${ready.what}:${ready.where}`;
      expect(asked.ok && asked.job.detailsToFill).toEqual([{ key, what: ready.what, where: ready.where }]);
      // Asked twice, still one
      const again = await fillInDetails(sara.brickId, sara.id);
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
});
