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

  it('resuming a goal after its Brick was deleted and given back brings its checks back too', async () => {
    const dot = await person('dot');
    const second = await makeBrick(dot.id, { name: 'Trip Brick' });
    const via = { uuid: dot.uuid, brickId: second.id };
    const goal = await set(via, { kind: 'goal', words: 'Plan the trip', outcome: 'Booked', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(second.id, { userId: dot.uuid, kind: 'watch', words: 'Flights', condition: 'It drops', cadence: { type: 'every', minutes: 60 }, parentId: goal.id }, NOW);
    if (!check.ok) throw new Error('expected the check');
    await deleteBrick(second.id, dot.id, NOW);
    await undoBrickDelete(second.id, dot.id, at(HOUR));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'paused' });
    await changeItem(second.id, goal.id, { userId: dot.uuid, action: 'resume' }, at(2 * HOUR));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'on', pausedBy: null, nextDueAt: at(3 * HOUR) });
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
    expect(await checkRun(started.runId, started.attempt)).toEqual({ ok: true });
    await changeItem(eli.brickId, item.id, { userId: eli.uuid, action: 'pause' }, at(HOUR + 2 * MIN));
    expect(await checkRun(started.runId, started.attempt)).toEqual({ ok: false, reason: 'paused' });
    const reported = await finishRun(started.runId, { attempt: started.attempt, state: 'done', outcome: 'spoke', result: 'Sent it' }, at(HOUR + 3 * MIN));
    expect(reported).toMatchObject({ ok: true, applied: false });
    // The run is still in the record as it was reported
    expect(await runsOf(item.id)).toMatchObject([{ state: 'done', outcome: 'spoke', result: 'Sent it' }]);
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: 'paused', nextDueAt: null });
    expect(await finishRun(started.runId, { attempt: started.attempt, state: 'done' })).toMatchObject({ ok: false, status: 409 });
    // Changed, not paused: a new revision, and reopening a done one starts from the new revision
    const second = await set(eli, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const [other] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === second.id);
    await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'change', change: { words: 'Only the important things' } }, at(HOUR + 2 * MIN));
    expect(await checkRun(other.runId, other.attempt)).toEqual({ ok: false, reason: 'changed' });
    await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'done' }, at(HOUR + 3 * MIN));
    const reopened = await changeItem(eli.brickId, second.id, { userId: eli.uuid, action: 'reopen' }, at(HOUR + 4 * MIN));
    expect(reopened).toMatchObject({ ok: true, item: { state: 'on', revision: 4 } });
    expect(await checkRun(other.runId, other.attempt)).toMatchObject({ ok: false });
  });

  it('a one-off ends with its one run, a watch that spoke moves to Done, and a failed run is on record at once and counted', async () => {
    const tala = await person('tala');
    const oneOff = await set(tala);
    const watch = await set(tala, { kind: 'watch', words: 'The flight price', condition: 'It drops', cadence: { type: 'every', minutes: 60 } });
    const flaky = await set(tala, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const claimed = await claimDueRuns(at(HOUR + MIN));
    const get = (id: string) => claimed.find((one) => one.itemId === id)!;
    expect(await finishRun(get(oneOff.id).runId, { attempt: get(oneOff.id).attempt, state: 'done', outcome: 'spoke', result: 'Reminded' }, at(HOUR + 2 * MIN))).toMatchObject({ ok: true, applied: true, item: { state: 'done', nextDueAt: null } });
    expect(await finishRun(get(watch.id).runId, { attempt: get(watch.id).attempt, state: 'done', outcome: 'quiet' }, at(HOUR + 2 * MIN))).toMatchObject({ item: { state: 'on' } });
    expect(await finishRun(get(flaky.id).runId, { attempt: get(flaky.id).attempt, state: 'failed', error: 'Calendar did not answer' }, at(HOUR + 2 * MIN))).toMatchObject({ ok: true, failuresInRow: 1 });
    expect(await runsOf(flaky.id)).toMatchObject([{ state: 'failed', error: 'Calendar did not answer' }]);
    const again = (await claimDueRuns(at(2 * HOUR + MIN))).filter((one) => [watch.id, flaky.id].includes(one.itemId));
    const spoke = await finishRun(again.find((one) => one.itemId === watch.id)!.runId, { attempt: again.find((one) => one.itemId === watch.id)!.attempt, state: 'done', outcome: 'spoke', result: 'It dropped to 92' }, at(2 * HOUR + 2 * MIN));
    expect(spoke).toMatchObject({ item: { state: 'done', result: 'It dropped to 92' } });
    expect(await finishRun(again.find((one) => one.itemId === flaky.id)!.runId, { attempt: again.find((one) => one.itemId === flaky.id)!.attempt, state: 'done', outcome: 'quiet' }, at(2 * HOUR + 2 * MIN))).toMatchObject({ failuresInRow: 0 });
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

  it('a one-off whose run fails, or is never reported, ends instead of staying on with nothing due', async () => {
    const odin = await person('odin');
    const reported = await set(odin);
    const lost = await set(odin);
    const claimed = (await claimDueRuns(at(HOUR + MIN))).filter((one) => [reported.id, lost.id].includes(one.itemId));
    expect(claimed).toHaveLength(2);
    const failed = await finishRun(claimed.find((one) => one.itemId === reported.id)!.runId, { attempt: claimed.find((one) => one.itemId === reported.id)!.attempt, state: 'failed', error: 'The chat did not answer' }, at(HOUR + 2 * MIN));
    expect(failed).toMatchObject({ ok: true, applied: true, item: { state: 'done', nextDueAt: null } });
    // The one never reported is handed out again twice, then given up: the item ends too
    await claimDueRuns(at(HOUR + 20 * MIN));
    await claimDueRuns(at(HOUR + 40 * MIN));
    await claimDueRuns(at(HOUR + 60 * MIN));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ state: 'done', nextDueAt: null });
    expect((await runsOf(lost.id))[0]).toMatchObject({ state: 'failed' });
    // Neither counts against the person's limit any more
    const listed = await listItems(odin.brickId, odin.uuid);
    expect(listed.ok && listed.items.filter((one) => one.state === 'on')).toEqual([]);
  });

  it('a goal whose first check is one moment is not closed by that check unless the outcome was reached', async () => {
    const pippa = await person('pippa');
    const goal = await set(pippa, { kind: 'goal', words: 'Renew my passport', outcome: 'The passport is renewed', cadence: { type: 'once', at: at(HOUR).toISOString() } });
    const check = await createItem(pippa.brickId, { userId: pippa.uuid, kind: 'watch', words: 'The office page', condition: 'It says ready', cadence: { type: 'every', minutes: 120 }, parentId: goal.id }, NOW);
    if (!check.ok) throw new Error('expected the check');
    const [first] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === goal.id);
    expect(await finishRun(first.runId, { attempt: first.attempt, state: 'done', progress: { statusLine: 'Still waiting on the office' } }, at(HOUR + 2 * MIN))).toMatchObject({ ok: true, applied: true, item: { state: 'on', statusLine: 'Still waiting on the office' } });
    // Its own check carries on
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'on' });
    expect(await changeItem(pippa.brickId, goal.id, { userId: pippa.uuid, action: 'done' }, at(2 * HOUR))).toMatchObject({ ok: true, item: { state: 'done' } });
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'done' });
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
    const reports = claimed.map((one) => finishRun(one.runId, { attempt: one.attempt, state: 'done', outcome: 'quiet' }, at(HOUR + 20 * MIN)));
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
    expect(await checkRun(inFlight.runId, inFlight.attempt)).toEqual({ ok: false, reason: 'changed' });
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

  it('resuming a goal brings back only the checks its own pause stopped, not one the person paused themselves', async () => {
    const sol = await person('sol');
    const goal = await set(sol, { kind: 'goal', words: 'Plan the trip', outcome: 'Booked', cadence: { type: 'every', minutes: 60 } });
    const make = async (words: string) => {
      const made = await createItem(sol.brickId, { userId: sol.uuid, kind: 'watch', words, condition: 'It changes', cadence: { type: 'every', minutes: 60 }, parentId: goal.id }, NOW);
      if (!made.ok) throw new Error('expected the check');
      return made.item.id;
    };
    const mine = await make('Flights');
    const theirs = await make('Hotels');
    await changeItem(sol.brickId, theirs, { userId: sol.uuid, action: 'pause' }, at(MIN));
    await changeItem(sol.brickId, goal.id, { userId: sol.uuid, action: 'pause' }, at(2 * MIN));
    await changeItem(sol.brickId, goal.id, { userId: sol.uuid, action: 'resume' }, at(HOUR));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: mine } })).toMatchObject({ state: 'on', pausedBy: null });
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: theirs } })).toMatchObject({ state: 'paused', pausedBy: 'owner' });
  });

  it('keeps the checks of one goal to the same most as goals and tasks, and a timerless goal always says what it waits for', async () => {
    const tam = await person('tam');
    await saveServerLimits({ bricks: { itemsPerPerson: 2 } }, tam.id);
    try {
      const goal = await set(tam, { kind: 'goal', words: 'Find a flat', outcome: 'Keys in hand', cadence: { type: 'every', minutes: 60 } });
      const check = (words: string) => createItem(tam.brickId, { userId: tam.uuid, kind: 'watch', words, condition: 'It changes', cadence: { type: 'every', minutes: 60 }, parentId: goal.id }, NOW);
      expect((await check('a')).ok).toBe(true);
      expect((await check('b')).ok).toBe(true);
      expect(await check('c')).toMatchObject({ ok: false, status: 422, code: 'too_many', limit: 2 });
    } finally {
      await saveServerLimits({ bricks: { itemsPerPerson: 20 } }, tam.id);
    }
    const sam = await person('sam');
    const waits = await set(sam, { kind: 'goal', words: 'Hear from the bank', outcome: 'A loan', cadence: { type: 'none' }, waitingFor: 'The bank to answer' });
    expect(await changeItem(sam.brickId, waits.id, { userId: sam.uuid, action: 'change', change: { waitingFor: null } }, NOW)).toMatchObject({ ok: false, status: 422, code: 'needs_wait' });
    expect(await changeItem(sam.brickId, waits.id, { userId: sam.uuid, action: 'change', change: { waitingFor: 'The embassy' } }, NOW)).toMatchObject({ ok: true, item: { waitingFor: 'The embassy' } });
  });

  it('reopening keeps to the same limits as setting one: the most goals and tasks, and a check only while its goal is on', async () => {
    const lorenzo = await person('lorenzo');
    await saveServerLimits({ bricks: { itemsPerPerson: 2 } }, lorenzo.id);
    try {
      const first = await set(lorenzo);
      await set(lorenzo);
      await changeItem(lorenzo.brickId, first.id, { userId: lorenzo.uuid, action: 'done' }, NOW);
      await set(lorenzo);
      // Two are on again, so the done one cannot come back
      expect(await changeItem(lorenzo.brickId, first.id, { userId: lorenzo.uuid, action: 'reopen' }, at(MIN))).toMatchObject({ ok: false, status: 422, code: 'too_many', limit: 2 });
    } finally {
      await saveServerLimits({ bricks: { itemsPerPerson: 20 } }, lorenzo.id);
    }
    const kiran = await person('kiran');
    const goal = await set(kiran, { kind: 'goal', words: 'Sell the car', outcome: 'Sold', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(kiran.brickId, { userId: kiran.uuid, kind: 'watch', words: 'Messages', condition: 'A buyer', cadence: { type: 'every', minutes: 60 }, parentId: goal.id }, NOW);
    if (!check.ok) throw new Error('expected the check');
    await changeItem(kiran.brickId, check.item.id, { userId: kiran.uuid, action: 'done' }, at(MIN));
    await changeItem(kiran.brickId, goal.id, { userId: kiran.uuid, action: 'done' }, at(2 * MIN));
    expect(await changeItem(kiran.brickId, check.item.id, { userId: kiran.uuid, action: 'reopen' }, at(3 * MIN))).toMatchObject({ ok: false, status: 409, code: 'needs_goal' });
    await changeItem(kiran.brickId, goal.id, { userId: kiran.uuid, action: 'reopen' }, at(4 * MIN));
    expect(await changeItem(kiran.brickId, check.item.id, { userId: kiran.uuid, action: 'reopen' }, at(5 * MIN))).toMatchObject({ ok: true, item: { state: 'on' } });
  });

  it('a check cannot be resumed on its own while its goal is paused', async () => {
    const xia = await person('xia');
    const goal = await set(xia, { kind: 'goal', words: 'Plan the trip', outcome: 'Booked', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(xia.brickId, { userId: xia.uuid, kind: 'watch', words: 'Flights', condition: 'It drops', cadence: { type: 'every', minutes: 60 }, parentId: goal.id }, NOW);
    if (!check.ok) throw new Error('expected the check');
    await changeItem(xia.brickId, goal.id, { userId: xia.uuid, action: 'pause' }, at(MIN));
    expect(await changeItem(xia.brickId, check.item.id, { userId: xia.uuid, action: 'resume' }, at(2 * MIN))).toMatchObject({ ok: false, status: 409, code: 'needs_goal' });
    expect((await claimDueRuns(at(3 * HOUR))).filter((one) => one.itemId === check.item.id)).toEqual([]);
    await changeItem(xia.brickId, goal.id, { userId: xia.uuid, action: 'resume' }, at(3 * MIN));
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: check.item.id } })).toMatchObject({ state: 'on' });
  });

  it('a new time zone alone changes nothing for a one-off, even one that is done, and moves a time of day to the new clock', async () => {
    const zoe = await person('zoe');
    const once = await set(zoe, { cadence: { type: 'once', at: at(HOUR).toISOString() } });
    const [run] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === once.id);
    await finishRun(run.runId, { attempt: run.attempt, state: 'done', outcome: 'spoke' }, at(HOUR + 2 * MIN));
    expect(await changeItem(zoe.brickId, once.id, { userId: zoe.uuid, action: 'change', change: { timeZone: 'Europe/London' } }, at(2 * HOUR))).toMatchObject({ ok: true, item: { state: 'done', timeZone: 'Europe/London' } });
    const daily = await set(zoe, { kind: 'schedule', words: 'My day', cadence: { type: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } });
    const moved = await changeItem(zoe.brickId, daily.id, { userId: zoe.uuid, action: 'change', change: { timeZone: 'UTC' } }, at(MIN));
    expect(moved).toMatchObject({ ok: true, item: { timeZone: 'UTC' } });
    expect(moved.ok && moved.item.nextDueAt).not.toBe(daily.nextDueAt);
  });

  it('a run handed out again belongs to the newer try: the older try is told stale and cannot report it', async () => {
    const ash = await person('ash');
    const item = await set(ash, { kind: 'schedule', cadence: { type: 'every', minutes: 60 } });
    const [first] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === item.id);
    const [second] = (await claimDueRuns(at(HOUR + 20 * MIN))).filter((one) => one.runId === first.runId);
    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    expect(await checkRun(first.runId, first.attempt)).toEqual({ ok: false, reason: 'stale' });
    expect(await finishRun(first.runId, { attempt: first.attempt, state: 'done' }, at(HOUR + 21 * MIN))).toMatchObject({ ok: false, status: 409 });
    expect(await checkRun(second.runId, second.attempt)).toEqual({ ok: true });
    expect(await finishRun(second.runId, { attempt: second.attempt, state: 'done', outcome: 'quiet' }, at(HOUR + 22 * MIN))).toMatchObject({ ok: true, applied: true });
  });

  it('a run lost while its Brick was off is not handed out again, and a one-off comes back due now', async () => {
    const bea = await person('bea');
    const once = await set(bea, { cadence: { type: 'once', at: at(HOUR).toISOString() } });
    const [run] = (await claimDueRuns(at(HOUR + MIN))).filter((one) => one.itemId === once.id);
    await prisma.bot.update({ where: { id: bea.brickId }, data: { enabled: false } });
    expect((await claimDueRuns(at(HOUR + 20 * MIN))).filter((one) => one.itemId === once.id)).toEqual([]);
    expect((await runsOf(once.id))[0]).toMatchObject({ id: run.runId, state: 'dropped' });
    expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: once.id } })).toMatchObject({ state: 'on', nextDueAt: at(HOUR + 20 * MIN) });
    await prisma.bot.update({ where: { id: bea.brickId }, data: { enabled: true } });
    expect((await claimDueRuns(at(HOUR + 25 * MIN))).filter((one) => one.itemId === once.id)).toHaveLength(1);
  });

  it('nothing is set on a Brick that is deleted, even when the two happen together', async () => {
    const col = await person('col');
    const second = await makeBrick(col.id, { name: 'Busy Brick' });
    const via = { uuid: col.uuid, brickId: second.id };
    const [made] = await Promise.all([createItem(second.id, { ...remind(), userId: col.uuid }, NOW), deleteBrick(second.id, col.id, NOW)]);
    const rows = await prisma.brickItem.findMany({ where: { botId: second.id } });
    // Whichever came first, nothing is left on for a deleted Brick
    expect(rows.filter((one) => one.state === 'on')).toEqual([]);
    expect(rows).toHaveLength(made.ok ? 1 : 0);
    expect(await createItem(second.id, { ...remind(), userId: via.uuid }, NOW)).toMatchObject({ ok: false });
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
    const ended = await finishRun(started.runId, { attempt: started.attempt, state: 'done', outcome: 'spoke', result: 'The visa is issued', reached: true, progress: { statusLine: 'Visa issued' } }, at(HOUR + 2 * MIN));
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
