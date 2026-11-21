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
import { seedGiveBackLimits, clearGiveBackLimits } from '../helpers/give-back-limits';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, planEffect, requestHandover, settleEffect, startJob, stopJobFor, sweepComputers, takeOver, turnOffComputer } from '@/lib/computer';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';
import { OWN_KEY_CALL_MARK, ORBIT_SOURCE } from '@/lib/computer-faults';

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
  await prisma.instantRun.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerRefundObligation.deleteMany({ where: { personId: { in: people } } });
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down', 'computer_late_report_since'] } } });
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
    await seedGiveBackLimits();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    await clearGiveBackLimits();
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

  it('tells that it could not finish with its one sentence cleaned of links and markup, and never gives back a run the agent gave up on', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    // The agent's own [[failed]] is the runner's `failed` with no cause: the job ran, so its minutes stay the person's and nothing is told as given back
    await finishJob(id, 'failed', minutes(6), 'The site kept failing at the **passport upload**, see [help](https://evil.example/pay) https://evil.example/x [[failed]]');
    expect(await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `computer:${id}:time` } })).toMatchObject({ personId: sara.id, personKey: `person:${sara.id}` });
    const [failed] = await mine([id]);
    expect(failed).toMatchObject({ kind: 'failed', why: 'The site kept failing at the passport upload, see help', givenBack: false });
    expect(failed.why).not.toMatch(/http|\[|\*/);
    // The same words with the cause the runner gives for the agent's own ending, or the turn cap, change nothing
    const capped = await started(sara, 'Capped');
    await finishJob(capped, 'failed', minutes(6), 'Out of turns', 'agent');
    expect(await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `computer:${capped}:time` } })).toMatchObject({ personId: sara.id });
    expect((await mine([capped]))[0].givenBack).toBe(false);
  });

  it('gives back a run the runner says failed on our side, and tells it so', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'failed', minutes(6), 'The relay was not there', 'ours');
    expect(await prisma.meterEvent.findFirstOrThrow({ where: { eventId: `computer:${id}:time` } })).toMatchObject({ personId: null, personKey: 'unknown' });
    expect((await mine([id]))[0]).toMatchObject({ kind: 'failed', givenBack: true });
  });

  it('says a try is given back only when the books show it written against nobody, or no minutes were counted', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'failed', minutes(6), null, 'ours');
    // The books as a failed job writes them now: minutes against nobody, marked, so it is told as given back
    expect((await mine([id]))[0].givenBack).toBe(true);
    // A line the books wrote against the person (nothing given back) is never told as given back
    await prisma.meterEvent.updateMany({ where: { eventId: `computer:${id}:time` }, data: { personId: sara.id, personKey: `person:${sara.id}`, detail: {} } });
    expect((await mine([id]))[0].givenBack).toBe(false);
    // The books as a given-back try writes them (minutes against nobody, marked)
    await prisma.meterEvent.updateMany({ where: { eventId: `computer:${id}:time` }, data: { personId: null, personKey: 'unknown', detail: { givenBack: true, forPersonId: sara.id } } });
    expect((await mine([id]))[0].givenBack).toBe(true);
    // No minutes counted at all
    const other = await started(await person('omar'), 'Quick');
    await finishJob(other, 'failed', NOW, null, 'ours');
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

  it('holds an unclosed ending past nine minutes while a hand-over on its computer is live, however long that goes on, and tells it when the claim is stale or let go', async () => {
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
    // A live claim holds it past an hour too (the hand-overs ahead go on one after the other): only a stale one does not
    await claim(at(60));
    expect(await told(61)).toEqual([]);
    expect(await told(63)).toEqual([]);
    // Not renewed for longer than a hand-over can last (4 minutes): stale
    expect(await told(65)).toEqual(['done']);
  });

  it('holds the ending of a job that still beats as waiting past an hour, and tells it once it stopped beating', async () => {
    const sara = await person('sara');
    const justNow = new Date();
    const at = (minutes: number) => new Date(justNow.getTime() + minutes * 60_000);
    const waiting = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'In line', status: 'done', startedAt: at(-1), endedAt: justNow, handOverAliveAt: at(89.9) } });
    await prisma.brickComputer.upsert({ where: { botId: sara.brickId }, create: { botId: sara.brickId, machine: 'working', filesClaimedAt: null }, update: { filesClaimedAt: null } });
    const told = async (minutes: number) => (await reportsToTell(200, at(minutes))).filter((report) => report.jobId === waiting.id).map((report) => report.kind);
    expect(await told(90)).toEqual([]);
    expect(await told(91)).toEqual(['done']);
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

  describe('GPT round 3: the one follow-up when an App went out after all', () => {
    // The deploy of this change, then the provider's log (a minute later, so after it)
    const SINCE = new Date('2026-11-21T10:00:00Z');
    const LATER = new Date('2026-11-21T11:00:00Z');
    const lateMine = async (jobIds: string[]) => (await reportsToTell(200, NOW, { accepts: ['late'] })).filter((report) => report.kind === 'late' && jobIds.includes(report.jobId));

    const letGo = (job: string, who: { id: string; brickId: string }, toolkit: string, over: { status?: string; at?: Date; customerState?: string; customerMicros?: number; state?: string; reason?: string } = {}) =>
      prisma.instantRun.create({
        data: {
          runKey: `k-${randomUUID()}`, botId: who.brickId, personId: who.id, taskKey: job, toolSlug: `${toolkit.toUpperCase()}_SEND`, toolkit, argsHash: `h-${randomUUID().slice(0, 6)}`, priceVersion: 'v',
          topMicros: BigInt(10_000), holdMicros: BigInt(10_000), state: over.state ?? 'failed', reason: over.reason ?? 'unclear', customerState: over.customerState ?? 'released', customerMicros: BigInt(over.customerMicros ?? 0),
          detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: over.status ?? 'success', chargeMicros: 0, at: (over.at ?? LATER).toISOString() } }, providerUserId: `u-${randomUUID().slice(0, 6)}`,
        } as never,
      });

    /** A computer job that failed on our side (given back) whose first report was delivered, with a Gmail let go unconfirmed that the log later confirmed */
    async function lateJob(name = 'sara', toolkit = 'gmail') {
      const who = await person(name);
      const id = await started(who);
      await finishJob(id, 'failed', minutes(6), 'The relay was not there', 'ours');
      await keepReportTold(id, 'failed');
      await letGo(id, who, toolkit);
      return { who, id };
    }

    beforeEach(async () => {
      await prisma.appSetting.upsert({ where: { key: 'computer_late_report_since' }, update: { value: SINCE.toISOString() }, create: { key: 'computer_late_report_since', value: SINCE.toISOString() } });
    });

    it('offers it once, with the Apps that went out, after the first report was delivered, and never to a reader that did not ask for it', async () => {
      const { who, id } = await lateJob();
      // An older game (no accepts) is never sent the kind; neither is one that asks for something else
      expect((await mine([id])).map((report) => report.kind)).not.toContain('late');
      expect((await reportsToTell(200, NOW, { accepts: ['other'] })).filter((report) => report.jobId === id)).toEqual([]);
      const [late, ...rest] = await lateMine([id]);
      expect(rest).toEqual([]);
      expect(late).toMatchObject({ key: `computer-told:${id}:late`, kind: 'late', jobId: id, botId: who.brickId, matrixUserId: expect.stringContaining('sara-'), apps: ['Gmail'], lateApps: ['Gmail'], holdReleased: true, givenBack: true, seq: null, effects: [], files: [] });
      // Told (said twice: the same), it is never offered again, and the ending's own mark is untouched
      const told = await prisma.computerJob.findUniqueOrThrow({ where: { id }, select: { endToldAt: true, lateToldAt: true } });
      expect(told.lateToldAt).toBeNull();
      expect(await keepReportTold(id, 'late')).toBe(true);
      const once = await prisma.computerJob.findUniqueOrThrow({ where: { id }, select: { endToldAt: true, lateToldAt: true } });
      expect(once.lateToldAt).toBeInstanceOf(Date);
      expect(once.endToldAt).toEqual(told.endToldAt);
      expect(await keepReportTold(id, 'late')).toBe(true);
      expect((await prisma.computerJob.findUniqueOrThrow({ where: { id }, select: { lateToldAt: true } })).lateToldAt).toEqual(once.lateToldAt);
      expect(await lateMine([id])).toEqual([]);
      // Nothing about it comes back as an ending either
      expect((await mine([id])).map((report) => report.kind)).toEqual([]);
    });

    it('one job with two Apps confirmed is one follow-up naming both, in the order confirmed, each once', async () => {
      const { who, id } = await lateJob();
      await letGo(id, who, 'slack', { at: new Date(LATER.getTime() + 60_000) });
      await letGo(id, who, 'gmail', { at: new Date(LATER.getTime() + 120_000) });
      const found = await lateMine([id]);
      expect(found).toHaveLength(1);
      expect(found[0].apps).toEqual(['Gmail', 'Slack']);
    });

    it('both arrival orders: confirmed before the first report was told, it waits for that report and is offered after it; confirmed after, at once', async () => {
      const who = await person('sara');
      const id = await started(who);
      await finishJob(id, 'failed', minutes(6), 'The relay was not there', 'ours');
      await letGo(id, who, 'gmail');
      // The first report is not told yet: this follows it, never leads it
      expect(await lateMine([id])).toEqual([]);
      expect((await mine([id])).map((report) => report.kind)).toEqual(['failed']);
      await keepReportTold(id, 'failed');
      expect((await lateMine([id])).map((report) => report.apps)).toEqual([['Gmail']]);
      // The other order (the first report delivered first, the confirmation later) is the one every other test here uses
      const { id: second } = await lateJob('omar');
      expect((await lateMine([second])).map((report) => report.kind)).toEqual(['late']);
    });

    it('a person who never got the first report (it could not be delivered) is never told, and a reply that could not be delivered still ends it for good', async () => {
      const { id } = await lateJob('sara');
      await prisma.computerJob.update({ where: { id }, data: { endUndeliverableAt: minutes(7), endUndeliverableWhy: 'no_chat' } });
      expect(await lateMine([id])).toEqual([]);
      // Told as undeliverable: the follow-up is also over (never offered again)
      const { id: other } = await lateJob('omar');
      expect(await keepReportTold(other, 'late', undefined, { delivered: false, why: 'no_chat' })).toBe(true);
      expect(await lateMine([other])).toEqual([]);
    });

    it('never for an App the log said failed, one nobody could confirm, one that was charged, one not let go, or a confirmation from before this shipped', async () => {
      // One person each: a person's month only gives back so many (a later one would not be "given back" for that reason, not the one under test)
      const make = async (name: string) => {
        const who = await person(name);
        const id = await started(who);
        await finishJob(id, 'failed', minutes(6), 'The relay was not there', 'ours');
        await keepReportTold(id, 'failed');
        // It is the sort of job that WOULD be offered: given back, first report told
        expect((await prisma.computerGiveBackDecision.findUniqueOrThrow({ where: { jobId: id } })).state).toBe('given');
        return { who, id };
      };
      const none = await make('p1');
      const failed = await make('p2');
      const charged = await make('p3');
      const held = await make('p4');
      const ran = await make('p5');
      const early = await make('p6');
      // No log said anything
      await prisma.instantRun.create({
        data: { runKey: `k-${randomUUID()}`, botId: none.who.brickId, personId: none.who.id, taskKey: none.id, toolSlug: 'GMAIL_SEND', toolkit: 'gmail', argsHash: 'h', priceVersion: 'v', topMicros: BigInt(1), holdMicros: BigInt(1), state: 'failed', reason: 'unclear', customerState: 'released', customerMicros: BigInt(0), detail: { noLog: true, releasedUnconfirmed: true }, providerUserId: 'u' } as never,
      });
      await letGo(failed.id, failed.who, 'gmail', { status: 'failed' });
      await letGo(charged.id, charged.who, 'gmail', { customerState: 'charged', customerMicros: 10_000 });
      await letGo(held.id, held.who, 'gmail', { customerState: 'held' });
      await letGo(ran.id, ran.who, 'gmail', { state: 'succeeded', reason: 'ok' });
      await letGo(early.id, early.who, 'gmail', { at: new Date(SINCE.getTime() - 60_000) });
      expect(await lateMine([none.id, failed.id, charged.id, held.id, ran.id, early.id])).toEqual([]);
    });

    it('never for a job that was not given back by a decision (a quick job that ended fine with no minutes counted) even though the books look given back', async () => {
      const who = await person('sara');
      const id = await started(who);
      await finishJob(id, 'done', NOW);
      await keepReportTold(id, 'done');
      await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${id}:time` } });
      await prisma.computerJob.update({ where: { id }, data: { secondsRun: 0 } });
      await prisma.computerGiveBackDecision.deleteMany({ where: { jobId: id } });
      await letGo(id, who, 'gmail');
      expect(await lateMine([id])).toEqual([]);
    });

    it('never for a job with a call on the person’s own key, a computer that was not given back, a refund still pending, or a deleted Brick', async () => {
      const own = await lateJob('sara');
      await prisma.computerJobFault.create({ data: { jobId: own.id, turn: null, run: null, callId: OWN_KEY_CALL_MARK, kind: 'answered', reason: 'own_key', source: ORBIT_SOURCE, route: null, providerStatus: null, at: NOW } });
      // The job ended on the agent's own account (nothing given back)
      const who = await person('tom');
      const agent = await started(who);
      await finishJob(agent, 'failed', minutes(6), 'Out of turns', 'agent');
      await keepReportTold(agent, 'failed');
      await letGo(agent, who, 'gmail');
      const owed = await lateJob('lena');
      await prisma.computerRefundObligation.create({ data: { jobId: owed.id, personId: owed.who.id, holdKey: `h-${randomUUID()}`, refundKey: `r-${randomUUID()}`, amountMicros: BigInt(30_000), state: 'owed' } });
      const gone = await lateJob('omar');
      await deleteBrick(gone.who.brickId, gone.who.id);
      expect(await lateMine([own.id, agent, owed.id, gone.id])).toEqual([]);
      // The same job offered once the refund is acknowledged: a pending refund only delays it
      await prisma.computerRefundObligation.updateMany({ where: { jobId: owed.id }, data: { state: 'acknowledged' } });
      expect((await lateMine([owed.id])).map((report) => report.kind)).toEqual(['late']);
    });

    it('Opus: jobs that are not eligible yet, ahead of an eligible one, never crowd it out: size 1 with four ineligible jobs (older confirmations) ahead of one eligible job still offers the eligible one', async () => {
      const make = async (name: string, at: Date) => {
        const who = await person(name);
        const id = await started(who);
        await finishJob(id, 'failed', minutes(6), 'The relay was not there', 'ours');
        await keepReportTold(id, 'failed');
        await letGo(id, who, 'gmail', { at });
        return { who, id };
      };
      const crowd: string[] = [];
      for (let n = 0; n < 4; n++) {
        const one = await make(`crowd${n}`, new Date(LATER.getTime() + n * 60_000));
        // A refund still owed back: dropped for now (it may be offered later), and never marked
        await prisma.computerRefundObligation.create({ data: { jobId: one.id, personId: one.who.id, holdKey: `h-${randomUUID()}`, refundKey: `r-${randomUUID()}`, amountMicros: BigInt(30_000), state: 'owed' } });
        crowd.push(one.id);
      }
      const eligible = await make('eligible', new Date(LATER.getTime() + 60 * 60_000));
      const offered = (await reportsToTell(1, NOW, { accepts: ['late'] })).filter((report) => report.kind === 'late');
      expect(offered.map((report) => report.jobId)).toEqual([eligible.id]);
      // The ones never offered are still waiting, not lost: once their refunds are acknowledged they are offered, oldest first
      await prisma.computerRefundObligation.updateMany({ where: { jobId: { in: crowd } }, data: { state: 'acknowledged' } });
      expect((await reportsToTell(1, NOW, { accepts: ['late'] })).filter((report) => report.kind === 'late').map((report) => report.jobId)).toEqual([crowd[0]]);
      // What can never change is not even read: a job whose decision is no give-back, one with a call on the person's own key, one whose Brick is gone
      const own = await make('ownkey', new Date(LATER.getTime() - 60_000));
      await prisma.computerJobFault.create({ data: { jobId: own.id, turn: null, run: null, callId: OWN_KEY_CALL_MARK, kind: 'answered', reason: 'own_key', source: ORBIT_SOURCE, route: null, providerStatus: null, at: NOW } });
      expect((await reportsToTell(200, NOW, { accepts: ['late'] })).filter((report) => report.jobId === own.id)).toEqual([]);
    });

    it('says nothing is told for an unknown job, and a confirmation sent before the deploy record exists keeps the time of the first look', async () => {
      expect(await keepReportTold(randomUUID(), 'late')).toBe(false);
      await prisma.appSetting.deleteMany({ where: { key: 'computer_late_report_since' } });
      const { id } = await lateJob('sara');
      // The confirmation is from before this first look (an hour before NOW): never offered, and the look is kept
      const run = await prisma.instantRun.findFirstOrThrow({ where: { taskKey: id } });
      await prisma.instantRun.update({ where: { id: run.id }, data: { detail: { noLog: true, releasedUnconfirmed: true, lateEvidence: { status: 'success', chargeMicros: 0, at: minutes(-60).toISOString() } } } });
      expect(await lateMine([id])).toEqual([]);
      expect(await prisma.appSetting.findUnique({ where: { key: 'computer_late_report_since' } })).toMatchObject({ value: NOW.toISOString() });
    });
  });
});
