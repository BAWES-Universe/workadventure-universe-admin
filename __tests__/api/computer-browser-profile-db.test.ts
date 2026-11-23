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
import { dropProfile, finishPendingParks, parkProfile, recoverResumedBrowsers, resetSignInsSweepForTests, restoreProfile, settleResumedBrowser, sweepPausedSignIns, wipeLiveProfile } from '@/lib/computer-browser-profile';

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

  describe('GPT round 6, finding 7: a job that carried on is not worked on until its browser is settled', () => {
    const prepOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { prepState: true } });

    it('its own browser back: ready at once, and nothing is emptied', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'restored' });
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      expect(sent.map((one) => one.action)).toEqual(['restore']);
    });

    it('nothing of its own kept: the live browser is emptied and PROVED empty before the job is ready', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      answers.restore = 'restored=0 reason=none';
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'fresh', reason: 'none' });
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      // Emptied, as root, for this job: a clean browser the job signs in to again is valid; one whose state we cannot tell is not
      expect(sent.map((one) => one.action)).toEqual(['restore', 'clear']);
      expect(sent[1]).toMatchObject({ action: 'clear', job: visa.id, user: 'root' });
    });

    it('the emptying fails: the job stays `recover`, so nothing runs it, and the sweep puts it right', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      answers.restore = 'restored=0 reason=none';
      answers.clear = 'failed=1 reason=busy';
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('recover');
      expect(await prepOf(visa.id)).toEqual({ prepState: 'recover' });
      // The sweep tries the restore again; this time the machine does it, and only then is the job ready
      sent = [];
      answers.restore = 'restored=1 cookies=2 pages=1';
      expect(await recoverResumedBrowsers(minutes(1))).toEqual({ looked: 1, ready: 1 });
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      expect(sent.map((one) => one.action)).toEqual(['restore']);
    });

    it('a restore the machine would not do leaves it `recover`: it is NEVER made runnable on a browser whose state is unknown', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      answers.restore = 'failed=1 reason=busy';
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'failed' });
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('recover');
      expect(await prepOf(visa.id)).toEqual({ prepState: 'recover' });
      // The failure is not turned into an emptying of its own accord: the browser may hold what the job itself left
      expect(sent.map((one) => one.action)).toEqual(['restore']);
      // The sweep keeps it `recover` while the machine keeps refusing: never ready on an unknown answer
      expect(await recoverResumedBrowsers(minutes(1))).toEqual({ looked: 1, ready: 0 });
      expect(await prepOf(visa.id)).toEqual({ prepState: 'recover' });
    });

    it('past the hours sign-ins are kept the sweep empties instead of restoring: a clean browser, proved clean, makes the job ready', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      await saveServerLimits({ bricks: { pausedSignInsHours: 1 } }, 'admin');
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 * 60 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover' } });
      expect(await recoverResumedBrowsers(NOW)).toEqual({ looked: 1, ready: 1 });
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      // Nothing of its own is left to bring back, so no restore is even asked for: the live browser is emptied
      expect(sent.map((one) => one.action)).toEqual(['clear']);
    });

    it('a browser SHARED with a job that is on the machine is left exactly as it is, and the resumed job is ready', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const looker = await job(sara, { status: 'running', writes: false, pausedMinutesAgo: null });
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'fresh', reason: 'shared' });
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      // Its own kept browser is thrown away (it is never shown beside another job's), and the SHARED live browser is not emptied under the job that is using it
      expect(sent.map((one) => one.action)).toEqual(['drop']);
      expect(looker.id).not.toBe(visa.id);
    });

    it('a try that died while bringing the browser back leaves the job `restoring`: the sweep takes it over once no try can still be working on it, and never before', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring', startedAt: NOW } });
      // A try that started moments ago may still be in its restore: it is not cut across
      expect(await recoverResumedBrowsers(minutes(1))).toEqual({ looked: 0, ready: 0 });
      expect(await prepOf(visa.id)).toEqual({ prepState: 'restoring' });
      expect(sent).toEqual([]);
      // Past the longest one command may take, no try is still working on it: the sweep settles the browser and the job can be worked on again
      expect(await recoverResumedBrowsers(minutes(6))).toEqual({ looked: 1, ready: 1 });
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      expect(sent.map((one) => one.action)).toEqual(['restore']);
    });

    it('a park nobody finished: the sweep finishes it, and the machine stops waiting', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      // The pause committed and the server stopped before the park ran: the machine carries the job's id
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 1, wiped: 0 });
      expect(sent.map((one) => one.action)).toEqual(['park']);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: null });
    });

    it('a park the machine will not do: the live browser is emptied instead, so the next job on that machine never finds those sign-ins', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.park = 'failed=1 reason=busy';
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 0, wiped: 1 });
      expect(sent.map((one) => one.action)).toEqual(['park', 'clear']);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: null });
    });

    it('a park that could be neither done nor emptied keeps the machine waiting: nothing else starts there until it is settled', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.park = 'failed=1 reason=busy';
      answers.clear = 'failed=1 reason=busy';
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 0, wiped: 0 });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: visa.id });
    });

    it('throwing the browser away (an ending, a cancel) lets the machine go at once: the jobs behind it do not wait for a sweep', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      expect(await dropProfile(sara.brickId, visa.id, minutes(1))).toMatchObject({ state: 'dropped' });
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true } })).toEqual({ parkPendingJobId: null });
    });

    it('emptying the live browser needs the cleanup claim and lets go of it, and does nothing on a machine that is not awake', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      expect(await wipeLiveProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'cleared' });
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
      await machine(sara.brickId, 'resting');
      expect(await wipeLiveProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'left', reason: 'not_awake' });
      expect(await wipeLiveProfile(sara.brickId, 'not an id; rm -rf /', NOW)).toMatchObject({ state: 'left', reason: 'not_a_job' });
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
