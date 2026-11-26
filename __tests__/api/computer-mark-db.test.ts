/**
 * The take-over fence's mark, held in Orbit's database (root-agent item 3A), against a real database and the pretend provider. The script
 * side is run for real in __tests__/lib/computer-fence-script.test.ts. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * THROWAWAY database (its clock set to Asia/Kuwait for the Kuwait-time run):
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-mark-db.test.ts --runInBand
 *
 * The rules under test:
 *   - the mark is saved in the SAME write that sets the machine to `working`, and only by the start that still holds the wake ticket;
 *   - on the same boot the first mark's clock reading stays (a later one would take in what the agent started since); a new boot gets a new one;
 *   - the fence is sent what Orbit holds, and a computer with no mark is not proved clear: it is stopped, like any fence that is not proved;
 *   - the computer's own parts are read and saved again after each restart Orbit does itself (the clean-up after a job), for the same boot only.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { isFenceCheckCommand, isFenceCommand, isMarkCommand } from '@/lib/computer-fence-script';
import { refreshMarkParts, savedMark } from '@/lib/computer-mark';
import { fenceMachine, finishJob, giveComputer, setLeaderRenewTriesForTests, startJob, takeOver } from '@/lib/computer';
import { CONTROL_TIMING } from '@/lib/computer-control';

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

async function running(name = 'sara') {
  const sara = await person(name);
  await giveComputer(sara.brickId, sara.id);
  const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW);
  if (!started.ok) throw new Error('the job did not start');
  return { sara, jobId: started.job.id };
}

const computerOf = (botId: string) => prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
const PART = { pid: 5, start: 9, kind: 'part' as const };
const GATEWAY = { pid: 6, start: 10, kind: 'gateway' as const };

run('the take-over fence’s mark, held by Orbit', () => {
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

  describe('taking it when the computer is made ready', () => {
    it('saves the mark in the write that says the machine works: boot, clock reading, parts', async () => {
      fake.parts = [PART, GATEWAY];
      const { sara } = await running();
      const row = await computerOf(sara.brickId);
      const expected = fake.markOf(row.providerRef as string);
      expect(row.machine).toBe('working');
      expect(row.markBootId).toBe(expected.bootId);
      expect(Number(row.markTicks)).toBeGreaterThanOrEqual(1000);
      expect(row.markParts).toEqual([PART, GATEWAY]);
      expect(savedMark(row)).toMatchObject({ bootId: expected.bootId, parts: [PART, GATEWAY] });
    });

    it('a row whose parts or runners are not lists is a damaged one: no mark, and an empty list is a real mark (CodeRabbit on #1033)', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      const row = await computerOf(sara.brickId);
      expect(savedMark(row)).not.toBeNull();
      expect(savedMark({ ...row, markParts: null })).toBeNull();
      expect(savedMark({ ...row, markParts: { 0: PART } as never })).toBeNull();
      expect(savedMark({ ...row, markRunners: 'x' as never })).toBeNull();
      expect(savedMark({ ...row, markParts: [], markRunners: [] })).toMatchObject({ parts: [], runners: [] });
    });

    it('keeps the first clock reading on the same boot (the parts are the freshest), and takes a new mark on a new boot', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      const first = await computerOf(sara.brickId);
      await finishJob(jobId, 'done', NOW);
      // The same boot, the machine rests and a job starts again: what the agent has started since is still the agent's
      fake.parts = [GATEWAY];
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, NOW)).ok).toBe(true);
      const same = await computerOf(sara.brickId);
      expect(same.machine).toBe('working');
      expect(same.markBootId).toBe(first.markBootId);
      expect(same.markTicks).toBe(first.markTicks);
      expect(same.markParts).toEqual([GATEWAY]);
      // A stop and start is a new boot: a new mark
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId, status: 'running' } });
      for (const job of jobs) await finishJob(job.id, 'done', NOW);
      fake.rebootForTests(first.providerRef as string);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Third' }, NOW)).ok).toBe(true);
      const next = await computerOf(sara.brickId);
      expect(next.markBootId).not.toBe(first.markBootId);
      expect(Number(next.markTicks)).toBeGreaterThan(Number(first.markTicks));
    });

    it('a computer that has worked before and has no mark saved is started afresh before its first mark: a boot that already ran jobs is never marked as the computer’s own (CodeRabbit on #1033)', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      const before = await computerOf(sara.brickId);
      const ref = before.providerRef as string;
      // A computer made new, and one that has a mark, are not restarted for it
      expect(fake.freshBoots).toEqual([]);
      await finishJob(jobId, 'done', NOW);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, NOW)).ok).toBe(true);
      expect(fake.freshBoots).toEqual([]);
      expect((await computerOf(sara.brickId)).markBootId).toBe(before.markBootId);
      // Made ready before Orbit kept marks: it worked, it slept, and its boot is the one the jobs ran on. The same boot would be marked with a clock reading taken NOW, after whatever those jobs left
      // running; so it is stopped and started first, and the mark is the first one of a boot nothing has run on
      const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId, status: 'running' } });
      for (const job of jobs) await finishJob(job.id, 'done', NOW);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting', markBootId: null, markTicks: null, markParts: Prisma.DbNull, markRunners: Prisma.DbNull } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Third' }, NOW)).ok).toBe(true);
      expect(fake.freshBoots).toEqual([ref]);
      const after = await computerOf(sara.brickId);
      expect(after.machine).toBe('working');
      expect(after.markBootId).not.toBeNull();
      expect(after.markBootId).not.toBe(before.markBootId);
      expect(savedMark(after)).not.toBeNull();
      // ... and from then on it is an ordinary row: the same boot keeps its first mark, with no more restarts
      const third = await prisma.computerJob.findMany({ where: { botId: sara.brickId, status: 'running' } });
      for (const job of third) await finishJob(job.id, 'done', NOW);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fourth' }, NOW)).ok).toBe(true);
      expect(fake.freshBoots).toEqual([ref]);
      expect((await computerOf(sara.brickId)).markTicks).toBe(after.markTicks);
    });

    it('a fresh boot that the computer does not prove never refuses the job: the job runs, no mark is saved, a take-over stops the machine, and a later wake with a real reboot saves the mark (Opus on #1033)', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      const before = await computerOf(sara.brickId);
      const ref = before.providerRef as string;
      await finishJob(jobId, 'done', NOW);
      const unmarked = { machine: 'resting' as const, markBootId: null, markTicks: null, markParts: Prisma.DbNull, markRunners: Prisma.DbNull };
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: unmarked });
      // Agent37 kept the boot over the stop and start: nothing proves the restart, so the provider answers no mark
      fake.freshBootUnproved = true;
      try {
        const started = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Unproved' }, NOW);
        expect(started.ok).toBe(true);
        expect(fake.freshBoots).toEqual([ref]);
        const row = await computerOf(sara.brickId);
        expect(row.machine).toBe('working');
        expect(row.markBootId).toBeNull();
        expect(row.markTicks).toBeNull();
        expect(savedMark(row)).toBeNull();
        // A take-over on it is not proved: no fence is sent and the machine is stopped
        fake.commands.length = 0;
        fake.calls.length = 0;
        expect(await fenceMachine(sara.brickId)).toBe('failed');
        expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
        expect(fake.calls.some((call) => call.name === 'rest' || call.name === 'stop')).toBe(true);
        // The next wake asks for the fresh boot again; this time the computer really reboots: the mark is saved
        const jobs = await prisma.computerJob.findMany({ where: { botId: sara.brickId, status: 'running' } });
        for (const job of jobs) await finishJob(job.id, 'done', NOW);
        await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting' } });
        fake.freshBootUnproved = false;
        expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Proved' }, NOW)).ok).toBe(true);
        expect(fake.freshBoots).toEqual([ref, ref]);
        const after = await computerOf(sara.brickId);
        expect(after.machine).toBe('working');
        expect(after.markBootId).not.toBeNull();
        expect(savedMark(after)).not.toBeNull();
      } finally {
        fake.freshBootUnproved = false;
      }
    });

    it('a row with no mark that never worked has nothing to clear: it is not restarted', async () => {
      const { sara, jobId } = await running('never');
      await finishJob(jobId, 'done', NOW);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'resting', lastWorkedAt: null, markBootId: null, markTicks: null, markParts: Prisma.DbNull, markRunners: Prisma.DbNull } });
      expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'First' }, NOW)).ok).toBe(true);
      expect(fake.freshBoots).toEqual([]);
      expect((await computerOf(sara.brickId)).markBootId).not.toBeNull();
    });

    it('a start that no longer holds the wake ticket saves nothing: the replacement’s mark stands', async () => {
      const sara = await person('lost');
      await giveComputer(sara.brickId, sara.id);
      const replacement = { bootId: '11111111-1111-4111-8111-111111111111', ticks: 777, parts: [GATEWAY], runners: [] };
      const spy = jest.spyOn(fake, 'ready').mockImplementationOnce(async (ref: string) => {
        // While this start waits for its machine to be ready, another start takes the ticket, readies the machine itself and writes its own mark
        await prisma.brickComputer.update({
          where: { botId: sara.brickId },
          data: { wakeEpoch: { increment: 1 }, machine: 'working', markBootId: replacement.bootId, markTicks: BigInt(replacement.ticks), markParts: replacement.parts, markRunners: [] },
        });
        return fake.markOf(ref);
      });
      try {
        expect((await startJob({ botId: sara.brickId, personId: sara.id, title: 'Job' }, NOW)).ok).toBe(true);
      } finally {
        spy.mockRestore();
      }
      const row = await computerOf(sara.brickId);
      expect(row.markBootId).toBe(replacement.bootId);
      expect(Number(row.markTicks)).toBe(777);
      expect(row.markParts).toEqual([GATEWAY]);
    });
  });

  describe('the fence is sent what Orbit holds', () => {
    it('the boot, the clock reading, the parts and the fingerprints come from the row, never from the computer', async () => {
      const { sara } = await running();
      const hash = 'c'.repeat(64);
      await prisma.brickComputer.update({
        where: { botId: sara.brickId },
        data: { markBootId: '22222222-2222-4222-8222-222222222222', markTicks: BigInt(424242), markParts: [PART, GATEWAY], markRunners: [hash] },
      });
      fake.commands.length = 0;
      // The computer answers every command with a different story (a mark of its own): none of it is read
      fake.execAnswer = async (command) => (isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : isMarkCommand(command) ? { stdout: 'boot=99999999-9999-4999-8999-999999999999\nticks=99999999\nmarked=1\n' } : {});
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      const fences = fake.commands.filter((entry) => isFenceCommand(entry.command));
      expect(fences.map((entry) => isFenceCheckCommand(entry.command))).toEqual([false, true]);
      for (const entry of fences) expect(entry.command).toContain(`--boot=22222222-2222-4222-8222-222222222222 --cutoff=424242 --parts=5:9:p,6:10:g --runners=${hash}`);
      expect(fake.commands.some((entry) => isMarkCommand(entry.command))).toBe(false);
    });

    it('waits while a restart of the browser is under way (the clean claim) and fences with the list that restart saved, never the old one', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      // A restore is putting the job's browser back: the claim is held, and the new browser's parts are saved only when it is done
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { cleanClaimedAt: new Date() } });
      fake.commands.length = 0;
      const fencing = fenceMachine(sara.brickId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { markParts: [GATEWAY], cleanClaimedAt: null } });
      expect(await fencing).toBe('done');
      const sent = fake.commands.filter((entry) => isFenceCommand(entry.command));
      expect(sent.length).toBe(2);
      for (const entry of sent) {
        expect(entry.command).toContain('--parts=6:10:g ');
        expect(entry.command).not.toContain('5:9:p');
      }
    });

    it('waits while a hand-over of files is reading the machine (the files claim), so the fence does not stop its commands (Sentry on #1033)', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      fake.commands.length = 0;
      const fencing = fenceMachine(sara.brickId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
      expect(await fencing).toBe('done');
      expect(fake.commands.filter((entry) => isFenceCommand(entry.command)).length).toBe(2);
    });

    const leaderLosesWhileWaiting = async (claims: { cleanClaimedAt: Date | null; filesClaimedAt: Date | null }) => {
      fake.parts = [PART];
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: claims });
      setLeaderRenewTriesForTests(2);
      try {
        let asked = 0;
        fake.commands.length = 0;
        // The lease is renewed three times (the first look and twice while the claim is held), then the transition is another leader's
        expect(await fenceMachine(sara.brickId, async () => ++asked <= 3)).toBe('lost');
        expect(asked).toBeGreaterThanOrEqual(4);
        expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
      } finally {
        setLeaderRenewTriesForTests(null);
      }
    };

    it('a leader that waits for the clean claim renews its lease while it waits, and sends nothing once it learns it lost the transition (Sentry on #1033)', async () => {
      await leaderLosesWhileWaiting({ cleanClaimedAt: new Date(), filesClaimedAt: null });
    });

    it('a leader that waits for the files claim does the same (each wait renews on its own: only that claim is held here)', async () => {
      await leaderLosesWhileWaiting({ cleanClaimedAt: null, filesClaimedAt: new Date() });
    });

    it('a files claim a stopped server left (older than a hand-over can run) is not waited for', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date(Date.now() - 60 * 60_000) } });
      expect(await fenceMachine(sara.brickId)).toBe('done');
    });

    it('the keep-awake no-op is not due while a fence runs: the fence’s own commands count as activity, so a command of its own started after the mark never overlaps a try (Sentry on #1033)', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { keptAwakeAt: null } });
      const started = Date.now();
      expect(await fenceMachine(sara.brickId)).toBe('done');
      // The sweep sends the no-op only to a machine whose time kept is five minutes old or null: after a fence it is the fence's own, so the next one is five minutes on
      const kept = (await computerOf(sara.brickId)).keptAwakeAt;
      expect(kept).not.toBeNull();
      expect((kept as Date).getTime()).toBeGreaterThanOrEqual(started - 1000);
    });

    it('a computer with no mark is not proved clear: no fence is sent, the machine is stopped, and the person has no screen until it wakes', async () => {
      const { sara, jobId } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { markBootId: null, markTicks: null, markParts: undefined, markRunners: undefined } });
      fake.commands.length = 0;
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
      expect(fake.calls.some((call) => call.name === 'rest' || call.name === 'stop')).toBe(true);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: jobId } })).control).toBe('person');
    });

    it('a mark that is damaged (a part that is not one) is not sent either', async () => {
      const { sara } = await running();
      await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { markParts: [{ pid: '5; id', start: 1, kind: 'part' }] } });
      fake.commands.length = 0;
      expect(await takeOver(sara.brickId, sara.id, NOW)).toMatchObject({ ok: true });
      expect(fake.commands.filter((entry) => isFenceCommand(entry.command))).toEqual([]);
    });
  });

  describe('the parts are saved again after a restart Orbit does itself', () => {
    const cleaned = (command: string) => (/universe-clean/.test(command) ? { stdout: 'cleaned=1\n' } : {});

    it('after the clean-up that follows a job: the new browser is on the list, the clock reading is the first one', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      const before = await computerOf(sara.brickId);
      fake.parts = [{ pid: 90, start: 5000, kind: 'part' }, GATEWAY];
      fake.execAnswer = async (command) => cleaned(command);
      await finishJob(jobId, 'done', NOW);
      const after = await computerOf(sara.brickId);
      expect(after.markParts).toEqual([{ pid: 90, start: 5000, kind: 'part' }, GATEWAY]);
      expect(after.markTicks).toBe(before.markTicks);
      expect(after.markBootId).toBe(before.markBootId);
    });

    it('not when the clean-up did not say it brought the browser up', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      fake.parts = [GATEWAY];
      fake.execAnswer = async () => ({ stdout: 'cleaned=0 reason=busy\n', exitCode: 1 });
      await finishJob(jobId, 'done', NOW);
      expect((await computerOf(sara.brickId)).markParts).toEqual([PART]);
    });

    it('not under a claim that is no longer held: the parts are neither read nor saved (Sentry on #1033)', async () => {
      fake.parts = [PART];
      const { sara } = await running();
      const row = await computerOf(sara.brickId);
      fake.parts = [GATEWAY];
      fake.commands.length = 0;
      expect(await refreshMarkParts(sara.brickId, row.providerRef as string, fake, async () => false)).toBe(false);
      expect(fake.commands.filter((entry) => isMarkCommand(entry.command))).toEqual([]);
      expect((await computerOf(sara.brickId)).markParts).toEqual([PART]);
      // renewed and held: read and saved
      expect(await refreshMarkParts(sara.brickId, row.providerRef as string, fake, async () => true)).toBe(true);
      expect((await computerOf(sara.brickId)).markParts).toEqual([GATEWAY]);
    });

    it('not for another boot: a computer that restarted under Orbit is marked again by the next wake, never patched with a list of the new boot', async () => {
      fake.parts = [PART];
      const { sara, jobId } = await running();
      fake.rebootForTests((await computerOf(sara.brickId)).providerRef as string);
      fake.parts = [GATEWAY];
      fake.execAnswer = async (command) => cleaned(command);
      await finishJob(jobId, 'done', NOW);
      expect((await computerOf(sara.brickId)).markParts).toEqual([PART]);
    });
  });
});
