/**
 * How the runner reaches a computer through Orbit, the take-over fence on the machine, and keeping a working machine awake, against a
 * real database (build handoff v2, sections 4 and 5). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-broker-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/computer', () => {
  const actual = jest.requireActual('@/lib/computer');
  return {
    ...actual,
    finishJob: jest.fn(actual.finishJob),
    finishJobUnder: jest.fn(actual.finishJobUnder),
    underTurnHold: jest.fn(actual.underTurnHold),
    settleTurnHold: jest.fn(actual.settleTurnHold),
    wakeIfStopped: jest.fn(actual.wakeIfStopped),
  };
});
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests, type TurnEvent } from '@/lib/computer-provider';
import { isFenceCheckCommand, isFenceCommand } from '@/lib/computer-fence-script';
const isPlainFence = (command: string) => isFenceCommand(command) && !isFenceCheckCommand(command);
import { Agent37Error, Agent37Unreached, TurnNotSent } from '@/lib/agent37/client';
import { fenceMachine, finishJob, finishJobUnder, recordFinishIntent, settleTurnHold, underTurnHold, wakeIfStopped, setLeaderStopTimesForTests, giveComputer, handBack, runnableJobs, runnableJobsPage, startJob, stopJobFor, sweepComputers, takeOver } from '@/lib/computer';
import { verifyJobToken } from '@/lib/computer-token';
import { cutoffLockKey, lockCutoff, readFaultRows, recordFaults } from '@/lib/computer-faults';
import { cancelJobTurn, prepareJob, reattachJobTurn, startTurn } from '@/lib/computer-broker';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

/** A take over's fence that cannot be proved: the computer has no note to fence by (`unmarked=1`, exit 3), so it is stopped. (A program still running, `remaining=N`, is a different answer for a take over: the person is asked.) */
const UNPROVABLE = { stdout: 'unmarked=1\n', exitCode: 3 };

const tag = randomUUID().slice(0, 8);
// The real clock, not a fixed day: a failed start ends its job at the real now (the broker reads its own clock there), and a job that began on a fixed day is settled for every minute since, at the pretend price, so
// each day that passed took more of the pool's room and the third job of a test eventually found none (the 504/502/503 test failed from 21 Nov: its job was queued for the pool). computer-db does the same
const NOW = new Date();
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
  // A job that waits in line (the pool has no room, the person's allowance is used) is not what these tests are about: say so at once instead of failing later with a misleading answer
  if (started.job.status !== 'running') throw new Error(`the job did not start running: ${started.job.status}, queued for ${started.job.queuedFor}`);
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

    it('a reported-unreachable relay is a fault only for a job that is running under Brick’s control: a job that is over, or the person’s, keeps no such row (CodeRabbit)', async () => {
      const over = await running('unreach-over');
      await finishJob(over.jobId, 'done');
      expect(await prepareJob(over.jobId, RELAY, NOW, { run: 'r-1', relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'not_running' });
      expect(await prisma.computerJobFault.count({ where: { jobId: over.jobId } })).toBe(0);
      const taken = await running('unreach-person');
      await takeOver(taken.sara.brickId, taken.sara.id, NOW);
      expect(await prepareJob(taken.jobId, RELAY, NOW, { run: 'r-1', relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'person_has_it' });
      expect(await prisma.computerJobFault.count({ where: { jobId: taken.jobId } })).toBe(0);
      const live = await running('unreach-live');
      expect(await prepareJob(live.jobId, RELAY, NOW, { run: 'r-1', relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
      expect(await prisma.computerJobFault.count({ where: { jobId: live.jobId, reason: 'relay_unreachable' } })).toBe(1);
    });

    describe('the computer asks the relay for its model list with the key it was given', () => {
      const probeCommands = () => fake.commands.filter((one) => one.command.includes('/v1/models'));
      // The marker of which run holds the job (made by a prepare that names its run) is not a fault
      const faultsOf = (jobId: string) => prisma.computerJobFault.findMany({ where: { jobId, NOT: { callId: { startsWith: 'orbit:runner-' } } }, orderBy: { callId: 'asc' } });

      it('a computer that cannot get it is a confirmed fault of ours: kept once per run, the runner is told, and nothing is kept for one that can or for a check that could not be made', async () => {
        const { jobId } = await running();
        // The relay answers (or the check says nothing: no curl, a command that did not say): prepared, and no fault
        fake.execAnswer = (command) => (command.includes('/v1/models') ? { stdout: 'reach=ok\n' } : {});
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toMatchObject({ ok: true });
        fake.execAnswer = (command) => (command.includes('/v1/models') ? { stdout: 'reach=nocurl\n' } : {});
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toMatchObject({ ok: true });
        fake.execAnswer = (command) => (command.includes('/v1/models') ? { exitCode: 1, stdout: 'reach=down\n' } : {});
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toMatchObject({ ok: true });
        fake.execAnswer = () => ({});
        expect(await prepareJob(jobId, RELAY, NOW)).toMatchObject({ ok: true });
        expect(await faultsOf(jobId)).toEqual([]);
        // It cannot (a page that is not the relay's answered): told, and one confirmed fault of ours is kept, saying it twice changes nothing
        fake.execAnswer = (command) => (command.includes('/v1/models') ? { stdout: 'reach=down\n' } : {});
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect(await faultsOf(jobId)).toMatchObject([{ jobId, turn: null, run: 'r-1', kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai', route: null }]);
        // A computer that cannot is never given a key it could not use: none is written and the one made is ended
        const writesBefore = fake.commands.filter((one) => one.command.includes('relay.json')).length;
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect(fake.commands.filter((one) => one.command.includes('relay.json'))).toHaveLength(writesBefore);
        expect(await prisma.computerJobToken.count({ where: { jobId, scope: 'model', revokedAt: null } })).toBe(0);
        // Another run says it for itself
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-2' })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect((await faultsOf(jobId)).map((row) => row.run)).toEqual(['r-1', 'r-2']);
        // Read as it is: a confirmed fault of ours, never the person's and never unresolved
        expect(await readFaultRows(prisma, jobId, [], 'r-1', { turnlessOnly: true })).toMatchObject([{ cls: 'ours', reason: 'relay_unreachable', route: null }]);
      });

      it('a prepare that lost its claim while its probe ran says nothing: its key was ended by the newer prepare, so the probe failed on a key that was refused, and only the holder of the claim keeps a fault', async () => {
        const { jobId } = await running();
        let letGo: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (letGo = resolve));
        let reached: () => void = () => undefined;
        const atTheProbe = new Promise<void>((resolve) => (reached = resolve));
        let probes = 0;
        fake.execAnswer = async (command: string) => {
          if (!command.includes('/v1/models')) return {};
          probes += 1;
          if (probes === 1) {
            reached();
            await gate;
            return { stdout: 'reach=down\n' };
          }
          return { stdout: 'reach=ok\n' };
        };
        const slow = prepareJob(jobId, RELAY, NOW, { run: 'r-1' });
        await atTheProbe;
        // Its claim lapsed meanwhile and a newer prepare took it, ended the first key, made and wrote its own
        await prisma.computerJob.update({ where: { id: jobId }, data: { prepareClaimedAt: new Date(Date.now() - 50_000) } });
        expect(await prepareJob(jobId, RELAY, minutes(1), { run: 'r-1' })).toMatchObject({ ok: true });
        const written = fake.commands.filter((one) => one.command.includes('relay.json'));
        expect(written).toHaveLength(1);
        const goodToken = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(written[0].command)?.[1] ?? '';
        // The first probe now answers "down" (its own key was refused): it holds no claim, so it keeps no fault and is told to ask again
        letGo();
        expect(await slow).toEqual({ ok: false, reason: 'preparing' });
        expect(await faultsOf(jobId)).toEqual([]);
        const live = await prisma.computerJobToken.findMany({ where: { jobId, revokedAt: null } });
        expect(live).toHaveLength(1);
        expect((await verifyJobToken(goodToken, 'model', minutes(2))).ok).toBe(true);
      });

      it('the bot server’s own finding that the relay address answers something that is not the relay (relayReached false) is the same fault, kept once per run with its status, told at once with no key made', async () => {
        const { sara, jobId } = await running();
        const tokens = () => prisma.computerJobToken.count({ where: { jobId, scope: 'model' } });
        const sent = fake.commands.length;
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1', relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1', relayReached: false, relayStatus: 404 })).toEqual({ ok: false, reason: 'relay_unreachable' });
        expect(fake.commands.length).toBe(sent);
        expect(await tokens()).toBe(0);
        expect(await faultsOf(jobId)).toMatchObject([{ turn: null, run: 'r-1', kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai', route: null, providerStatus: 404 }]);
        // True, or nothing said: as always
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1', relayReached: true })).toMatchObject({ ok: true });
        expect(await faultsOf(jobId)).toHaveLength(1);
        // The relay's own row of the same name (the game's: turn 1, route "unknown") is another row, never the one Orbit keeps
        await recordFaults(sara.brickId, jobId, [{ turn: 1, run: 'r-1', callId: 'relay_unreachable', kind: 'fault', reason: 'relay_unreachable', source: 'universe-ai', route: 'unknown', at: NOW }]);
        expect((await faultsOf(jobId)).map((row) => [row.callId, row.turn, row.route])).toEqual([['orbit:r-1:relay_unreachable', null, null], ['relay_unreachable', 1, 'unknown']]);
      });

      it('asks with the job’s own key, before the key is written (the write stays the last command), and the ask itself reads a 200 with a model list as reached and anything else as not (run in a real shell against a real server)', async () => {
        const { jobId } = await running();
        expect(await prepareJob(jobId, RELAY, NOW)).toMatchObject({ ok: true });
        const writes = fake.commands.findIndex((one) => one.command.includes('relay.json'));
        const asks = probeCommands();
        expect(asks).toHaveLength(1);
        expect(fake.commands.indexOf(asks[0])).toBeLessThan(writes);
        expect(fake.commands.at(-1)?.command).toContain('relay.json');
        const written = fake.commands[writes].command;
        const token = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(written)?.[1] ?? '';
        expect(asks[0].command).toContain(`Authorization: Bearer ${token}`);
        expect(asks[0].command).toContain(`'${RELAY}/v1/models'`);
        // The very command, against servers that answer as a relay, as a page that is not one, with a model list missing, and not at all
        const server = http.createServer((request, response) => {
          if (request.url === '/ok/v1/models' && request.headers.authorization === `Bearer ${token}`) response.end('{"object":"list","data":[{"id":"m"}]}');
          else if (request.url === '/nolist/v1/models') response.end('{"object":"list"}');
          else {
            response.statusCode = 404;
            response.setHeader('content-type', 'text/html');
            response.end('<html>"data" 404</html>');
          }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
          // (not spawnSync: this process answers the server, and must not be blocked while the shell waits)
          const ask = async (base: string) => (await promisify(execFile)('sh', ['-c', asks[0].command.replace(`'${RELAY}/v1/models'`, `'${base}/v1/models'`).replace(/sleep \d+/, 'sleep 0')])).stdout.trim();
          expect(await ask(`http://127.0.0.1:${port}/ok`)).toBe('reach=ok');
          expect(await ask(`http://127.0.0.1:${port}/nolist`)).toBe('reach=down');
          expect(await ask(`http://127.0.0.1:${port}/wrong`)).toBe('reach=down');
          expect(await ask('http://127.0.0.1:9')).toBe('reach=down');
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });
    });

    describe('the ask says down only for a definite wrong address, and asks once more before it is believed (Sentry: a redirect, a slow answer, a 429/5xx blip or a transient DNS failure wrote a confirmed fault)', () => {
      const probeCommand = async () => {
        const { jobId } = await running();
        fake.commands.length = 0;
        expect(await prepareJob(jobId, RELAY, NOW)).toMatchObject({ ok: true });
        const ask = fake.commands.find((one) => one.command.includes('/v1/models'))?.command ?? '';
        expect(ask).not.toBe('');
        return ask;
      };
      const asked: string[] = [];

      it('each class of answer, run in a real shell against a real server: the list is ok; a wrong address (refused, 404/410, 401/403, a 200 with no list, a page that is not JSON) is down; a redirect, 429, 5xx, a slow answer and a JSON error are not learned from', async () => {
        const command = await probeCommand();
        const server = http.createServer((request, response) => {
          const path = (request.url ?? '').replace('/v1/models', '');
          asked.push(path);
          const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
            response.writeHead(status, { 'content-type': type, ...headers });
            response.end(body);
          };
          if (path === '/ok') send(200, 'application/json', '{"object":"list","data":[{"id":"m"}]}');
          else if (path === '/nolist') send(200, 'application/json', '{"object":"list"}');
          else if (path === '/html200') send(200, 'text/html', '<html>hello</html>');
          else if (path === '/404' || path === '/410') send(Number(path.slice(1)), 'text/html', '<html>nope</html>');
          else if (path === '/401' || path === '/403') send(Number(path.slice(1)), 'application/json', '{"error":"key"}');
          else if (path === '/redirect') send(302, 'text/html', '', { location: '/ok/v1/models' });
          else if (path === '/429' || path === '/500' || path === '/503') send(Number(path.slice(1)), 'application/json', '{"error":"busy"}');
          else if (path === '/502html') send(502, 'text/html', '<html>bad gateway</html>');
          else if (path === '/400json') send(400, 'application/json', '{"error":"what"}');
          else if (path === '/400html') send(400, 'text/html', '<html>what</html>');
          else if (path === '/slow') setTimeout(() => send(200, 'application/json', '{"data":[]}'), 3000);
          else send(404, 'text/html', 'x');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
          // (the real wait before a second ask is kept short here; a slow answer is cut at one second instead of ten)
          const ask = async (base: string) =>
            (await promisify(execFile)('sh', ['-c', command.replace(`'${RELAY}/v1/models'`, `'${base}/v1/models'`).replace('-m 10', '-m 1').replace(/sleep \d+/, 'sleep 0')])).stdout.trim();
          const at = (path: string) => ask(`http://127.0.0.1:${port}${path}`);
          expect(await at('/ok')).toBe('reach=ok');
          for (const down of ['/nolist', '/html200', '/404', '/410', '/401', '/403', '/400html']) expect({ down, said: await at(down) }).toEqual({ down, said: 'reach=down' });
          for (const unsure of ['/redirect', '/429', '/500', '/503', '/502html', '/400json', '/slow']) expect({ unsure, said: await at(unsure) }).toEqual({ unsure, said: 'reach=unknown' });
          // Nothing listens there: refused, a definite wrong address
          expect(await ask('http://127.0.0.1:9')).toBe('reach=down');
          // A definite "down" is asked a second time (and only that): the 404 was asked twice, the redirect once
          expect(asked.filter((path) => path === '/404')).toHaveLength(2);
          expect(asked.filter((path) => path === '/redirect')).toHaveLength(1);
          expect(asked.filter((path) => path === '/503')).toHaveLength(1);
          expect(asked.filter((path) => path === '/ok')).toHaveLength(1);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });

      it('down, then fine on the second ask, is fine: it keeps no fault and the job is prepared', async () => {
        const command = await probeCommand();
        let hits = 0;
        const server = http.createServer((request, response) => {
          hits += 1;
          if (hits === 1) {
            response.statusCode = 404;
            response.end('<html>starting</html>');
          } else response.end('{"object":"list","data":[{"id":"m"}]}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
          const said = (await promisify(execFile)('sh', ['-c', command.replace(`'${RELAY}/v1/models'`, `'http://127.0.0.1:${port}/v1/models'`).replace(/sleep \d+/, 'sleep 0')])).stdout.trim();
          expect(said).toBe('reach=ok');
          expect(hits).toBe(2);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
        // And the answers the prepare is given: only `down` writes a fault, `unknown` (and ok) never do
        const { jobId } = await running();
        fake.execAnswer = (cmd) => (cmd.includes('/v1/models') ? { stdout: 'reach=unknown\n' } : {});
        expect(await prepareJob(jobId, RELAY, NOW, { run: 'r-1' })).toMatchObject({ ok: true });
        expect(await prisma.computerJobFault.count({ where: { jobId, NOT: { callId: { startsWith: 'orbit:runner-' } } } })).toBe(0);
      });
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
        const other = command.replaceAll(jobId, 'another-job').replace('"url":"' + RELAY + '"', '"url":"https://other.example.test"');
        expect(runIt(other).status).toBe(0);
        expect(readFileSync(join(home, '.universe', 'relay.json'), 'utf8')).toContain('other.example.test');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('writes the job’s own key in a file of its own, never over another job’s, and a write delayed past a later one of the same job leaves the later key', async () => {
      const { jobId } = await running();
      await prepareJob(jobId, RELAY, NOW);
      const command = fake.commands.at(-1)?.command ?? '';
      const mark = Number(/ (\d+) > "\$d\/relay\.gen"/.exec(command)?.[1]);
      const token = /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(command)?.[1] ?? '';
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      const runIt = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      const keyIn = (path: string) => (JSON.parse(readFileSync(join(home, '.universe', path), 'utf8')) as { token: string }).token;
      try {
        // another job of the same machine writes its key first
        const other = command.replaceAll(jobId, 'another-job').replaceAll(token, 'cjt_other');
        expect(runIt(other).status).toBe(0);
        expect(runIt(command).status).toBe(0);
        expect(keyIn(`jobs/${jobId}.json`)).toBe(token);
        expect(keyIn('jobs/another-job.json')).toBe('cjt_other');
        // a later write of this job (a later claim) replaces its file; a delayed write of the earlier claim then changes nothing
        const later = command.replaceAll(new RegExp(`\\b${mark}\\b`, 'g'), String(mark + 1_000)).replaceAll(token, 'cjt_later');
        expect(runIt(later).status).toBe(0);
        expect(runIt(command.replaceAll(token, 'cjt_delayed')).status).toBe(0);
        expect(keyIn(`jobs/${jobId}.json`)).toBe('cjt_later');
        expect(keyIn('jobs/another-job.json')).toBe('cjt_other');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('a delayed prepare of one job, run after another job wrote the key last written, changes nothing at all: not its own file, and not relay.json or relay.gen', async () => {
      const { sara, jobId: a } = await running();
      // Only jobs that read run side by side (a job that may sign in has the machine alone): the first one only looks too
      await prisma.computerJob.update({ where: { id: a }, data: { writes: false } });
      const readerStarted = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second', writes: false }, NOW);
      if (!readerStarted.ok) throw new Error('the second job did not start');
      const b = readerStarted.job.id;
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      const runIt = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      const commandOf = async (jobId: string) => {
        await prepareJob(jobId, RELAY, NOW);
        return fake.commands.filter((entry) => entry.command.includes('relay.json')).at(-1)?.command ?? '';
      };
      try {
        // job A is prepared twice (the first command is delayed), then job B writes the key last written
        const earlier = await commandOf(a);
        const later = await commandOf(a);
        const other = await commandOf(b);
        expect(runIt(later).status).toBe(0);
        expect(runIt(other).status).toBe(0);
        const state = () => ['relay.json', 'relay.gen', `jobs/${a}.json`, `jobs/${a}.gen`, `jobs/${b}.json`].map((name) => readFileSync(join(home, '.universe', name), 'utf8'));
        const before = state();
        expect(JSON.parse(before[0]).token).toBe(JSON.parse(before[4]).token);
        expect(before[1].startsWith(b)).toBe(true);
        // the delayed write of A's earlier claim arrives: nothing on the machine changes
        expect(runIt(earlier).status).toBe(0);
        expect(state()).toEqual(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('CodeRabbit on #1025 (C10): a delayed prepare of an OLDER job never puts its key over relay.json a newer claim of ANOTHER job wrote; its own file is still written, and a newer claim still replaces relay.json', async () => {
      const { sara, jobId: a } = await running();
      // Only jobs that read run side by side (a job that may sign in has the machine alone): the first one only looks too
      await prisma.computerJob.update({ where: { id: a }, data: { writes: false } });
      const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second', writes: false }, NOW);
      if (!second.ok) throw new Error('the second job did not start');
      const b = second.job.id;
      const commandOf = async (jobId: string) => {
        await prepareJob(jobId, RELAY, NOW);
        return fake.commands.filter((entry) => entry.command.includes('relay.json')).at(-1)?.command ?? '';
      };
      const forA = await commandOf(a);
      const forB = await commandOf(b);
      const markOf = (command: string) => Number(/ (\d+) > "\$d\/relay\.gen"/.exec(command)?.[1]);
      const tokenOf = (command: string) => /"token":"(cjt_[A-Za-z0-9_-]+)"/.exec(command)?.[1] ?? '';
      // The claims are put well apart, so which is older does not depend on the clock of the test
      const at = (command: string, from: number, to: number, token: string, to_token: string) => command.replaceAll(new RegExp(`\\b${from}\\b`, 'g'), String(to)).replaceAll(token, to_token);
      const olderA = at(forA, markOf(forA), 1_000_000, tokenOf(forA), 'cjt_older_a');
      const newerB = at(forB, markOf(forB), 2_000_000, tokenOf(forB), 'cjt_newer_b');
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      const runIt = (text: string) => spawnSync('sh', ['-c', text], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      const keyIn = (path: string) => (JSON.parse(readFileSync(join(home, '.universe', path), 'utf8')) as { token: string }).token;
      try {
        expect(runIt(newerB).status).toBe(0);
        expect(keyIn('relay.json')).toBe('cjt_newer_b');
        const gen = readFileSync(join(home, '.universe', 'relay.gen'), 'utf8');
        // The older job's write arrives late: the shared file and its note stay the newer claim's, the older job's own file is written
        expect(runIt(olderA).status).toBe(0);
        expect(keyIn('relay.json')).toBe('cjt_newer_b');
        expect(readFileSync(join(home, '.universe', 'relay.gen'), 'utf8')).toBe(gen);
        expect(keyIn(`jobs/${a}.json`)).toBe('cjt_older_a');
        expect(keyIn(`jobs/${b}.json`)).toBe('cjt_newer_b');
        // A claim later than the one that wrote it still replaces the shared file
        const newest = at(forA, markOf(forA), 3_000_000, tokenOf(forA), 'cjt_newest_a');
        expect(runIt(newest).status).toBe(0);
        expect(keyIn('relay.json')).toBe('cjt_newest_a');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('Sentry on #1025 (S2): an alias whose stamp file does not exist is written even when the job’s own stamp is newer (the stamp of one file never carries over to the next)', async () => {
      const { sara, jobId } = await running('s2-alias');
      // The job carries on an ended one: its key is also written under that job's id
      const earlier = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Earlier', status: 'stopped', endedAt: NOW } });
      await prisma.computerJob.update({ where: { id: jobId }, data: { continuesJobId: earlier.id } });
      await prepareJob(jobId, RELAY, NOW);
      const command = fake.commands.at(-1)?.command ?? '';
      expect(command).toContain(`jobs/${earlier.id}.stamp`);
      const mark0 = Number(/printf '%s' (\d+) > "\$d\/jobs\/[^"]*\.stamp"/.exec(command)?.[1]);
      const home = mkdtempSync(join(tmpdir(), 'universe-relay-'));
      try {
        // The job's own file was written by a LATER prepare (its stamp is newer than this one's claim); the alias has no stamp at all
        mkdirSync(join(home, '.universe', 'jobs'), { recursive: true });
        writeFileSync(join(home, '.universe', 'jobs', `${jobId}.json`), JSON.stringify({ url: RELAY, token: 'cjt_later_own' }));
        writeFileSync(join(home, '.universe', 'jobs', `${jobId}.stamp`), String(mark0 + 10_000));
        const done = spawnSync('sh', ['-c', command], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
        expect(done.status).toBe(0);
        // The own file was left alone (a later write is there), the alias is written with this prepare's key
        expect((JSON.parse(readFileSync(join(home, '.universe', 'jobs', `${jobId}.json`), 'utf8')) as { token: string }).token).toBe('cjt_later_own');
        const alias = JSON.parse(readFileSync(join(home, '.universe', 'jobs', `${earlier.id}.json`), 'utf8')) as { token: string };
        // The alias carries the EXACT key this prepare made (the one in its command), never just any `cjt_` key (CodeRabbit on #1025, 14c4e407 pass, N3)
        const made = [...new Set(command.match(/cjt_[A-Za-z0-9_-]+/g) ?? [])];
        expect(made).toHaveLength(1);
        expect(alias.token).toBe(made[0]);
        expect(readFileSync(join(home, '.universe', 'jobs', `${earlier.id}.stamp`), 'utf8')).toBe(String(mark0));
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
      // The prepare's own look at the job (the whole row; its earlier look at the owner names a `select`) is where it is held, with its claim taken
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { select?: unknown }) =>
        real(args).then(async (row) => {
          if (!held && !args.select) {
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
      // The prepare is held at the key's own look at the job (the one with a `select` of the control generation), just before its transaction decides whether the key is made
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob) as (args: unknown) => Promise<unknown>;
      let held = false;
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { select?: { controlGeneration?: boolean } }) => {
        if (!held && args.select?.controlGeneration) {
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
        // The slow one decides whether to make its key only now, in a transaction that finds the claim is the other's: it makes none
        letGo();
        expect(await slow).toEqual({ ok: false, reason: 'preparing' });
        // ...and none was made for it: the keys of the job that are good are the other's alone
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
      fake.execAnswer = async (command) => {
        // Once, while the key is being written (the take over's own fence commands go through here too)
        if (!taken && !isFenceCommand(command)) {
          taken = true;
          await takeOver(sara.brickId, sara.id, NOW);
        }
        return isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {};
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
    it('never passes the job’s tag on from the agent’s own words, however its text is split, in a turn or in a reconnect to it', async () => {
      const { jobId } = await running();
      const tagged = `[universe-job:${jobId}] (a tag for the system, there is no need to repeat it)`;
      const said = `Done ${tagged}`;
      fake.turns = [[{ type: 'created', id: 'resp-1', sessionId: 'sess-1' }, { type: 'text', text: said.slice(0, 20) }, { type: 'text', text: said.slice(20) }, { type: 'completed', outputText: said, usage: null }]];
      const started = await startTurn(jobId, 'Say it');
      if (!started.ok) throw new Error('no turn');
      const seen = await drain(started.events);
      expect(JSON.stringify(seen)).not.toContain('universe-job');
      expect(seen.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')).toBe('Done ');
      expect(seen.at(-1)).toMatchObject({ type: 'completed', outputText: 'Done ' });
      // Orbit keeps none of the agent's words: nothing it stored holds the tag
      const row = await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain('universe-job');
      // a reconnect passes on what the agent says through the same cleaning
      await prisma.computerJob.update({ where: { id: jobId }, data: { agentResponseId: 'resp-9', agentSessionId: 'sess-1' } });
      const reattach = jest.spyOn(fake, 'reattachTurn').mockImplementation((async () =>
        (async function* (): AsyncGenerator<TurnEvent> {
          yield { type: 'created', id: 'resp-9', sessionId: 'sess-1' };
          yield { type: 'text', text: `again ${tagged}` };
          yield { type: 'completed', outputText: `again ${tagged}`, usage: null };
        })()) as never);
      try {
        const again = await reattachJobTurn(jobId);
        if (!again.ok) throw new Error('no reconnect');
        expect(JSON.stringify(await drain(again.events))).not.toContain('universe-job');
      } finally {
        reattach.mockRestore();
      }
    });

    describe('no turn after the runner committed to ending the job (its finish intent), even in the instant between the last look and the dispatch (CodeRabbit)', () => {
      it('an intent that commits while the admission waits for the job’s lock: no turn is opened, NO first-turn mark is ever written, the claim is let go, and the answer is `finish_pending`', async () => {
        const { jobId } = await running('fence-a');
        // The admission (the last look at the job, which is also where the first turn is marked) finds the intent that committed just before it
        const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
        // The first turn is marked through the TRANSACTION's client (its own model delegate, not the root one), so the spy sits there: every write of the mark is counted, even one that a later write in the same transaction takes back
        let marks = 0;
        const watchMarks = (tx: object): object =>
          new Proxy(tx, {
            get(target, key) {
              const value = Reflect.get(target, key);
              if (key !== 'computerJob') return typeof value === 'function' ? value.bind(target) : value;
              return new Proxy(value as object, {
                get(delegate, method) {
                  const member = Reflect.get(delegate, method);
                  if (typeof member !== 'function') return member;
                  if (method !== 'updateMany' && method !== 'update') return member.bind(delegate);
                  return (args: { data?: { firstTurnSentAt?: Date | null } }) => {
                    if (args?.data?.firstTurnSentAt instanceof Date) marks++;
                    return member.call(delegate, args);
                  };
                },
              });
            },
          });
        let fired = false;
        const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: unknown) => {
          if (typeof fn !== 'function') return original(fn, options);
          const watched = (tx: object) => (fn as (tx: object) => unknown)(watchMarks(tx));
          if (!fired && fn.toString().includes('finish_pending')) {
            fired = true;
            return recordFinishIntent(jobId, { outcome: 'done' }, new Date()).then(() => original(watched, options));
          }
          return original(watched, options);
        }) as unknown as typeof prisma.$transaction);
        const sent = jest.spyOn(fake, 'openTurn');
        const markSpy = jest.spyOn(prisma.computerJob, 'updateMany');
        try {
          expect(await startTurn(jobId, 'carry on')).toEqual({ ok: false, reason: 'finish_pending' });
          expect(fired).toBe(true);
          expect(marks).toBe(0);
          // The root delegate saw no mark either (no write of the mark is made outside the admission's transaction)
          expect(markSpy.mock.calls.filter(([args]) => (args as { data?: { firstTurnSentAt?: unknown } }).data?.firstTurnSentAt instanceof Date)).toEqual([]);
          expect(sent).not.toHaveBeenCalled();
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ firstTurnSentAt: null, turnClaimedAt: null, agentResponseId: null });
        } finally {
          spy.mockRestore();
          markSpy.mockRestore();
          sent.mockRestore();
        }
      });

      /** Holds the job's cutoff lock in a transaction of its own, as a pause, a claim or a finish would (the lock the admission waits for); `release` lets it go. */
      const holdJob = (jobId: string) => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let ready: () => void = () => undefined;
        const taken = new Promise<void>((resolve) => (ready = resolve));
        const done = prisma.$transaction(
          async (tx) => {
            await lockCutoff(tx, jobId);
            ready();
            await gate;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );
        // Its failure is reported where the test waits for it (`held`) and where the test joins it (`done`), never as an unhandled rejection
        done.catch(() => undefined);
        // The checkpoint is raced against the transaction itself: one that fails (or ends) before it holds the lock rejects the wait at once, so the test reaches its cleanup
        const held = Promise.race([taken, done.then(() => { throw new Error('The fixture transaction ended before it held the job’s cutoff lock'); })]);
        return { held, release: () => release(), done };
      };
      /** Waits until a statement of THIS database is waiting for THIS job's cutoff lock (the advisory lock the admission takes), not for any lock: an unrelated waiter proves nothing about the request under test. */
      const waitingOnJob = async (jobId: string, start: Promise<unknown>) => {
        // The request is watched while the checkpoint is waited for: one that ends (or fails) before it reaches the lock fails the checkpoint at once, and its rejection is observed here (CodeRabbit on #1025, N6)
        let ended: Error | null = null;
        start.then(
          () => {
            ended = new Error('the request ended before it reached the lock checkpoint');
          },
          (error) => {
            ended = error instanceof Error ? error : new Error(String(error));
          },
        );
        for (let at = 0; at < 500; at++) {
          const rows = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended(${cutoffLockKey(jobId)}, 0) AS k) h
            WHERE l.locktype = 'advisory' AND NOT l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND l.classid = ((h.k >> 32) & 4294967295)::bigint::oid AND l.objid = (h.k & 4294967295)::bigint::oid AND l.objsubid = 1`;
          if (rows[0].n > 0) return true;
          if (ended) throw ended;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };

      it('CodeRabbit A2: while the admission waits for the job’s lock, the first turn is NOT marked yet (a start that stalls before its dispatch leaves no mark for a new owner to end the job by); the mark is written by the admission and the turn then goes', async () => {
        const { jobId } = await running('mark-a2');
        const lock = holdJob(jobId);
        let start: Promise<unknown> = Promise.resolve();
        try {
          await lock.held;
          start = startTurn(jobId, 'carry on').then(async (started) => {
            if (started.ok) await drain(started.events);
            return started;
          });
          expect(await waitingOnJob(jobId, start)).toBe(true);
          // The claim is held and the admission is waiting: nothing is marked
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ firstTurnSentAt: null });
          lock.release();
          await lock.done;
          expect(await start).toMatchObject({ ok: true });
        } finally {
          lock.release();
          await Promise.allSettled([lock.done, start]);
        }
      });

      it('CodeRabbit C9: a request cut while the admission waited sends nothing: the claim is let go and this attempt’s mark goes, whoever asks next opens the turn normally', async () => {
        const { jobId } = await running('abort-c9');
        const lock = holdJob(jobId);
        const cut = new AbortController();
        const sent = jest.spyOn(fake, 'openTurn');
        try {
          let start: Promise<unknown> = Promise.resolve();
          try {
            await lock.held;
            start = startTurn(jobId, 'carry on', cut.signal);
            expect(await waitingOnJob(jobId, start)).toBe(true);
            cut.abort();
            lock.release();
            await lock.done;
            expect(await start).toEqual({ ok: false, reason: 'failed' });
          } finally {
            lock.release();
            // The pending start is joined before the spy is let go: it cannot reach the provider after the restore
            await Promise.allSettled([lock.done, start]);
          }
          expect(sent).not.toHaveBeenCalled();
          expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ firstTurnSentAt: null, turnClaimedAt: null, agentResponseId: null });
        } finally {
          sent.mockRestore();
        }
        // The retry goes through the fake provider's real method
        const again = await startTurn(jobId, 'carry on');
        expect(again).toMatchObject({ ok: true });
        if (again.ok) await drain(again.events);
      });

      it('CodeRabbit B1: a turn the provider proves was not sent clears only THIS attempt’s mark: a replacement mark (another attempt’s) stays', async () => {
        const { jobId } = await running('notsent-b1');
        const replacement = new Date(Date.now() + 5_000);
        const open = jest.spyOn(fake, 'openTurn').mockImplementation((async () => {
          // While the request is in flight another attempt's mark takes this attempt's place
          await prisma.computerJob.update({ where: { id: jobId }, data: { firstTurnSentAt: replacement } });
          throw new TurnNotSent('the agent said no');
        }) as never);
        try {
          expect(await startTurn(jobId, 'carry on')).toEqual({ ok: false, reason: 'failed' });
        } finally {
          open.mockRestore();
        }
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).firstTurnSentAt).toEqual(replacement);
        // CONTROL: its own mark goes
        await prisma.computerJob.update({ where: { id: jobId }, data: { firstTurnSentAt: null } });
        const own = jest.spyOn(fake, 'openTurn').mockImplementation((async () => {
          throw new TurnNotSent('the agent said no');
        }) as never);
        try {
          expect(await startTurn(jobId, 'carry on')).toEqual({ ok: false, reason: 'failed' });
        } finally {
          own.mockRestore();
        }
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).firstTurnSentAt).toBeNull();
      });

      it('an intent that commits while the agent accepts the turn: the turn’s id is NOT kept for the job, the turn is cancelled, and the runner is told the job is ending', async () => {
        const { jobId } = await running('fence-b');
        fake.turns = [[{ type: 'created', id: 'resp-late', sessionId: 'sess-late' }, { type: 'text', text: 'Working' }, { type: 'completed', outputText: 'Working', usage: null }]];
        const original = FakeComputerProvider.prototype.openTurn.bind(fake);
        const open = jest.spyOn(fake, 'openTurn').mockImplementation((async (ref: string, input: { text: string; sessionId: string | null }, signal?: AbortSignal) => {
          await recordFinishIntent(jobId, { outcome: 'failed', cause: 'agent', turns: [1], run: 'r1' }, new Date());
          return original(ref, input, signal);
        }) as never);
        try {
          const started = await startTurn(jobId, 'carry on');
          if (!started.ok) throw new Error('the dispatch is the only fence this test crosses');
          const seen = await drain(started.events);
          expect(seen[0]).toMatchObject({ type: 'failed', code: 'fenced', message: 'The turn was stopped because the job is ending' });
        } finally {
          open.mockRestore();
        }
        expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ agentResponseId: null });
        expect(fake.calls.filter((call) => call.name === 'cancelTurn').length).toBeGreaterThanOrEqual(1);
      });
    });

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
      // the agent is told which job the turn is for: its model calls carry the tag, so the machine's model address calls on that job's key
      expect(fake.openedTurns[0].input).toEqual({ text: `[universe-job:${jobId}] (a tag for the system, there is no need to repeat it)\nFill the form`, sessionId: null });
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

    it('a prepare whose read throws after it took its claim lets the claim go (it is under a finally), so the next prepare is not told "preparing"', async () => {
      const { jobId } = await running();
      const silent = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementationOnce((() => {
        throw new Error('the database did not answer');
      }) as never);
      await expect(prepareJob(jobId, RELAY)).rejects.toThrow('did not answer');
      spy.mockRestore();
      silent.mockRestore();
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).prepareClaimedAt).toBeNull();
      expect((await prepareJob(jobId, RELAY)).ok).toBe(true);
    });

    describe('a read that throws after the turn is claimed', () => {
      const claimed = async (jobId: string) => (await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).turnClaimedAt;
      const okTurn = () => [[{ type: 'created', id: 'resp-a', sessionId: 'sess-1' }, { type: 'completed', outputText: '', usage: null }]] as TurnEvent[][];
      const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);
      afterEach(() => {
        jest.restoreAllMocks();
        for (const fn of [underTurnHold, settleTurnHold, wakeIfStopped]) (fn as jest.Mock).mockClear();
      });

      it('the second look at the job: the claim goes back at once, and the same start can be asked again straight away', async () => {
        const { jobId } = await running();
        fake.turns = okTurn();
        const silent = quiet();
        const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
        let looks = 0;
        const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: never) => {
          // The job is read once before the claim and once with the claim held (the computer's own row is read more than once by each: control is asked too)
          if (++looks === 2) throw new Error('the database did not answer');
          return real(args);
        }) as never);
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        spy.mockRestore();
        silent.mockRestore();
        expect(await claimed(jobId)).toBeNull();
        expect((await startTurn(jobId, 'go')).ok).toBe(true);
      });

      it('asking whether a hold is on the machine', async () => {
        const { jobId } = await running();
        fake.turns = okTurn();
        const silent = quiet();
        (underTurnHold as jest.Mock).mockRejectedValueOnce(new Error('the database did not answer'));
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        silent.mockRestore();
        expect(await claimed(jobId)).toBeNull();
        expect((await startTurn(jobId, 'go')).ok).toBe(true);
      });

      it('proving the machine asleep under a hold', async () => {
        const { jobId } = await running();
        fake.turns = okTurn();
        const silent = quiet();
        (underTurnHold as jest.Mock).mockResolvedValueOnce(true);
        (settleTurnHold as jest.Mock).mockRejectedValueOnce(new Error('the machine could not be asked'));
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        silent.mockRestore();
        expect(await claimed(jobId)).toBeNull();
        expect((await startTurn(jobId, 'go')).ok).toBe(true);
      });

      it('waking the machine after the hold was settled', async () => {
        const { jobId } = await running();
        fake.turns = okTurn();
        const silent = quiet();
        (underTurnHold as jest.Mock).mockResolvedValueOnce(true);
        (settleTurnHold as jest.Mock).mockResolvedValueOnce(true);
        (wakeIfStopped as jest.Mock).mockRejectedValueOnce(new Error('the machine did not wake'));
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        silent.mockRestore();
        expect(await claimed(jobId)).toBeNull();
        // Nothing was sent, so no first-turn mark was left either
        expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).firstTurnSentAt).toBeNull();
        expect((await startTurn(jobId, 'go')).ok).toBe(true);
      });
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

      it('CodeRabbit on #1025 (29): the stream fails before the id after another worker claimed the job: the ending is refused, the stream says `superseded` and not that the job ended, and the job runs on for its new owner', async () => {
        const { jobId } = await running();
        fake.openTurn = async () =>
          (async function* (): AsyncGenerator<TurnEvent> {
            await prisma.computerJob.update({ where: { id: jobId }, data: { ownerEpoch: { increment: 1 } } });
            throw new Error('socket hang up');
          })();
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        expect(await drain(started.events)).toEqual([expect.objectContaining({ type: 'failed', code: 'superseded' })]);
        expect((await jobRow(jobId)).status).toBe('running');
      });

      it('the job cannot be ended at that moment: the mark stays, so the next start ends it and never opens another turn', async () => {
        const { jobId } = await running();
        const { opened, wrap } = counted();
        fake.openTurn = wrap(failing('socket hang up'));
        (finishJobUnder as jest.Mock).mockRejectedValueOnce(new Error('database unreachable'));
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        // The ending could not be made: the stream says so (an unresolved turn), never that the job was ended (CodeRabbit on #1025)
        expect(await drain(started.events)).toEqual([expect.objectContaining({ type: 'failed', code: 'turn_unresolved' })]);
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

      // A first turn that is accepted and whose id comes only later: the stream waits until the test lets it go
      const gatedFirstTurn = () => {
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const original = FakeComputerProvider.prototype.openTurn.bind(fake);
        let first = true;
        fake.openTurn = async (ref, input, signal) => {
          if (!first) return original(ref, input, signal);
          first = false;
          return (async function* (): AsyncGenerator<TurnEvent> {
            await gate;
            yield { type: 'created', id: 'resp-late', sessionId: 'sess-late' };
            yield { type: 'completed', outputText: '', usage: null };
          })();
        };
        return open;
      };

      it('a gateway error (504, or 502 or 503) may have come after the agent accepted the turn: the job ends, and a second start opens no turn', async () => {
        for (const status of [504, 502, 503]) {
          const { jobId } = await running(`gw${status}`);
          const { opened, wrap } = counted();
          fake.openTurn = wrap(async () => {
            throw new Agent37Error(status, null, 'gateway');
          });
          expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
          expect((await jobRow(jobId)).status).toBe('failed');
          expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'not_running' });
          expect(opened).toHaveBeenCalledTimes(1);
        }
      });

      it('an answer that Agent37 itself says is safe to ask again (try_again, or too many asks) opened nothing: the mark goes and the start can be asked again', async () => {
        const { jobId } = await running();
        fake.openTurn = async () => {
          throw new Agent37Error(503, 'try_again', 'busy');
        };
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        expect((await jobRow(jobId)).firstTurnSentAt).toBeNull();
        fake.openTurn = async () => {
          throw new Agent37Error(429, null, 'slow down');
        };
        expect(await startTurn(jobId, 'go')).toEqual({ ok: false, reason: 'failed' });
        const row = await jobRow(jobId);
        expect(row.status).toBe('running');
        expect(row.firstTurnSentAt).toBeNull();
      });

      it('a first turn whose id comes after the job was fenced is cancelled, and its mark goes with it: the next start opens a turn, the job is not failed', async () => {
        const { jobId } = await running();
        const letGo = gatedFirstTurn();
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        expect((await jobRow(jobId)).firstTurnSentAt).not.toBeNull();
        const reading = drain(started.events);
        // The control number moves (the keys of the turn are of the older one) before the agent says its id
        await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: { increment: 1 } } });
        letGo();
        expect(await reading).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
        expect(fake.cancelledTurns).toContain('resp-late');
        const after = await jobRow(jobId);
        expect(after.firstTurnSentAt).toBeNull();
        expect(after.status).toBe('running');
        expect(await startTurn(jobId, 'again')).toMatchObject({ ok: true });
      });

      // A first turn the agent accepted and whose id never came here (the server that sent it stopped): it runs inside the agent's gateway, which the
      // machine's fence keeps. The claim of that start lapses by itself.
      const acceptedAndLost = async (jobId: string) => {
        const sent = jest.spyOn(fake, 'openTurn');
        sent.mockImplementationOnce((async () =>
          (async function* (): AsyncGenerator<TurnEvent> {
            await new Promise(() => undefined);
          })()) as never);
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        expect((await jobRow(jobId)).firstTurnSentAt).not.toBeNull();
        const lapse = () => prisma.computerJob.update({ where: { id: jobId }, data: { turnClaimedAt: new Date(Date.now() - 5 * 60_000) } });
        return { sent, lapse };
      };

      it('the take-over fence does not clear the mark of a first turn that never said its id while the machine keeps working (the fence keeps the agent\'s gateway, where the turn runs): after the hand-back the start ends the job and opens no second turn', async () => {
        const { sara, jobId } = await running();
        const { sent, lapse } = await acceptedAndLost(jobId);
        try {
          expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
          // The fence ran and was proved clear, and the machine works on: the turn may still be running inside the gateway
          expect(fake.commands.map((one) => one.command).some(isFenceCheckCommand)).toBe(true);
          expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
          expect((await jobRow(jobId)).firstTurnSentAt).not.toBeNull();
          expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
          await lapse();
          expect(await startTurn(jobId, 'carry on')).toEqual({ ok: false, reason: 'not_running' });
          expect(sent).toHaveBeenCalledTimes(1);
          expect((await jobRow(jobId)).status).toBe('failed');
        } finally {
          sent.mockRestore();
        }
      });

      it('the take-over fence that could not be proved stops the machine, and with it the first turn: its mark goes, and after the hand-back a start opens a turn', async () => {
        const { sara, jobId } = await running();
        const { sent, lapse } = await acceptedAndLost(jobId);
        try {
          fake.execAnswer = (command) => (isFenceCheckCommand(command) ? UNPROVABLE : {});
          expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
          expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
          expect((await jobRow(jobId)).firstTurnSentAt).toBeNull();
          fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {});
          expect(await handBack(sara.brickId, sara.id)).toMatchObject({ ok: true });
          await lapse();
          const back = await startTurn(jobId, 'carry on');
          expect(back).toMatchObject({ ok: true });
          if (back.ok) await drain(back.events);
          expect(sent).toHaveBeenCalledTimes(2);
          expect((await jobRow(jobId)).status).toBe('running');
        } finally {
          sent.mockRestore();
        }
      });

      describe('a job that ends with a first turn nobody can name: no other job or turn starts on its machine until the machine is proved asleep', () => {
        const machineOf = (botId: string) => prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
        const waitingJob = async (sara: { id: string; brickId: string }, writes = true) => {
          const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Next', writes }, NOW);
          if (!queued.ok) throw new Error('the job was not saved');
          return queued.job.id;
        };

        it('the machine is put to sleep and proved before the job in line starts (a stop is made, then the machine is woken for it)', async () => {
          const { sara, jobId } = await running();
          const { sent } = await acceptedAndLost(jobId);
          try {
            const nextId = await waitingJob(sara);
            expect((await jobRow(nextId)).status).toBe('queued');
            fake.calls.length = 0;
            await finishJob(jobId, 'failed', NOW);
            const names = fake.calls.map((call) => call.name);
            expect(names).toContain('stop');
            expect(names.indexOf('stop')).toBeLessThan(names.lastIndexOf('wake'));
            expect((await jobRow(nextId)).status).toBe('running');
            expect((await machineOf(sara.brickId)).turnUnprovenSince).toBeNull();
          } finally {
            sent.mockRestore();
          }
        });

        it('the machine’s files are saved before it is stopped, as every other stop does, so a later restore never uses an older copy', async () => {
          const { sara, jobId } = await running();
          const { sent } = await acceptedAndLost(jobId);
          try {
            fake.calls.length = 0;
            await finishJob(jobId, 'failed', NOW);
            const names = fake.calls.map((call) => call.name);
            expect(names).toContain('stop');
            expect(names).toContain('saveFiles');
            expect(names.indexOf('saveFiles')).toBeLessThan(names.indexOf('stop'));
            expect((await machineOf(sara.brickId)).filesSavedAt).not.toBeNull();
          } finally {
            sent.mockRestore();
          }
        });

        it('a stop that cannot be proved keeps the hold: the job in line stays in line, and a later sweep that proves the machine asleep lets it start', async () => {
          const { sara, jobId } = await running();
          const { sent } = await acceptedAndLost(jobId);
          const ref = `fake-${sara.brickId}`;
          try {
            const nextId = await waitingJob(sara);
            fake.stuckAwake.add(ref);
            await finishJob(jobId, 'failed', NOW);
            expect((await jobRow(nextId)).status).toBe('queued');
            expect((await machineOf(sara.brickId)).turnUnprovenSince).not.toBeNull();
            // Still unproved: another try to start it changes nothing
            await sweepComputers(minutes(1));
            expect((await jobRow(nextId)).status).toBe('queued');
            expect((await machineOf(sara.brickId)).turnUnprovenSince).not.toBeNull();
            fake.stuckAwake.delete(ref);
            await sweepComputers(minutes(2));
            expect((await jobRow(nextId)).status).toBe('running');
            expect((await machineOf(sara.brickId)).turnUnprovenSince).toBeNull();
          } finally {
            fake.stuckAwake.delete(ref);
            sent.mockRestore();
          }
        });

        it('a job that ended with no unnamed turn leaves nothing behind: the job in line starts at once and the machine is not put to sleep', async () => {
          const { sara, jobId } = await running();
          const nextId = await waitingJob(sara);
          fake.calls.length = 0;
          await finishJob(jobId, 'done', NOW);
          expect((await jobRow(nextId)).status).toBe('running');
          expect(fake.calls.map((call) => call.name)).not.toContain('stop');
          expect((await machineOf(sara.brickId)).turnUnprovenSince).toBeNull();
        });

        const readerAndWriter = async () => {
          const { sara, jobId } = await running();
          // Only jobs that read run side by side (a job that may sign in has the machine alone): the first one only looks too
          await prisma.computerJob.update({ where: { id: jobId }, data: { writes: false } });
          const accepted = await acceptedAndLost(jobId);
          // A read-only job holds the machine beside the first, and a second one keeps it held when the first ends
          const readerId = await waitingJob(sara, false);
          expect((await jobRow(readerId)).status).toBe('running');
          const other = await waitingJob(sara, false);
          await finishJob(jobId, 'failed', NOW);
          expect((await machineOf(sara.brickId)).turnUnprovenSince).not.toBeNull();
          expect((await machineOf(sara.brickId)).machine).toBe('working');
          return { sara, readerId, other, sent: accepted.sent };
        };

        it('a job that already holds the machine opens no turn beside the unnamed one: it waits while another job holds the machine too', async () => {
          const { readerId, sent } = await readerAndWriter();
          try {
            expect(await startTurn(readerId, 'go')).toEqual({ ok: false, reason: 'starting' });
            expect(sent).toHaveBeenCalledTimes(1);
          } finally {
            sent.mockRestore();
          }
        });

        it('the job left alone as the holder has the machine put to sleep, proved and woken for it, and goes on: its turn opens, it does not fail for nothing', async () => {
          const { sara, readerId, other, sent } = await readerAndWriter();
          try {
            await finishJob(other, 'done', NOW);
            fake.calls.length = 0;
            const started = await startTurn(readerId, 'go');
            expect(started.ok).toBe(true);
            const names = fake.calls.map((call) => call.name);
            expect(names).toContain('stop');
            expect(names.indexOf('stop')).toBeLessThan(names.lastIndexOf('wake'));
            expect(sent).toHaveBeenCalledTimes(2);
            expect((await machineOf(sara.brickId)).machine).toBe('working');
            expect((await machineOf(sara.brickId)).turnUnprovenSince).toBeNull();
            expect((await jobRow(readerId)).status).toBe('running');
          } finally {
            sent.mockRestore();
          }
        });

        it('a machine that will not wake again ends the job as an error with its room given back (never a job left waiting on a machine that is not there)', async () => {
          const { readerId, other, sent } = await readerAndWriter();
          try {
            await finishJob(other, 'done', NOW);
            fake.failNext.wake = true;
            expect(await startTurn(readerId, 'go')).toMatchObject({ ok: false });
            expect(sent).toHaveBeenCalledTimes(1);
            const ended = await jobRow(readerId);
            expect(ended.status).toBe('stopped');
            expect(ended.endedBy).toBe('error');
          } finally {
            sent.mockRestore();
          }
        });

        it('a job that holds a named turn is told it is busy and its machine is not put to sleep by the hold', async () => {
          const { sara, readerId, sent } = await readerAndWriter();
          try {
            await prisma.computerJob.update({ where: { id: readerId }, data: { agentResponseId: 'resp-own' } });
            fake.calls.length = 0;
            expect(await startTurn(readerId, 'go')).toMatchObject({ ok: false, reason: 'busy' });
            expect(fake.calls.map((call) => call.name)).not.toContain('stop');
            expect((await machineOf(sara.brickId)).machine).toBe('working');
          } finally {
            sent.mockRestore();
          }
        });
      });

      it('a first turn whose id comes after the job was fenced and that cannot be cancelled by its id keeps its mark (the fence that replaces the cancel keeps the gateway): the next start ends the job and opens no second turn', async () => {
        const { jobId } = await running();
        const letGo = gatedFirstTurn();
        const sent = jest.spyOn(fake, 'openTurn');
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        const reading = drain(started.events);
        await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: { increment: 1 } } });
        fake.failCancel = true;
        letGo();
        expect(await reading).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
        // Three tries to cancel it by its id, then the machine's fence: proved clear, the machine works on
        expect(fake.calls.filter((call) => call.name === 'cancelTurn').length).toBeGreaterThanOrEqual(3);
        expect((await jobRow(jobId)).firstTurnSentAt).not.toBeNull();
        fake.failCancel = false;
        expect(await startTurn(jobId, 'again')).toEqual({ ok: false, reason: 'not_running' });
        expect(sent).toHaveBeenCalledTimes(1);
        expect((await jobRow(jobId)).status).toBe('failed');
        sent.mockRestore();
      });

      it('...unless the machine fence that replaced the cancel could not be proved and stopped the machine: then nothing runs, and the mark goes', async () => {
        const { jobId } = await running();
        const letGo = gatedFirstTurn();
        const started = await startTurn(jobId, 'go');
        if (!started.ok) throw new Error('no turn');
        const reading = drain(started.events);
        await prisma.computerJob.update({ where: { id: jobId }, data: { controlGeneration: { increment: 1 } } });
        fake.failCancel = true;
        fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=2\n' } : {});
        letGo();
        expect(await reading).toEqual([{ type: 'failed', code: 'fenced', message: expect.any(String) }]);
        expect((await jobRow(jobId)).firstTurnSentAt).toBeNull();
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
        return isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {};
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
      expect(commands.some(isPlainFence)).toBe(true);
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
      // Starting a writing job already listed the files once (the baseline its results are told apart from): only what the take-over runs is checked here
      fake.commands.length = 0;
      const taken = await takeOver(sara.brickId, sara.id, NOW);
      expect(taken.ok).toBe(true);
      expect(fake.cancelledTurns).toEqual(['resp-5']);
      expect(fake.commands.map((entry) => (isFenceCheckCommand(entry.command) ? 'check' : isPlainFence(entry.command) ? 'fence' : entry.command))).toEqual(['fence', 'check']);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).agentResponseId).toBeNull();
    });

    it('tries again when the first look finds something left, and the machine keeps working once it is proved', async () => {
      const { sara } = await running();
      let looks = 0;
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: ++looks < 2 ? 'remaining=3\n' : 'remaining=0\n' } : {});
      expect(await fenceMachine(sara.brickId)).toBe('done');
      expect(looks).toBe(2);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
    });

    it('stops the machine when it cannot be proved, so the person never has a screen with an agent still acting behind it', async () => {
      const { sara } = await running();
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=2\n' } : {});
      expect(await fenceMachine(sara.brickId)).toBe('failed');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
      expect(fake.calls.some((call) => call.name === 'stop')).toBe(true);
      // and a machine that does not answer at all is the same
      const other = await running('omar');
      fake.failExec = true;
      expect(await fenceMachine(other.sara.brickId)).toBe('failed');
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: other.sara.brickId } })).machine).toBe('stopped');
    });

    describe('a stop that takes too long while the computer’s row is held', () => {
      afterEach(() => setLeaderStopTimesForTests(null));
      const slowStop = (ms: number) => {
        const stop = fake.stop.bind(fake);
        fake.stop = async (ref: string) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return stop(ref);
        };
      };
      const machineOf = async (botId: string) => (await prisma.brickComputer.findUniqueOrThrow({ where: { botId } })).machine;

      it('is not proved when the provider is slower than the time given it, and is written `stopping` for the sweep, never left `working`', async () => {
        const { sara } = await running();
        fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=2\n' } : {});
        setLeaderStopTimesForTests({ deadlineMs: 150, transactionMs: 10_000 });
        slowStop(1_000);
        expect(await fenceMachine(sara.brickId)).toBe('failed');
        expect(await machineOf(sara.brickId)).toBe('stopping');
      });

      it('writes `stopping` again when the transaction itself ran out of time after the stop was sent, so a stopped machine is never left `working`', async () => {
        const { sara } = await running();
        fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=2\n' } : {});
        // The stop is allowed longer than the transaction: the transaction is rolled back, with the record in it
        setLeaderStopTimesForTests({ deadlineMs: 5_000, transactionMs: 300 });
        slowStop(900);
        expect(await fenceMachine(sara.brickId)).toBe('failed');
        expect(await machineOf(sara.brickId)).toBe('stopping');
      });
    });

    it('does not call the machine stopped when the stop was refused: it is blocked and tried again until proved asleep', async () => {
      const { sara } = await running();
      fake.execAnswer = () => (UNPROVABLE);
      const ref = `fake-${sara.brickId}`;
      fake.stuckAwake.add(ref);
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopping');
      fake.stuckAwake.delete(ref);
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {});
      await sweepComputers(minutes(2));
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
    });

    it('wakes a machine that a failed fence stopped when the person hands the job back, so the job can go on', async () => {
      const { sara, jobId } = await running();
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? UNPROVABLE : {});
      await takeOver(sara.brickId, sara.id, NOW);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('stopped');
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {});
      const back = await handBack(sara.brickId, sara.id);
      expect(back.ok).toBe(true);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('running');
    });

    it('a command that fails is not proof, whatever it printed', async () => {
      const { sara } = await running();
      fake.execAnswer = (command) => (isFenceCheckCommand(command) ? { exitCode: 127, stdout: 'remaining=0\n' } : {});
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

    it('sends none while the machine is changing hands (a take-over or a hand-back runs the fence), and again once it is the person’s or the agent’s (Sentry on #1033)', async () => {
      const { sara } = await running();
      const quiet = () => fake.commands.filter((entry) => entry.command === 'true').length;
      for (const controlState of ['fencing', 'returning']) {
        // A leader holds the transition (a lease that has not run out): the sweep does not finish it for them
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { controlState, controlLeaseUntil: new Date(Date.now() + 10 * 60_000), keptAwakeAt: null } });
        await sweepComputers(minutes(1));
        expect(quiet()).toBe(0);
      }
      // The person has the screen: the machine still needs the no-op
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { controlState: 'human_ready', keptAwakeAt: null } });
      await sweepComputers(minutes(1));
      expect(quiet()).toBe(1);
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
      expect(mine).toEqual([{ jobId: started.job.id, botId: sara.brickId, title: 'Visa form', brief: 'Fill the Kuwait visa form for two people', writes: true, hasTurn: false, continuesJobId: null }]);
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
