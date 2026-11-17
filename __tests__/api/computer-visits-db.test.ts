/**
 * Where a job's computer browsed, against a real database with the PRETEND provider (R06): read back when a job ends, kept under the job with
 * host and path only, the person's take-overs told apart from Brick's, a computer that cannot be read or has no recorder said so, and gone with
 * the job. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/computer-visits-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { CONTROL_TIMING } from '@/lib/computer-control';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { HANDS_MAX, VISITS_MAX, visitsFor } from '@/lib/computer-visits';
import { finishJob, giveComputer, handBack, startJob, takeOver } from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const seconds = (n: number) => new Date(NOW.getTime() + n * 1000);
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string): Promise<{ id: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = () => saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
};

/** What the computer's `universe-visits read` prints. The machine's clock is this one, so a line at NOW + n seconds is the job's own time. */
const reading = (lines: object[], head: { state?: string; alive?: number } = {}) => ({
  stdout: [`now=${Date.now()}`, `state=${head.state ?? 'on'}`, `alive=${head.alive ?? 1}`, ...lines.map((entry) => `line=${JSON.stringify(entry)}`), 'end=1'].join('\n') + '\n',
});
const visit = (second: number, over: Record<string, unknown> = {}) => ({ k: 'visit', at: seconds(second).getTime(), m: 'GET', h: 'shop.example', p: '/a', n: 1, ...over });
const reads = () => provider.commands.filter((entry) => entry.command.startsWith('universe-visits read'));

run('where a job’s computer browsed, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
    Object.assign(CONTROL_TIMING, { openLeaseMs: 60, inputLeaseMs: 60, pollMs: 10, joinMs: 4000 });
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  async function jobFor(sara: { id: string; brickId: string }) {
    await giveComputer(sara.brickId, sara.id);
    const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'A' }, NOW);
    if (!job.ok) throw new Error('did not start');
    return job.job.id;
  }

  it('reads the job’s own time from its computer when it ends, and keeps host and path under the job, never a query string or a body', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    provider.execAnswer = (command) =>
      command.startsWith('universe-visits read')
        ? reading([
            visit(-300, { p: '/earlier-job' }),
            visit(2, { p: '/cart?card=4242&token=secret#top' }),
            visit(3, { k: 'post', m: 'POST', form: 1, p: '/checkout/AbCdEfGhIjKlMnOpQrStUvWx12345/pay' }),
            visit(4, { k: 'post', m: 'POST', form: 1, p: '/checkout/AbCdEfGhIjKlMnOpQrStUvWx12345/pay' }),
            visit(5, { k: 'on' }),
            { k: 'visit', at: seconds(6).getTime(), m: 'GET', h: 'Bad Host/?x', p: '/dropped', n: 1 },
            visit(7, { h: 'down.example', p: '/gone', f: 1 }),
            visit(500, { p: '/after-the-job' }),
          ])
        : {};
    await finishJob(id, 'done', seconds(60));
    // One read, with the job's start (and a margin) as where to begin
    expect(reads()).toHaveLength(1);
    expect(reads()[0].command).toBe(`universe-visits read ${NOW.getTime() - 120_000}`);
    const view = await visitsFor(sara.brickId, id);
    // An "on" while the connection was on is a listener started again: the record says it has a gap
    expect(view?.state).toBe('partial');
    expect(view?.items.map((item) => [item.kind, item.method, item.host, item.path, item.count, item.form, item.failed, item.by])).toEqual([
      ['visit', 'GET', 'shop.example', '/cart', 1, false, false, 'brick'],
      ['post', 'POST', 'shop.example', '/checkout/…/pay', 2, true, false, 'brick'],
      ['visit', 'GET', 'down.example', '/gone', 1, false, true, 'brick'],
    ]);
    // Nothing that was cut away is anywhere in the rows
    const rows = await prisma.computerJobVisit.findMany({ where: { jobId: id } });
    expect(JSON.stringify(rows)).not.toMatch(/4242|secret|AbCdEf|Bad Host|dropped|earlier-job|after-the-job/);
  });

  it('says complete for a clean read, and the computer is read before its browser is cleared', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    provider.execAnswer = (command) => (command.startsWith('universe-visits read') ? reading([visit(2), visit(3, { p: '/b' })]) : {});
    await finishJob(id, 'done', seconds(60));
    expect((await visitsFor(sara.brickId, id))?.state).toBe('complete');
    const order = provider.commands.map((entry) => entry.command.split(' ')[0]);
    expect(order.indexOf('universe-visits')).toBeLessThan(order.indexOf('universe-clean'));
  });

  it('shows every page and post next to its take-over notes however many notes there are, and says so when it has to cut', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    await prisma.computerJob.update({ where: { id }, data: { visitsState: 'complete' } });
    await prisma.computerJobVisit.createMany({
      data: Array.from({ length: VISITS_MAX }, (_, k) => ({ jobId: id, kind: 'visit', at: new Date(NOW.getTime() + k * 1000), method: 'GET', host: 'shop.example', path: `/p/${k}`, count: 1 })),
    });
    // Notes, a hundred and two more than the old room for them: none of the pages is dropped, and neither is a note
    await prisma.computerJobVisit.createMany({ data: Array.from({ length: 102 }, (_, k) => ({ jobId: id, kind: 'hands', at: new Date(NOW.getTime() + k * 1000 + 500), by: k % 2 ? 'brick' : 'person' })) });
    const view = await visitsFor(sara.brickId, id);
    expect(view?.items.filter((item) => item.kind === 'visit')).toHaveLength(VISITS_MAX);
    expect(view?.items.filter((item) => item.kind === 'hands')).toHaveLength(102);
    expect(view?.state).toBe('complete');
    expect(view?.truncated).toBeUndefined();
    // Far past what one job can honestly have: the answer is cut, and it is no longer called complete
    await prisma.computerJobVisit.createMany({ data: Array.from({ length: HANDS_MAX }, (_, k) => ({ jobId: id, kind: 'hands', at: new Date(NOW.getTime() + 1_000_000 + k), by: 'person' })) });
    const cut = await visitsFor(sara.brickId, id);
    expect(cut?.truncated).toBe(true);
    expect(cut?.state).toBe('partial');
    expect(cut?.items.filter((item) => item.kind === 'visit')).toHaveLength(VISITS_MAX);
  });

  it('is empty and null until the job ends, and a job that ended with nothing browsed is complete and empty', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    expect(await visitsFor(sara.brickId, id)).toEqual({ state: null, items: [] });
    await finishJob(id, 'done', seconds(60));
    expect(await visitsFor(sara.brickId, id)).toEqual({ state: 'complete', items: [] });
  });

  it('tells a page the person opened during a take-over from one Brick did', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    expect((await takeOver(sara.brickId, sara.id, seconds(10))).ok).toBe(true);
    expect((await handBack(sara.brickId, sara.id)).ok).toBe(true);
    // Orbit wrote its own notes of who had the computer, for the job, in order
    const notes = await prisma.computerJobVisit.findMany({ where: { jobId: id, kind: 'hands' }, orderBy: { at: 'asc' } });
    expect(notes.map((note) => note.by)).toEqual(['person', 'brick']);
    // The test's clock is not the database's: the notes are put at the moments of this test
    await prisma.computerJobVisit.update({ where: { id: notes[0].id }, data: { at: seconds(10) } });
    await prisma.computerJobVisit.update({ where: { id: notes[1].id }, data: { at: seconds(30) } });
    provider.execAnswer = (command) =>
      command.startsWith('universe-visits read') ? reading([visit(5, { p: '/brick-before' }), visit(15, { p: '/signed-in-by-person' }), visit(16, { k: 'post', m: 'POST', form: 1, p: '/login' }), visit(40, { p: '/brick-after' })]) : {};
    await finishJob(id, 'done', seconds(60));
    const view = await visitsFor(sara.brickId, id);
    expect(view?.items.filter((item) => item.kind !== 'hands').map((item) => [item.path, item.by])).toEqual([
      ['/brick-before', 'brick'],
      ['/signed-in-by-person', 'person'],
      ['/login', 'person'],
      ['/brick-after', 'brick'],
    ]);
    // The notes are part of what is shown, so the hand-overs are seen where they happened
    expect(view?.items.filter((item) => item.kind === 'hands').map((item) => item.by)).toEqual(['person', 'brick']);
  });

  it('says unread when the computer cannot be read, none when it has no recorder, and never holds up the end of the job', async () => {
    const unreadable = await person('sara');
    const a = await jobFor(unreadable);
    provider.failExec = true;
    await finishJob(a, 'done', seconds(60));
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: a } })).status).toBe('done');
    expect((await visitsFor(unreadable.brickId, a))?.state).toBe('unread');
    provider.failExec = false;

    const old = await person('omar');
    const b = await jobFor(old);
    provider.execAnswer = (command) => (command.startsWith('universe-visits read') ? { exitCode: 127, stderr: 'sh: 1: universe-visits: not found\n' } : {});
    await finishJob(b, 'done', seconds(60));
    expect((await visitsFor(old.brickId, b))?.state).toBe('none');

    const broken = await person('lina');
    const c = await jobFor(broken);
    provider.execAnswer = (command) => (command.startsWith('universe-visits read') ? { exitCode: 1, stdout: '', stderr: 'boom' } : {});
    await finishJob(c, 'done', seconds(60));
    expect((await visitsFor(broken.brickId, c))?.state).toBe('unread');
  });

  it('says unread, and runs no command on a machine that is not awake (a command would wake it)', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    await prisma.brickComputer.update({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
    await finishJob(id, 'done', seconds(60));
    expect(reads()).toHaveLength(0);
    expect((await visitsFor(sara.brickId, id))?.state).toBe('unread');
  });

  it('is only the owner’s Brick and job: another Brick’s job id shows nothing', async () => {
    const sara = await person('sara');
    const omar = await person('omar');
    const id = await jobFor(sara);
    await finishJob(id, 'done', seconds(60));
    expect(await visitsFor(omar.brickId, id)).toBeNull();
    expect(await visitsFor(sara.brickId, 'not-a-job')).toBeNull();
  });

  it('goes with the job, and with a Brick that is purged', async () => {
    const sara = await person('sara');
    const id = await jobFor(sara);
    provider.execAnswer = (command) => (command.startsWith('universe-visits read') ? reading([visit(2)]) : {});
    await finishJob(id, 'done', seconds(60));
    expect(await prisma.computerJobVisit.count({ where: { jobId: id } })).toBe(1);
    await deleteBrick(sara.brickId, sara.id, seconds(120));
    await prisma.bot.update({ where: { id: sara.brickId }, data: { goneAt: seconds(180) } });
    expect(await removeGoneBricks(seconds(180), sara.id)).toEqual([sara.brickId]);
    expect(await prisma.bot.count({ where: { id: sara.brickId } })).toBe(0);
    expect(await prisma.computerJobVisit.count({ where: { jobId: id } })).toBe(0);
  });
});
