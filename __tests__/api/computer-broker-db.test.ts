/**
 * How the runner reaches a computer through Orbit, the take-over fence on the machine, and keeping a working machine awake, against a
 * real database (build handoff v2, sections 4 and 5). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-broker-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/computer', () => {
  const actual = jest.requireActual('@/lib/computer');
  return { ...actual, finishJob: jest.fn(actual.finishJob) };
});
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests, type TurnEvent } from '@/lib/computer-provider';
import { Agent37Error, Agent37Unreached } from '@/lib/agent37/client';
import { screenTicket } from '@/lib/computer-screen';
import { fenceMachine, finishJob, giveComputer, handBack, runnableJobs, runnableJobsPage, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
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
    process.env.BOT_SERVICE_TOKEN = process.env.BOT_SERVICE_TOKEN || 'service-secret-for-tickets';
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

    it('leaves a newer key of the same job alone when a delayed write of an older one arrives, and never blocks another job’s', async () => {
      const { jobId } = await running();
      await prepareJob(jobId, RELAY, NOW);
      const command = fake.commands.at(-1)?.command ?? '';
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      const runIt = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      try {
        expect(runIt(command).status).toBe(0);
        const written = readFileSync(join(home, '.universe', 'relay.json'), 'utf8');
        expect(written).toContain(RELAY);
        // A write of an older control number of the same job finds the newer one there and changes nothing
        const newer = command.replace(/ (\d+) (\d+) > "\$d\/relay\.gen"/, ' 5 $2 > "$d/relay.gen"').replace(/-gt (\d+) \]/, '-gt 5 ]');
        expect(runIt(newer).status).toBe(0);
        const older = command.replace('"url":"' + RELAY + '"', '"url":"https://older.example.test"').replace(/-gt \d+ \]/, '-gt 0 ]').replace(/ (\d+) (\d+) > "\$d\/relay\.gen"/, ' 0 $2 > "$d/relay.gen"');
        expect(runIt(older).status).toBe(0);
        expect(readFileSync(join(home, '.universe', 'relay.json'), 'utf8')).not.toContain('older.example.test');
        // Another job's write is never held back by this job's number
        const other = command.replace(jobId, 'another-job').replace('"url":"' + RELAY + '"', '"url":"https://other.example.test"');
        expect(runIt(other).status).toBe(0);
        expect(readFileSync(join(home, '.universe', 'relay.json'), 'utf8')).toContain('other.example.test');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('a write delayed past its claim never puts its ended key over the one the claim after it wrote, though both are of the same control number', async () => {
      const { jobId } = await running();
      await prepareJob(jobId, RELAY, NOW);
      const first = fake.commands.at(-1)?.command ?? '';
      // The claim's mark is in the command: a later claim has a later one
      const marked = (mark: number) => first.replace(/ (\d+) > "\$d\/relay\.gen"/, ` ${mark} > "$d/relay.gen"`).replace(/-gt (\d+) \]; \}; \}/, `-gt ${mark} ]; }; }`);
      const mine = Number(/ (\d+) > "\$d\/relay\.gen"/.exec(first)?.[1]);
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      const runIt = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      try {
        // The later claim writes first, then the delayed write of the earlier claim arrives: it changes nothing
        const later = marked(mine + 1_000).replace('"url":"' + RELAY + '"', '"url":"https://later.example.test"');
        const earlier = marked(mine).replace('"url":"' + RELAY + '"', '"url":"https://earlier.example.test"');
        expect(runIt(later).status).toBe(0);
        expect(runIt(earlier).status).toBe(0);
        expect(readFileSync(join(home, '.universe', 'relay.json'), 'utf8')).toContain('later.example.test');
        // ...and the later one over the earlier one does write
        const home2 = mkdtempSync(join(tmpdir(), 'universe-relay-'));
        try {
          const run2 = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home2 }, encoding: 'utf8' });
          expect(run2(earlier).status).toBe(0);
          expect(run2(later).status).toBe(0);
          expect(readFileSync(join(home2, '.universe', 'relay.json'), 'utf8')).toContain('later.example.test');
        } finally {
          rmSync(home2, { recursive: true, force: true });
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('a prepare held up past its claim, which another prepare has taken, changes no key and writes nothing, and says "preparing"', async () => {
      const { jobId } = await running();
      // The first prepare is held at its look at the job; its claim is then taken by another that made and wrote its key
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      let reached: () => void = () => undefined;
      const atTheLook = new Promise<void>((resolve) => (reached = resolve));
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as (args: unknown) => Promise<unknown>;
      let held = false;
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: unknown) =>
        real(args).then(async (row) => {
          if (!held) {
            held = true;
            reached();
            await gate;
          }
          return row;
        })) as never);
      let slow: ReturnType<typeof prepareJob> | null = null;
      try {
        slow = prepareJob(jobId, RELAY, NOW);
        await atTheLook;
        // The claim lapsed (a stopped process) and another prepare took it, made its key and wrote it
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(Date.now() - 50_000) } });
        spy.mockRestore();
        expect(await prepareJob(jobId, RELAY, minutes(1))).toMatchObject({ ok: true });
        const written = fake.commands.filter((entry) => entry.command.includes('relay.json'));
        expect(written).toHaveLength(1);
        const goodToken = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(written[0].command)?.[1] ?? '';
        letGo();
        expect(await slow).toEqual({ ok: false, reason: 'preparing' });
        // The key the other one wrote is still good, and the slow one wrote nothing
        expect((await verifyJobToken(goodToken, 'model', minutes(2))).ok).toBe(true);
        expect(fake.commands.filter((entry) => entry.command.includes('relay.json'))).toHaveLength(1);
      } finally {
        letGo();
        spy.mockRestore();
        await slow?.catch(() => undefined);
      }
    });

    it('marks its claims by the database\'s clock, so a server whose clock runs ahead cannot make the machine skip the later prepare of another: the key left is the later one\'s', async () => {
      const { jobId } = await running();
      // The first prepare is made by a server whose clock is an hour ahead
      jest.useFakeTimers({
        now: Date.now() + 3_600_000,
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      });
      try {
        expect(await prepareJob(jobId, RELAY, NOW)).toMatchObject({ ok: true });
      } finally {
        jest.useRealTimers();
      }
      expect(await prepareJob(jobId, RELAY, minutes(1))).toMatchObject({ ok: true });
      const written = fake.commands.filter((entry) => entry.command.includes('relay.json'));
      expect(written).toHaveLength(2);
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      try {
        // Both reach the machine in the order they were made
        for (const entry of written) expect(spawnSync('sh', ['-c', entry.command], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).status).toBe(0);
        const kept = JSON.parse(readFileSync(join(home, '.universe', 'relay.json'), 'utf8')) as { token: string };
        const secondToken = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(written[1].command)?.[1] ?? '';
        expect(kept.token).toBe(secondToken);
        expect((await verifyJobToken(kept.token, 'model', minutes(2))).ok).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('a prepare whose claim went to another before it made its key ends that key at once: of the keys the job has, only the one the claim\'s holder wrote is good', async () => {
      const { jobId } = await running();
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      let reached: () => void = () => undefined;
      const atTheMint = new Promise<void>((resolve) => (reached = resolve));
      const real = prisma.computerJobToken.create.bind(prisma.computerJobToken) as (args: unknown) => Promise<unknown>;
      let held = false;
      const spy = jest.spyOn(prisma.computerJobToken, 'create').mockImplementation(((args: unknown) => {
        if (!held) {
          held = true;
          reached();
          return gate.then(() => real(args));
        }
        return real(args);
      }) as never);
      let slow: ReturnType<typeof prepareJob> | null = null;
      try {
        slow = prepareJob(jobId, RELAY, NOW);
        await atTheMint;
        // Its claim lapsed meanwhile (a stopped process) and another prepare took it, made its key and wrote it
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(Date.now() - 50_000) } });
        expect(await prepareJob(jobId, RELAY, minutes(1))).toMatchObject({ ok: true });
        const written = fake.commands.filter((entry) => entry.command.includes('relay.json'));
        expect(written).toHaveLength(1);
        const goodToken = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(written[0].command)?.[1] ?? '';
        // The slow one makes its key only now, after the other's keys were ended: it is made good for a moment
        letGo();
        expect(await slow).toEqual({ ok: false, reason: 'preparing' });
        // ...and ended before it was ever written anywhere: the keys of the job that are good are the other's alone
        const live = await prisma.computerJobToken.findMany({ where: { jobId, revokedAt: null } });
        expect(live).toHaveLength(1);
        expect((await verifyJobToken(goodToken, 'model', minutes(2))).ok).toBe(true);
        expect(fake.commands.filter((entry) => entry.command.includes('relay.json'))).toHaveLength(1);
      } finally {
        letGo();
        spy.mockRestore();
        await slow?.catch(() => undefined);
      }
    });

    it('a prepare whose claim went to another while its key was being written leaves no key of its own good: of the keys the job has, only the one the claim\'s holder wrote works', async () => {
      const { jobId } = await running();
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      let reached: () => void = () => undefined;
      const atTheWrite = new Promise<void>((resolve) => (reached = resolve));
      let writes = 0;
      fake.execAnswer = async () => {
        writes += 1;
        if (writes === 1) {
          reached();
          await gate;
          return { exitCode: 1 };
        }
        return {};
      };
      const slow = prepareJob(jobId, RELAY, NOW);
      try {
        await atTheWrite;
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(Date.now() - 50_000) } });
        expect(await prepareJob(jobId, RELAY, minutes(1))).toMatchObject({ ok: true });
        const goodToken = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(fake.commands.at(-1)?.command ?? '')?.[1] ?? '';
        letGo();
        // Its own write failed and its claim is gone: it says so, and changes nothing of the other's
        expect((await slow).ok).toBe(false);
        const live = await prisma.computerJobToken.findMany({ where: { jobId, revokedAt: null } });
        expect(live).toHaveLength(1);
        expect((await verifyJobToken(goodToken, 'model', minutes(2))).ok).toBe(true);
      } finally {
        letGo();
        await slow.catch(() => undefined);
      }
    });

    it('says the job is not the runner’s to act on when the person took over while the key was being written', async () => {
      const { sara, jobId } = await running();
      let taken = false;
      fake.execAnswer = async () => {
        // The person takes over once, while the key is being written (the fence's own commands are not another take-over)
        if (!taken) {
          taken = true;
          await takeOver(sara.brickId, sara.id, NOW);
        }
        return {};
      };
      const done = await prepareJob(jobId, RELAY, NOW);
      expect(done).toMatchObject({ ok: false });
      const token = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(fake.commands.at(-1)?.command ?? '')?.[1] ?? '';
      // and the key it wrote is refused: it is of the control number before the take-over
      expect((await verifyJobToken(token, 'model', NOW)).ok).toBe(false);
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

    it('keeps the turn’s id when the reader goes away before it ends, so it can be reconnected or cancelled', async () => {
      const { jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'resp-1', sessionId: 'sess-1' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'completed', outputText: 'Hello', usage: null }]];
      const started = await startTurn(jobId, 'Fill the form');
      if (!started.ok) throw new Error('no turn');
      for await (const event of started.events) {
        if (event.type === 'text') break; // the runner drops
      }
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ agentSessionId: 'sess-1', agentResponseId: 'resp-1' });
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

    it('keeps the turn it kept when the check on it could not be made, and starts nothing', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-1', agentResponseId: 'resp-live' } });
      fake.activeTurn = async () => {
        throw new Error('gateway timeout');
      };
      expect(await startTurn(jobId, 'next')).toEqual({ ok: false, reason: 'failed' });
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBe('resp-live');
      expect(fake.openedTurns).toHaveLength(0);
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

    it('does not hand the runner’s own connection to the agent, so the turn’s id is kept even if the runner drops at once', async () => {
      const { jobId } = await running();
      const runner = new AbortController();
      const started = await startTurn(jobId, 'go', runner.signal);
      if (!started.ok) throw new Error('no turn');
      expect(fake.openedTurns[0].signal).toBeDefined();
      expect(fake.openedTurns[0].signal).not.toBe(runner.signal);
      runner.abort();
      expect(fake.openedTurns[0].signal?.aborted).toBe(false);
      // The runner stops reading as soon as it can: the id is still kept, because the reader is only heard once the id is stored
      const reading = started.events.next();
      const returning = started.events.return(undefined);
      await reading;
      await returning;
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBe('resp-1');
    });

    it('sends the caller to reconnect when a turn is kept but its conversation is not known, and clears it once it is gone', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: null, agentResponseId: 'resp-x' } });
      expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'busy', responseId: 'resp-x' });
      expect(fake.openedTurns).toHaveLength(0);
    });

    it('starts nothing when the runner is already gone', async () => {
      const { jobId } = await running();
      const runner = new AbortController();
      runner.abort();
      expect(await startTurn(jobId, 'go', runner.signal)).toEqual({ ok: false, reason: 'failed' });
      expect(fake.openedTurns).toHaveLength(0);
    });

    it('starts one turn at a time: a second start at the same moment is told it is busy, and the agent is asked once', async () => {
      const { jobId } = await running();
      fake.turns = [
        [{ type: 'created', id: 'resp-a', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }],
        [{ type: 'created', id: 'resp-b', sessionId: 'sess-2' }, { type: 'completed', outputText: '', usage: null }],
      ];
      const [one, two] = await Promise.all([startTurn(jobId, 'one'), startTurn(jobId, 'two')]);
      expect([one.ok, two.ok].sort()).toEqual([false, true]);
      // The other one's turn has no id yet, so there is nothing to reconnect to: it is told it is starting (ask again, not a failure), never "busy"
      expect([one, two].find((turn) => !turn.ok)).toEqual({ ok: false, reason: 'starting' });
      expect(fake.openedTurns).toHaveLength(1);
      const started = [one, two].find((turn) => turn.ok);
      if (!started || !started.ok) throw new Error('no turn');
      expect((await drain(started.events)).map((event) => event.type)).toEqual(['created', 'completed']);
      // Once that turn has ended, the claim is let go and the next one starts
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt).toBeNull();
      expect((await startTurn(jobId, 'three')).ok).toBe(true);
    });

    it('a claim left by a server that stopped is not waited behind for minutes: it is asked again later while it is fresh, and lapses after about 45 seconds', async () => {
      const { jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'resp-a', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }]];
      // Left claimed a moment ago, with no turn id: the runner is told "starting" (wait and ask again, not a bad turn), never "busy" (reconnect to nothing) or a failure
      await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 10_000) } });
      expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'starting' });
      expect(fake.openedTurns).toHaveLength(0);
      // After about 45 seconds nobody holds it any more
      await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 50_000) } });
      expect((await startTurn(jobId, 'go')).ok).toBe(true);
      expect(fake.openedTurns).toHaveLength(1);
    });

    it('keeps its claim fresh while it waits for the agent to say the turn\'s id, so a second start never takes it and opens another turn', async () => {
      const { jobId } = await running();
      let letGo: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      const open = jest.spyOn(fake, 'openTurn').mockImplementation((async () =>
        (async function* () {
          await gate;
          yield { type: 'created', id: 'resp-slow', sessionId: 'sess-slow' } as TurnEvent;
          yield { type: 'completed', outputText: '', usage: null } as TurnEvent;
        })()) as never);
      const beats: Array<() => unknown> = [];
      const realInterval = global.setInterval;
      const interval = jest.spyOn(global, 'setInterval').mockImplementation(((handler: () => unknown, ms?: number, ...rest: unknown[]) => {
        if (ms === 15_000) {
          beats.push(handler);
          return realInterval(() => undefined, 1_000_000);
        }
        return (realInterval as unknown as (...args: unknown[]) => NodeJS.Timeout)(handler, ms, ...rest);
      }) as never);
      try {
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        const waiting = started.events.next();
        for (let wait = 0; wait < 100 && beats.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
        // The agent has accepted the turn and has not said its id: the claim is renewed every 15 seconds
        expect(beats).toHaveLength(1);
        const before = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt!;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await beats[0]();
        const after = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt!;
        expect(after.getTime()).toBeGreaterThan(before.getTime());
        letGo();
        expect((await waiting).value).toMatchObject({ type: 'created', id: 'resp-slow' });
        await started.events.return(undefined);
        // Let go of at the mark it stands at now
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt).toBeNull();
      } finally {
        letGo();
        open.mockRestore();
        interval.mockRestore();
      }
    });

    // A turn the agent accepted but whose id never arrives: its stream waits (and ends when it is cut, as a real one does)
    const silentStream = (fakeProvider: FakeComputerProvider) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const open = jest.spyOn(fakeProvider, 'openTurn').mockImplementation((async (_ref: string, _input: unknown, signal?: AbortSignal) =>
        (async function* () {
          await new Promise<void>((resolve, reject) => {
            void gate.then(resolve);
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
          yield { type: 'completed', outputText: '', usage: null } as TurnEvent;
        })()) as never);
      return { open, release };
    };
    // The 15-second beats of a start are caught so a test can run them when it likes
    const catchBeats = () => {
      const beats: Array<() => unknown> = [];
      const realInterval = global.setInterval;
      const spy = jest.spyOn(global, 'setInterval').mockImplementation(((handler: () => unknown, ms?: number, ...rest: unknown[]) => {
        if (ms === 15_000) {
          beats.push(handler);
          return realInterval(() => undefined, 1_000_000);
        }
        return (realInterval as unknown as (...args: unknown[]) => NodeJS.Timeout)(handler, ms, ...rest);
      }) as never);
      return { beats, spy };
    };
    const later = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);

    it('a first turn whose id and conversation never arrive: after the cap the job ends visibly and no second turn is opened beside it', async () => {
      const { jobId } = await running();
      const { open, release } = silentStream(fake);
      const { beats, spy } = catchBeats();
      let clock: jest.SpyInstance | null = null;
      try {
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        const waiting = started.events.next();
        for (let wait = 0; wait < 100 && beats.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(beats).toHaveLength(1);
        // Within the cap it is renewed
        const before = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt!;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await beats[0]();
        const renewed = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt!;
        expect(renewed.getTime()).toBeGreaterThan(before.getTime());
        // Ten minutes on, still without an id or a conversation: nothing can say whether that turn still runs, so the job ends
        clock = later(10 * 60_000);
        await beats[0]();
        clock.mockRestore();
        clock = null;
        expect((await waiting).value).toMatchObject({ type: 'failed', code: 'no_turn_id' });
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed');
        // A start after it is told the job is over: the agent is asked once
        expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'not_running' });
        expect(open).toHaveBeenCalledTimes(1);
      } finally {
        release();
        clock?.mockRestore();
        open.mockRestore();
        spy.mockRestore();
      }
    });

    describe('a first turn nothing can name (no turn id, no conversation): never a second one beside it', () => {
      const jobRow = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      const failing = (text: string) => async () => (async function* (): AsyncGenerator<TurnEvent> {
        throw new Error(text);
      })();
      const counted = () => {
        const opened = jest.fn();
        return { opened, wrap: (make: () => Promise<AsyncGenerator<TurnEvent>>) => async () => (opened(), make()) };
      };

      it('the server stops after the agent accepted the first turn: the claim lapses, and the next start ends the job instead of opening another turn', async () => {
        const { jobId } = await running();
        let markedWhenSent: Date | null = null;
        const sent = jest.spyOn(fake, 'openTurn').mockImplementation((async () => {
          // The mark is in the row before the agent is asked
          markedWhenSent = (await jobRow(jobId)).firstTurnSentAt;
          return (async function* (): AsyncGenerator<TurnEvent> {
            await new Promise(() => undefined);
          })();
        }) as never);
        try {
          const started = await startTurn(jobId, 'go');
          expect(started.ok).toBe(true);
          expect(markedWhenSent).not.toBeNull();
          // The server stopped here: nothing reads the stream, nothing renews or lets go of the claim, and it lapses by itself
          await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 5 * 60_000) } });
          expect(await startTurn(jobId, 'go again')).toEqual({ ok: false, reason: 'not_running' });
          expect(sent).toHaveBeenCalledTimes(1);
          const ended = await jobRow(jobId);
          expect(ended.status).toBe('failed');
          expect(ended.turnClaimedAt).toBeNull();
        } finally {
          sent.mockRestore();
        }
      });

      it('the stream fails before the turn\'s id: the job ends there, and a start after it opens nothing', async () => {
        const { jobId } = await running();
        const { opened, wrap } = counted();
        fake.openTurn = wrap(failing('socket hang up'));
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        expect(await drain(started.events)).toEqual([expect.objectContaining({ type: 'failed', code: 'no_turn_id' })]);
        expect((await jobRow(jobId)).status).toBe('failed');
        expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'not_running' });
        expect(opened).toHaveBeenCalledTimes(1);
      });

      it('the stream ends before the turn\'s id, with no error: the same end', async () => {
        const { jobId } = await running();
        const { opened, wrap } = counted();
        fake.openTurn = wrap(async () => (async function* (): AsyncGenerator<TurnEvent> {})());
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        expect(await drain(started.events)).toEqual([expect.objectContaining({ type: 'failed', code: 'no_turn_id' })]);
        expect((await jobRow(jobId)).status).toBe('failed');
        expect(opened).toHaveBeenCalledTimes(1);
      });

      it('the job cannot be ended at that moment: the mark stays, so the next start ends it and never opens another turn', async () => {
        const { jobId } = await running();
        const { opened, wrap } = counted();
        fake.openTurn = wrap(failing('socket hang up'));
        (finishJob as jest.Mock).mockRejectedValueOnce(new Error('database unreachable'));
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        await drain(started.events);
        const still = await jobRow(jobId);
        expect(still.status).toBe('running');
        expect(still.firstTurnSentAt).not.toBeNull();
        // Nothing holds the claim any more: the next start finds the mark and ends the job
        expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'not_running' });
        expect((await jobRow(jobId)).status).toBe('failed');
        expect(opened).toHaveBeenCalledTimes(1);
      });

      it('an answer that is not a turn (the agent said no) opened nothing: the mark goes, and the same start can be asked again', async () => {
        const { jobId } = await running();
        fake.openTurn = async () => {
          throw new Agent37Error(400, 'bad_request', 'no');
        };
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        const row = await jobRow(jobId);
        expect(row.status).toBe('running');
        expect(row.firstTurnSentAt).toBeNull();
        fake.openTurn = FakeComputerProvider.prototype.openTurn.bind(fake);
        expect(await startTurn(jobId, 'go')).toMatchObject({ ok: true });
      });

      it('a request that may have reached the agent (the connection broke) is a turn that may run: the job ends, as it does for a stream that failed', async () => {
        const { jobId } = await running();
        fake.openTurn = async () => {
          throw new Agent37Unreached('connection reset');
        };
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        expect((await jobRow(jobId)).status).toBe('failed');
      });

      it('once the turn\'s id is kept the mark is gone, so the next first turn of a conversation the agent never named is not ended', async () => {
        const { jobId } = await running();
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        await drain(started.events);
        const row = await jobRow(jobId);
        expect(row.firstTurnSentAt).toBeNull();
        expect(row.status).toBe('running');
      });
    });

    it('a turn in a conversation the agent knows: after the cap the claim lapses, and the agent itself refuses a second turn beside the first (busy, with its id)', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-known' } });
      const { open, release } = silentStream(fake);
      const { beats, spy } = catchBeats();
      let clock: jest.SpyInstance | null = null;
      try {
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        const waiting = started.events.next();
        for (let wait = 0; wait < 100 && beats.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
        clock = later(10 * 60_000);
        const before = (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt!;
        await beats[0]();
        clock.mockRestore();
        clock = null;
        // Not renewed any more, and the job goes on (the conversation can be asked)
        const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
        expect(after.turnClaimedAt!.getTime()).toBe(before.getTime());
        expect(after.status).toBe('running');
        await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 50_000) } });
        // The conversation's first turn is still going: the agent says so, atomically, and no second turn opens
        open.mockImplementationOnce((async () => {
          throw new Agent37Error(409, 'session_busy', 'busy', 'resp-first');
        }) as never);
        expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'busy', responseId: 'resp-first' });
        expect(fake.openedTurns).toHaveLength(0);
        release();
        await waiting;
        await started.events.return(undefined);
      } finally {
        release();
        clock?.mockRestore();
        open.mockRestore();
        spy.mockRestore();
      }
    });

    it('a start left by a server that stopped lapses by itself, and the next start works', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 50_000) } });
      expect((await startTurn(jobId, 'go')).ok).toBe(true);
      expect(fake.openedTurns).toHaveLength(1);
    });

    it('looks at the job again once it holds the claim: a turn another start kept in between is busy (its id is given), and nothing is opened', async () => {
      const { jobId } = await running();
      const real = prisma.$queryRaw.bind(prisma) as (query: { sql: string }) => Promise<unknown>;
      let done = false;
      const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((query: { sql: string }) => {
        if (!done && typeof query?.sql === 'string' && query.sql.includes('"turn_claimed_at"')) {
          done = true;
          // Another start kept its turn's id just before this one's claim was taken
          return prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-kept', agentSessionId: 'sess-kept' } }).then(() => real(query));
        }
        return real(query);
      }) as never);
      try {
        // The turn the job holds is still running on the machine
        jest.spyOn(fake, 'activeTurn').mockResolvedValue('resp-kept');
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'busy', responseId: 'resp-kept' });
      } finally {
        spy.mockRestore();
        jest.restoreAllMocks();
      }
      expect(fake.openedTurns).toHaveLength(0);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt).toBeNull();
    });

    it('says "starting", never "busy", for a held claim even when a turn id the job kept was just cleared', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-gone', agentSessionId: 'sess-gone', turnClaimedAt: new Date() } });
      expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'starting' });
      expect(fake.openedTurns).toHaveLength(0);
    });

    it('a second prepare waits only a few seconds for the first, then says "preparing"; a claim older than about 45 seconds lapses', async () => {
      const { jobId } = await running();
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date() } });
      const started = Date.now();
      expect(await prepareJob(jobId, RELAY, NOW)).toEqual({ ok: false, reason: 'preparing' });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(fake.commands.filter((entry) => entry.command.includes('relay.json'))).toHaveLength(0);
      await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(Date.now() - 50_000) } });
      expect(await prepareJob(jobId, RELAY, NOW)).toMatchObject({ ok: true });
    }, 30_000);

    it('writes one key at a time for a job: a second prepare at the same moment waits, so the key left on the machine is the one that is good', async () => {
      const { jobId } = await running();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let writes = 0;
      const finished: string[] = [];
      fake.execAnswer = async (command) => {
        writes += 1;
        // The first write is slow; the second prepare starts while it waits
        if (writes === 1) await gate;
        // The order the writes reached the machine in is the order they finished
        finished.push(command);
        return {};
      };
      const first = prepareJob(jobId, RELAY, NOW);
      for (let wait = 0; wait < 100 && writes === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
      const second = prepareJob(jobId, RELAY, minutes(1));
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: true });
      // The last key to reach the machine is the one that is good: the second prepare did not end it, and did not write before the first
      const last = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(finished.at(-1) ?? '')?.[1] ?? '';
      expect((await verifyJobToken(last, 'model', minutes(2))).ok).toBe(true);
      expect(fake.commands.filter((entry) => entry.command.includes('relay.json'))).toHaveLength(2);
    });

    it('never replaces the id of a turn the job already holds: a second turn started at the same moment is cancelled', async () => {
      const { jobId } = await running();
      fake.turns = [
        [{ type: 'created', id: 'resp-a', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }],
        [{ type: 'created', id: 'resp-b', sessionId: 'sess-2' }, { type: 'completed', outputText: '', usage: null }],
      ];
      // In a conversation the agent knows (the agent itself refuses a second turn there; a job's very first turn is the mark's: see the tests of it)
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentSessionId: 'sess-0' } });
      const first = await startTurn(jobId, 'one');
      // The first start's claim has lapsed (nobody released it): the backstop still holds, a second turn never replaces the first one's id
      await prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 10 * 60_000) } });
      const second = await startTurn(jobId, 'two');
      if (!first.ok || !second.ok) throw new Error('no turn');
      const firstEvent = await first.events.next();
      expect(firstEvent.value).toMatchObject({ type: 'created', id: 'resp-a' });
      const seen = await drain(second.events);
      expect(seen).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
      expect(fake.cancelledTurns).toEqual(['resp-b']);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ agentResponseId: 'resp-a', agentSessionId: 'sess-1' });
      await first.events.return(undefined);
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

    it('keeps the turn id even when a keep-alive comes first and the reader leaves at once', async () => {
      const { jobId } = await running();
      fake.turns = [[{ type: 'keepalive' }, { type: 'keepalive' }, { type: 'created', id: 'resp-ka', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }]];
      const started = await startTurn(jobId, 'go');
      if (!started.ok) throw new Error('no turn');
      // The first thing the reader is given is the id, never a keep-alive it could leave on
      const first = await started.events.next();
      expect(first.value).toMatchObject({ type: 'created', id: 'resp-ka' });
      await started.events.return(undefined);
      expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ agentResponseId: 'resp-ka', agentSessionId: 'sess-1' });
    });

    it('stops what the agent started when a turn that must not run cannot be cancelled', async () => {
      const { sara, jobId } = await running();
      fake.turns = [[{ type: 'created', id: 'resp-late', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }]];
      const commands: string[] = [];
      fake.execAnswer = (command) => {
        commands.push(command);
        return command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {};
      };
      const started = await startTurn(jobId, 'go');
      if (!started.ok) throw new Error('no turn');
      await takeOver(sara.brickId, sara.id, NOW);
      commands.length = 0;
      fake.failCancel = true;
      const seen = await drain(started.events);
      expect(seen).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
      // Three tries to cancel it, then the machine's own fence
      expect(fake.calls.filter((call) => call.name === 'cancelTurn').length).toBeGreaterThanOrEqual(3);
      expect(commands).toContain('universe-fence');
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

    it('a take-over asked again while the first one is still making the fence waits for it, and the person has no input until it is proved', async () => {
      const { sara } = await running();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      // The fence is slow: it holds until the test lets it go
      fake.execAnswer = async (command) => {
        if (command === 'universe-fence') await gate;
        return command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {};
      };
      const first = takeOver(sara.brickId, sara.id, NOW);
      for (let wait = 0; wait < 100 && !(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).not.toBeNull();
      // Control is the person's already, but the machine is not fenced yet: no input on the screen
      expect(await prisma.computerJob.count({ where: { botId: sara.brickId, control: 'person' } })).toBe(1);
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      let secondAnswered = false;
      const second = takeOver(sara.brickId, sara.id, NOW).then((answer) => {
        secondAnswered = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      // The second one did not answer "already theirs" while the agent could still be acting
      expect(secondAnswered).toBe(false);
      release();
      expect((await first).ok).toBe(true);
      expect((await second).ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).toBeNull();
      expect((await screenTicket(sara.brickId, sara.id, 'input', NOW)).ok).toBe(true);
      // Repeatable after it is done: the same answer, at once
      expect((await takeOver(sara.brickId, sara.id, NOW)).ok).toBe(true);
    });

    it('a take-over asked at the moment the first one has handed the job over, before its fence began, waits for the fence: it never answers "theirs" early, and the person has no input meanwhile', async () => {
      const { sara } = await running();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      fake.execAnswer = async (command) => {
        if (command === 'universe-fence') await gate;
        return command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {};
      };
      // The first take-over is held right after its write that hands the job to the person: the point between that write and the making of its fence
      let atTheWindow: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => (atTheWindow = resolve));
      let letThrough: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => (letThrough = resolve));
      const real = prisma.computerJob.updateMany.bind(prisma.computerJob) as (args: { data?: { control?: string } }) => Promise<{ count: number }>;
      let held = false;
      const spy = jest.spyOn(prisma.computerJob, 'updateMany').mockImplementation(((args: { data?: { control?: string } }) =>
        real(args).then(async (result) => {
          if (!held && args?.data?.control === 'person' && result.count > 0) {
            held = true;
            atTheWindow();
            await hold;
          }
          return result;
        })) as never);
      let first: Promise<Awaited<ReturnType<typeof takeOver>>> | null = null;
      let second: Promise<Awaited<ReturnType<typeof takeOver>>> | null = null;
      try {
        first = takeOver(sara.brickId, sara.id, NOW);
        await reached;
        // The job is the person's now, and the marker says the fence is being made, although the fence itself has not begun
        expect(await prisma.computerJob.count({ where: { botId: sara.brickId, control: 'person' } })).toBe(1);
        expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).not.toBeNull();
        expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
        let secondAnswered = false;
        second = takeOver(sara.brickId, sara.id, NOW).then((answer) => {
          secondAnswered = true;
          return answer;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(secondAnswered).toBe(false);
      } finally {
        letThrough();
        release();
        const settled = await Promise.allSettled([first, second]);
        spy.mockRestore();
        expect(settled.map((one) => one.status)).toEqual(['fulfilled', 'fulfilled']);
      }
      expect((await first)!.ok).toBe(true);
      expect((await second)!.ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).toBeNull();
      expect((await screenTicket(sara.brickId, sara.id, 'input', NOW)).ok).toBe(true);
    });

    it('a fence claimed by a server that stopped is made again by the next take-over', async () => {
      const { sara } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { fencingSince: new Date(Date.now() - 10 * 60_000) } });
      fake.commands.length = 0;
      expect((await takeOver(sara.brickId, sara.id, NOW)).ok).toBe(true);
      expect(fake.commands.map((entry) => entry.command)).toContain('universe-fence');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).toBeNull();
    });

    it('a fence left half made by a server that stopped is made again by the sweep, so the person is not left without input until they tap again; a fresh marker is left alone', async () => {
      const { sara } = await running();
      await takeOver(sara.brickId, sara.id, NOW);
      // A fresh marker (a take-over is making its fence now) is not touched
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { fencingSince: new Date(NOW.getTime() - 60_000) } });
      fake.commands.length = 0;
      await sweepComputers(NOW);
      expect(fake.commands.map((entry) => entry.command)).not.toContain('universe-fence');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).not.toBeNull();
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      // The server that made it stopped: the marker is old, input is still refused (the agent is not proved stopped) until the sweep has made the fence again
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { fencingSince: new Date(NOW.getTime() - 10 * 60_000) } });
      expect(await screenTicket(sara.brickId, sara.id, 'input', NOW)).toEqual({ ok: false, reason: 'not_taken_over' });
      await sweepComputers(NOW);
      expect(fake.commands.map((entry) => entry.command)).toContain('universe-fence');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).toBeNull();
      expect((await screenTicket(sara.brickId, sara.id, 'input', NOW)).ok).toBe(true);
    });

    it('a marker left old with nothing the person holds any more is just cleared by the sweep, and no fence is made behind a running job', async () => {
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { fencingSince: new Date(NOW.getTime() - 10 * 60_000) } });
      const before = await prisma.computerJob.findMany({ where: { botId: sara.brickId }, select: { id: true, controlGeneration: true } });
      fake.commands.length = 0;
      await sweepComputers(NOW);
      expect(fake.commands.map((entry) => entry.command)).not.toContain('universe-fence');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).fencingSince).toBeNull();
      expect(await prisma.computerJob.findMany({ where: { botId: sara.brickId }, select: { id: true, controlGeneration: true } })).toEqual(before);
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

    it('does not call the machine stopped when the stop was refused: it is blocked and tried again until proved asleep', async () => {
      const { sara } = await running();
      fake.execAnswer = () => ({ stdout: 'remaining=3\n', exitCode: 1 });
      const ref = `fake-${sara.brickId}`;
      fake.stuckAwake.add(ref);
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopping');
      fake.stuckAwake.delete(ref);
      fake.execAnswer = (command) => (command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {});
      await sweepComputers(minutes(2));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
    });

    it('wakes a machine that a failed fence stopped when the person hands the job back, so the job can go on', async () => {
      const { sara, jobId } = await running();
      fake.execAnswer = (command) => (command.endsWith('--check') ? { stdout: 'remaining=2\n' } : {});
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
      fake.execAnswer = (command) => (command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {});
      const back = await handBack(sara.brickId, sara.id);
      expect(back.ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
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

  describe('a machine made ready', () => {
    it('is brought up for a job before the job runs, and a machine that cannot be made ready starts no job', async () => {
      const { sara } = await running('ready');
      expect(fake.readied).toHaveLength(1);
      expect(fake.readied[0]).toBe(`fake-${sara.brickId}`);
      const second = await person('notready');
      await giveComputer(second.brickId, second.id);
      fake.ready = async () => {
        throw new Error('The computer is not ready (browser)');
      };
      const started = await startJob({ botId: second.brickId, personId: second.id, title: 'Job' }, NOW);
      expect(started.ok).toBe(false);
    });
  });

  describe('the running jobs, a page at a time', () => {
    it('gives every running job across pages, oldest first, and says when it is the last page', async () => {
      const ids: string[] = [];
      for (const name of ['p1', 'p2', 'p3']) {
        const { jobId } = await running(name);
        ids.push(jobId);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof runnableJobsPage>> = await runnableJobsPage(2, cursor);
        seen.push(...page.jobs.map((job) => job.jobId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(seen.length);
      expect(cursor).toBeNull();
      expect(pages).toBeGreaterThan(1);
    });

    it('starts from the beginning when the cursor is not understood', async () => {
      const { jobId } = await running('p4');
      const page = await runnableJobsPage(200, 'not a cursor');
      expect(page.jobs.map((job) => job.jobId)).toContain(jobId);
    });
  });

  describe('the words for the agent', () => {
    it('are kept with the job, handed only to the runner, and cleared when the job ends', async () => {
      const sara = await person('words');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', brief: '  Fill the Kuwait visa form for two people  ' }, NOW);
      if (!started.ok) throw new Error('the job did not start');
      // never part of what the owner is shown
      expect(JSON.stringify(started.job)).not.toContain('Kuwait visa');
      const mine = (await runnableJobs()).filter((job) => job.botId === sara.brickId);
      expect(mine).toEqual([{ jobId: started.job.id, botId: sara.brickId, title: 'Visa form', brief: 'Fill the Kuwait visa form for two people', writes: true, hasTurn: false }]);
      await stopJobFor(sara.brickId, sara.id, NOW);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).brief).toBeNull();
      expect((await runnableJobs()).filter((job) => job.botId === sara.brickId)).toEqual([]);
    });

    it('are cut to their limit, and a job with none has none', async () => {
      const sara = await person('longwords');
      await giveComputer(sara.brickId, sara.id);
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Long', brief: 'x'.repeat(9000) }, NOW);
      if (!started.ok) throw new Error('the job did not start');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: started.job.id } })).brief).toHaveLength(4000);
    });

    it('leave out a job the person has taken over, or one waiting for them, and say when a turn is going', async () => {
      const { sara, jobId } = await running('hands');
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-1' } });
      expect((await runnableJobs()).find((job) => job.jobId === jobId)).toMatchObject({ hasTurn: true });
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await runnableJobs()).find((job) => job.jobId === jobId)).toBeUndefined();
    });
  });
});
