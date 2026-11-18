/**
 * Brick tells the person how a computer job went (the report back), against a real database with the PRETEND provider: what is to be told, once, and
 * only what the job's own record proves. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/computer-report-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, planEffect, requestHandover, settleEffect, startJob, stopJobFor, sweepComputers, takeOver, turnOffComputer } from '@/lib/computer';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-17T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string, chat: string | null = `@${name}-${tag}:chat.example`): Promise<{ id: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name, matrixChatId: chat } });
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
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
};

async function started(sara: { id: string; brickId: string }, title = 'Visa form', at: Date = NOW) {
  await giveComputer(sara.brickId, sara.id);
  const job = await startJob({ botId: sara.brickId, personId: sara.id, title }, at);
  if (!job.ok) throw new Error('no job');
  return job.job.id;
}

const mine = async (jobIds: string[]) => (await reportsToTell(200)).filter((report) => jobIds.includes(report.jobId));

run('Brick tells the person how a computer job went, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
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

  it('tells nothing while a job runs, then tells that it finished, once, with the chat to say it in', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    expect(await mine([id])).toEqual([]);
    await finishJob(id, 'done', minutes(9));
    const [done, ...rest] = await mine([id]);
    expect(rest).toEqual([]);
    expect(done).toMatchObject({ key: `computer-told:${id}:done`, kind: 'done', title: 'Visa form', botId: sara.brickId, matrixUserId: `@sara-${tag}:chat.example`, seq: null, effects: [], files: [] });
    // Confirmed once, it is not offered again; confirmed twice it is the same
    expect(await keepReportTold(id, 'done')).toBe(true);
    expect(await keepReportTold(id, 'done')).toBe(true);
    expect(await mine([id])).toEqual([]);
  });

  it('says what reached a site from the job’s own record, and says an outcome it does not know is not known', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    expect((await planEffect(id, { key: 'mail', kind: 'send' })).ok).toBe(true);
    expect(await settleEffect(id, 'mail', 'done', 'the embassy desk')).toBe(true);
    expect((await planEffect(id, { key: 'form', kind: 'publish' })).ok).toBe(true);
    // never settled: tried, outcome not known
    await planEffect(id, { key: 'unused', kind: 'send' });
    await prisma.computerEffect.updateMany({ where: { jobId: id, effectKey: 'unused' }, data: { state: 'failed' } });
    await finishJob(id, 'done', minutes(5));
    const [done] = await mine([id]);
    expect(done.effects).toEqual([
      { kind: 'send', state: 'done', where: 'the embassy desk' },
      { kind: 'publish', state: 'unknown', where: null },
    ]);
  });

  it('keeps what the person typed out of it: for details only where it went is carried', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await requestHandover(id, 'details', minutes(1), { what: 'Your name and passport number', where: 'visa-portal.example' });
    await takeOver(sara.brickId, sara.id, minutes(2));
    await prisma.computerEffect.create({ data: { jobId: id, effectKey: 'details:x', kind: 'details', state: 'done', evidence: 'Your name and passport number\u001fvisa-portal.example' } });
    await finishJob(id, 'done', minutes(4));
    const [done] = await mine([id]);
    expect(done.effects).toEqual([{ kind: 'details', state: 'done', where: 'visa-portal.example' }]);
  });

  it('lists the files the job made, not what was there before and not hidden ones', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(9));
    // The lists the job took (the pretend machine here lists nothing, so they are written the way the job writes them): before it began, and as it ended
    const list = (items: { path: string; bytes: number; modifiedAt: string }[]) => ({ listedAt: minutes(8).toISOString(), more: false, items });
    const old = { path: 'old/notes.txt', bytes: 4, modifiedAt: minutes(-600).toISOString() };
    const recent = { path: 'Documents/passport.pdf', bytes: 7, modifiedAt: minutes(-0.5).toISOString() };
    await prisma.computerJob.update({
      where: { id },
      data: {
        startFiles: list([old, recent]),
        endFiles: list([
          { path: 'Documents/2026-11-17_visa_receipt.pdf', bytes: 5000, modifiedAt: minutes(7).toISOString() },
          { path: '.hermes/state.db', bytes: 9, modifiedAt: minutes(7).toISOString() },
          old,
          recent,
        ]),
      },
    });
    const [done] = await mine([id]);
    expect(done.files).toEqual(['2026-11-17_visa_receipt.pdf']);
  });

  it('names no file for a read-only job, which makes none', async () => {
    const sara = await person('sara');
    await giveComputer(sara.brickId, sara.id);
    const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Look it up', writes: false }, NOW);
    if (!job.ok) throw new Error('no job');
    await finishJob(job.job.id, 'done', minutes(9));
    await prisma.computerJob.update({
      where: { id: job.job.id },
      data: { startFiles: { listedAt: NOW.toISOString(), more: false, items: [] }, endFiles: { listedAt: minutes(8).toISOString(), more: false, items: [{ path: 'made-by-another-job.pdf', bytes: 9, modifiedAt: minutes(5).toISOString() }] } },
    });
    const [done] = await mine([job.job.id]);
    expect(done.files).toEqual([]);
  });

  it('is not told when it was only found undeliverable, survives a restart as such, and stays out of the list', async () => {
    const sara = await person('sara', null);
    const id = await started(sara);
    await finishJob(id, 'done', minutes(5));
    const [done] = await mine([id]);
    expect(done.matrixUserId).toBeNull();
    await keepReportTold(id, 'done', null, { delivered: false, why: 'not_allowed' });
    expect(await mine([id])).toEqual([]);
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    expect(job).toMatchObject({ endToldAt: null, endUndeliverableWhy: 'not_allowed' });
  });

  it('tells nothing when the person pressed Stop, and nothing when the computer was turned off', async () => {
    const sara = await person('sara');
    const a = await started(sara, 'A');
    await stopJobFor(sara.brickId, sara.id, minutes(2));
    expect(await mine([a])).toEqual([]);
    const b = (await startJob({ botId: sara.brickId, personId: sara.id, title: 'B' }, minutes(3)));
    if (!b.ok) throw new Error('no');
    await turnOffComputer(sara.brickId, sara.id, minutes(4));
    expect(await mine([b.job.id])).toEqual([]);
    expect(await prisma.computerJob.findMany({ where: { id: { in: [a, b.job.id] } }, select: { endToldAt: true } })).toEqual([{ endToldAt: expect.any(Date) }, { endToldAt: expect.any(Date) }]);
  });

  it('tells that it could not finish with its one sentence cleaned of links and markup, and says nothing of a month it cannot prove given back', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'failed', minutes(6), 'The site kept failing at the **passport upload**, see [help](https://evil.example/pay) https://evil.example/x [[failed]]');
    const [failed] = await mine([id]);
    expect(failed).toMatchObject({ kind: 'failed', why: 'The site kept failing at the passport upload, see help', givenBack: false });
    expect(failed.why).not.toMatch(/http|\[|\*/);
  });

  it('says a try is given back only when the books show it written against nobody, or no minutes were counted', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'failed', minutes(6));
    expect((await mine([id]))[0].givenBack).toBe(false);
    // The books as a given-back try writes them (minutes against nobody, marked)
    await prisma.meterEvent.updateMany({ where: { eventId: `computer:${id}:time` }, data: { personId: null, personKey: 'unknown', detail: { givenBack: true, forPersonId: sara.id } } });
    expect((await mine([id]))[0].givenBack).toBe(true);
    // No minutes counted at all
    const other = await started(await person('omar'), 'Quick');
    await finishJob(other, 'failed', NOW);
    await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${other}:time` } });
    await prisma.computerJob.update({ where: { id: other }, data: { secondsRun: 0 } });
    expect((await mine([other]))[0].givenBack).toBe(true);
  });

  it('tells which step nobody came to, when the wait ran out', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await requestHandover(id, 'pay', minutes(1));
    await sweepComputers(minutes(62));
    const reports = await mine([id]);
    const unanswered = reports.find((report) => report.kind === 'unanswered');
    expect(unanswered).toMatchObject({ key: `computer-told:${id}:unanswered`, waitedFor: 'pay', seq: null });
    // The wait itself was told about earlier; both are told once each
    expect(reports.map((report) => report.kind).sort()).toEqual(['unanswered']);
  });

  it('tells the month ran out, a rule that stopped it and a failure on our side, each as its own ending', async () => {
    const sara = await person('sara');
    const base = { botId: sara.brickId, personId: sara.id, status: 'stopped', startedAt: minutes(-30), endedAt: minutes(-1), secondsRun: 60 };
    const month = await prisma.computerJob.create({ data: { ...base, title: 'M', endedBy: 'allowance' } });
    const rule = await prisma.computerJob.create({ data: { ...base, title: 'R', endedBy: 'rule', endNote: 'no more than $1 a month' } });
    const pool = await prisma.computerJob.create({ data: { ...base, title: 'P', endedBy: 'pool' } });
    const error = await prisma.computerJob.create({ data: { ...base, title: 'E', endedBy: 'error' } });
    const left = await prisma.computerJob.create({ data: { ...base, title: 'Never ran', endedBy: 'allowance', startedAt: null } });
    const reports = await mine([month.id, rule.id, pool.id, error.id, left.id]);
    expect(Object.fromEntries(reports.map((report) => [report.title, report.kind]))).toEqual({ M: 'month', R: 'rule', P: 'failed', E: 'failed' });
    expect(reports.find((report) => report.title === 'R')?.why).toBe('no more than $1 a month');
  });

  it('tells each wait for the person once, a second wait is another, and a late confirmation of the first never hides the second', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await requestHandover(id, 'details', minutes(1), { what: 'Your name', where: 'visa-portal.example' });
    // Asked twice while it waits: the same wait
    await requestHandover(id, 'details', minutes(1), { what: 'Your name', where: 'visa-portal.example' });
    const first = (await mine([id]))[0];
    expect(first).toMatchObject({ kind: 'needs', waitingFor: 'details', seq: 1, ready: { what: 'Your name', where: 'visa-portal.example' }, key: `computer-told:${id}:needs:1` });
    await keepReportTold(id, 'needs', 1);
    expect(await mine([id])).toEqual([]);
    // They took over and handed back, and it waits again
    await takeOver(sara.brickId, sara.id, minutes(2));
    await prisma.computerJob.update({ where: { id }, data: { status: 'running', control: 'brick', waitingFor: null } });
    await requestHandover(id, 'signin', minutes(5));
    const second = (await mine([id]))[0];
    expect(second).toMatchObject({ kind: 'needs', waitingFor: 'signin', seq: 2 });
    // A confirmation of the first wait that arrives late does not hide the second
    await keepReportTold(id, 'needs', 1);
    expect((await mine([id])).map((report) => report.seq)).toEqual([2]);
    await keepReportTold(id, 'needs', 2);
    expect(await mine([id])).toEqual([]);
  });

  it('tells an ending only once everything it does is finished, and tells one a stopped server left half done after a while', async () => {
    const sara = await person('sara');
    const justNow = new Date();
    // Over, but its time is not yet in the books and its files not yet listed (the ending is still at work)
    const open = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Open', status: 'done', startedAt: new Date(justNow.getTime() - 60_000), endedAt: justNow } });
    expect((await reportsToTell(200, justNow)).filter((report) => report.jobId === open.id)).toEqual([]);
    // Its work finishes: now it is told
    await prisma.computerJob.update({ where: { id: open.id }, data: { endClosedAt: new Date() } });
    expect((await reportsToTell(200, justNow)).filter((report) => report.jobId === open.id).map((report) => report.kind)).toEqual(['done']);
    // One whose server stopped halfway is told as it stands, a few minutes later
    const stuck = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Stuck', status: 'done', startedAt: new Date(justNow.getTime() - 60_000), endedAt: justNow } });
    expect((await reportsToTell(200, justNow)).filter((report) => report.jobId === stuck.id)).toEqual([]);
    // Not while a hand-over of files could still be running (5 minutes plus the longest hand-over), then it goes out as it stands
    expect((await reportsToTell(200, new Date(justNow.getTime() + 6 * 60_000))).filter((report) => report.jobId === stuck.id)).toEqual([]);
    expect((await reportsToTell(200, new Date(justNow.getTime() + 10 * 60_000))).filter((report) => report.jobId === stuck.id).map((report) => report.kind)).toEqual(['done']);
  });

  it('holds an unclosed ending past nine minutes while a hand-over on its computer is live, never past an hour, and tells it when the hand-over is over', async () => {
    const sara = await person('sara');
    const justNow = new Date();
    const waiting = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'In line', status: 'done', startedAt: new Date(justNow.getTime() - 60_000), endedAt: justNow } });
    const at = (minutes: number) => new Date(justNow.getTime() + minutes * 60_000);
    const told = async (minutes: number) => (await reportsToTell(200, at(minutes))).filter((report) => report.jobId === waiting.id).map((report) => report.kind);
    // The hand-overs ahead of it take the machine one after the other: the last took it at minute 12
    const claim = (when: Date | null) => prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, machine: 'working', filesClaimedAt: when }, update: { filesClaimedAt: when } });
    await claim(at(12));
    expect(await told(10)).toEqual([]);
    expect(await told(13)).toEqual([]);
    // Nobody has taken it for longer than a hand-over can last: the ending is told as it stands
    expect(await told(12 + 5)).toEqual(['done']);
    // A claim that is let go is no hold
    await claim(null);
    expect(await told(13)).toEqual(['done']);
    // Never held for ever, whatever is claimed
    await claim(at(70));
    expect(await told(30)).toEqual([]);
    expect(await told(61)).toEqual(['done']);
  });

  it('does not tell an unclosed ending in the gap between two hand-overs while its job still beats as waiting, and tells it once it stopped beating', async () => {
    const sara = await person('sara');
    const justNow = new Date();
    const at = (minutes: number) => new Date(justNow.getTime() + minutes * 60_000);
    // Waiting in line for ten minutes: the machine has no claim on it at this moment, but the job beat a few seconds ago
    const waiting = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'In line', status: 'done', startedAt: at(-1), endedAt: justNow, handOverAliveAt: at(11.8) } });
    await prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, machine: 'working', filesClaimedAt: null }, update: { filesClaimedAt: null } });
    const told = async (minutes: number) => (await reportsToTell(200, at(minutes))).filter((report) => report.jobId === waiting.id).map((report) => report.kind);
    expect(await told(12)).toEqual([]);
    // It stopped beating (its server stopped): it is told as it stands
    expect(await told(13)).toEqual(['done']);
  });

  it('marks an ending closed when its own work is finished, so a real finish is told at once', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(5));
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id } })).endClosedAt).toEqual(expect.any(Date));
  });

  it('does not tell a wait the person already took over, and tells nothing of a job that is over for a wait it never told', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await requestHandover(id, 'upload', minutes(1));
    await takeOver(sara.brickId, sara.id, minutes(2));
    expect(await mine([id])).toEqual([]);
    await finishJob(id, 'done', minutes(8));
    expect((await mine([id])).map((report) => report.kind)).toEqual(['done']);
  });

  it('offers a person with no chat with no chat id, so the bot server can say it cannot, and offers nothing of a deleted Brick', async () => {
    const lena = await person('lena', null);
    const id = await started(lena);
    await finishJob(id, 'done', minutes(2));
    expect((await mine([id]))[0].matrixUserId).toBeNull();
    const omar = await person('omar');
    const other = await started(omar);
    await finishJob(other, 'done', minutes(2));
    await deleteBrick(omar.brickId, omar.id);
    expect(await mine([other])).toEqual([]);
  });

  it('never tells about jobs that were over before this existed: the migration marked them told', async () => {
    const sara = await person('sara');
    // As the migration leaves an old finished job
    const old = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Old', status: 'done', startedAt: minutes(-90), endedAt: minutes(-80), endToldAt: minutes(-80) } });
    expect(await mine([old.id])).toEqual([]);
  });

  it('says nothing is told for an unknown job', async () => {
    expect(await keepReportTold(randomUUID(), 'done')).toBe(false);
    expect(await keepReportTold(randomUUID(), 'needs', 1)).toBe(false);
  });
});
