/**
 * Two jobs that run at once on one Brick's computer (read-only jobs may overlap), end to end: each one's calls reach the model relay with ITS OWN key, so each is
 * booked its own room, its own spend (and what a rule counts for a task), and, when one fails on our side, only its own calls are given back.
 *
 * The machine is real here as far as it can be: the commands Orbit sends to write the keys are run in a home folder, the turns' text is what Orbit sent to the agent,
 * and the calls go through the image's own `universe-proxy` to a pretend bot server that asks Orbit (`authorizeModelCall`, `settleModelCall`) the way the real one does.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database, and with python3:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-overlap-db.test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(async () => null),
}));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, startJob } from '@/lib/computer';
import { prepareJob, startTurn } from '@/lib/computer-broker';
import * as calls from '@/lib/computer-calls';
import { callRoomKey } from '@/lib/computer-calls';
import { proposeRule } from '@/lib/spend-rules';
import { imageFiles } from '@/lib/agent37/image-files';
import type { TurnEvent } from '@/lib/agent37/turn-events';

const hasPython = spawnSync('sh', ['-c', 'command -v python3']).status === 0;
const run = process.env.ROLES_DB_TEST === 'yes' && hasPython ? describe : describe.skip;
// What happens to a failed job's calls is the release's own rule (`giveBackModelCalls`); the part that needs it runs where it is
const givesBack = typeof (calls as Record<string, unknown>).giveBackModelCalls === 'function';

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;
let fake: FakeComputerProvider;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({
    data: { uuid: unique, email: `${unique}@example.test`, name },
  });
  people.push(user.id);
  const brick = await createBrick({
    ownerId: user.id,
    name: `${name}'s Brick`,
  });
  return { id: user.id, brickId: brick.id };
}

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.spendRule.deleteMany({
    where: { ownerPersonId: { in: people } },
  });
  await prisma.appSetting.deleteMany({
    where: { key: { in: ['meter', 'bot-limits'] } },
  });
};

// The runner says a job failed on our side by its cause (the release's rule says only that gives back); a computer with no such word ends it as the person's
const failedOnOurSide = (jobId: string) => (finishJob as (...args: unknown[]) => Promise<unknown>)(jobId, 'failed', NOW, null, 'ours');

const drain = async (events: AsyncGenerator<TurnEvent>) => {
  for await (const event of events) void event;
};

run('two read-only jobs that run at once on one computer, each calling on its own key', () => {
  let bank: Server;
  let bankBase: string;
  let bankCalls = 0;
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    process.env.COMPUTER_PROVIDER = 'fake';
    // The pretend bot server: the key on the call says who asks; Orbit decides, and the cost the call really had is settled after
    bank = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          // Only a call is answered here (the readiness look at the machine's model address is not one)
          if (req.method !== 'POST') return void res.writeHead(404).end();
          const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
          const parsed = JSON.parse(body || '{}') as {
            estimate?: number;
            cost?: number;
          };
          const callId = `call-${++bankCalls}`;
          const authorized = await calls.authorizeModelCall(
            {
              token,
              callId,
              estimateMicros: parsed.estimate ?? 1_000,
              payer: 'universe',
            },
            NOW,
          );
          let status = 200;
          let answer: Record<string, unknown>;
          if (authorized.ok) {
            await calls.settleModelCall(
              authorized.jobId,
              callId,
              {
                costMicros: parsed.cost ?? parsed.estimate ?? 1_000,
                basis: 'measured',
                payer: { kind: 'universe' },
                route: 'universe-ai',
              },
              NOW,
            );
            answer = { jobId: authorized.jobId, callId };
          } else {
            status = 429;
            answer = { refused: authorized.reason };
          }
          answers.push({ status, body: answer });
          res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
        } catch (error) {
          console.error('BANKERR', error);
          res.writeHead(500).end();
        }
      });
    });
    await new Promise<void>((resolve) => bank.listen(0, '127.0.0.1', resolve));
    bankBase = `http://127.0.0.1:${(bank.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({
      where: { bot: { ownerId: { in: people } } },
    });
    fake = new FakeComputerProvider();
    setComputerProviderForTests(fake);
    await saveMeterSettings(
      {
        memberAllowanceMicros: 5_000_000,
        poolCeilingMicros: 100_000_000,
        reserveMicros: 0,
        storageMicrosPerGbMonth: 0,
        atOnceMember: 100,
        atOnceAll: 100,
        renewMinutes: 10,
      },
      'admin',
    );
    answers.length = 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => bank.close(() => resolve()));
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  /** Sara's computer with two read-only jobs on it, both prepared, and a model address on the machine that reads what Orbit wrote. */
  async function twoReaders() {
    const sara = await person('sara');
    await giveComputer(sara.brickId, sara.id);
    const start = async (title: string) => {
      const started = await startJob({ botId: sara.brickId, personId: sara.id, title, writes: false }, NOW);
      if (!started.ok || started.job.status !== 'running') throw new Error('the job did not start');
      return started.job.id;
    };
    const a = await start('Read page one');
    const b = await start('Read page two');
    const home = mkdtempSync(join(tmpdir(), 'universe-overlap-'));
    const dir = mkdtempSync(join(tmpdir(), 'universe-overlap-bin-'));
    const proxyFile = imageFiles().find((file) => file.name === 'universe-proxy');
    if (!proxyFile) throw new Error('the image has no model address');
    writeFileSync(join(dir, 'universe-proxy'), proxyFile.text, {
      mode: 0o755,
    });
    // Each job is made ready, one after the other; what Orbit sends to the machine is run in the machine's home, pointed at the pretend bot server
    for (const jobId of [a, b]) {
      expect(await prepareJob(jobId, 'https://bot-server.example.test', NOW)).toMatchObject({ ok: true });
      const command = fake.commands.filter((entry) => entry.command.includes('relay.json')).at(-1)?.command ?? '';
      const ran = spawnSync('sh', ['-c', command.replaceAll('"url":"https://bot-server.example.test"', `"url":"${bankBase}"`)], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(ran.status).toBe(0);
    }
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn('python3', [join(dir, 'universe-proxy')], {
      env: { ...process.env, HOME: home, UNIVERSE_PROXY_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let tries = 0; tries < 50; tries++) {
      if (
        await fetch(`http://127.0.0.1:${port}/v1/models`)
          .then(() => true)
          .catch(() => false)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // What each job's agent was told: its turns start with its tag (the agent's model calls carry the conversation, so they carry the tag too)
    fake.turns = [
      [
        { type: 'created', id: 'resp-a', sessionId: 'sess-a' },
        { type: 'completed', outputText: '', usage: null },
      ],
      [
        { type: 'created', id: 'resp-b', sessionId: 'sess-b' },
        { type: 'completed', outputText: '', usage: null },
      ],
    ];
    for (const jobId of [a, b]) {
      const turn = await startTurn(jobId, 'Read the page');
      if (!turn.ok) throw new Error(`the turn did not start: ${turn.reason}`);
      await drain(turn.events);
    }
    const [textA, textB] = fake.openedTurns.map((opened) => opened.input.text);
    /** A model call the way Hermes makes it: the conversation of the job's turn, through the machine's model address. */
    const call = (text: string, body: { estimate: number; cost?: number }) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You are an agent.' },
            { role: 'user', content: text },
          ],
          ...body,
        }),
      }).then(async (answer) => ({
        status: answer.status,
        body: (await answer.json()) as Record<string, unknown>,
      }));
    const stop = () => {
      child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    };
    return {
      sara,
      a,
      b,
      home,
      textA,
      textB,
      callA: (body: { estimate: number; cost?: number }) => call(textA, body),
      callB: (body: { estimate: number; cost?: number }) => call(textB, body),
      stop,
    };
  }

  const eventsOf = (jobId: string) =>
    prisma.meterEvent.findMany({
      where: { jobId, kind: 'model_call' },
      orderBy: { eventId: 'asc' },
    });

  it('writes each job’s own key beside the other’s, and tells each agent its job: the last key written is only what a call with no tag uses', async () => {
    const { a, b, home, textA, textB, stop } = await twoReaders();
    try {
      expect(textA.startsWith(`[universe-job:${a}]`)).toBe(true);
      expect(textB.startsWith(`[universe-job:${b}]`)).toBe(true);
      expect(textA.endsWith('Read the page')).toBe(true);
      const keyOf = (path: string) =>
        (
          JSON.parse(readFileSync(join(home, '.universe', path), 'utf8')) as {
            token: string;
          }
        ).token;
      const { verifyJobToken } = await import('@/lib/computer-token');
      expect(await verifyJobToken(keyOf(`jobs/${a}.json`), 'model', NOW)).toMatchObject({ ok: true, jobId: a });
      expect(await verifyJobToken(keyOf(`jobs/${b}.json`), 'model', NOW)).toMatchObject({ ok: true, jobId: b });
      // the key last written is the second job's; the first job's own key was never ended by it
      expect(keyOf('relay.json')).toBe(keyOf(`jobs/${b}.json`));
    } finally {
      stop();
    }
  });

  it('books every call of two jobs that call at once to the job it came from: its room, its own event, nothing of the other’s', async () => {
    const { a, b, callA, callB, stop } = await twoReaders();
    try {
      const answered = await Promise.all([
        callA({ estimate: 5_000, cost: 3_000 }),
        callB({ estimate: 8_000, cost: 6_000 }),
        callA({ estimate: 5_000, cost: 3_000 }),
        callB({ estimate: 8_000, cost: 6_000 }),
      ]);
      expect(answered.map((one) => one.status)).toEqual([200, 200, 200, 200]);
      expect(answered.map((one) => one.body.jobId)).toEqual([a, b, a, b]);
      const [forA, forB] = [await eventsOf(a), await eventsOf(b)];
      expect(forA.map((event) => Number(event.costMicros))).toEqual([3_000, 3_000]);
      expect(forB.map((event) => Number(event.costMicros))).toEqual([6_000, 6_000]);
      // every call's room is named for its own job, and was settled at that call's cost
      const rooms = await prisma.meterReservation.findMany({
        where: { reservationKey: { startsWith: 'computer:call:' } },
      });
      expect(rooms.filter((room) => room.reservationKey.startsWith(callRoomKey(a, ''))).map((room) => Number(room.settledMicros))).toEqual([3_000, 3_000]);
      expect(rooms.filter((room) => room.reservationKey.startsWith(callRoomKey(b, ''))).map((room) => Number(room.settledMicros))).toEqual([6_000, 6_000]);
      expect(rooms.every((room) => room.jobId === a || room.jobId === b)).toBe(true);
    } finally {
      stop();
    }
  });

  it('a sibling’s calls never use up a job’s per-task spend: each job is held to its own', async () => {
    const { sara, a, callA, callB, stop } = await twoReaders();
    try {
      // "For each task, at most 200,000"
      expect(
        await proposeRule({
          botId: sara.brickId,
          speakerId: sara.id,
          scope: 'bot',
          period: 'task',
          capMicros: 200_000,
        }),
      ).toMatchObject({ ok: true });
      // Each job holds its own room (60,000 for its first stretch). The first job spends 100,000 and the second asks for 100,000 of its own: each is under its own
      // cap (160,000), but both together are over it, as they would be if the second's call were booked to the first
      expect((await callA({ estimate: 100_000, cost: 100_000 })).status).toBe(200);
      const second = await callB({ estimate: 100_000, cost: 100_000 });
      expect(second).toMatchObject({ status: 200 });
      expect(second.body.jobId).not.toBe(a);
      // ...and a job is still held to its own: the first job's next call would take it over its own 200,000
      expect(await callA({ estimate: 100_000, cost: 100_000 })).toMatchObject({ status: 429, body: { refused: 'rule' } });
    } finally {
      stop();
    }
  });

  (givesBack ? it : it.skip)('a job that fails on our side is given back its own calls and nothing of its sibling’s, which goes on and is still charged', async () => {
    const { sara, a, b, callA, callB, stop } = await twoReaders();
    try {
      await Promise.all([callA({ estimate: 5_000, cost: 3_000 }), callB({ estimate: 8_000, cost: 6_000 }), callA({ estimate: 5_000, cost: 3_000 })]);
      await failedOnOurSide(a);
      const forA = await eventsOf(a);
      expect(forA).toHaveLength(2);
      for (const event of forA) {
        expect(event.personKey).toBe('unknown');
        expect(event.detail).toMatchObject({
          givenBack: true,
          forPersonId: sara.id,
        });
      }
      // the sibling's call stays the person's, and its next call still goes through
      const forB = await eventsOf(b);
      expect(forB.map((event) => event.personKey)).toEqual([`person:${sara.id}`]);
      expect(forB[0].detail).not.toHaveProperty('givenBack');
      expect((await callB({ estimate: 8_000, cost: 6_000 })).status).toBe(200);
      expect((await eventsOf(b)).every((event) => event.personKey === `person:${sara.id}`)).toBe(true);
      // the failed job's computer holds no key from the failure: a call it makes after is refused, and the sibling's is not
      expect(await callA({ estimate: 1_000 })).toMatchObject({
        status: 429,
        body: { refused: 'refused' },
      });
      expect(await eventsOf(a)).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('a job that failed on our side leaves its sibling’s per-task room and rule alone: the sibling keeps calling on its own key', async () => {
    const { a, b, callA, callB, stop } = await twoReaders();
    try {
      expect((await callA({ estimate: 5_000, cost: 5_000 })).status).toBe(200);
      await failedOnOurSide(a);
      expect((await callA({ estimate: 5_000 })).status).toBe(429);
      const next = await callB({ estimate: 5_000, cost: 5_000 });
      expect(next).toMatchObject({ status: 200 });
      expect(next.body.jobId).toBe(b);
    } finally {
      stop();
    }
  });
});
