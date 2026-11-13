/**
 * Money and the run (game #2002, Brick 11) against a real database, with the PRETEND computer provider. A model call a run made is on
 * the books under the run's own id, once however many times it is reported, and only for a run that is this Brick's; a computer job
 * a run starts is one job for that run, ever, with its room taken once, and its computer time carries the run. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-meter-runs-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { claimDueRuns, createItem, runOfBrick } from '@/lib/brick-items';
import { recordModelCall } from '@/lib/meter';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, startJob } from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const people: string[] = [];
let made = 0;
const env = process.env.COMPUTER_PROVIDER;

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  await prisma.userPreference.create({ data: { userId: user.id, key: 'timeZone', value: 'Asia/Kuwait' } });
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: user.uuid, brickId: brick.id };
}

/** A goal and its first run, claimed. */
async function goalRun(who: { uuid: string; brickId: string }) {
  const goal = await createItem(who.brickId, { userId: who.uuid, kind: 'goal', words: 'Get my visa', outcome: 'Visa issued', cadence: { type: 'every', minutes: 60 } }, NOW);
  if (!goal.ok) throw new Error(goal.error);
  const [started] = (await claimDueRuns(minutes(61))).filter((one) => one.itemId === goal.item.id);
  return { itemId: goal.item.id, runId: started.runId };
}

const call = (botId: string, over: Record<string, unknown> = {}) => ({
  usageRowId: Math.floor(Math.random() * 1e9),
  botId,
  providerId: 'universe-ai',
  keyOwnerId: null,
  talkedUserId: null,
  talkedPersonId: null,
  talkedGuest: null,
  channel: 'task',
  tokensUsed: 100,
  apiCalls: 1,
  error: false,
  greeting: false,
  costBasis: null,
  costMicros: 1200,
  occurredAt: minutes(62),
  ...over,
});

run('money and the run, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    setComputerProviderForTests(new FakeComputerProvider());
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
  });
  afterAll(async () => {
    const bots = (await prisma.bot.findMany({ where: { ownerId: { in: people } }, select: { id: true } })).map((bot) => bot.id);
    await prisma.meterReservation.deleteMany({ where: { botId: { in: bots } } });
    await prisma.meterEvent.deleteMany({ where: { botId: { in: bots } } });
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('puts a model call under the run’s id: once however often it is reported, and only for this Brick’s own run', async () => {
    const sara = await person('sara');
    const omar = await person('omar');
    const mine = await goalRun(sara);
    const theirs = await goalRun(omar);

    // The report names the run; the books check it is this Brick's before they keep it
    expect(await runOfBrick(sara.brickId, mine.runId)).toBe(mine.runId);
    expect(await runOfBrick(sara.brickId, theirs.runId)).toBeNull();
    expect(await runOfBrick(sara.brickId, 'nope')).toBeNull();
    expect(await runOfBrick(sara.brickId, null)).toBeNull();

    const first = await recordModelCall(call(sara.brickId, { clientEventId: 'c1', runId: mine.runId }) as never);
    expect(first).toEqual({ recorded: true, conflict: false });
    const again = await recordModelCall(call(sara.brickId, { clientEventId: 'c1', runId: mine.runId, usageRowId: 5 }) as never);
    expect(again).toMatchObject({ recorded: false });
    const events = await prisma.meterEvent.findMany({ where: { eventId: { startsWith: `run:${mine.runId}:` } } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: `run:${mine.runId}:model:c1`, kind: 'model_call', botId: sara.brickId, personId: sara.id });
    expect(events[0].detail).toMatchObject({ runId: mine.runId, channel: 'task' });

    // A call with no run, or one that was not checked, keeps the ids it always had
    await recordModelCall(call(sara.brickId, { clientEventId: 'c2' }) as never);
    expect(await prisma.meterEvent.count({ where: { eventId: `model:${sara.brickId}:c2` } })).toBe(1);
    // Without the bot server's own id for the call, the report's row stands in for it, so a different report is a different call
    await recordModelCall(call(sara.brickId, { runId: mine.runId, usageRowId: 77 }) as never);
    expect(await prisma.meterEvent.count({ where: { eventId: `run:${mine.runId}:model:row-77` } })).toBe(1);
  });

  it('starts one computer job for a run, ever, and a run that is not the person’s starts none', async () => {
    const sara = await person('sara');
    const omar = await person('omar');
    expect((await giveComputer(sara.brickId, sara.id)).ok).toBe(true);
    const mine = await goalRun(sara);
    const theirs = await goalRun(omar);

    const first = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fill in the form', runId: mine.runId }, NOW);
    expect(first.ok && first.job.status).toBe('running');
    const jobId = first.ok ? first.job.id : '';
    // Handed out again: the same job, no second one, no second room
    const again = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fill in the form', runId: mine.runId }, minutes(1));
    expect(again.ok && again.job.id).toBe(jobId);
    expect(await prisma.computerJob.count({ where: { botId: sara.brickId, runId: mine.runId } })).toBe(1);
    expect(await prisma.meterReservation.count({ where: { jobId } })).toBe(1);

    // Even after it ended, the run finds what its job came to rather than starting another
    await finishJob(jobId, 'done', minutes(5));
    const after = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Fill in the form', runId: mine.runId }, minutes(6));
    expect(after.ok && after.job).toMatchObject({ id: jobId, status: 'done' });
    expect(await prisma.computerJob.count({ where: { botId: sara.brickId, runId: mine.runId } })).toBe(1);

    // Someone else's run, a run of another Brick or one that does not exist: nothing starts
    expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'x', runId: theirs.runId }, NOW)).toEqual({ ok: false, reason: 'no_run' });
    expect(await startJob({ botId: sara.brickId, personId: sara.id, title: 'x', runId: randomUUID() }, NOW)).toEqual({ ok: false, reason: 'no_run' });

    // Its computer time is on the books with the run named
    const time = await prisma.meterEvent.findUnique({ where: { eventId: `computer:${jobId}:time` } });
    expect(time?.detail).toMatchObject({ runId: mine.runId });
  });
});
