/**
 * Goals and tasks (game #2002) against a real database: what only the database can show. One due time runs once, however
 * many servers ask at the same moment; paused, done, deleted, a deleted Brick and a Brick switched off run nothing; an
 * outage gives one catch-up and never a backlog; a change stops work that already started; an account that never asked
 * for one has nothing. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-items-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { deleteBrick, undoBrickDelete } from '@/lib/brick-delete';
import { makeBrick } from '@/lib/brick-make';
import { saveServerLimits } from '@/lib/bot-limits';
import { changeItem, checkRun, claimDueRuns, createItem, finishRun, itemSettings, keepWorkweek, listItems, readItem, type NewItemInput } from '@/lib/brick-items';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Thursday 12 Nov 2026, 9:00 in Kuwait
const NOW = new Date('2026-11-12T06:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

async function person(name: string, zone: string | null = 'Asia/Kuwait') {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  if (zone) await prisma.userPreference.create({ data: { userId: user.id, key: 'timeZone', value: zone } });
  const { brick } = await ensureDefaultBrick(user.id);
  return { id: user.id, uuid: user.uuid, email: user.email!, brickId: brick!.id };
}

const remind = (over: Partial<NewItemInput> = {}): NewItemInput => ({
  userId: '',
  kind: 'reminder',
  words: 'Call the dentist',
  cadence: { type: 'once', at: at(HOUR).toISOString() },
  ...over,
});

async function set(who: { uuid: string; brickId: string }, over: Partial<NewItemInput> = {}, now = NOW) {
  const answer = await createItem(who.brickId, { ...remind(over), userId: who.uuid }, now);
  if (!answer.ok) throw new Error(`could not set it: ${answer.error}`);
  return answer.item;
}

const runsOf = (itemId: string) => prisma.brickItemRun.findMany({ where: { itemId }, orderBy: { claimedAt: 'asc' } });

run('goals and tasks, in a real database', () => {
  beforeAll(async () => {
    // Settings are the starting ones: 20 at once, 30 minutes shortest, 24 runs a day, 10 minutes a run, 15 minutes late
    await prisma.appSetting.deleteMany({ where: { key: 'server-limits' } }).catch(() => undefined);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('sets a reminder for the owner only, in the zone kept for them, and refuses what cannot be set with a reason the Brick can say', async () => {
    const sara = await person('sara');
    const lina = await person('lina');
    const item = await set(sara);
    expect(item).toMatchObject({ kind: 'reminder', state: 'on', setBy: 'you', timeZone: 'Asia/Kuwait', revision: 1, nextDueAt: at(HOUR).toISOString() });

    // Someone else's chat, a name nobody has, and a Brick that does not exist are all the same "not found"
    expect(await createItem(sara.brickId, { ...remind(), userId: lina.uuid }, NOW)).toMatchObject({ ok: false, status: 404 });
    expect(await createItem(sara.brickId, { ...remind(), userId: 'nobody' }, NOW)).toMatchObject({ ok: false, status: 404 });
    expect(await listItems(sara.brickId, lina.uuid)).toMatchObject({ ok: false, status: 404 });
    expect(await readItem(sara.brickId, item.id, lina.uuid)).toMatchObject({ ok: false, status: 404 });

    // No zone is kept for this person: the Brick has to ask, nothing is guessed
    const nina = await person('nina', null);
    expect(await createItem(nina.brickId, { ...remind(), userId: nina.uuid }, NOW)).toMatchObject({ ok: false, status: 422, code: 'needs_time_zone' });
    expect(await createItem(nina.brickId, { ...remind(), userId: nina.uuid, timeZone: 'Europe/London' }, NOW)).toMatchObject({ ok: true });

    expect(await createItem(sara.brickId, { ...remind({ cadence: { type: 'once', at: at(-HOUR).toISOString() } }), userId: sara.uuid }, NOW)).toMatchObject({ ok: false, code: 'past' });
    expect(await createItem(sara.brickId, { ...remind({ kind: 'watch', condition: 'The price drops', cadence: { type: 'every', minutes: 5 } }), userId: sara.uuid }, NOW)).toMatchObject({ ok: false, status: 422, code: 'too_often', limit: 30 });
    expect(await createItem(sara.brickId, { ...remind({ kind: 'watch', cadence: { type: 'every', minutes: 60 } }), userId: sara.uuid }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await createItem(sara.brickId, { ...remind({ kind: 'goal', outcome: 'A visa', cadence: { type: 'none' } }), userId: sara.uuid }, NOW)).toMatchObject({ ok: false, code: 'needs_wait' });
    expect(await createItem(sara.brickId, { ...remind({ cadence: { type: 'every', minutes: 60 } }), userId: sara.uuid }, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it('keeps the person’s zone and workdays, and never guesses either', async () => {
    const omar = await person('omar', null);
    expect(await itemSettings(omar.brickId, omar.uuid)).toMatchObject({ ok: true, timeZone: null, workdays: null });
    await prisma.userPreference.create({ data: { userId: omar.id, key: 'timeZone', value: 'Asia/Kuwait' } });
    expect(await keepWorkweek(omar.brickId, omar.uuid, [4, 0, 1, 2, 3])).toEqual({ ok: true, workdays: [0, 1, 2, 3, 4] });
    expect(await keepWorkweek(omar.brickId, omar.uuid, [])).toMatchObject({ ok: false, status: 400 });
    expect(await itemSettings(omar.brickId, omar.uuid)).toMatchObject({ ok: true, timeZone: 'Asia/Kuwait', workdays: [0, 1, 2, 3, 4], limits: { shortestRepeat: 30 } });
  });

  it('stops at the most goals and tasks a person can have, counting paused ones and not done ones', async () => {
    const hadi = await person('hadi');
    await saveServerLimits({ bricks: { itemsPerPerson: 2 } }, hadi.id);
    try {
      const first = await set(hadi);
      await set(hadi);
      expect(await createItem(hadi.brickId, { ...remind(), userId: hadi.uuid }, NOW)).toMatchObject({ ok: false, status: 422, code: 'too_many', limit: 2 });
      // Two at the same moment never both take the last place
      await changeItem(hadi.brickId, first.id, { userId: hadi.uuid, action: 'done' }, NOW);
      const both = await Promise.all([1, 2, 3].map(() => createItem(hadi.brickId, { ...remind(), userId: hadi.uuid }, NOW)));
      expect(both.filter((answer) => answer.ok)).toHaveLength(1);
    } finally {
      await saveServerLimits({ bricks: { itemsPerPerson: 20 } }, hadi.id);
    }
  });

  it('runs one due time once, however many servers ask at the same moment, and never again', async () => {
    const maya = await person('maya');
    const item = await set(maya);
    expect(await claimDueRuns(at(HOUR - MIN))).toEqual([]);
    const batches = await Promise.all([1, 2, 3, 4, 5, 6].map(() => claimDueRuns(at(HOUR + MIN))));
    const mine = batches.flat().filter((one) => one.itemId === item.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'reminder', userId: maya.uuid, brickId: maya.brickId, late: false, fresh: false, attempt: 1, revision: 1, timeZone: 'Asia/Kuwait' });
    expect(await runsOf(item.id)).toHaveLength(1);
    // Asked again, nothing new is made for this due time (a run nobody reported can only be handed out again, with the same id)
    for (const when of [at(HOUR + 2 * MIN), at(DAY)]) {
      expect((await claimDueRuns(when)).filter((one) => one.itemId === item.id && one.runId !== mine[0].runId)).toEqual([]);
    }
    expect(await runsOf(item.id)).toHaveLength(1);
  });

  it('the database itself refuses a second run for one due time', async () => {
    const zed = await person('zed');
    const item = await set(zed);
    const [claimed] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === item.id);
    await expect(prisma.brickItemRun.create({ data: { itemId: item.id, dueAt: new Date(claimed.dueAt), revision: 1, leaseUntil: at(DAY) } })).rejects.toThrow();
  });

  it('runs nothing once it is paused, done or deleted, and nothing for a Brick that is off', async () => {
    const lena = await person('lena');
    const paused = await set(lena);
    const done = await set(lena);
    const deleted = await set(lena);
    const kept = await set(lena);
    await changeItem(lena.brickId, paused.id, { userId: lena.uuid, action: 'pause' }, NOW);
    await changeItem(lena.brickId, done.id, { userId: lena.uuid, action: 'done', result: 'Did it myself' }, NOW);
    await changeItem(lena.brickId, deleted.id, { userId: lena.uuid, action: 'delete' }, NOW);
    expect((await prisma.brickItem.findUnique({ where: { id: paused.id } }))).toMatchObject({ state: 'paused', nextDueAt: null, revision: 2 });
    const ran = (await claimDueRuns(at(HOUR + MIN))).filter((one) => [paused.id, done.id, deleted.id, kept.id].includes(one.itemId));
    expect(ran.map((one) => one.itemId)).toEqual([kept.id]);
    for (const id of [paused.id, done.id, deleted.id]) expect(await runsOf(id)).toHaveLength(0);
    // Resume: it is due again from the person’s word, not from the past
    const resumed = await changeItem(lena.brickId, paused.id, { userId: lena.uuid, action: 'resume' }, at(HOUR + 5 * MIN));
    expect(resumed).toMatchObject({ ok: true, item: { state: 'on', revision: 3 } });
    // A Brick that is switched off runs nothing, and nothing is set for it
    const off = await set(lena, { cadence: { type: 'once', at: at(3 * HOUR).toISOString() } });
    await prisma.bot.update({ where: { id: lena.brickId }, data: { enabled: false } });
    expect((await claimDueRuns(at(3 * HOUR + MIN))).filter((one) => one.itemId === off.id)).toEqual([]);
    expect(await createItem(lena.brickId, { ...remind(), userId: lena.uuid }, NOW)).toMatchObject({ ok: false, status: 409, code: 'off' });
    await prisma.bot.update({ where: { id: lena.brickId }, data: { enabled: true } });
    expect((await claimDueRuns(at(3 * HOUR + 2 * MIN))).filter((one) => one.itemId === off.id)).toHaveLength(1);
  });

  it('pauses everything when its Brick is deleted, and Undo does not switch any of it back on', async () => {
    const rami = await person('rami');
    const second = await makeBrick(rami.id, { name: 'Garden Brick' });
    const a = await set({ uuid: rami.uuid, brickId: second.id }, { words: 'Water the plants', cadence: { type: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } });
    const finished = await set({ uuid: rami.uuid, brickId: second.id });
    await changeItem(second.id, finished.id, { userId: rami.uuid, action: 'done' }, NOW);
    const other = await set(rami);
    await deleteBrick(second.id, rami.id, NOW);
    expect(await prisma.brickItem.findUnique({ where: { id: a.id } })).toMatchObject({ state: 'paused', pausedBy: 'brick_deleted', nextDueAt: null, revision: 2 });
    expect(await prisma.brickItem.findUnique({ where: { id: finished.id } })).toMatchObject({ state: 'done' });
    expect(await prisma.brickItem.findUnique({ where: { id: other.id } })).toMatchObject({ state: 'on' });
    await undoBrickDelete(second.id, rami.id, at(HOUR));
    expect(await prisma.brickItem.findUnique({ where: { id: a.id } })).toMatchObject({ state: 'paused', nextDueAt: null });
    expect((await claimDueRuns(at(2 * DAY))).filter((one) => one.itemId === a.id)).toEqual([]);
    // Only the owner can switch it on, with the Brick back on
    expect(await changeItem(second.id, a.id, { userId: rami.uuid, action: 'resume' }, at(2 * HOUR))).toMatchObject({ ok: true, item: { state: 'on' } });
  });

  it('after an outage a reminder comes once and says it is late, a watch does one fresh check, and nothing is replayed', async () => {
    const dana = await person('dana');
    const briefing = await set(dana, { kind: 'schedule', words: 'Tell me what is on', cadence: { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4] } });
    const watch = await set(dana, { kind: 'watch', words: 'The flight price', condition: 'It drops below 100', cadence: { type: 'every', minutes: 60 } });
    const reminder = await set(dana, { cadence: { type: 'once', at: at(HOUR).toISOString() } });
    // Down for three days: Sunday 15, Monday 16 and Tuesday 17 mornings were missed
    const back = at(5 * DAY);
    const claimed = (await claimDueRuns(back)).filter((one) => [briefing.id, watch.id, reminder.id].includes(one.itemId));
    expect(claimed).toHaveLength(3);
    expect(claimed.find((one) => one.itemId === briefing.id)).toMatchObject({ late: true, fresh: false, dueAt: '2026-11-15T04:30:00.000Z' });
    expect(claimed.find((one) => one.itemId === watch.id)).toMatchObject({ late: false, fresh: true });
    expect(claimed.find((one) => one.itemId === reminder.id)).toMatchObject({ late: true, fresh: false, dueAt: at(HOUR).toISOString() });
    // The next one is the first still to come, never one that is past
    const next = await prisma.brickItem.findUniqueOrThrow({ where: { id: briefing.id } });
    expect(next.nextDueAt!.getTime()).toBeGreaterThan(back.getTime());
    expect(next.nextDueAt!.toISOString()).toBe('2026-11-18T04:30:00.000Z');
    expect((await prisma.brickItem.findUniqueOrThrow({ where: { id: watch.id } })).nextDueAt!.getTime()).toBeGreaterThan(back.getTime());
    expect(await claimDueRuns(at(5 * DAY + MIN))).toEqual([]);
    expect(await runsOf(briefing.id)).toHaveLength(1);
  });

  it('a change stops what already started: the run is told no at its next step and its report changes nothing', async () => {
    const eli = await person('eli');
    const item = await set(eli, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const [started] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === item.id);
    expect(await checkRun(started.runId)).toEqual({ ok: true });
    await changeItem(eli.brickId, item.id, { userId: eli.uuid, action: 'pause' }, at(HOUR + 2 * MIN));
    expect(await checkRun(started.runId)).toEqual({ ok: false, reason: 'paused' });
    const reported = await finishRun(started.runId, { state: 'done', outcome: 'spoke', result: 'Sent it' }, at(HOUR + 3 * MIN));
    expect(reported).toMatchObject({ ok: true, applied: false });
    // The run is still in the record as it was reported
    expect(await runsOf(item.id)).toMatchObject([{ state: 'done', outcome: 'spoke', result: 'Sent it' }]);
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: 'paused', nextDueAt: null });
    expect(await finishRun(started.runId, { state: 'done' })).toMatchObject({ ok: false, status: 409 });
    // Changed, not paused: a new revision, and reopening a done one starts from the new revision
    const second = await set(eli, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const [other] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === second.id);
    await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'change', change: { words: 'Only the important things' } }, at(HOUR + 2 * MIN));
    expect(await checkRun(other.runId)).toEqual({ ok: false, reason: 'changed' });
    await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'done' }, at(HOUR + 3 * MIN));
    const reopened = await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'reopen' }, at(HOUR + 4 * MIN));
    expect(reopened).toMatchObject({ ok: true, item: { state: 'on', revision: 4 } });
    expect(await checkRun(other.runId)).toMatchObject({ ok: false });
  });

  it('a one-off ends with its one run, a watch that spoke moves to Done, and a failed run is on record at once and counted', async () => {
    const tala = await person('tala');
    const oneOff = await set(tala);
    const watch = await set(tala, { kind: 'watch', words: 'The flight price', condition: 'It drops', cadence: { type: 'every', minutes: 60 } });
    const flaky = await set(tala, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const claimed = await claimDueRuns(at(HOUR + MIN));
    const get = (id: string) => claimed.find((one) => one.itemId === id)!;
    expect(await finishRun(get(oneOff.id).runId, { state: 'done', outcome: 'spoke', result: 'Reminded' }, at(HOUR + 2 * MIN))).toMatchObject({ ok: true, applied: true, item: { state: 'done', nextDueAt: null } });
    expect(await finishRun(get(watch.id).runId, { state: 'done', outcome: 'quiet' }, at(HOUR + 2 * MIN))).toMatchObject({ item: { state: 'on' } });
    expect(await finishRun(get(flaky.id).runId, { state: 'failed', error: 'Calendar did not answer' }, at(HOUR + 2 * MIN))).toMatchObject({ ok: true, failuresInRow: 1 });
    expect(await runsOf(flaky.id)).toMatchObject([{ state: 'failed', error: 'Calendar did not answer' }]);
    const again = (await claimDueRuns(at(2 * HOUR + MIN))).filter((one) => [watch.id, flaky.id].includes(one.itemId));
    const spoke = await finishRun(again.find((one) => one.itemId === watch.id)!.runId, { state: 'done', outcome: 'spoke', result: 'It dropped to 92' }, at(2 * HOUR + 2 * MIN));
    expect(spoke).toMatchObject({ item: { state: 'done', result: 'It dropped to 92' } });
    expect(await finishRun(again.find((one) => one.itemId === flaky.id)!.runId, { state: 'done', outcome: 'quiet' }, at(2 * HOUR + 2 * MIN))).toMatchObject({ failuresInRow: 0 });
    // A done watch is not run again; Reopen starts it from now
    expect((await claimDueRuns(at(5 * HOUR))).filter((one) => one.itemId === watch.id)).toEqual([]);
    expect(await changeItem(tala.brickId, watch.id, { userId: tala.uuid, action: 'reopen' }, at(5 * HOUR))).toMatchObject({ ok: true, item: { state: 'on', nextDueAt: at(6 * HOUR).toISOString() } });
  });

  it('hands a run that was never reported out again with the same id, then gives it up as failed', async () => {
    const yara = await person('yara');
    const item = await set(yara, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const [first] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === item.id);
    // Still inside its lease: nothing is handed out again
    expect((await claimDueRuns(at(HOUR + 5 * MIN))).filter((one) => one.itemId === item.id)).toEqual([]);
    const second = (await claimDueRuns(at(HOUR + 20 * MIN))).filter((one) => one.runId === first.runId);
    expect(second).toMatchObject([{ attempt: 2 }]);
    const third = (await claimDueRuns(at(HOUR + 40 * MIN))).filter((one) => one.runId === first.runId);
    expect(third).toMatchObject([{ attempt: 3 }]);
    expect((await claimDueRuns(at(HOUR + 60 * MIN))).filter((one) => one.runId === first.runId)).toEqual([]);
    expect((await runsOf(item.id))[0]).toMatchObject({ state: 'failed', attempts: 3, error: 'It did not finish in time' });
    expect((await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).failuresInRow).toBe(1);
  });

  it('does not let a person at their runs a day fill the batch ahead of everyone else', async () => {
    const ivy = await person('ivy');
    const kai = await person('kai');
    await saveServerLimits({ bricks: { runsPerDay: 1 } }, ivy.id);
    // Leave only these two in the queue: what other tests of this file left due would be ahead of both
    await prisma.brickItem.updateMany({ where: { ownerId: { notIn: [ivy.id, kai.id] }, state: 'on' }, data: { state: 'paused', nextDueAt: null } });
    try {
      // Ivy has three watches due long ago and has used her one run today; Kai's is due later
      for (const name of ['a', 'b', 'c']) await set(ivy, { kind: 'watch', words: name, condition: 'It changes', cadence: { type: 'every', minutes: 60 } });
      expect((await claimDueRuns(at(HOUR + MIN))).filter((one) => one.userId === ivy.uuid)).toHaveLength(1);
      const kaiWatch = await set(kai, { kind: 'watch', words: 'k', condition: 'It changes', cadence: { type: 'every', minutes: 90 } });
      // A batch of one: if Ivy's held-back items were looked at first, Kai's would never come
      const batch = await claimDueRuns(at(2 * HOUR), 1);
      expect(batch.map((one) => one.itemId)).toContain(kaiWatch.id);
      expect(batch.filter((one) => one.userId === ivy.uuid && one.attempt === 1)).toEqual([]);
    } finally {
      await saveServerLimits({ bricks: { runsPerDay: 24 } }, ivy.id);
    }
  });

  it('a run that is handed out again while its server reports does not deadlock or lose what was claimed', async () => {
    const lou = await person('lou');
    const items: { id: string }[] = [];
    for (const name of ['a', 'b', 'c', 'd']) items.push(await set(lou, { kind: 'schedule', words: name, cadence: { type: 'every', minutes: 60 } }));
    const claimed = (await claimDueRuns(at(HOUR + MIN))).filter((one) => items.some((item) => item.id === one.itemId));
    expect(claimed).toHaveLength(4);
    // Every one reports at the very moment it is looked at again, after its lease
    const again = claimDueRuns(at(HOUR + 20 * MIN));
    const reports = claimed.map((one) => finishRun(one.runId, { state: 'done', outcome: 'quiet' }, at(HOUR + 20 * MIN)));
    const [handedOut, finished] = await Promise.all([again, Promise.all(reports)]);
    expect(finished.every((one) => one.ok)).toBe(true);
    // Each run is either finished or handed out again, never both lost
    const states = await prisma.brickItemRun.findMany({ where: { id: { in: claimed.map((one) => one.runId) } }, select: { state: true } });
    expect(states.every((one) => ['done', 'claimed'].includes(one.state))).toBe(true);
    expect(handedOut.filter((one) => claimed.some((c) => c.runId === one.runId)).length).toBeLessThanOrEqual(4);
  });

  it('a change to a one-off while its run is in flight drops that run and makes it due again with the new words, never stranded', async () => {
    const pia = await person('pia');
    const item = await set(pia, { words: 'Call the dentist' });
    const [inFlight] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === item.id);
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: 'on', nextDueAt: null });
    await changeItem(pia.brickId, item.id, { userId: pia.uuid, action: 'change', change: { words: 'Call the dentist about the crown' } }, at(HOUR + 2 * MIN));
    expect(await checkRun(inFlight.runId)).toEqual({ ok: false, reason: 'changed' });
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: 'on', nextDueAt: at(HOUR + 2 * MIN) });
    const again = (await claimDueRuns(at(HOUR + 3 * MIN))).filter((one) => one.itemId === item.id && one.runId !== inFlight.runId);
    expect(again).toMatchObject([{ words: 'Call the dentist about the crown', revision: 2, attempt: 1 }]);
  });

  it('resuming a goal brings back its one-off check even when its moment passed while the goal was paused', async () => {
    const rue = await person('rue');
    const goal = await set(rue, { kind: 'goal', words: 'Sell the car', outcome: 'Sold', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(rue.brickId, { userId: rue.uuid, kind: 'reminder', words: 'Post the ad', cadence: { type: 'once', at: at(2 * HOUR).toISOString() }, parentId: goal.id }, NOW);
    if (!check.ok) throw new Error('expected the check');
    await changeItem(rue.brickId, goal.id, { userId: rue.uuid, action: 'pause' }, at(MIN));
    await changeItem(rue.brickId, goal.id, { userId: rue.uuid, action: 'resume' }, at(3 * HOUR));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'on', nextDueAt: at(3 * HOUR) });
    expect((await claimDueRuns(at(3 * HOUR + MIN))).filter((one) => one.itemId === check.item.id)).toHaveLength(1);
  });

  it('keeps to the runs a day for watches and goals, but never for reminders', async () => {
    const jo = await person('jo');
    await saveServerLimits({ bricks: { runsPerDay: 2 } }, jo.id);
    try {
      const watches = [] as string[];
      for (const name of ['a', 'b', 'c']) watches.push((await set(jo, { kind: 'watch', words: name, condition: 'It changes', cadence: { type: 'every', minutes: 60 } })).id);
      const reminders = [] as string[];
      for (const name of ['x', 'y', 'z']) reminders.push((await set(jo, { words: name })).id);
      const claimed = await claimDueRuns(at(HOUR + MIN));
      expect(claimed.filter((one) => watches.includes(one.itemId))).toHaveLength(2);
      expect(claimed.filter((one) => reminders.includes(one.itemId))).toHaveLength(3);
    } finally {
      await saveServerLimits({ bricks: { runsPerDay: 24 } }, jo.id);
    }
  });

  it('a goal ends on its outcome and stops only the checks it set; a reminder the person set stays', async () => {
    const noor = await person('noor');
    const goal = await set(noor, { kind: 'goal', words: 'Get my visa', outcome: 'The visa is issued', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(noor.brickId, { userId: noor.uuid, kind: 'watch', words: 'Look at the embassy page', condition: 'It says approved', cadence: { type: 'every', minutes: 120 }, parentId: goal.id }, NOW);
    const reminder = await set(noor, { words: 'Bring my passport', cadence: { type: 'once', at: at(10 * HOUR).toISOString() } });
    expect(check).toMatchObject({ ok: true, item: { setBy: 'brick', parentId: goal.id } });
    // A check is set by a goal of this person that is on, never someone else's and never a missing one
    expect(await createItem(noor.brickId, { userId: noor.uuid, kind: 'watch', words: 'x', condition: 'y', cadence: { type: 'every', minutes: 120 }, parentId: 'nope' }, NOW)).toMatchObject({ ok: false, code: 'needs_goal' });
    const [started] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === goal.id);
    const ended = await finishRun(started.runId, { state: 'done', outcome: 'spoke', result: 'The visa is issued', reached: true, progress: { statusLine: 'Visa issued' } }, at(HOUR + 2 * MIN));
    expect(ended).toMatchObject({ ok: true, applied: true, item: { state: 'done', result: 'The visa is issued' } });
    expect(await prisma.brickItem.findUnique({ where: { id: (check as { item: { id: string } }).item.id } })).toMatchObject({ state: 'done', nextDueAt: null });
    expect(await prisma.brickItem.findUnique({ where: { id: reminder.id } })).toMatchObject({ state: 'on' });
    // Pausing a goal pauses its checks; resuming brings them back
    const goal2 = await set(noor, { kind: 'goal', words: 'Sell the car', outcome: 'The car is sold', cadence: { type: 'every', minutes: 60 } });
    const check2 = await createItem(noor.brickId, { userId: noor.uuid, kind: 'watch', words: 'Messages', condition: 'A buyer', cadence: { type: 'every', minutes: 60 }, parentId: goal2.id }, NOW);
    if (!check2.ok) throw new Error('expected the check');
    await changeItem(noor.brickId, goal2.id, { userId: noor.uuid, action: 'pause' }, NOW);
    expect(await prisma.brickItem.findUnique({ where: { id: check2.item.id } })).toMatchObject({ state: 'paused', nextDueAt: null });
    await changeItem(noor.brickId, goal2.id, { userId: noor.uuid, action: 'resume' }, at(HOUR));
    expect(await prisma.brickItem.findUnique({ where: { id: check2.item.id } })).toMatchObject({ state: 'on', nextDueAt: at(2 * HOUR) });
  });

  it('an account that never asked for one has nothing: no items, no runs, whatever the clock says', async () => {
    const quiet = await person('quiet');
    for (let day = 1; day <= 7; day++) await claimDueRuns(at(day * DAY));
    expect(await prisma.brickItem.count({ where: { ownerId: quiet.id } })).toBe(0);
    expect(await prisma.brickItemRun.count({ where: { item: { ownerId: quiet.id } } })).toBe(0);
    expect(await prisma.bot.count({ where: { ownerId: quiet.id } })).toBe(1);
    expect(await prisma.botsAiUsage.count({ where: { botId: quiet.brickId } })).toBe(0);
  });
});
