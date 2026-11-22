/**
 * A paused job's own browser sign-ins (lib/computer-browser-profile.ts), against a real database with the PRETEND provider: which job's
 * browser is put away, brought back or thrown away, on which machine, as whom, and when nothing is done at all. The command itself is
 * tested for real in __tests__/lib/computer-browser-profile-script.test.ts. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a
 * migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/computer-browser-profile-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveServerLimits } from '@/lib/bot-limits';
import { FakeComputerProvider, setComputerProviderForTests, type ExecOptions } from '@/lib/computer-provider';
import { dropProfile, parkProfile, resetSignInsSweepForTests, restoreProfile, sweepPausedSignIns } from '@/lib/computer-browser-profile';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-23T08:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

interface Sent {
  action: string;
  job: string;
  keep: string[];
  user: string | undefined;
}
let sent: Sent[] = [];
/** What the pretend machine answers for each action (the command's own answer line). */
let answers: Record<string, string> = {};

async function person(name: string): Promise<{ id: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

async function machine(botId: string, state = 'working') {
  await prisma.brickComputer.upsert({ where: { botId }, create: { botId, machine: state, provider: 'fake', providerRef: `fake-${botId}` }, update: { machine: state, providerRef: `fake-${botId}`, cleanClaimedAt: null } });
}

/** A job of this person on this Brick, as piece 1 leaves it: `pausedMinutesAgo` writes its last pause from running (null: never paused while it ran). */
async function job(who: { id: string; brickId: string }, over: { status?: string; queuedFor?: string | null; writes?: boolean; pausedMinutesAgo?: number | null; botId?: string } = {}) {
  const paused = over.pausedMinutesAgo ?? null;
  const row = await prisma.computerJob.create({
    data: {
      botId: over.botId ?? who.brickId,
      personId: who.id,
      title: 'Fill the visa form',
      status: over.status ?? 'queued',
      queuedFor: over.queuedFor === undefined ? ((over.status ?? 'queued') === 'queued' ? 'paused' : null) : over.queuedFor,
      writes: over.writes ?? true,
      pauses: paused === null ? 0 : 1,
      pausedAt: paused !== null && (over.status ?? 'queued') === 'queued' ? minutes(-paused) : null,
    },
  });
  if (paused !== null) await prisma.computerJobPause.create({ data: { jobId: row.id, n: 1, why: 'person', seconds: 60, at: minutes(-paused) } });
  return row;
}

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
};

run('a paused job’s own browser sign-ins, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });

  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    sent = [];
    answers = { park: 'parked=1 cookies=4 pages=2', restore: 'restored=1 cookies=4 pages=2', drop: 'dropped=1', clear: 'cleared=1', prune: 'pruned=1' };
    const exec = provider.exec.bind(provider);
    jest.spyOn(provider, 'exec').mockImplementation(async (ref: string, command: string, options?: ExecOptions) => {
      const action = /ACTION="([a-z]+)"/.exec(command)?.[1] ?? '?';
      sent.push({ action, job: /JOB="([^"]*)"/.exec(command)?.[1] ?? '', keep: (/KEEP="([^"]*)"/.exec(command)?.[1] ?? '').split(' ').filter(Boolean), user: options?.user });
      provider.execAnswer = () => ({ stdout: `${answers[action] ?? ''}\n` });
      return exec(ref, command);
    });
    resetSignInsSweepForTests();
  });

  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('putting it away when a running job is paused', () => {
    it('puts away the browser of the job just paused from running, as root, on its own Brick’s machine, and lets go of the claim', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toEqual({ state: 'parked', reason: null, cookies: 4, pages: 2 });
      expect(sent).toEqual([{ action: 'park', job: visa.id, keep: [visa.id], user: 'root' }]);
      expect(provider.commands[0].ref).toBe(`fake-${sara.brickId}`);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
    });

    it('does nothing for a job of another Brick, a job that is not paused, or a job paused while it waited in line', async () => {
      const sara = await person('Sara');
      const omar = await person('Omar');
      await machine(sara.brickId);
      await machine(omar.brickId);
      const omars = await job(omar, { pausedMinutesAgo: 0 });
      expect(await parkProfile(sara.brickId, omars.id, NOW)).toMatchObject({ state: 'left', reason: 'not_this_brick' });
      const running = await job(sara, { status: 'running', pausedMinutesAgo: null });
      expect(await parkProfile(sara.brickId, running.id, NOW)).toMatchObject({ state: 'left', reason: 'not_paused' });
      // Paused while still in line: it never had the browser, and parking would take the browser of the job that is on the machine
      const inLine = await job(sara, { pausedMinutesAgo: null });
      expect(await parkProfile(sara.brickId, inLine.id, NOW)).toMatchObject({ state: 'left', reason: 'not_on_machine' });
      // Paused from running long ago, resumed, then paused again in line: not on the machine now either
      const longAgo = await job(sara, { pausedMinutesAgo: 30 });
      expect(await parkProfile(sara.brickId, longAgo.id, NOW)).toMatchObject({ state: 'left', reason: 'not_on_machine' });
      expect(sent).toEqual([]);
    });

    it('never wakes a machine that is not awake', async () => {
      const sara = await person('Sara');
      for (const state of ['resting', 'stopped', 'cold', 'packing', 'none']) {
        await machine(sara.brickId, state);
        const visa = await job(sara, { pausedMinutesAgo: 0 });
        expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'left', reason: 'not_awake' });
      }
      expect(sent).toEqual([]);
    });

    it('a writer paused while a job that only looks stays on the machine: the shared browser is emptied, nothing of it is kept', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      await job(sara, { status: 'running', writes: false });
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'cleared', reason: 'shared' });
      expect(sent.map((one) => one.action)).toEqual(['clear']);
    });

    it('a job that only looked, paused beside a writer still at work: the browser is the writer’s and is left alone', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      await job(sara, { status: 'running', writes: true });
      const look = await job(sara, { pausedMinutesAgo: 0, writes: false });
      expect(await parkProfile(sara.brickId, look.id, NOW)).toMatchObject({ state: 'left', reason: 'shared' });
      expect(sent).toEqual([]);
    });

    it('waits while the browser is being cleared after another job, then puts this one away', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      const cleanup = new Date();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { cleanClaimedAt: cleanup } });
      // (a Prisma query runs only once it is awaited or then-ed)
      setTimeout(() => prisma.brickComputer.updateMany({ where: { botId: sara.brickId, cleanClaimedAt: cleanup }, data: { cleanClaimedAt: null } }).then(() => undefined), 600);
      const started = Date.now();
      expect((await parkProfile(sara.brickId, visa.id, NOW)).state).toBe('parked');
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    });

    it('a machine that does not answer, or answers with anything but its own line, is a failure and never throws', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      answers.park = 'parked=0 reason=browser_running';
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'failed', reason: 'browser_running' });
      answers.park = 'something else';
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'failed' });
      provider.failExec = true;
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'failed', reason: 'unreachable' });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
    });
  });

  describe('bringing it back when the job carries on', () => {
    it('gives the resumed job its own browser back, on its own Brick, as root', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 60 });
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toEqual({ state: 'restored', reason: null, cookies: 4, pages: 2 });
      expect(sent).toEqual([{ action: 'restore', job: visa.id, keep: [visa.id], user: 'root' }]);
    });

    it('nothing of its own was kept: it gets an empty browser, and is told so (fresh: sign in again)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 60 });
      answers.restore = 'restored=0 reason=none';
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'none' });
    });

    it('kept longer than the Limits say: it is dropped first, and the job gets an empty browser', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 25 * 60 });
      answers.restore = 'restored=0 reason=none';
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'expired' });
      expect(sent.map((one) => [one.action, one.job])).toEqual([['drop', visa.id], ['restore', visa.id]]);
      expect(sent[1].keep).not.toContain(visa.id);
    });

    it('the Limits value is the super admin’s: kept for 2 hours, a job paused 3 hours ago starts fresh', async () => {
      await saveServerLimits({ bricks: { pausedSignInsHours: 2 } }, 'admin');
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 180 });
      answers.restore = 'restored=0 reason=none';
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'expired' });
      expect(sent[0].action).toBe('drop');
    });

    it('a job whose person no longer owns the Brick never gets the kept browser back', async () => {
      const sara = await person('Sara');
      const omar = await person('Omar');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 10 });
      await prisma.bot.update({ where: { id: sara.brickId }, data: { ownerId: omar.id } });
      answers.restore = 'restored=0 reason=none';
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'owner' });
      expect(sent.map((one) => one.action)).toEqual(['drop', 'restore']);
      await prisma.bot.update({ where: { id: sara.brickId }, data: { ownerId: sara.id } });
    });

    it('another job on the machine: the kept browser is dropped, never shown to it, and the browser it uses is left alone', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      await job(sara, { status: 'running', writes: false });
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 10 });
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'shared' });
      expect(sent.map((one) => one.action)).toEqual(['drop']);
    });

    it('does nothing for a job of another Brick, a job that is not running, or on a machine that is not awake', async () => {
      const sara = await person('Sara');
      const omar = await person('Omar');
      await machine(sara.brickId);
      const omars = await job(omar, { status: 'running', pausedMinutesAgo: 5 });
      expect(await restoreProfile(sara.brickId, omars.id, NOW)).toMatchObject({ state: 'left', reason: 'not_this_brick' });
      const paused = await job(sara, { pausedMinutesAgo: 5 });
      expect(await restoreProfile(sara.brickId, paused.id, NOW)).toMatchObject({ state: 'left', reason: 'not_running' });
      const ended = await job(sara, { status: 'stopped', queuedFor: null, pausedMinutesAgo: 5 });
      expect(await restoreProfile(sara.brickId, ended.id, NOW)).toMatchObject({ state: 'left', reason: 'not_running' });
      await machine(sara.brickId, 'resting');
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'left', reason: 'not_awake' });
      expect(sent).toEqual([]);
    });
  });

  describe('throwing it away', () => {
    it('drops the job’s kept browser, keeping only the other jobs of this Brick still allowed one', async () => {
      const sara = await person('Sara');
      const omar = await person('Omar');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'stopped', queuedFor: null, pausedMinutesAgo: 5 });
      const hotel = await job(sara, { pausedMinutesAgo: 5 });
      const resumed = await job(sara, { status: 'running', pausedMinutesAgo: 30 });
      const tooLong = await job(sara, { pausedMinutesAgo: 25 * 60 });
      const neverPaused = await job(sara, { pausedMinutesAgo: null });
      const omars = await job(omar, { pausedMinutesAgo: 5 });
      expect(await dropProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'dropped' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ action: 'drop', job: visa.id, user: 'root' });
      expect(sent[0].keep.sort()).toEqual([hotel.id, resumed.id].sort());
      for (const gone of [visa.id, tooLong.id, neverPaused.id, omars.id]) expect(sent[0].keep).not.toContain(gone);
    });

    it('a job that is cancelled while paused is never in the list it is dropped with', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 5 });
      await dropProfile(sara.brickId, visa.id, NOW);
      expect(sent[0].keep).not.toContain(visa.id);
    });

    it('leaves a machine that is not awake alone, and never throws', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId, 'resting');
      const visa = await job(sara, { pausedMinutesAgo: 5 });
      expect(await dropProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'left', reason: 'not_awake' });
      await machine(sara.brickId);
      provider.failExec = true;
      expect(await dropProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'failed' });
      expect(await dropProfile(sara.brickId, 'not an id; rm -rf /', NOW)).toMatchObject({ state: 'left', reason: 'not_a_job' });
    });
  });

  describe('the sweep', () => {
    it('removes, on awake machines only, what was kept longer than the Limits say, once an hour per machine', async () => {
      const sara = await person('Sara');
      const omar = await person('Omar');
      const lina = await person('Lina');
      await machine(sara.brickId);
      await machine(omar.brickId, 'resting');
      await machine(lina.brickId);
      const old = await job(sara, { pausedMinutesAgo: 25 * 60 });
      const fresh = await job(sara, { pausedMinutesAgo: 30 });
      await job(omar, { pausedMinutesAgo: 25 * 60 });
      await job(lina, { pausedMinutesAgo: 60 });
      expect(await sweepPausedSignIns(NOW)).toEqual({ looked: 1, pruned: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ action: 'prune', user: 'root' });
      expect(sent[0].keep).toEqual([fresh.id]);
      expect(sent[0].keep).not.toContain(old.id);
      // Asked again within the hour: the machine is not asked again
      expect(await sweepPausedSignIns(minutes(5))).toEqual({ looked: 0, pruned: 0 });
      expect(await sweepPausedSignIns(minutes(61))).toEqual({ looked: 1, pruned: 1 });
    });
  });
});
