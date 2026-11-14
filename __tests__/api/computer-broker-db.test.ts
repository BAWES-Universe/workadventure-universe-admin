/**
 * How the runner reaches a computer through Orbit, the take-over fence on the machine, and keeping a working machine awake, against a
 * real database (build handoff v2, sections 4 and 5). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-broker-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests, type TurnEvent } from '@/lib/computer-provider';
import { Agent37Error } from '@/lib/agent37/client';
import { fenceMachine, giveComputer, handBack, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { verifyJobToken } from '@/lib/computer-token';
import { cancelJobTurn, prepareJob, reattachJobTurn, startTurn } from '@/lib/computer-broker';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
let fake: FakeComputerProvider;

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

const drain = async (events: AsyncGenerator<TurnEvent>) => {
  const seen: TurnEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};
const RELAY = 'https://bot-server.example.test';

run('the broker, the fence and keep-awake, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
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

  describe('getting the machine ready for a model', () => {
    it('writes a new key and the relay’s address onto the machine, and the key is good', async () => {
      const { sara, jobId } = await running();
      const done = await prepareJob(jobId, RELAY, NOW);
      expect(done).toMatchObject({ ok: true });
      const command = fake.commands.at(-1)?.command ?? '';
      const token = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(command)?.[1] ?? '';
      expect(command).toContain(`"url":"${RELAY}"`);
      expect(await verifyJobToken(token, 'model', NOW)).toMatchObject({ ok: true, jobId, botId: sara.brickId });
      // written whole and moved into place, readable by the machine's own user only
      expect(command).toMatch(/umask 077/);
      expect(command).toMatch(/mv .*relay\.json\.new.*relay\.json/);
    });

    it('ends the job’s earlier key when it makes a new one, so one is good at a time', async () => {
      const { jobId } = await running();
      await prepareJob(jobId, RELAY, NOW);
      const first = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(fake.commands.at(-1)?.command ?? '')?.[1] ?? '';
      await prepareJob(jobId, RELAY, minutes(1));
      const second = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(fake.commands.at(-1)?.command ?? '')?.[1] ?? '';
      expect(second).not.toBe(first);
      expect((await verifyJobToken(first, 'model', minutes(1))).ok).toBe(false);
      expect((await verifyJobToken(second, 'model', minutes(1))).ok).toBe(true);
    });

    it('refuses an address that is not a plain https one, before making a key', async () => {
      const { jobId } = await running();
      for (const bad of ['http://bot.example.test', 'https://user:pw@bot.example.test', "https://bot.example.test/x'y", 'https://bot.example.test/?a=1', 'not a url', 12, null]) {
        expect(await prepareJob(jobId, bad, NOW)).toEqual({ ok: false, reason: 'bad_relay' });
      }
      expect(await prisma.computerJobToken.count({ where: { jobId } })).toBe(0);
    });

    it('is not for a job that is over, waiting for its person, or not there, and ends the key when the machine did not take it', async () => {
      const { sara, jobId } = await running();
      expect(await prepareJob(randomUUID(), RELAY, NOW)).toEqual({ ok: false, reason: 'not_found' });
      fake.execAnswer = () => ({ exitCode: 1 });
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'failed' });
      expect(await prisma.computerJobToken.count({ where: { jobId, revokedAt: null } })).toBe(0);
      fake.failExec = true;
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'failed' });
      fake.failExec = false;
      fake.execAnswer = () => ({});
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'person_has_it' });
      await stopJobFor(sara.brickId, sara.id, NOW);
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'not_running' });
    });
  });

  describe('a turn', () => {
    it('is sent to the job’s machine, its ids are kept while it runs, and cleared when it ends', async () => {
      const { jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'resp-1', sessionId: 'sess-1' }, { type: 'text', text: 'Hello' }, { type: 'completed', outputText: 'Hello', usage: null }]];
      const started = await startTurn(jobId, 'Fill the form');
      if (!started.ok) throw new Error('no turn');
      const seen: TurnEvent[] = [];
      for await (const event of started.events) {
        seen.push(event);
        if (event.type === 'created') {
          const mid = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
          expect(mid).toMatchObject({ agentSessionId: 'sess-1', agentResponseId: 'resp-1' });
        }
      }
      expect(seen.map((event) => event.type)).toEqual(['created', 'text', 'completed']);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ agentSessionId: 'sess-1', agentResponseId: null });
      expect(fake.openedTurns[0].input).toEqual({ text: 'Fill the form', sessionId: null });
    });

    it('continues the job’s own conversation on the next turn', async () => {
      const { jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'r1', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }]];
      const first = await startTurn(jobId, 'one');
      if (first.ok) await drain(first.events);
      const second = await startTurn(jobId, 'two');
      if (second.ok) await drain(second.events);
      expect(fake.openedTurns[1].input.sessionId).toBe('sess-1');
    });

    it('says the agent is busy, with the turn’s id, when it is still working, and does not start another', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-9' } });
      fake.running.set('sess-1', 'resp-9');
      expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'busy', responseId: 'resp-9' });
      expect(fake.openedTurns).toHaveLength(0);
    });

    it('goes ahead when the turn it kept is over (its end was lost on the way)', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-old' } });
      const started = await startTurn(jobId, 'next');
      expect(started.ok).toBe(true);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBeNull();
    });

    it('says busy when the agent itself says its session is busy', async () => {
      const { jobId } = await running();
      fake.openTurn = async () => {
        throw new Agent37Error(409, 'session_busy', 'busy', 'resp-7');
      };
      expect(await startTurn(jobId, 'x')).toEqual({ ok: false, reason: 'busy', responseId: 'resp-7' });
    });

    it('is not sent to a job that waits for its person, is over, or is not there, and an empty message is not sent', async () => {
      const { sara, jobId } = await running();
      expect(await startTurn(jobId, '')).toEqual({ ok: false, reason: 'failed' });
      expect(await startTurn(randomUUID(), 'x')).toEqual({ ok: false, reason: 'not_found' });
      await takeOver(sara.brickId, sara.id, NOW);
      expect(await startTurn(jobId, 'x')).toEqual({ ok: false, reason: 'person_has_it' });
      await stopJobFor(sara.brickId, sara.id, NOW);
      expect(await startTurn(jobId, 'x')).toEqual({ ok: false, reason: 'not_running' });
      expect(fake.openedTurns).toHaveLength(0);
    });

    it('is cancelled at once, and says it was fenced, when the person took over before the agent started it', async () => {
      const { sara, jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'resp-late', sessionId: 'sess-1' }, { type: 'text', text: 'working' }, { type: 'completed', outputText: '', usage: null }]];
      const started = await startTurn(jobId, 'go');
      if (!started.ok) throw new Error('no turn');
      // The person takes over after the turn was asked for and before the agent said it began
      await takeOver(sara.brickId, sara.id, NOW);
      const seen = await drain(started.events);
      expect(seen).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
      expect(fake.cancelledTurns).toContain('resp-late');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBeNull();
    });

    it('is cancelled by the job’s own record, never by an id the caller gives', async () => {
      const { jobId } = await running();
      expect(await cancelJobTurn(jobId)).toEqual({ ok: true, cancelled: false });
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-5' } });
      expect(await cancelJobTurn(jobId)).toEqual({ ok: true, cancelled: true });
      expect(fake.cancelledTurns).toEqual(['resp-5']);
      expect(await cancelJobTurn(randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    });

    it('is reconnected to from the job’s own record, and a job with no turn says so', async () => {
      const { jobId } = await running();
      expect(await reattachJobTurn(jobId)).toEqual({ ok: false, reason: 'no_turn' });
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-5' } });
      const again = await reattachJobTurn(jobId);
      if (!again.ok) throw new Error('no reattach');
      expect((await drain(again.events)).map((event) => event.type)).toEqual(['created', 'completed']);
    });

    it('ending the job cancels the turn the agent was running', async () => {
      const { sara, jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-5' } });
      await stopJobFor(sara.brickId, sara.id, NOW);
      expect(fake.cancelledTurns).toContain('resp-5');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBeNull();
    });
  });

  describe('the take-over fence on the machine', () => {
    it('cancels the turn, stops what the agent started, proves none is left, and only then is the person’s', async () => {
      const { sara, jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-5' } });
      const taken = await takeOver(sara.brickId, sara.id, NOW);
      expect(taken.ok).toBe(true);
      expect(fake.cancelledTurns).toEqual(['resp-5']);
      expect(fake.commands.map((entry) => entry.command)).toEqual(['universe-fence', 'universe-fence --check']);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBeNull();
    });

    it('tries again when the first look finds something left, and the machine keeps working once it is proved', async () => {
      const { sara } = await running();
      let looks = 0;
      fake.execAnswer = (command) => (command.endsWith('--check') ? { stdout: ++looks < 2 ? 'remaining=3\n' : 'remaining=0\n' } : {});
      expect(await fenceMachine(sara.brickId)).toBe('done');
      expect(looks).toBe(2);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
    });

    it('stops the machine when it cannot be proved, so the person never has a screen with an agent still acting behind it', async () => {
      const { sara } = await running();
      fake.execAnswer = (command) => (command.endsWith('--check') ? { stdout: 'remaining=2\n' } : {});
      expect(await fenceMachine(sara.brickId)).toBe('failed');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
      expect(fake.calls.some((call) => call.name === 'stop')).toBe(true);
      // and a machine that does not answer at all is the same
      const other = await running('omar');
      fake.failExec = true;
      expect(await fenceMachine(other.sara.brickId)).toBe('failed');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: other.sara.brickId } })).machine).toBe('stopped');
    });

    it('a command that fails is not proof, whatever it printed', async () => {
      const { sara } = await running();
      fake.execAnswer = (command) => (command.endsWith('--check') ? { exitCode: 127, stdout: 'remaining=0\n' } : {});
      expect(await fenceMachine(sara.brickId)).toBe('failed');
    });

    it('does nothing on a machine that is not working, and handing back does not run it', async () => {
      const { sara } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      const before = fake.commands.length;
      await handBack(sara.brickId, sara.id);
      expect(fake.commands.length).toBe(before);
      await stopJobFor(sara.brickId, sara.id, NOW);
      expect(await fenceMachine(sara.brickId)).toBe('skipped');
    });
  });

  describe('keeping a working machine awake', () => {
    it('sends a command that does nothing every five minutes while a job holds the machine, once per sweep', async () => {
      const { sara } = await running();
      await sweepComputers(minutes(1));
      const quiet = () => fake.commands.filter((entry) => entry.command === 'true').length;
      expect(quiet()).toBe(1);
      await sweepComputers(minutes(2));
      expect(quiet()).toBe(1);
      await sweepComputers(minutes(7));
      expect(quiet()).toBe(2);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).keptAwakeAt).not.toBeNull();
    });

    it('sends none to a machine no job holds, which is left to rest', async () => {
      const { sara } = await running();
      await stopJobFor(sara.brickId, sara.id, NOW);
      const before = fake.commands.length;
      await sweepComputers(minutes(10));
      expect(fake.commands.length).toBe(before);
    });

    it('tries again on the next sweep when the machine did not answer', async () => {
      await running();
      fake.failExec = true;
      await sweepComputers(minutes(1));
      fake.failExec = false;
      await sweepComputers(minutes(2));
      expect(fake.commands.filter((entry) => entry.command === 'true')).toHaveLength(2);
    });
  });
});
