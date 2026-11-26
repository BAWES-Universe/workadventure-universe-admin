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
import { isMarkCommand } from '@/lib/computer-fence-script';
import { FakeComputerProvider, setComputerProviderForTests, type ExecOptions } from '@/lib/computer-provider';
import { clearParkPending, dropProfile, finishParkOf, finishPendingParks, resetPendingCursorForTests, resetRecoveryCursorForTests, needsSignInAgain, parkProfile, parkWorthWaitingFor, recoverResumedBrowsers, resetSignInsSweepForTests, restoreProfile, settlePark, settleResumedBrowser, signInsKept, sweepPausedSignIns, wipeLiveProfile } from '@/lib/computer-browser-profile';

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
  /** The machine the command went to, as the pretend provider names it: `fake-<botId>`. */
  ref: string;
  job: string;
  keep: string[];
  user: string | undefined;
}
let sent: Sent[] = [];
/** The pause number each command carried ("action:number"), kept apart from `sent` (N29). */
let numbers: string[] = [];
/** What the pretend machine answers for each action (the command's own answer line). */
let answers: Record<string, string> = {};
/** Run when the machine is sent a command, before it answers: a test uses it to let something else happen WHILE the command runs. */
let during: ((action: string) => Promise<void>) | null = null;

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
    numbers = [];
    during = null;
    answers = { park: 'parked=1 cookies=4 pages=2', restore: 'restored=1 cookies=4 pages=2', drop: 'dropped=1', clear: 'cleared=1', prune: 'pruned=1', commit: 'committed=1' };
    const exec = provider.exec.bind(provider);
    jest.spyOn(provider, 'exec').mockImplementation(async (ref: string, command: string, options?: ExecOptions) => {
      // The parts the fence keeps are read again after a command that restarts the browser: that is not one of the sign-ins commands this file counts
      if (isMarkCommand(command)) {
        provider.execAnswer = () => ({});
        return exec(ref, command);
      }
      const action = /ACTION="([a-z]+)"/.exec(command)?.[1] ?? '?';
      sent.push({ action, ref, job: /JOB="([^"]*)"/.exec(command)?.[1] ?? '', keep: (/KEEP="([^"]*)"/.exec(command)?.[1] ?? '').split(' ').filter(Boolean), user: options?.user });
      numbers.push(`${action}:${/GEN="([^"]*)"/.exec(command)?.[1] ?? '?'}`);
      provider.execAnswer = () => ({ stdout: `${answers[action] ?? ''}\n` });
      if (during) await during(action);
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
      expect(sent).toEqual([{ action: 'park', ref: `fake-${sara.brickId}`, job: visa.id, keep: [visa.id], user: 'root' }]);
      expect(provider.commands[0].ref).toBe(`fake-${sara.brickId}`);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
    });

    it('reads the computer’s own parts again after a command that starts a browser (park), saves them for the fence, and not after a command that starts none (drop)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const mark = provider.markOf(`fake-${sara.brickId}`);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { markBootId: mark.bootId, markTicks: BigInt(500), markParts: [], markRunners: [] } });
      provider.parts = [{ pid: 61, start: 7000, kind: 'part' }];
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      expect(await parkProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'parked' });
      const row = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
      expect(row.markParts).toEqual([{ pid: 61, start: 7000, kind: 'part' }]);
      // the clock reading is the first one: only the list moves
      expect(row.markTicks).toBe(BigInt(500));
      expect(provider.commands.filter((entry) => isMarkCommand(entry.command))).toHaveLength(1);
      // A drop starts no browser: nothing is read
      provider.commands.length = 0;
      provider.parts = [];
      await dropProfile(sara.brickId, visa.id, NOW);
      expect(provider.commands.filter((entry) => isMarkCommand(entry.command))).toHaveLength(0);
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).markParts).toEqual([{ pid: 61, start: 7000, kind: 'part' }]);
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

    it('F: a job paused beside a job still at work puts nothing away and empties nothing: it keeps nothing, and the wipe is left for the moment none is on the machine', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const working = await job(sara, { status: 'running', writes: false });
      const look = await job(sara, { pausedMinutesAgo: 0, writes: false });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: look.id } });
      expect(await parkProfile(sara.brickId, look.id, NOW)).toMatchObject({ state: 'left', reason: 'wipe_later' });
      expect(sent).toEqual([]);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: look.id, parkPendingWipe: true });
      expect((await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId: look.id, n: 1 } } })).signInsKept).toBe(false);
      // The settlement while the other job still works changes nothing: no command, the marker and the wipe stay
      expect(await settlePark(sara.brickId, look.id, await parkProfile(sara.brickId, look.id, NOW), NOW)).toBe('waiting');
      expect(await finishParkOf(sara.brickId, look.id, NOW)).toBe('waiting');
      expect(sent).toEqual([]);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: look.id, parkPendingWipe: true });
      // The last job ends: the browser is emptied once, and the marker and the wipe are let go
      await prisma.computerJob.update({ where: { id: working.id }, data: { status: 'done', queuedFor: null } });
      expect(await finishParkOf(sara.brickId, look.id, NOW)).toBe('wiped');
      expect(sent.map((one) => one.action)).toEqual(['clear']);
      expect(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId }, select: { parkPendingJobId: true, parkPendingWipe: true } })).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
    });

    it('waits while the browser is being cleared after another job, then puts this one away', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      const cleanup = new Date();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { cleanClaimedAt: cleanup } });
      const release = () => prisma.brickComputer.updateMany({ where: { botId: sara.brickId, cleanClaimedAt: cleanup }, data: { cleanClaimedAt: null } });
      let parking: ReturnType<typeof parkProfile> | undefined;
      let failing = false;
      try {
        parking = parkProfile(sara.brickId, visa.id, NOW);
        // Held, the claim keeps every command off the machine: nothing is sent while it is held, however long the park has been looking (CodeRabbit on #1025)
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(sent).toEqual([]);
      } catch (error) {
        failing = true;
        throw error;
      } finally {
        // Released in every case (a failed check above included), and the park is joined on BOTH paths, so it never sends a command into the next test; a failure of the release itself does not hide the first failure (CodeRabbit on #1025, 47)
        const released = await Promise.allSettled([release()]);
        const joined = await Promise.allSettled(parking ? [parking] : []);
        for (const one of [...released, ...joined]) if (one.status === 'rejected' && !failing) throw one.reason;
      }
      expect((await parking).state).toBe('parked');
      expect(sent.map((one) => one.action)).toEqual(['park']);
    });

    it('CodeRabbit on #1025: a machine that had nothing to put away is not "kept", the machine waits for nothing, and the pause says the sign-ins are not kept', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      answers.park = 'parked=0 reason=nothing';
      const parked = await parkProfile(sara.brickId, visa.id, NOW);
      expect(parked).toMatchObject({ state: 'left', reason: 'nothing_saved' });
      expect(signInsKept(parked)).toBe(false);
      expect(await settlePark(sara.brickId, visa.id, parked, NOW)).toBe('settled');
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
      expect(sent).toEqual([{ action: 'restore', ref: `fake-${sara.brickId}`, job: visa.id, keep: [visa.id], user: 'root' }]);
    });

    it('nothing of its own was kept: the answer is `fresh`, which `needsSignInAgain` reads as a job that must sign in again (the words themselves are not told yet)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 60 });
      answers.restore = 'restored=0 reason=none';
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'fresh', reason: 'none' });
      // Only the helper is checked here, and the title says so: nothing tells the person these words yet, because a telling of their own needs a
      // new kind (a migration and words the game shows). CodeRabbit N (review body, lib/computer-browser-profile.ts:204) asked for the test to say
      // what it really checks until that telling exists. What the resume path DOES act on is whether the job may run at all (GPT round 6, finding 7)
      expect(needsSignInAgain(back)).toBe(true);
      expect(needsSignInAgain({ state: 'restored', reason: null, cookies: 1, pages: 1 })).toBe(false);
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

    it('another job on the machine: nothing is brought back and the shared browser is left alone, and the kept browser is LEFT WHERE IT IS (it is the person’s, and this job is allowed it)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      await job(sara, { status: 'running', writes: false });
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 10 });
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'shared' });
      // Nothing is run on the machine at all: the job that is on it keeps its browser, and this job keeps its park for when it has the machine to itself (GPT round 6, finding 7)
      expect(sent).toEqual([]);
      // ...and a job whose park it is still allowed waits for the machine instead of coming here at all
      expect(await parkWorthWaitingFor(sara.brickId, visa.id, NOW)).toBe(true);
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
      expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
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
      expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
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
      // Nothing is run on the machine: the SHARED live browser is not emptied under the job using it, and this job's own park is not thrown away to let it run in that browser
      expect(sent).toEqual([]);
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
      // Past the longest one command may take, no try is still working on it. What that try left is an UNKNOWN result, so the sweep never reads it as ready: it writes `recover` and runs
      // nothing on the machine on this pass
      expect(await recoverResumedBrowsers(minutes(6))).toEqual({ looked: 1, ready: 0 });
      expect(await prepOf(visa.id)).toEqual({ prepState: 'recover' });
      expect(sent).toEqual([]);
      // The recover path then settles it, the same way as any other: the restore is tried and the job can be worked on again
      expect(await recoverResumedBrowsers(minutes(7))).toEqual({ looked: 1, ready: 1 });
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
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

    const markOf = async (botId: string) => prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { parkPendingJobId: true, parkPendingWipe: true } });

    it('CodeRabbit on #1025: a pause that is OLD (the park cannot say it was on the machine) is never released without proof: the live browser is emptied first, and the marker stays if that fails', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 30 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.clear = 'failed=1 reason=busy';
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 0, wiped: 0 });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBe(visa.id);
      expect(sent.map((one) => one.action)).toEqual(['clear']);
      answers.clear = 'cleared=1';
      expect(await finishPendingParks(minutes(2))).toEqual({ looked: 1, parked: 0, wiped: 1 });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBeNull();
    });

    it('a pause that found nothing to put away, or a park that was already made, lets the marker go with no wipe; a browser a job beside uses is left alone, and emptied once that job is over (F)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.park = 'parked=0 reason=nothing';
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 1, wiped: 0 });
      expect(sent.map((one) => one.action)).toEqual(['park']);
      // The pause's row says it kept nothing: the job has no browser of its own to wait for
      expect((await prisma.computerJobPause.findFirstOrThrow({ where: { jobId: visa.id } })).signInsKept).toBe(false);
      expect(await parkWorthWaitingFor(sara.brickId, visa.id, NOW)).toBe(false);
      // A job running beside it uses the browser: it is not emptied under it, the marker (and the wipe it carries) stays, and the machine holds every other job until then
      const omar = await person('Omar');
      await machine(omar.brickId);
      const gone = await job(omar, { pausedMinutesAgo: 30 });
      const beside = await job(omar, { status: 'running', pausedMinutesAgo: null, writes: false });
      await prisma.brickComputer.update({ where: { botId: omar.brickId }, data: { parkPendingJobId: gone.id } });
      sent = [];
      expect(await finishPendingParks(minutes(1))).toMatchObject({ looked: 1, wiped: 0 });
      expect(sent.map((one) => one.action)).not.toContain('clear');
      expect((await markOf(omar.brickId)).parkPendingJobId).toBe(gone.id);
      // The job beside is over: the browser is emptied, once, and the marker goes
      await prisma.computerJob.update({ where: { id: beside.id }, data: { status: 'done', queuedFor: null } });
      expect(await finishPendingParks(minutes(2))).toMatchObject({ looked: 1, wiped: 1 });
      expect(sent.map((one) => one.action).filter((action) => action === 'clear')).toHaveLength(1);
      expect((await markOf(omar.brickId)).parkPendingJobId).toBeNull();
    });

    it('two pauses that left their marks together: the browser is emptied, never put away under either name', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const writer = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: writer.id, parkPendingWipe: true } });
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 0, wiped: 1 });
      expect(sent.map((one) => one.action)).toEqual(['clear']);
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
    });

    it('Opus on slice 1 (S1-a): the SECOND job of a two-pause command settling FIRST never parks the shared browser under its own name: only a clear is sent, the pointer and flag go, and its resume finds nothing kept', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const writer = await job(sara, { pausedMinutesAgo: 0 });
      const looker = await job(sara, { pausedMinutesAgo: 0, writes: false });
      // The writer's pause set the pointer and the flag; the looker's pause found the pointer taken and set the flag
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: writer.id, parkPendingWipe: true } });
      expect(await parkProfile(sara.brickId, looker.id, minutes(1))).toMatchObject({ state: 'left', reason: 'wipe_pending' });
      expect(sent).toEqual([]);
      expect(await settlePark(sara.brickId, looker.id, { state: 'left', reason: 'wipe_pending', cookies: 0, pages: 0 }, minutes(1))).toBe('wiped');
      expect(sent.map((one) => one.action)).toEqual(['clear']);
      // The pointer stands on the writer until the writer's own settle (nothing starts before it)
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: writer.id, parkPendingWipe: true });
      expect(await parkWorthWaitingFor(sara.brickId, looker.id, NOW)).toBe(false);
      // The writer's settle then also only clears: the pointer and flag go, and it has no browser of its own to wait for either
      expect(await parkProfile(sara.brickId, writer.id, minutes(1))).toMatchObject({ state: 'left', reason: 'wipe_pending' });
      expect(await settlePark(sara.brickId, writer.id, { state: 'left', reason: 'wipe_pending', cookies: 0, pages: 0 }, minutes(1))).toBe('wiped');
      expect(sent.map((one) => one.action)).toEqual(['clear', 'clear']);
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
      expect(await parkWorthWaitingFor(sara.brickId, writer.id, NOW)).toBe(false);
    });

    it('a job that is on the machine again owns the live browser: its stale marker goes with no wipe', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      expect(await finishPendingParks(minutes(1))).toEqual({ looked: 1, parked: 1, wiped: 0 });
      expect(sent).toEqual([]);
    });

    it('machines that keep failing never hold up a healthy one behind them: the sweep goes on past them, and starts again at the end', async () => {
      resetPendingCursorForTests();
      const bricks: string[] = [];
      for (let i = 0; i < 4; i++) {
        const who = await person(`Cursor${i}`);
        await machine(who.brickId);
        const visa = await job(who, { pausedMinutesAgo: 0 });
        await prisma.brickComputer.update({ where: { botId: who.brickId }, data: { parkPendingJobId: visa.id } });
        bricks.push(who.brickId);
      }
      bricks.sort();
      answers.park = 'failed=1 reason=busy';
      answers.clear = 'failed=1 reason=busy';
      expect(await finishPendingParks(minutes(1), 2)).toEqual({ looked: 2, parked: 0, wiped: 0 });
      const first = sent.map((one) => one.ref);
      sent = [];
      answers.clear = 'cleared=1';
      expect(await finishPendingParks(minutes(2), 2)).toEqual({ looked: 2, parked: 0, wiped: 2 });
      // The second pass reached the other two Bricks, not the same two again
      expect(new Set([...first, ...sent.map((one) => one.ref)]).size).toBe(4);
      // The cursor is NOT reset here (CodeRabbit C24): the end-of-scan pass finds nothing after the last Brick, looks at none, and sends the cursor back to the start
      sent = [];
      answers.clear = 'cleared=1';
      expect(await finishPendingParks(minutes(3), 2)).toEqual({ looked: 0, parked: 0, wiped: 0 });
      expect(sent).toEqual([]);
      // The next sweep, with no reset, revisits the markers the first pass left (a cursor that moved on correctly but never wrapped would look at none for ever)
      expect(await finishPendingParks(minutes(4), 2)).toEqual({ looked: 2, parked: 0, wiped: 2 });
      expect(new Set(sent.map((one) => one.ref))).toEqual(new Set(first));
      resetPendingCursorForTests();
    });

    it('throwing the browser away (an ending, a cancel) lets the machine go only once the LIVE browser is proved empty', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.clear = 'failed=1 reason=busy';
      expect(await dropProfile(sara.brickId, visa.id, minutes(1))).toMatchObject({ state: 'dropped' });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBe(visa.id);
      answers.clear = 'cleared=1';
      expect(await dropProfile(sara.brickId, visa.id, minutes(2))).toMatchObject({ state: 'dropped' });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBeNull();
    });

    it('recovery goes on past jobs whose commands keep failing, in a stable order, and a late second attempt never undoes a settled job', async () => {
      resetRecoveryCursorForTests();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const who = await person(`Recover${i}`);
        await machine(who.brickId);
        const visa = await job(who, { status: 'running', pausedMinutesAgo: 5 });
        await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover' } });
        ids.push(visa.id);
      }
      answers.restore = 'failed=1 reason=busy';
      expect(await recoverResumedBrowsers(minutes(7), 2)).toEqual({ looked: 2, ready: 0 });
      answers.restore = 'restored=1 cookies=1 pages=1';
      expect(await recoverResumedBrowsers(minutes(8), 2)).toEqual({ looked: 1, ready: 1 });
      resetRecoveryCursorForTests();
      // A late attempt that read `recover` finds the job already settled: it writes nothing
      const settled = ids.sort()[0];
      await prisma.computerJob.update({ where: { id: settled }, data: { prepState: null } });
      const late = await settleResumedBrowser(settled, (await prisma.computerJob.findUniqueOrThrow({ where: { id: settled } })).botId, { state: 'failed', reason: 'busy', cookies: 0, pages: 0 }, minutes(9), undefined, 'recover');
      expect(late).toBe('recover');
      expect(await prepOf(settled)).toEqual({ prepState: null });
    });

    it('an expired recovery leaves a browser that a running sibling uses exactly as it is, and the job is ready', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 30 * 60 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover' } });
      await job(sara, { status: 'running', pausedMinutesAgo: null, writes: false });
      resetRecoveryCursorForTests();
      expect(await recoverResumedBrowsers(minutes(7))).toEqual({ looked: 1, ready: 1 });
      expect(sent.map((one) => one.action)).not.toContain('clear');
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
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

  describe('CodeRabbit pass on #1025 (A5, A6, A7, A8, A9, B/C19): the races between a pause, a restore and a settlement', () => {
    const prepOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { prepState: true } });
    const markOf = (botId: string) => prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { parkPendingJobId: true, parkPendingWipe: true } });
    const keptOf = async (jobId: string) => (await prisma.computerJobPause.findMany({ where: { jobId }, orderBy: { n: 'asc' }, select: { n: true, signInsKept: true } })).map((one) => [one.n, one.signInsKept]);

    /** The checkpoints' own deadline: shorter than jest's default test timeout (10 s), so a wrong fixture fails with the checkpoint's own message, never with the timeout's (CodeRabbit on #1025, 14c4e407 pass, N7). */
    const CHECKPOINT_MS = 8_000;

    /** A poll bounded by the checkpoint's own deadline, whatever the database does: a query that waits for a connection or stalls rejects with the checkpoint's own message when the time is up, never later (CodeRabbit on #1025, d522f4b3 pass, N7). */
    function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(what)), Math.max(1, ms));
        work.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    }

    /**
     * What a lock checkpoint of these tests is about: the exact fixture transaction (the backend that holds the rows), the exact requests that must be waiting for it, and nothing else. A checkpoint that counted every lock wait in the
     * database could be satisfied by an unrelated session while the request under test had not reached its wait at all. `running` are the requests being waited for: one that ends before it is blocked fails the checkpoint at once, and the poll
     * has a ceiling, so a wrong fixture rejects instead of hanging.
     */
    async function waitUntilBlockedBy(holderPid: number, count: number, ...running: Array<Promise<unknown>>) {
      let over = false;
      // The poll's waits end the moment it is stopped (a watched request that exits early), so a cleanup never waits for a query or a sleep to run out (CodeRabbit on #1025, 14c4e407 pass, N4)
      let stop: () => void = () => undefined;
      const stopped = new Promise<null>((resolve) => (stop = () => resolve(null)));
      const poll = (async () => {
        const end = Date.now() + CHECKPOINT_MS;
        for (;;) {
          // Waiting for the holder, directly or behind another waiter for the same row (a second waiter queues behind the first one, and Postgres names the first one as its blocker)
          if (over) return;
          const query = within(prisma.$queryRaw<{ n: number }[]>`
            WITH RECURSIVE waiting(pid) AS (
              SELECT a.pid FROM pg_stat_activity a WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND ${holderPid}::int = ANY (pg_blocking_pids(a.pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid)) WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
            )
            SELECT count(*)::int AS n FROM waiting`, end - Date.now(), `Timed out waiting for ${count} statement(s) to be blocked by backend ${holderPid}`);
          // A query still running when the poll is stopped is let go: its late answer or error is handled here, never left unhandled
          query.catch(() => undefined);
          const rows = await Promise.race([query, stopped]);
          if (rows === null) return;
          if (rows[0].n >= count) return;
          if (over) return;
          if (Date.now() > end) throw new Error(`Timed out waiting for ${count} statement(s) to be blocked by backend ${holderPid}`);
          await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), stopped]);
        }
      })();
      try {
        await Promise.race([poll, ...running.map((one) => one.then(() => { throw new Error('A request ended before it was blocked by the fixture transaction'); }))]);
      } finally {
        over = true;
        stop();
        await poll.catch(() => undefined);
      }
    }

    /** Polls `check` until it holds, for at most ten seconds, and fails at once when one of the requests being waited for ends first. */
    async function boundedUntil(check: () => boolean, what: string, ...running: Array<Promise<unknown>>) {
      const end = Date.now() + CHECKPOINT_MS;
      let over = false;
      const poll = (async () => {
        while (!check() && !over) {
          if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      try {
        await Promise.race([poll, ...running.map((one) => one.then(() => { throw new Error(`A request ended before ${what}`); }))]);
      } finally {
        over = true;
        await poll.catch(() => undefined);
      }
    }

    /** Waits for a fixture transaction to say it is in place, and fails at once (with the transaction's own error) when the transaction ends first. */
    const reached = <T>(signal: Promise<T>, tx: Promise<unknown>): Promise<T> => Promise.race([signal, tx.then(() => { throw new Error('The fixture transaction ended before it reached its checkpoint'); })]);

    /**
     * Holds the Brick's machine row (and runs `inside` in the same open transaction) until `release` is called, so whatever claims the machine meanwhile is shown waiting for that row in pg_stat_activity: a test stands at the exact wait
     * it means to test (`pid` is the backend that holds it: see `waitUntilBlockedBy`). `release` is safe to call twice, and the transaction is joined on every path.
     */
    async function holdMachineRow(botId: string, inside: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>) {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held: (pid: number) => void = () => undefined;
      const open = new Promise<number>((resolve) => (held = resolve));
      const tx = prisma.$transaction(
        async (inner) => {
          const [{ pid }] = await inner.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          await inner.$queryRaw`SELECT 1 FROM "brick_computers" WHERE "bot_id" = ${botId} FOR UPDATE`;
          await inner.$queryRaw`SELECT 1 FROM "computer_jobs" WHERE "bot_id" = ${botId} FOR UPDATE`;
          await inside(inner);
          held(pid);
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      tx.catch(() => undefined);
      const pid = await reached(open, tx);
      return { pid, release, done: async () => { release(); await tx; } };
    }

    it('A5: a second pause that commits after the park read the wipe flag and before the claim counted the jobs beside is seen: nothing is put away under the first job’s name', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const first = await job(sara, { pausedMinutesAgo: 0 });
      const second = await job(sara, { status: 'running', pausedMinutesAgo: null, writes: false });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: first.id } });
      // The second pause: it writes the flag and leaves the held states in one commit, and has not committed yet
      const pause = await holdMachineRow(sara.brickId, async (tx) => {
        await tx.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingWipe: true } });
        await tx.computerJob.update({ where: { id: second.id }, data: { status: 'queued', queuedFor: 'paused', pauses: 1, pausedAt: NOW } });
      });
      let parking: ReturnType<typeof parkProfile> | undefined;
      try {
        // The park reads the flag (not set: the pause has not committed) and then stands at the claim, waiting for the machine row the pause holds
        parking = parkProfile(sara.brickId, first.id, NOW);
        await waitUntilBlockedBy(pause.pid, 1, parking);
        await pause.done();
        // The pause committed. The jobs beside are now none, and the flag is set: the park is refused, and no command is sent
        expect(await parking).toMatchObject({ state: 'left', reason: 'wipe_pending' });
        expect(sent).toEqual([]);
      } finally {
        await Promise.allSettled([pause.done(), ...(parking ? [parking] : [])]);
      }
      // Control: with no flag the same park goes through
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingWipe: false } });
      expect(await parkProfile(sara.brickId, first.id, NOW)).toMatchObject({ state: 'parked' });
      expect(sent.map((one) => one.action)).toEqual(['park']);
    });

    it('A6: a recovery attempt holding a `fresh` result does not empty the browser of a job that another attempt made ready while it waited for the claim', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', reservationKey: 'room-1' } });
      // The faster attempt settles the job (ready) in the very commit that lets the claim go
      const faster = await holdMachineRow(sara.brickId, async (tx) => {
        await tx.computerJob.update({ where: { id: visa.id }, data: { prepState: null } });
      });
      let late: ReturnType<typeof settleResumedBrowser> | undefined;
      try {
        late = settleResumedBrowser(visa.id, sara.brickId, { state: 'fresh', reason: 'none', cookies: 0, pages: 0 }, NOW, 'room-1', 'recover');
        await waitUntilBlockedBy(faster.pid, 1, late);
        await faster.done();
        // Not ready (nothing of this attempt was written), and the ready job's browser was never emptied
        expect(await late).toBe('recover');
        expect(sent).toEqual([]);
        expect(await prepOf(visa.id)).toEqual({ prepState: null });
      } finally {
        await Promise.allSettled([faster.done(), ...(late ? [late] : [])]);
      }
      // Control: an attempt that still owns the job (same room, still `recover`) does empty the browser and settles it
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover' } });
      expect(await settleResumedBrowser(visa.id, sara.brickId, { state: 'fresh', reason: 'none', cookies: 0, pages: 0 }, NOW, 'room-1', 'recover')).toBe('ready');
      expect(sent.map((one) => one.action)).toEqual(['clear']);
      // A job on another room is not this attempt's either
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', stretchStarted: null, reservationKey: 'room-2' } });
      sent = [];
      expect(await settleResumedBrowser(visa.id, sara.brickId, { state: 'fresh', reason: 'none', cookies: 0, pages: 0 }, NOW, 'room-1', 'recover')).toBe('recover');
      expect(sent).toEqual([]);
      expect(await prepOf(visa.id)).toEqual({ prepState: 'recover' });
    });

    it('A7: two sweeps that read the same `recover` job do not both restore it: the later one finds it settled under the claim and sends nothing', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', reservationKey: 'room-1' } });
      resetRecoveryCursorForTests();
      const hold = await holdMachineRow(sara.brickId, async () => undefined);
      let both: Promise<Array<{ looked: number; ready: number }>> | undefined;
      try {
        // Both have read the job (it is `recover`) and both stand at the claim
        // Each sweep is watched on its own: one that ends before it blocks is reported as that, not as a generic timeout of the pair (CodeRabbit on #1025, N7)
        const first = recoverResumedBrowsers(minutes(1));
        const second = recoverResumedBrowsers(minutes(1));
        both = Promise.all([first, second]);
        // Watched at once: if either sweep rejects, `both` rejects with it, and nothing is awaiting it while the checkpoint polls the database (a rejection handled only at the join is reported as unhandled). The promise itself is kept for the join below (CodeRabbit on #1025, d522f4b3 pass, N3)
        both.catch(() => undefined);
        await waitUntilBlockedBy(hold.pid, 2, first, second);
        await hold.done();
        const answers2 = await both;
        // One restore, once: the second sweep did not send another (which would have found nothing parked, emptied the live browser, and lost the restored sign-ins)
        expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
        expect(answers2.map((one) => one.looked)).toEqual([1, 1]);
        expect(answers2.map((one) => one.ready).sort()).toEqual([0, 1]);
      } finally {
        await Promise.allSettled([hold.done(), ...(both ? [both] : [])]);
      }
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      resetRecoveryCursorForTests();
    });

    it('A7: the settlement is written under the claim of the restore: while the first sweep’s write is still pending, a second sweep that read the same job sends nothing', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', reservationKey: 'room-1' } });
      resetRecoveryCursorForTests();
      // While the first restore runs, the job's row is held by someone else's write, so the first sweep's settlement has to wait for it
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lock: Promise<void> | undefined;
      let lockHeld: (pid: number) => void = () => undefined;
      let lockFailed: (error: unknown) => void = () => undefined;
      const lockPid = new Promise<number>((resolve, reject) => {
        lockHeld = resolve;
        lockFailed = reject;
      });
      lockPid.catch(() => undefined);
      during = async (action) => {
        if (action !== 'restore' || lock) return;
        lock = prisma.$transaction(
          async (tx) => {
            const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
            await tx.$queryRaw`SELECT 1 FROM "computer_jobs" WHERE "id" = ${visa.id} FOR UPDATE`;
            lockHeld(pid);
            await gate;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );
        lock.catch(lockFailed);
        await reached(lockPid, lock);
      };
      // Every try of a sweep to take the machine's cleanup claim, with what the database answered: the first sweep's take (1), and the second sweep's wait for it (0 rows: the claim is still the first sweep's)
      const claimed: number[] = [];
      const realClaim = prisma.brickComputer.updateMany.bind(prisma.brickComputer);
      const claimSpy = jest.spyOn(prisma.brickComputer, 'updateMany').mockImplementation((async (args: { where?: { OR?: unknown } }) => {
        const done = await realClaim(args as never);
        if (args.where?.OR) claimed.push(done.count);
        return done;
      }) as never);
      let first: ReturnType<typeof recoverResumedBrowsers> | undefined;
      let second: ReturnType<typeof recoverResumedBrowsers> | undefined;
      try {
        first = recoverResumedBrowsers(minutes(1));
        // The restore is done and its settlement write waits for the row the fixture transaction holds: the claim is the first sweep's
        const holder = await Promise.race([lockPid, first.then(() => { throw new Error('The first sweep ended before its write was blocked'); })]);
        await waitUntilBlockedBy(holder, 1, first);
        expect(claimed).toEqual([1]);
        // A second sweep reads the job (still `recover`) and wants the machine: the checkpoint is its own try of the claim, which must come back busy while the first write is still blocked
        second = recoverResumedBrowsers(minutes(1));
        await boundedUntil(() => claimed.length >= 2, 'the second sweep to try the claim', second);
        expect(claimed[0]).toBe(1);
        expect(claimed.slice(1).every((answer) => answer === 0)).toBe(true);
        expect(sent.map((one) => one.action)).toEqual(['restore']);
      } finally {
        release();
        await Promise.allSettled([...(lock ? [lock] : []), ...(first ? [first] : []), ...(second ? [second] : [])]);
        claimSpy.mockRestore();
      }
      expect(await first).toEqual({ looked: 1, ready: 1 });
      expect(await second).toEqual({ looked: 1, ready: 0 });
      expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
      resetRecoveryCursorForTests();
    });

    it('A7: a restore for a job that is not `restoring` or `recover` on its own room any more sends nothing', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: null, reservationKey: 'room-1' } });
      expect(await restoreProfile(sara.brickId, visa.id, NOW, { reservation: 'room-1', from: 'recover' })).toMatchObject({ state: 'left', reason: 'superseded' });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', stretchStarted: null, reservationKey: 'room-2' } });
      expect(await restoreProfile(sara.brickId, visa.id, NOW, { reservation: 'room-1', from: 'recover' })).toMatchObject({ state: 'left', reason: 'superseded' });
      expect(sent).toEqual([]);
      expect(await restoreProfile(sara.brickId, visa.id, NOW, { reservation: 'room-2', from: 'recover' })).toMatchObject({ state: 'restored' });
      expect(sent.map((one) => one.action)).toEqual(['restore']);
    });

    it('A8: while a job’s own restore is unresolved its marker and the wipe it carries stay; when it is settled they go', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id, parkPendingWipe: true } });
      for (const state of ['restoring', 'recover']) {
        await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: state } });
        expect(await settlePark(sara.brickId, visa.id, null, NOW)).toBe('waiting');
        expect(await finishPendingParks(minutes(1))).toMatchObject({ looked: 1, parked: 0, wiped: 0 });
        expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: true });
      }
      expect(sent).toEqual([]);
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: null } });
      expect(await settlePark(sara.brickId, visa.id, null, NOW)).toBe('settled');
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
    });

    it('A9: a park that waited for the claim while its job paused again puts nothing away, clears nothing of the later pause and writes nothing onto it', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      // While the park waits for the claim: the job starts again and pauses again (its second pause row, the marker the same job id)
      const again = await holdMachineRow(sara.brickId, async (tx) => {
        await tx.computerJob.update({ where: { id: visa.id }, data: { pauses: 2 } });
        await tx.computerJobPause.create({ data: { jobId: visa.id, n: 2, why: 'person', seconds: 60, at: NOW } });
      });
      let parking: ReturnType<typeof parkProfile> | undefined;
      try {
        parking = parkProfile(sara.brickId, visa.id, NOW, 1);
        await waitUntilBlockedBy(again.pid, 1, parking);
        await again.done();
        expect(await parking).toMatchObject({ state: 'left', reason: 'not_paused' });
      } finally {
        await Promise.allSettled([again.done(), ...(parking ? [parking] : [])]);
      }
      expect(sent).toEqual([]);
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: false });
      expect(await keptOf(visa.id)).toEqual([[1, null], [2, null]]);
      // Its settlement is the later pause's to make: the stale one clears and wipes nothing
      expect(await settlePark(sara.brickId, visa.id, { state: 'left', reason: 'not_paused', cookies: 0, pages: 0 }, NOW, 1)).toBe('waiting');
      // Even with a park that went through: it is not reported as the settled pause (the marker is not its to let go of)
      expect(await settlePark(sara.brickId, visa.id, { state: 'parked', reason: null, cookies: 1, pages: 1 }, NOW, 1)).toBe('waiting');
      expect(sent).toEqual([]);
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: false });
    });

    it('A9: a park whose job pauses again WHILE the command runs records and clears only for its own pause', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      during = async (action) => {
        if (action !== 'park') return;
        await prisma.computerJob.update({ where: { id: visa.id }, data: { pauses: 2 } });
        await prisma.computerJobPause.create({ data: { jobId: visa.id, n: 2, why: 'person', seconds: 60, at: NOW } });
      };
      expect(await parkProfile(sara.brickId, visa.id, NOW, 1)).toMatchObject({ state: 'parked' });
      // Pause 1 kept its browser; pause 2 is not told it did, and its marker is still there
      expect(await keptOf(visa.id)).toEqual([[1, true], [2, null]]);
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: false });
    });

    it('A9, A12: the marker is let go only for the pause (and room) that was settled, and never while another write holds the job', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { reservationKey: 'room-1' } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id, parkPendingWipe: true } });
      // A pause is in flight: it holds the job's row and has moved the pause count. The clear is not made on a guess, and not after the pause commits either
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockedIt = new Promise<void>((resolve) => (locked = resolve));
      const pause = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "computer_jobs" WHERE "id" = ${visa.id} FOR UPDATE`;
          await tx.computerJob.update({ where: { id: visa.id }, data: { pauses: 2, status: 'queued', queuedFor: 'paused' } });
          locked();
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      pause.catch(() => undefined);
      try {
        await reached(lockedIt, pause);
        await clearParkPending(sara.brickId, visa.id, { pauses: 1, reservation: 'room-1' });
        expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: true });
      } finally {
        release();
        await Promise.allSettled([pause]);
      }
      // The pause committed: the old settlement (pause 1, room-1) finds another pause and clears nothing
      await clearParkPending(sara.brickId, visa.id, { pauses: 1, reservation: 'room-1' });
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: visa.id, parkPendingWipe: true });
      await clearParkPending(sara.brickId, visa.id, { pauses: 2 });
      expect(await markOf(sara.brickId)).toEqual({ parkPendingJobId: null, parkPendingWipe: false });
      // A start's clear also needs the job on the room it carried on from (and on the machine)
      const carried = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: carried.id }, data: { reservationKey: 'room-3' } });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: carried.id } });
      await clearParkPending(sara.brickId, carried.id, { pauses: 1, reservation: 'room-2' });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBe(carried.id);
      await clearParkPending(sara.brickId, carried.id, { pauses: 1, reservation: 'room-3' });
      expect((await markOf(sara.brickId)).parkPendingJobId).toBeNull();
    });

    it('B/C19: a recovery counts as ready only when its state write landed on a row', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring', reservationKey: 'room-1' } });
      const restored = { state: 'restored' as const, reason: null, cookies: 1, pages: 1 };
      // The write fails: the restore worked, but the job is still `restoring` and claimJob refuses it, so it is not ready
      const write = jest.spyOn(prisma.computerJob, 'updateMany').mockRejectedValueOnce(new Error('the database went away'));
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await settleResumedBrowser(visa.id, sara.brickId, restored, NOW, 'room-1', 'restoring')).toBe('recover');
      } finally {
        write.mockRestore();
        quiet.mockRestore();
      }
      expect(await prepOf(visa.id)).toEqual({ prepState: 'restoring' });
      // The write matches nothing (the job is on another room): not ready either, and nothing is written
      expect(await settleResumedBrowser(visa.id, sara.brickId, restored, NOW, 'room-other', 'restoring')).toBe('recover');
      expect(await prepOf(visa.id)).toEqual({ prepState: 'restoring' });
      // The job paused again: not running, so nothing is written and it is not ready
      const paused = await job(sara, { pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: paused.id }, data: { prepState: 'restoring', reservationKey: 'room-1' } });
      expect(await settleResumedBrowser(paused.id, sara.brickId, restored, NOW, 'room-1', 'restoring')).toBe('recover');
      expect(await prepOf(paused.id)).toEqual({ prepState: 'restoring' });
      // Control: the write lands
      expect(await settleResumedBrowser(visa.id, sara.brickId, restored, NOW, 'room-1', 'restoring')).toBe('ready');
      expect(await prepOf(visa.id)).toEqual({ prepState: null });
    });
  });

  describe('CodeRabbit on #1025 (round 9): I4, I5 and I6', () => {
    const prepOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { prepState: true, stretchStarted: true } });

    it('I5: a drop that takes long and loses the claim to another operation does not go on to restore: the result is superseded and no restore is sent', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 25 * 60 });
      during = async (action) => {
        // Another operation on the browser took the claim while the drop ran
        if (action === 'drop') await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { cleanClaimedAt: new Date(Date.now() + 5_000) } });
      };
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'left', reason: 'superseded' });
      expect(sent.map((one) => one.action)).toEqual(['drop']);
    });

    it('I5 (control): a drop that keeps the claim goes on to restore', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 25 * 60 });
      answers.restore = 'restored=0 reason=none';
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'fresh', reason: 'expired' });
      expect(sent.map((one) => one.action)).toEqual(['drop', 'restore']);
    });

    it('I6: the stretch of a resumed job starts at the moment of the ready write, read after the emptying, never at a moment sampled before the claim was waited for', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      let clock = NOW;
      let reads = 0;
      // The emptying takes a while: the clock moves on while the command runs
      during = async (action) => {
        if (action === 'clear') clock = minutes(7);
      };
      const back = { state: 'fresh' as const, reason: 'none' as const, cookies: 0, pages: 0 };
      expect(
        await settleResumedBrowser(visa.id, sara.brickId, back, () => {
          reads++;
          return clock;
        }),
      ).toBe('ready');
      // Read for the emptying (before it) and again for the write (after it)
      expect(reads).toBe(2);
      expect((await prepOf(visa.id)).stretchStarted).toEqual(minutes(7));
    });

    it('I6 (control): a plain moment still works as before', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect((await prepOf(visa.id)).stretchStarted).toEqual(NOW);
    });

    it('I4: the machine is told the restore is committed only after the ready write landed, and only for a browser that was really restored', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(back).toMatchObject({ state: 'restored' });
      // The ready write does not land (the job is no longer in the state the attempt read): no commit, so a retry still finds the note and keeps the browser
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW, undefined, 'recover')).toBe('recover');
      expect(sent.map((one) => one.action)).toEqual(['restore']);
      // Landed: committed once, and the ready write had landed when the machine was told: the job's `prep_state` is read at the moment `commit` arrives (a commit sent before the write could leave the note gone with the write failing, and a
      // retry would then empty the browser just restored) (CodeRabbit on #1025, N22)
      const atCommit: Array<string | null> = [];
      during = async (action) => {
        if (action === 'commit') atCommit.push((await prepOf(visa.id)).prepState);
      };
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(atCommit).toEqual([null]);
      expect(sent.map((one) => one.action)).toEqual(['restore', 'commit']);
      expect(sent[1]).toMatchObject({ job: visa.id, user: 'root' });
    });

    it('N29: the restore and its commit carry the number of the pause they belong to, and the commit runs under the machine’s claim', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      const claimAtCommit: Array<Date | null> = [];
      during = async (action) => {
        if (action === 'commit') claimAtCommit.push((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt);
      };
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(numbers).toEqual(['restore:1', 'commit:1']);
      expect(claimAtCommit).toHaveLength(1);
      expect(claimAtCommit[0]).not.toBeNull();
      expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).cleanClaimedAt).toBeNull();
    });

    it('N29: a commit whose ready write was held across a newer pause of the job still names the pause its own restore brought back', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      const real = prisma.computerJob.updateMany.bind(prisma.computerJob);
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const atWrite = new Promise<void>((resolve) => { reached = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const hold = jest.spyOn(prisma.computerJob, 'updateMany').mockImplementation(((args: { data?: Record<string, unknown> }) => {
        if (args?.data && args.data.prepState === null) {
          reached();
          return gate.then(() => real(args as never));
        }
        return real(args as never);
      }) as never);
      let settling: Promise<unknown> = Promise.resolve();
      try {
        settling = settleResumedBrowser(visa.id, sara.brickId, back, NOW);
        // A settlement that ends (or fails) before it reaches the held ready write fails the checkpoint at once, with what it answered, instead of timing out with the spy still installed (CodeRabbit on #1025, d522f4b3 pass, N4)
        await Promise.race([atWrite, settling.then((answer) => Promise.reject(new Error(`the settlement ended (${String(answer)}) before the ready write`)))]);
        // While the ready write is held the job is paused and restored again: its number is now 2
        await prisma.computerJob.update({ where: { id: visa.id }, data: { pauses: 2 } });
        release();
        expect(await settling).toBe('ready');
        expect(numbers).toEqual(['restore:1', 'commit:1']);
      } finally {
        release();
        await Promise.allSettled([settling]);
        hold.mockRestore();
      }
    });

    it('N29: the sweep renews its claim before the commit command and sends none when the claim was taken over (the job is ready; its note is let go later)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', reservationKey: 'room-1' } });
      resetRecoveryCursorForTests();
      // Another holder takes the claim over while the restore command runs
      during = async (action) => {
        if (action === 'restore') await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { cleanClaimedAt: new Date(Date.now() + 1000) } });
      };
      expect(await recoverResumedBrowsers(minutes(1))).toMatchObject({ looked: 1, ready: 1 });
      expect(sent.map((one) => one.action)).toEqual(['restore']);
      expect(await prepOf(visa.id)).toMatchObject({ prepState: null });
      resetRecoveryCursorForTests();
    });

    it('I4: a browser that was emptied (fresh) has no note to let go of: nothing is committed', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      answers.restore = 'restored=0 reason=none';
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect(sent.map((one) => one.action)).toEqual(['restore', 'clear']);
    });

    it('I4: a commit that cannot be sent never undoes the ready job', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      answers.commit = '';
      expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
      expect((await prepOf(visa.id)).prepState).toBeNull();
    });
  });

  describe('CodeRabbit on #1025 (d522f4b3 pass, N24): a pause number that cannot be read is never replaced by a shared stand-in', () => {
    const prepOf = (jobId: string) => prisma.computerJob.findUniqueOrThrow({ where: { id: jobId }, select: { prepState: true } });
    /** The reads of the job's pause number (a query for `pauses` alone) fail from the `from`th one on (1 = all). */
    const failNumberReads = (from: number) => {
      const real = prisma.computerJob.findUnique.bind(prisma.computerJob);
      let reads = 0;
      let rejected = 0;
      const spy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { select?: Record<string, boolean> }) => {
        const keys = Object.keys(args?.select ?? {});
        if (keys.length === 1 && keys[0] === 'pauses') {
          reads += 1;
          if (reads >= from) {
            rejected += 1;
            return Promise.reject(new Error('the database is not answering')) as never;
          }
        }
        return real(args as never);
      }) as never);
      return { reads: () => reads, rejected: () => rejected, stop: () => spy.mockRestore() };
    };

    it('a restore whose number cannot be read does not run: no command (so no note numbered 0), the answer is `failed`, and the job is left for the recovery', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const failing = failNumberReads(1);
      try {
        expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'failed' });
        expect(failing.reads()).toBeGreaterThan(0);
      } finally {
        failing.stop();
      }
      expect(sent.map((one) => one.action)).toEqual([]);
      expect(numbers).toEqual([]);
      // The next try (the number can be read again) restores it, with the real number
      expect(await restoreProfile(sara.brickId, visa.id, NOW)).toMatchObject({ state: 'restored' });
      expect(numbers).toEqual(['restore:1']);
    });

    it('a commit whose number cannot be read removes nothing: the job is ready and the machine’s note stays for the recovery', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'restoring' } });
      const back = await restoreProfile(sara.brickId, visa.id, NOW);
      const failing = failNumberReads(1);
      try {
        expect(await settleResumedBrowser(visa.id, sara.brickId, back, NOW)).toBe('ready');
        expect(failing.reads()).toBeGreaterThan(0);
      } finally {
        failing.stop();
      }
      expect(sent.map((one) => one.action)).toEqual(['restore']);
      expect(numbers).toEqual(['restore:1']);
      expect((await prepOf(visa.id)).prepState).toBeNull();
    });

    it('the sweep: its commit with an unreadable number removes nothing either (the restore it ran read the number once)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { status: 'running', pausedMinutesAgo: 5 });
      await prisma.computerJob.update({ where: { id: visa.id }, data: { prepState: 'recover', reservationKey: 'room-n24' } });
      resetRecoveryCursorForTests();
      const failing = failNumberReads(2);
      try {
        expect(await recoverResumedBrowsers(minutes(1))).toMatchObject({ looked: 1, ready: 1 });
        // The sweep did reach the injected failure: the commit's number read was the one rejected (the restore's own read, the first, was answered)
        expect(failing.reads()).toBe(2);
        expect(failing.rejected()).toBe(1);
      } finally {
        failing.stop();
        resetRecoveryCursorForTests();
      }
      expect(numbers).toEqual(['restore:1']);
    });
  });

  describe('Opus on #1025 (O45): a park that was proved but whose record could not be written never leaves the pause unrecorded for good', () => {
    const markOf = async (botId: string) => (await prisma.brickComputer.findUniqueOrThrow({ where: { botId }, select: { parkPendingJobId: true } })).parkPendingJobId;
    const keptOf = async (jobId: string) => (await prisma.computerJobPause.findUniqueOrThrow({ where: { jobId_n: { jobId, n: 1 } } })).signInsKept;
    const failWrites = (times: number | 'always') => {
      const real = prisma.computerJobPause.updateMany.bind(prisma.computerJobPause);
      let left = times === 'always' ? Infinity : times;
      return jest.spyOn(prisma.computerJobPause, 'updateMany').mockImplementation(((args: Parameters<typeof real>[0]) => {
        if (left > 0) {
          left--;
          return Promise.reject(new Error('the database is not answering')) as never;
        }
        return real(args) as never;
      }) as never);
    };

    it('the park\'s own write fails once: the marker stays, and the settlement that follows writes the result and lets the marker go', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      const spy = failWrites(1);
      let parked;
      try {
        parked = await parkProfile(sara.brickId, visa.id, NOW);
      } finally {
        spy.mockRestore();
      }
      expect(parked).toMatchObject({ state: 'parked' });
      // Proved on the machine, but not recorded: the machine still waits for this pause
      expect(await markOf(sara.brickId)).toBe(visa.id);
      expect(await keptOf(visa.id)).toBeNull();
      expect(await settlePark(sara.brickId, visa.id, parked, NOW)).toBe('settled');
      expect(await keptOf(visa.id)).toBe(true);
      expect(await markOf(sara.brickId)).toBeNull();
    });

    it('both writes fail: the settlement waits with the marker, and the sweep (finishParkOf) records the result and lets the marker go once the database answers', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      const spy = failWrites('always');
      try {
        const parked = await parkProfile(sara.brickId, visa.id, NOW);
        expect(await settlePark(sara.brickId, visa.id, parked, NOW)).toBe('waiting');
      } finally {
        spy.mockRestore();
      }
      expect(await markOf(sara.brickId)).toBe(visa.id);
      expect(await keptOf(visa.id)).toBeNull();
      answers.park = 'parked=0 reason=already';
      expect(await finishParkOf(sara.brickId, visa.id, NOW)).toBe('settled');
      expect(await keptOf(visa.id)).toBe(true);
      expect(await markOf(sara.brickId)).toBeNull();
    });

    it('a park with nothing to put away is recorded false the same way (the write fails, the marker stays, the retry writes false)', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id } });
      answers.park = 'parked=0 reason=nothing';
      const spy = failWrites(2);
      try {
        const parked = await parkProfile(sara.brickId, visa.id, NOW);
        expect(await settlePark(sara.brickId, visa.id, parked, NOW)).toBe('waiting');
      } finally {
        spy.mockRestore();
      }
      expect(await markOf(sara.brickId)).toBe(visa.id);
      expect(await finishParkOf(sara.brickId, visa.id, NOW)).toBe('settled');
      expect(await keptOf(visa.id)).toBe(false);
      expect(await markOf(sara.brickId)).toBeNull();
    });

    it('a wipe whose record fails keeps the marker (waiting); the next settlement empties again and records false', async () => {
      const sara = await person('Sara');
      await machine(sara.brickId);
      const visa = await job(sara, { pausedMinutesAgo: 0 });
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { parkPendingJobId: visa.id, parkPendingWipe: true } });
      const spy = failWrites(1);
      try {
        expect(await settlePark(sara.brickId, visa.id, null, NOW)).toBe('waiting');
      } finally {
        spy.mockRestore();
      }
      expect(await markOf(sara.brickId)).toBe(visa.id);
      expect(await settlePark(sara.brickId, visa.id, null, NOW)).toBe('wiped');
      expect(await keptOf(visa.id)).toBe(false);
      expect(await markOf(sara.brickId)).toBeNull();
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

    it('a Brick inside its hour does not hold up the ones behind it: the sweep carries a cursor and reaches every Brick', async () => {
      // Three Bricks, every one of them with sign-ins kept longer than the Limits allow
      const three = [await person('One'), await person('Two'), await person('Three')];
      for (const who of three) {
        await machine(who.brickId);
        await job(who, { pausedMinutesAgo: 25 * 60 });
      }
      const inOrder = three.map((who) => who.brickId).sort();
      // A page of one Brick, so three Bricks are more pages than one sweep takes (the real page is 200: the behaviour, not the number, is what is tested)
      resetSignInsSweepForTests(1);
      const pruned = (): string[] => sent.filter((one) => one.action === 'prune').map((one) => one.ref.replace('fake-', ''));

      // One sweep takes two pages, so it reaches the first two Bricks and stops with its cursor on the second
      expect((await sweepPausedSignIns(NOW)).looked).toBe(2);
      expect(pruned()).toEqual([inOrder[0], inOrder[1]]);

      // The next sweep starts AFTER the second Brick, so the third is reached: before the cursor, the first page would have been the same two for ever
      expect((await sweepPausedSignIns(minutes(1))).looked).toBe(1);
      expect(pruned()).toEqual([inOrder[0], inOrder[1], inOrder[2]]);

      // Past the last Brick the cursor starts again from the first, and what keeps it from pruning twice is the hour, not the cursor
      expect((await sweepPausedSignIns(minutes(2))).looked).toBe(0);
      expect(pruned()).toHaveLength(3);

      // Once the hour has passed every Brick is reached a second time, each still only once in its own hour
      for (const at of [61, 62, 63, 64]) await sweepPausedSignIns(minutes(at));
      expect([...new Set(pruned().slice(3))].sort()).toEqual(inOrder);
      expect(pruned()).toHaveLength(6);
    });
  });
});
