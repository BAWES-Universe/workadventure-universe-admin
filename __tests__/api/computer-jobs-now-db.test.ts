/**
 * What a Brick is told about its own computer jobs with every message (the Brick chat audit, 26 Nov, findings 3 and 4), against a real database: GET /api/bots/:id/computer-jobs?jobs=1.
 * A job that finished is still there for the Brick to see (it said "there was no job" about one), the live ones come in the order the bar shows them, and only the owner's own
 * jobs, never another person's. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-jobs-now-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn(), getClient: jest.fn(() => undefined), flush: jest.fn(async () => true) }));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { giveComputer } from '@/lib/computer';
import { JOBS_NOW_ENDED_MAX, jobsNow } from '@/lib/computer-jobs-now';
import { GET } from '@/app/api/bots/[id]/computer-jobs/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  return { id: user.id, uuid: unique, brickId: brick.id };
}

type Who = { id: string; brickId: string };
const job = (who: Who, title: string, data: Record<string, unknown>) => prisma.computerJob.create({ data: { botId: who.brickId, personId: who.id, title, ...data } });

const look = async (who: { uuid: string; brickId: string }, query = '&jobs=1') =>
  (await GET(new NextRequest(`http://orbit.test/api/bots/${who.brickId}/computer-jobs?userId=${encodeURIComponent(who.uuid)}${query}`), { params: Promise.resolve({ id: who.brickId }) })).json();

run('a Brick sees its own computer jobs, live and lately ended, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    setComputerProviderForTests(new FakeComputerProvider());
  });
  afterAll(async () => {
    await prisma.computerJobFile.deleteMany({ where: { ownerId: { in: people } } });
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('a job that ran and finished is told as done, with nothing running (the Airbnb search the Brick said never existed)', async () => {
    const khalid = await person('k-done');
    await job(khalid, 'Airbnb Bangkok search', { status: 'done', startedAt: minutes(-20), endedAt: minutes(-9), endNote: 'should not be said for a finished job' });
    const answer = await look(khalid);
    expect(answer.on).toBe(true);
    expect(answer.jobs.live).toEqual([]);
    expect(answer.jobs.ended).toHaveLength(1);
    expect(answer.jobs.ended[0]).toMatchObject({ title: 'Airbnb Bangkok search', status: 'done', endedBy: null, why: null, files: [] });
    expect(new Date(answer.jobs.ended[0].endedAt).getTime()).toBe(minutes(-9).getTime());
  });

  it('the live jobs come with their state and step, the one holding the computer first, then the line in order', async () => {
    const khalid = await person('k-live');
    await job(khalid, 'Taxi booking', { status: 'queued', queuedFor: 'turn', createdAt: minutes(-3) });
    await job(khalid, 'Visa form', { status: 'running', startedAt: minutes(-2), createdAt: minutes(-2), stepDone: 2, stepTotal: 6, stepLabel: 'Opening the form' });
    await job(khalid, 'Shop website', { status: 'queued', queuedFor: 'paused', createdAt: minutes(-1), pauses: 1 });
    const { jobs } = await look(khalid);
    expect(jobs.live.map((one: { title: string }) => one.title)).toEqual(['Visa form', 'Taxi booking', 'Shop website']);
    expect(jobs.live[0]).toMatchObject({ status: 'running', stepDone: 2, stepTotal: 6, stepLabel: 'Opening the form', control: 'brick', queuedFor: null, waitingFor: null });
    expect(jobs.live[1]).toMatchObject({ status: 'queued', queuedFor: 'turn' });
    expect(jobs.live[2]).toMatchObject({ status: 'queued', queuedFor: 'paused' });
  });

  it('a job waiting for the person says what for, and who has the screen', async () => {
    const khalid = await person('k-wait');
    await job(khalid, 'Visa form', { status: 'waiting', waitingFor: 'signin', control: 'person', startedAt: minutes(-4) });
    const { jobs } = await look(khalid);
    expect(jobs.live[0]).toMatchObject({ status: 'waiting', waitingFor: 'signin', control: 'person' });
  });

  it('an ended job says how it ended, the cleaned reason of one that could not go on, and the files it handed over', async () => {
    const khalid = await person('k-ended');
    const failed = await job(khalid, 'Shop website', { status: 'failed', endedBy: 'error', startedAt: minutes(-30), endedAt: minutes(-20), endNote: 'The site [would not](https://evil.example) load' });
    const stopped = await job(khalid, 'Visa form', { status: 'stopped', endedBy: 'person', startedAt: minutes(-15), endedAt: minutes(-10), endNote: 'person stopped' });
    const done = await job(khalid, 'Price list', { status: 'done', startedAt: minutes(-8), endedAt: minutes(-5) });
    await prisma.computerJobFile.create({ data: { jobId: done.id, botId: khalid.brickId, makerName: 'Brick', ownerId: khalid.id, jobTitle: 'Price list', name: 'prices.csv', path: 'Documents/prices.csv', modifiedAt: minutes(-5), bytes: 10, mimeType: 'text/csv' } });
    const { jobs } = await look(khalid);
    expect(jobs.ended.map((one: { title: string }) => one.title)).toEqual(['Price list', 'Visa form', 'Shop website']);
    expect(jobs.ended[0]).toMatchObject({ status: 'done', files: ['prices.csv'], why: null });
    expect(jobs.ended[1]).toMatchObject({ status: 'stopped', endedBy: 'person', why: null });
    expect(jobs.ended[2]).toMatchObject({ status: 'failed', endedBy: 'error', why: 'The site would not load' });
    expect(failed.id).not.toBe(stopped.id);
  });

  it(`only the latest ${JOBS_NOW_ENDED_MAX} ended jobs, and none older than a week`, async () => {
    const khalid = await person('k-many');
    await job(khalid, 'Old one', { status: 'done', endedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000) });
    for (let n = 1; n <= JOBS_NOW_ENDED_MAX + 1; n++) await job(khalid, `Job ${n}`, { status: 'done', endedAt: minutes(-60 + n) });
    const now = await jobsNow(khalid.brickId, khalid.id, NOW);
    expect(now.ended.map((one) => one.title)).toEqual(['Job 4', 'Job 3', 'Job 2']);
  });

  it("another person's look at this Brick sees none of its owner's jobs", async () => {
    const khalid = await person('k-own');
    const stranger = await person('k-stranger');
    await job(khalid, 'Visa form', { status: 'running', startedAt: minutes(-1) });
    await job(khalid, 'Price list', { status: 'done', endedAt: minutes(-1) });
    const theirs = await look({ uuid: stranger.uuid, brickId: khalid.brickId });
    expect(theirs.jobs).toEqual({ live: [], ended: [] });
  });

  it('a look without jobs=1 answers as before, with no jobs', async () => {
    const khalid = await person('k-plain');
    await job(khalid, 'Visa form', { status: 'running', startedAt: minutes(-1) });
    const answer = await look(khalid, '');
    expect(answer).toEqual({ available: true, on: true, busy: true });
  });
});
