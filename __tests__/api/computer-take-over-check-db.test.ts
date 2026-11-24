/**
 * The honest check before a take over (post 0.5.0, 1B), against a real database and the pretend provider.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-take-over-check-db.test.ts --runInBand
 *
 * The rules under test: a program the agent left running that the fence cannot stop is TOLD to the person (nothing is stopped for it, and the person has no
 * input yet); they restart the computer (once per ask: the job keeps its progress and Brick asks again with the same ask) or take over anyway (which goes on with
 * it running and says so until the hand back). A check that passes says nothing. The sweep never decides for the person.
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { computerView, getJob, giveComputer, handBack, requestHandover, restartComputer, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { CONTROL_TIMING, readControl } from '@/lib/computer-control';
import { screenTicket } from '@/lib/computer-screen';
import { mintJobToken } from '@/lib/computer-token';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-24T12:00:00Z');
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
let fake: FakeComputerProvider;
const savedTiming = { ...CONTROL_TIMING };

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = () =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
};

/** A job that waits for the person's sign-in (the ask), on a working machine. */
async function waitingForSignIn(name = 'sara', ask: { kind: 'signin' | 'details'; ready?: { what: string; where: string } } = { kind: 'signin' }) {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  await requestHandover(started.job.id, ask.kind, NOW, ask.ready);
  return { sara, jobId: started.job.id };
}

/** What the fence's own second look says: a program the fence has no right to stop is still running (the agent has administrator rights and can start one). */
const LEFT = { stdout: 'remaining=2\n', exitCode: 1 };
const CLEAR = { stdout: 'remaining=0\n' };
let leftAfter: { still: boolean } = { still: true };
const stillRunning = () => {
  leftAfter = { still: true };
  fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? (leftAfter.still ? LEFT : CLEAR) : {});
};
const until = async (ok: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waited too long');
};
const machineOf = async (botId: string) => (await prisma.brickComputer.findUniqueOrThrow({ where: { botId } })).machine;
const jobOf = (id: string) => prisma.computerJob.findUniqueOrThrow({ where: { id } });
const fences = () => fake.commands.filter((entry) => entry.command === 'universe-fence').length;
const stops = () => fake.calls.filter((call) => call.name === 'stop').length;

run('the honest check before a take over (1B)', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    Object.assign(CONTROL_TIMING, savedTiming, { pollMs: 10, joinMs: 2000, inputLeaseMs: 300, openLeaseMs: 300 });
    await setUp();
  });
  afterAll(async () => {
    Object.assign(CONTROL_TIMING, savedTiming);
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('a program is still running after the fence', () => {
    it('is told to the person: nothing is stopped, the person has no input yet, and Brick stays shut out', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      // The machine keeps working (it was not stopped for this), the job is the person's, control is closed
      expect(await machineOf(sara.brickId)).toBe('working');
      expect(stops()).toBe(0);
      expect(await jobOf(jobId)).toMatchObject({ status: 'waiting', control: 'person' });
      expect((await readControl(sara.brickId))?.state).toBe('fencing');
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'securing' });
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      // The page can say so, and offers Restart first for this ask
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toEqual({ state: 'blocked', restartOffered: true });
    });

    it('says nothing when the check passes: no mark on the computer, and the person has the screen', async () => {
      const { sara } = await waitingForSignIn();
      fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? CLEAR : {});
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true, job: { control: 'person' } });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
    });

    it('the sweep leaves it for the person: it never runs the fence again by itself, and never gives the screen without their tap', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      const before = fences();
      // Even after the program is gone and the lease long run out
      leftAfter.still = false;
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 60_000) } });
      await sweepComputers(NOW);
      expect(fences()).toBe(before);
      expect((await readControl(sara.brickId))?.state).toBe('fencing');
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toMatchObject({ state: 'blocked' });
    });

    it('asked again by the person, the check is made again: a program that is gone since lets them in with nothing said', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      leftAfter.still = false;
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });

    it('a fence that could not run at all is still not a block: the machine is stopped, as before', async () => {
      const { sara } = await waitingForSignIn();
      fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? { stdout: 'unmarked=1\n', exitCode: 3 } : {});
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(await machineOf(sara.brickId)).toBe('stopped');
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });
  });

  describe('take over anyway', () => {
    it('goes on with the program still running, says so on the computer until the hand back, and the person has the screen', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      expect(await takeOver(sara.brickId, sara.id, NOW, { anyway: true })).toMatchObject({ ok: true, job: { control: 'person' } });
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
      expect(await machineOf(sara.brickId)).toBe('working');
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toMatchObject({ state: 'running' });
      expect((await screenTicket(sara.brickId, sara.id, 'input', NOW)).ok).toBe(true);
      // Brick stays shut out the whole time
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      // The hand back ends it: Brick's again, nothing said any more
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
      expect((await readControl(sara.brickId))?.state).toBe('agent');
    });

    it('asked straight away (no block seen first) it is the same: the person chose it', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW, { anyway: true })).toMatchObject({ ok: true });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toMatchObject({ state: 'running' });
    });

    it('a passed check says nothing even when the person said anyway', async () => {
      const { sara } = await waitingForSignIn();
      fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? CLEAR : {});
      expect(await takeOver(sara.brickId, sara.id, NOW, { anyway: true })).toMatchObject({ ok: true });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });
  });

  describe('Restart first', () => {
    it('restarts the computer, keeps the job and its ask, gives Brick back its hands, and Brick is told to ask again with the same words', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      const asleep: string[] = [];
      const stop = fake.stop.bind(fake);
      fake.stop = async (ref) => {
        asleep.push(ref);
        return stop(ref);
      };
      leftAfter.still = false;
      const done = await restartComputer(sara.brickId, sara.id, NOW);
      expect(done).toMatchObject({ ok: true, job: { id: jobId, status: 'running', control: 'brick' } });
      // It was stopped and woken (a restart), the job went on, control is Brick's, nothing is said about a program any more
      expect(asleep).toHaveLength(1);
      expect(fake.calls.some((call) => call.name === 'wake')).toBe(true);
      expect(await machineOf(sara.brickId)).toBe('working');
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
      // The job keeps its ask, so Brick asks again with the same line: what it waited for is kept for it
      const job = await getJob(jobId);
      expect(job).toMatchObject({ restarts: 1, status: 'running', restartAsk: { kind: 'signin', what: null, where: null } });
    });

    it('keeps what Brick was ready to put in and where, for an ask for details', async () => {
      const { sara, jobId } = await waitingForSignIn('sara', { kind: 'details', ready: { what: 'Your name, passport number', where: 'visa-portal.example' } });
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      await restartComputer(sara.brickId, sara.id, NOW);
      expect(await getJob(jobId)).toMatchObject({ restarts: 1, restartAsk: { kind: 'details', what: 'Your name, passport number', where: 'visa-portal.example' } });
    });

    it('is offered once per ask: after the restart and Brick asking again, a program still running is told again with no restart, and anyway works', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await restartComputer(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      // Brick gets the page ready again and asks the same thing again
      await requestHandover(jobId, 'signin', NOW);
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toEqual({ state: 'blocked', restartOffered: false });
      // A second restart for the same ask is refused, and nothing is stopped for it
      const stopsBefore = stops();
      expect(await restartComputer(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'not_offered' });
      expect(stops()).toBe(stopsBefore);
      expect(await takeOver(sara.brickId, sara.id, NOW, { anyway: true })).toMatchObject({ ok: true });
    });

    it('is offered again for the NEXT ask, once the person has had the screen and handed back', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      await restartComputer(sara.brickId, sara.id, NOW);
      await requestHandover(jobId, 'signin', NOW);
      await takeOver(sara.brickId, sara.id, NOW, { anyway: true });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
      expect((await jobOf(jobId)).restartedAt).toBeNull();
      // Brick is not told to ask again for an ask that was answered
      expect((await getJob(jobId))?.restartAsk).toBeNull();
      // A new ask later: blocked again, and Restart first is offered again
      await requestHandover(jobId, 'pay', NOW);
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toEqual({ state: 'blocked', restartOffered: true });
    });

    it('is refused when nothing was blocked: no restart happens', async () => {
      const { sara } = await waitingForSignIn();
      expect(await restartComputer(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'not_offered' });
      expect(stops()).toBe(0);
      expect(await machineOf(sara.brickId)).toBe('working');
    });

    it('is only for the owner of the Brick', async () => {
      const { sara } = await waitingForSignIn();
      const other = await person('omar');
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await restartComputer(sara.brickId, other.id, NOW)).toEqual({ ok: false, reason: 'not_found' });
      expect(stops()).toBe(0);
    });

    it('two taps at the same moment are one restart', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      leftAfter.still = false;
      const [a, b] = await Promise.all([restartComputer(sara.brickId, sara.id, NOW), restartComputer(sara.brickId, sara.id, NOW)]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(stops()).toBe(1);
      expect((await jobOf(jobId)).restarts).toBe(1);
    });

    it('a second tap while the first restart is on its way joins it: one restart, one stop, and never "not offered"', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      leftAfter.still = false;
      // The stop is slow, so the second tap arrives well after control moved to `returning`
      const stop = fake.stop.bind(fake);
      fake.stop = async (ref) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return stop(ref);
      };
      const first = restartComputer(sara.brickId, sara.id, NOW);
      await until(async () => (await readControl(sara.brickId))?.state === 'returning');
      const second = restartComputer(sara.brickId, sara.id, NOW);
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(stops()).toBe(1);
      expect((await jobOf(jobId)).restarts).toBe(1);
    });

    it('a second tap that read the screen just before the first restart committed joins it, never "not offered"', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      leftAfter.still = false;
      // The second tap has read the control row (still `fencing`) and is held just before its "is a restart offered" read, while the first tap runs to the end
      const original = prisma.computerJob.count.bind(prisma.computerJob);
      let atCount: () => void = () => {};
      const reached = new Promise<void>((resolve) => (atCount = resolve));
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const spy = jest.spyOn(prisma.computerJob, 'count').mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
        atCount();
        await held;
        return original(args);
      }) as unknown as typeof prisma.computerJob.count);
      try {
        const second = restartComputer(sara.brickId, sara.id, NOW);
        await reached;
        const first = await restartComputer(sara.brickId, sara.id, NOW);
        expect(first.ok).toBe(true);
        release();
        const b = await second;
        expect(b.ok).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(stops()).toBe(1);
      expect((await jobOf(jobId)).restarts).toBe(1);
    });

    it('the three writes of a restart are one:control going back, the restart noted and the ask kept are never seen apart', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      leftAfter.still = false;
      const stop = fake.stop.bind(fake);
      fake.stop = async (ref) => {
        // Seen from outside, in the middle of the restart (after the writes, before the stop is over)
        const seen = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
        const job = await jobOf(jobId);
        expect({ state: seen.controlState, check: seen.takeOverCheck, restarts: job.restarts, kind: job.restartKind }).toEqual({ state: 'returning', check: 'restarting', restarts: 1, kind: 'signin' });
        return stop(ref);
      };
      expect(await restartComputer(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
    });

    it('a take over in the middle of Brick\'s work (no ask open) is restarted: Brick is told the person wanted the screen, not to ask again', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form' }, NOW);
      if (!started.ok) throw new Error('the job did not start');
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      leftAfter.still = false;
      expect(await restartComputer(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(await getJob(started.job.id)).toMatchObject({ restarts: 1, status: 'running', restartAsk: { kind: 'person', what: null, where: null } });
    });

    it('a computer left going back with the check still on blocked (a leader that died between writes, as an older build wrote it) is finished by the sweep; a take over at the check is not', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      // At the check (fencing + blocked) the sweep leaves it for the person
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      await sweepComputers(NOW);
      expect((await readControl(sara.brickId))?.state).toBe('fencing');
      // Going back with the check not yet moved on: finished
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlState: 'returning', controlEpoch: { increment: 1 }, controlLeaseUntil: new Date(Date.now() - 1000) } });
      leftAfter.still = false;
      await sweepComputers(NOW);
      expect((await readControl(sara.brickId))?.state).toBe('agent');
    });

    it('a restart whose leader died is finished by the sweep: the machine is stopped and woken, and the job goes back to Brick', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      // The leader began (control is going back, the restart is noted, the job's ask is kept) and died before it stopped anything
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlState: 'returning', controlEpoch: { increment: 1 }, controlLeaseUntil: new Date(Date.now() - 1000), takeOverCheck: 'restarting' } });
      await prisma.computerJob.update({ where: { id: jobId }, data: { restarts: 1, restartedAt: NOW, restartKind: 'signin' } });
      leftAfter.still = false;
      await sweepComputers(NOW);
      expect(stops()).toBe(1);
      expect(await machineOf(sara.brickId)).toBe('working');
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      expect(await jobOf(jobId)).toMatchObject({ status: 'running', control: 'brick', restarts: 1 });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });

    it('a computer that will not wake after the restart ends its jobs, as after any hand back', async () => {
      const { sara, jobId } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW);
      fake.failNext.wake = true;
      await restartComputer(sara.brickId, sara.id, NOW);
      expect((await jobOf(jobId)).status).toBe('stopped');
    });
  });

  describe('when the job is over before the person decides', () => {
    it('a take over that stopped at the check is finished by the sweep once its jobs are over: control is Brick’s again and nothing is said', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'still_running' });
      await stopJobFor(sara.brickId, sara.id, NOW);
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      await sweepComputers(NOW);
      await until(async () => (await readControl(sara.brickId))?.state === 'agent');
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });

    it('a take over anyway whose job ends is not said any more once control is Brick’s again', async () => {
      const { sara } = await waitingForSignIn();
      stillRunning();
      await takeOver(sara.brickId, sara.id, NOW, { anyway: true });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toMatchObject({ state: 'running' });
      await stopJobFor(sara.brickId, sara.id, NOW);
      await until(async () => {
        await sweepComputers(NOW);
        return (await readControl(sara.brickId))?.state === 'agent';
      });
      expect((await computerView(sara.brickId, sara.id, NOW))?.check).toBeNull();
    });
  });
});
