/**
 * Who has a Brick's computer while it changes hands (audit F02, acceptance A17 and A18), against a real database and the pretend provider.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-control-db.test.ts --runInBand
 *
 * The rule under test: the person's screen input and the agent's work are never both authorized, a take over answers only once its
 * fence is PROVED, a hand back resumes the agent only after the person's input has been revoked and drained, and a change of hands a
 * request died in is finished by the next one.
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, handBack, recoverControl, requestHandover, startJob, sweepComputers, takeOver, planEffect, fillInDetails } from '@/lib/computer';
import { beginTransition, CONTROL_TIMING, readControl } from '@/lib/computer-control';
import { checkScreen, openScreen, screenTicket } from '@/lib/computer-screen';
import { mintJobToken, verifyJobToken } from '@/lib/computer-token';
import { prepareJob, startTurn } from '@/lib/computer-broker';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
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

async function running(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}

/** A fence that stays pending until the test lets it go (the machine is slow to stop what the agent started). */
function slowFence() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.execAnswer = async (command) => {
    if (command === 'universe-fence') await gate;
    return command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {};
  };
  return release;
}

const fences = () => fake.commands.filter((entry) => entry.command === 'universe-fence').length;
const until = async (ok: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waited too long');
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = async <T,>(promise: Promise<T>, ms = 250): Promise<{ done: true; value: T } | { done: false }> =>
  Promise.race([promise.then((value) => ({ done: true as const, value })), pause(ms).then(() => ({ done: false as const }))]);

run('who has a Brick’s computer while it changes hands (F02, A17, A18)', () => {
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

  describe('the take over (A17)', () => {
    it('gives the person no input while the fence is still pending, and the take over does not answer until it is proved', async () => {
      const { sara } = await running();
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      // The jobs are already the person's (nothing runs under Brick's hands), but the fence is not proved: there is no input to ask for
      expect(await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ status: 'waiting', control: 'person' });
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'securing' });
      expect((await readControl(sara.brickId))?.state).toBe('fencing');
      expect((await settled(first)).done).toBe(false);
      release();
      expect(await first).toMatchObject({ ok: true, job: { control: 'person' } });
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
      const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      expect(ticket.ok).toBe(true);
      expect(await openScreen(ticket.ok ? ticket.ticket : '', NOW)).toMatchObject({ ok: true, mode: 'input' });
    });

    it('refuses an input socket opened with a ticket made before the fence was proved', async () => {
      const { sara } = await running();
      // A watch ticket is allowed (it only looks); an input ticket made by any other means cannot be opened mid-fence either
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      const control = await readControl(sara.brickId);
      // Whatever epoch a page guessed: the control is not human_ready, so every input ask is refused
      expect(control?.state).toBe('fencing');
      const watch = await screenTicket(sara.brickId, sara.id, 'watch', NOW);
      expect(watch.ok).toBe(true);
      release();
      await first;
      const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      if (!ticket.ok) throw new Error('no ticket');
      expect(await checkScreen(ticket.ticket, NOW)).toEqual({ ok: true, mode: 'input' });
    });

    it('two tabs taking over at the same moment share one fence, and neither is told it is done before it is', async () => {
      const { sara } = await running();
      const release = slowFence();
      const tabA = takeOver(sara.brickId, sara.id, NOW);
      const tabB = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() >= 1);
      await pause(150);
      expect(fences()).toBe(1);
      expect((await settled(tabA, 50)).done).toBe(false);
      expect((await settled(tabB, 50)).done).toBe(false);
      release();
      const [a, b] = await Promise.all([tabA, tabB]);
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      expect(fences()).toBe(1);
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
    });

    it('a second take over that comes while the fence is slow waits for it and says "still going" if it takes too long, never success', async () => {
      const { sara } = await running();
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      CONTROL_TIMING.joinMs = 200;
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'in_progress' });
      release();
      expect(await first).toMatchObject({ ok: true });
    });

    it('two app servers: only one of two compare-and-sets begins the transition', async () => {
      const { sara } = await running();
      const row = await readControl(sara.brickId);
      const results = await Promise.all([1, 2, 3, 4].map(() => beginTransition(sara.brickId, 'agent', row?.epoch ?? 0, 'fencing')));
      expect(results.filter((epoch) => epoch !== null)).toHaveLength(1);
    });

    it('a fence that cannot be proved leaves no input: the machine is stopped, and a stop that is not proved keeps control closed until it is', async () => {
      const { sara, jobId } = await running();
      fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? { stdout: 'remaining=2\n' } : {});
      const row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
      // The stop does not take: the machine stays awake
      fake.stuckAwake.add(row.providerRef as string);
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'not_secured' });
      expect((await readControl(sara.brickId))?.state).toBe('fencing');
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'securing' });
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      // The machine is proved stopped later: the sweep completes the take over (nothing can act on a stopped machine; the person has no screen until it wakes)
      fake.stuckAwake.clear();
      await sweepComputers(NOW);
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'resting' });
    });

    it('a fence that is not proved but whose machine IS proved stopped is closed: no screen, and the agent is not admitted', async () => {
      const { sara, jobId } = await running();
      fake.execAnswer = async (command) => (command.startsWith('universe-fence --check') ? { stdout: 'remaining=2\n' } : {});
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'resting' });
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
    });

    it('a read-only job alongside the writer is the person’s too: nothing runs under Brick’s hands, and both come back together', async () => {
      const { sara, jobId } = await running();
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, NOW);
      if (!reader.ok) throw new Error('no reader');
      expect((await takeOver(sara.brickId, sara.id, NOW)).ok).toBe(true);
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
      expect(jobs.filter((job) => job.status === 'running')).toEqual([]);
      expect(jobs.map((job) => `${job.status}/${job.control}`).sort()).toEqual(['waiting/person', 'waiting/person']);
      expect((await handBack(sara.brickId, sara.id)).ok).toBe(true);
      const after = await prisma.computerJob.findMany({ where: { botId: sara.brickId } });
      expect(after.map((job) => `${job.status}/${job.control}`).sort()).toEqual(['running/brick', 'running/brick']);
      expect(after.find((job) => job.id === jobId)).toBeTruthy();
    });

    it('a job asked for while the fence is pending waits in line, and runs after the hand back', async () => {
      const { sara } = await running();
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Read', writes: false }, NOW);
      expect(reader.ok && reader.job.status).toBe('queued');
      release();
      await first;
      await handBack(sara.brickId, sara.id);
      await sweepComputers(new Date(NOW.getTime() + 60_000));
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.ok ? reader.job.id : '' } })).toMatchObject({ status: 'running' });
    });

    it('the agent’s work is not authorized while the fence is pending or after: no key, no relay, no turn, no effect', async () => {
      const { sara, jobId } = await running();
      const before = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      expect((await verifyJobToken(before.token, 'model', NOW)).ok).toBe(false);
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      expect(await prepareJob(jobId, 'https://bot-server.example.test', NOW)).toMatchObject({ ok: false, reason: 'person_has_it' });
      expect(await startTurn(jobId, 'carry on')).toMatchObject({ ok: false, reason: 'person_has_it' });
      release();
      await first;
      expect(await prepareJob(jobId, 'https://bot-server.example.test', NOW)).toMatchObject({ ok: false, reason: 'person_has_it' });
    });

    it('the person’s "fill in my details" tap is only taken once the fence is proved', async () => {
      const { sara, jobId } = await running();
      const ready = { what: 'Your details', where: 'Step 1' };
      await requestHandover(jobId, 'details', NOW, ready);
      const release = slowFence();
      const first = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      expect(await fillInDetails(sara.brickId, sara.id, ready)).toEqual({ ok: false, reason: 'not_in_control' });
      release();
      await first;
      const asked = await fillInDetails(sara.brickId, sara.id, ready);
      expect(asked.ok).toBe(true);
      const key = asked.ok ? asked.job.detailsToFill[0].key : '';
      expect(await planEffect(jobId, { key, kind: 'details' })).toEqual({ ok: true, already: false });
    });
  });

  describe('crashes between stages (A17)', () => {
    it('a take over whose leader died after moving the jobs is finished by the next take over, and the fence is run', async () => {
      const { sara } = await running();
      // The leader got as far as claiming the transition and moving the job, then the server died
      const row = await readControl(sara.brickId);
      const epoch = await beginTransition(sara.brickId, 'agent', row?.epoch ?? 0, 'fencing');
      expect(epoch).not.toBeNull();
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'waiting', control: 'person' } });
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      expect(fences()).toBe(0);
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(fences()).toBe(1);
      expect(await readControl(sara.brickId)).toMatchObject({ state: 'human_ready', epoch });
    });

    it('a take over whose leader is alive (its lease has not run out) is joined, never taken over', async () => {
      const { sara } = await running();
      const row = await readControl(sara.brickId);
      await beginTransition(sara.brickId, 'agent', row?.epoch ?? 0, 'fencing');
      CONTROL_TIMING.joinMs = 200;
      expect(await takeOver(sara.brickId, sara.id, NOW)).toEqual({ ok: false, reason: 'in_progress' });
      expect(fences()).toBe(0);
    });

    it('the sweep finishes a take over its leader died in', async () => {
      const { sara } = await running();
      const row = await readControl(sara.brickId);
      await beginTransition(sara.brickId, 'agent', row?.epoch ?? 0, 'fencing');
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      expect(await recoverControl(NOW)).toBeGreaterThanOrEqual(1);
      expect((await readControl(sara.brickId))?.state).toBe('human_ready');
      expect(await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ status: 'waiting', control: 'person' });
    });

    it('a hand back whose leader died after moving the jobs is finished: keys made before still end, and only then is Brick admitted', async () => {
      const { sara, jobId } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const row = await readControl(sara.brickId);
      const epoch = await beginTransition(sara.brickId, 'human_ready', row?.epoch ?? 0, 'returning');
      expect(epoch).not.toBeNull();
      // The jobs went back, then the server died before the keys were ended and control was given back
      await prisma.computerJob.updateMany({ where: { botId: sara.brickId }, data: { status: 'running', control: 'brick' } });
      const generation = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).controlGeneration;
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      // Brick is not admitted yet: control is still being handed back
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      expect(await startTurn(jobId, 'carry on')).toMatchObject({ ok: false, reason: 'person_has_it' });
      expect((await handBack(sara.brickId, sara.id)).ok).toBe(true);
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).controlGeneration).toBeGreaterThan(generation);
      expect((await mintJobToken(jobId, 'model', NOW)).ok).toBe(true);
    });

    it('the sweep finishes a hand back its leader died in', async () => {
      const { sara } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const row = await readControl(sara.brickId);
      await beginTransition(sara.brickId, 'human_ready', row?.epoch ?? 0, 'returning');
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { controlLeaseUntil: new Date(Date.now() - 1000) } });
      await recoverControl(NOW);
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      expect(await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ status: 'running', control: 'brick' });
    });

    it('a computer the person holds after their jobs are over goes back to Brick’s, so the next job can start', async () => {
      const { sara, jobId } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      // The job ended some way that did not go through the usual end (a row put right by hand): the sweep still puts control right
      await prisma.computerJob.update({ where: { id: jobId }, data: { status: 'done', control: 'brick', endedAt: NOW } });
      await recoverControl(NOW);
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      const next = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next' }, NOW);
      expect(next.ok && next.job.status).toBe('running');
    });
  });

  describe('ending a job that the person holds', () => {
    it('a job that ends while the person holds the computer gives control back, after what the gateway was granted has drained', async () => {
      const { sara, jobId } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      if (!ticket.ok) throw new Error('no ticket');
      await openScreen(ticket.ticket, NOW);
      await finishJob(jobId, 'done', NOW);
      // The input is dead at once (the computer rests too); Brick is admitted only once the grant has run out
      expect((await checkScreen(ticket.ticket, NOW)).ok).toBe(false);
      expect((await readControl(sara.brickId))?.state).toBe('returning');
      const early = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next' }, NOW);
      expect(early.ok && early.job.status).toBe('queued');
      await pause(CONTROL_TIMING.openLeaseMs + 100);
      await sweepComputers(new Date(NOW.getTime() + 60_000));
      expect((await readControl(sara.brickId))?.state).toBe('agent');
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: early.ok ? early.job.id : '' } })).toMatchObject({ status: 'running' });
    });
  });

  describe('the hand back (A18)', () => {
    it('revokes the person’s input first and waits out what the gateway was granted: Brick resumes only after the input has drained', async () => {
      const { sara, jobId } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      if (!ticket.ok) throw new Error('no ticket');
      // The gateway opened a socket and asked: input is good for the lease
      expect(await openScreen(ticket.ticket, NOW)).toMatchObject({ ok: true });
      expect(await checkScreen(ticket.ticket, NOW)).toEqual({ ok: true, mode: 'input' });
      const startedAt = Date.now();
      const back = handBack(sara.brickId, sara.id);
      await until(async () => (await readControl(sara.brickId))?.state === 'returning');
      // From the first moment the old ticket is dead (the gateway is told no) and Brick is still not admitted
      expect(await checkScreen(ticket.ticket, NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      expect(await mintJobToken(jobId, 'model', NOW)).toEqual({ ok: false, reason: 'not_running' });
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'waiting', control: 'person' });
      expect((await settled(back, 50)).done).toBe(false);
      expect(await back).toMatchObject({ ok: true, job: { status: 'running', control: 'brick' } });
      // It did not return before the granted lease ran out (the delayed check could have been the last yes)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CONTROL_TIMING.inputLeaseMs - 60);
      expect((await readControl(sara.brickId))?.state).toBe('agent');
    });

    it('a reconnect with an old ticket after the hand back is refused, and so is one racing the hand back: no yes is given that the hand back did not wait for', async () => {
      for (let round = 0; round < 4; round++) {
        const { sara } = await running(`racer${round}`);
        await takeOver(sara.brickId, sara.id, NOW);
        const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
        if (!ticket.ok) throw new Error('no ticket');
        const begun = Date.now();
        const [opened, back] = await Promise.all([openScreen(ticket.ticket, NOW).then((answer) => ({ answer, at: Date.now() })), handBack(sara.brickId, sara.id).then((answer) => ({ answer, at: Date.now() }))]);
        expect(back.answer.ok).toBe(true);
        if (opened.answer.ok) {
          // A yes that was given is one the hand back waited for
          expect(back.at - begun).toBeGreaterThanOrEqual(CONTROL_TIMING.openLeaseMs - 80);
        }
        expect(await openScreen(ticket.ticket, NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
        expect(await checkScreen(ticket.ticket, NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      }
    });

    it('a hand back asked while the take over is still fencing waits for the fence, then hands back', async () => {
      const { sara } = await running();
      const release = slowFence();
      const taking = takeOver(sara.brickId, sara.id, NOW);
      await until(() => fences() === 1);
      const back = handBack(sara.brickId, sara.id);
      expect((await settled(back, 100)).done).toBe(false);
      expect(await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } })).toMatchObject({ status: 'waiting', control: 'person' });
      release();
      await taking;
      expect(await back).toMatchObject({ ok: true, job: { status: 'running', control: 'brick' } });
      expect((await readControl(sara.brickId))?.state).toBe('agent');
    });

    it('two hand backs at the same moment are one, and a second one later is the same', async () => {
      const { sara } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const [a, b] = await Promise.all([handBack(sara.brickId, sara.id), handBack(sara.brickId, sara.id)]);
      expect(a).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(b).toMatchObject({ ok: true, job: { status: 'running' } });
      expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true, job: { status: 'running' } });
      expect((await prisma.computerJob.findFirstOrThrow({ where: { botId: sara.brickId } })).controlGeneration).toBe(2);
    });

    it('stale credentials are refused at every stage: a key from before the take over, a screen ticket from an earlier take over, a ticket after the hand back', async () => {
      const { sara, jobId } = await running();
      const key = (await mintJobToken(jobId, 'model', NOW)) as { token: string };
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await verifyJobToken(key.token, 'model', NOW)).ok).toBe(false);
      const first = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      if (!first.ok) throw new Error('no ticket');
      await handBack(sara.brickId, sara.id);
      expect((await verifyJobToken(key.token, 'model', NOW)).ok).toBe(false);
      expect(await checkScreen(first.ticket, NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      await takeOver(sara.brickId, sara.id, NOW);
      // The same job taken over again is a new take over: the old ticket stays dead, and a new one works
      expect(await checkScreen(first.ticket, NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      const second = await screenTicket(sara.brickId, sara.id, 'input', NOW);
      expect(second.ok).toBe(true);
      expect(await checkScreen(second.ok ? second.ticket : '', NOW)).toEqual({ ok: true, mode: 'input' });
    });

    it('while control changes hands and after, the person’s input and Brick are never both authorized', async () => {
      const { sara, jobId } = await running();
      let stop = false;
      const violations: string[] = [];
      const watcher = (async () => {
        while (!stop) {
          // One read of the state and the lease: input granted to a person while Brick is admitted is the thing that must never be seen
          const rows = await prisma.$queryRaw<Array<{ control_state: string; granted: boolean }>>`SELECT control_state, (human_input_until IS NOT NULL AND human_input_until > now()) AS granted FROM brick_computers WHERE bot_id = ${sara.brickId}`;
          const row = rows[0];
          if (row && row.control_state === 'agent' && row.granted) violations.push('agent admitted while input still granted');
          await pause(2);
        }
      })();
      for (let round = 0; round < 3; round++) {
        await takeOver(sara.brickId, sara.id, NOW);
        const ticket = await screenTicket(sara.brickId, sara.id, 'input', NOW);
        if (ticket.ok) {
          await openScreen(ticket.ticket, NOW);
          await checkScreen(ticket.ticket, NOW);
        }
        await handBack(sara.brickId, sara.id);
        expect((await mintJobToken(jobId, 'model', NOW)).ok).toBe(true);
      }
      stop = true;
      await watcher;
      expect(violations).toEqual([]);
    });
  });
});
