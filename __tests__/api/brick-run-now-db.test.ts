/**
 * Run now and a snooze that moves one occurrence (game #2002), against a real database. Run now is one extra run the owner asks for: it
 * leaves the recurrence where it was, passes the same checks as a scheduled run, runs once however it is asked, and is handed to the bot
 * server like any other. Snooze moves ONE occurrence and never the rule: an hourly task due at 8:00 and snoozed to 8:10 still has 9:00 next.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-run-now-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { deleteBrick } from '@/lib/brick-delete';
import * as botLimits from '@/lib/bot-limits';
import { saveServerLimits } from '@/lib/bot-limits';

// The real limits, with the read counted
jest.mock('@/lib/bot-limits', () => {
  const actual = jest.requireActual('@/lib/bot-limits');
  return { ...actual, getBrickLimits: jest.fn(actual.getBrickLimits) };
});
import { changeItem, checkRun, claimDueRuns, claimWork, createItem, finishRun, readItem, type NewItemInput } from '@/lib/brick-items';
import { changeFromScreen, didByBrick } from '@/lib/brick-item-screens';
import { itemsRefused } from '@/lib/brick-item-api';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Thursday 12 Nov 2026, 9:00 in Kuwait
const NOW = new Date('2026-11-12T06:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();

async function person(name: string, zone: string | null = 'Asia/Kuwait') {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  if (zone) await prisma.userPreference.create({ data: { userId: user.id, key: 'timeZone', value: zone } });
  const { brick } = await ensureDefaultBrick(user.id);
  return { id: user.id, uuid: user.uuid, brickId: brick!.id };
}
type Who = Awaited<ReturnType<typeof person>>;

const base = (over: Partial<NewItemInput>): NewItemInput => ({ userId: '', kind: 'reminder', words: 'Call the dentist', cadence: { type: 'once', at: at(HOUR).toISOString() }, ...over });

async function set(who: Who, over: Partial<NewItemInput> = {}, now = NOW) {
  const answer = await createItem(who.brickId, { ...base(over), userId: who.uuid }, now);
  if (!answer.ok) throw new Error(`could not set it: ${answer.error}`);
  return answer.item;
}

const tap = (who: Who, itemId: string, action: 'run' | 'snooze' | 'pause' | 'resume' | 'done', now: Date, key?: string) => changeItem(who.brickId, itemId, { userId: who.uuid, action, ...(key ? { key } : {}) }, now);
const row = (itemId: string) => prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } });
const runsOf = (itemId: string) => prisma.brickItemRun.findMany({ where: { itemId }, orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }] });
const mine = <T extends { itemId: string }>(runs: T[], itemId: string) => runs.filter((one) => one.itemId === itemId);
const hourly = { type: 'every', minutes: 60 } as const;
const everyDay = { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] } as const;

run('Run now and snooze, in a real database', () => {
  afterAll(async () => {
    await prisma.botsAiUsage.deleteMany({ where: { talkedPersonId: { in: people } } });
    await prisma.replyWindow.deleteMany({ where: { key: { in: people.map((id) => `ua:person:${id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('Run now (F03)', () => {
    it('runs once, extra: the recurrence stays where it was, nothing about the item changes, and the scheduled run still comes', async () => {
      const ana = await person('ana');
      const briefing = await set(ana, { kind: 'schedule', words: 'Headlines', cadence: hourly });
      const before = await row(briefing.id);
      const asked = await tap(ana, briefing.id, 'run', at(10 * MIN), 'tap-1');
      expect(asked).toMatchObject({ ok: true, run: { state: 'queued', replay: false }, item: { state: 'on', nextDueAt: iso(HOUR), revision: before.revision } });
      // The item is exactly as it was: not moved, not changed, no revision (so a run already going is not stopped)
      const same = await row(briefing.id);
      expect({ nextDueAt: same.nextDueAt, revision: same.revision, cadence: same.cadence, state: same.state, regularDueAt: same.regularDueAt }).toEqual({ nextDueAt: before.nextDueAt, revision: before.revision, cadence: before.cadence, state: 'on', regularDueAt: null });
      // Nothing started yet: it waits, and it is not something Brick did
      expect((await didByBrick(ana.id, ana.brickId)).runs).toEqual([]);
      // The bot server asks: it is handed the run, as a run asked for, not late, with the usual lease, and nothing else is run early
      const handed = mine(await claimDueRuns(at(11 * MIN)), briefing.id);
      expect(handed).toHaveLength(1);
      expect(handed[0]).toMatchObject({ runId: asked.ok ? asked.run!.runId : '', manual: true, late: false, fresh: false, attempt: 1, dueAt: iso(10 * MIN), leaseUntil: iso(21 * MIN), kind: 'schedule', userId: ana.uuid });
      expect(await row(briefing.id)).toMatchObject({ nextDueAt: before.nextDueAt, revision: before.revision });
      expect(await checkRun(handed[0].runId, 1, at(12 * MIN))).toEqual({ ok: true });
      // It finishes and is on record; the item is untouched except that it ran
      const done = await finishRun(handed[0].runId, { attempt: 1, state: 'done', outcome: 'spoke', result: 'Sent the headlines' }, at(13 * MIN));
      expect(done).toMatchObject({ ok: true, applied: true, item: { nextDueAt: iso(HOUR), state: 'on' } });
      expect((await didByBrick(ana.id, ana.brickId)).runs).toMatchObject([{ state: 'done', manual: true, result: 'Sent the headlines' }]);
      // The scheduled run still comes at its own time, as its own run
      const scheduled = mine(await claimDueRuns(at(HOUR + MIN)), briefing.id);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ manual: false, dueAt: iso(HOUR) });
      expect(scheduled[0].runId).not.toBe(handed[0].runId);
      expect(await row(briefing.id)).toMatchObject({ nextDueAt: at(2 * HOUR) });
    });

    it('is one run however it is asked: the same key, a second tap while it waits, two servers at once and a retry', async () => {
      const ben = await person('ben');
      const briefing = await set(ben, { kind: 'schedule', cadence: hourly });
      const first = await tap(ben, briefing.id, 'run', at(MIN), 'k1');
      const second = await tap(ben, briefing.id, 'run', at(MIN + 1), 'k1');
      const third = await tap(ben, briefing.id, 'run', at(MIN + 2));
      if (!first.ok || !second.ok || !third.ok) throw new Error('expected all three to be answered');
      expect(second.run).toEqual({ runId: first.run!.runId, state: 'queued', replay: true });
      // A tap with another key (or none) while one still waits is that run too: never two waiting
      expect(third.run).toEqual({ runId: first.run!.runId, state: 'queued', replay: true });
      expect(await runsOf(briefing.id)).toHaveLength(1);
      // Two servers asking at the same moment: one gets it
      const both = await Promise.all([claimDueRuns(at(2 * MIN)), claimDueRuns(at(2 * MIN))]);
      const handed = both.flatMap((runs) => mine(runs, briefing.id));
      expect(handed).toHaveLength(1);
      // While it is running, another tap is refused as busy: one run of an item at a time
      expect(await tap(ben, briefing.id, 'run', at(3 * MIN), 'k2')).toMatchObject({ ok: false, status: 409, code: 'busy' });
      // The same key after it is over is still that run: the tap is never run twice
      await finishRun(handed[0].runId, { attempt: 1, state: 'done', outcome: 'quiet' }, at(4 * MIN));
      expect(await tap(ben, briefing.id, 'run', at(5 * MIN), 'k1')).toMatchObject({ ok: true, run: { runId: first.run!.runId, state: 'done', replay: true } });
      expect(await runsOf(briefing.id)).toHaveLength(1);
      // A new tap is a new run
      const again = await tap(ben, briefing.id, 'run', at(6 * MIN), 'k3');
      expect(again).toMatchObject({ ok: true, run: { state: 'queued', replay: false } });
      expect(again.ok && again.run!.runId).not.toBe(first.run!.runId);
      expect(await runsOf(briefing.id)).toHaveLength(2);
      // The key is only for Run now
      expect(await changeItem(ben.brickId, briefing.id, { userId: ben.uuid, action: 'pause', key: 'nope' }, at(7 * MIN))).toMatchObject({ ok: false, status: 400 });
    });

    it('a run handed out and never reported is handed out again with the same id, still a run that was asked for, and then given up: the item’s own time is never touched', async () => {
      const cai = await person('cai');
      const reminder = await set(cai, { words: 'Pay rent', cadence: { type: 'once', at: at(5 * HOUR).toISOString() } });
      const asked = await tap(cai, reminder.id, 'run', at(MIN));
      const handed = mine(await claimDueRuns(at(2 * MIN)), reminder.id);
      expect(handed).toMatchObject([{ manual: true, attempt: 1 }]);
      // Never reported: after the lease it is handed out again, the same run
      const again = mine(await claimDueRuns(at(13 * MIN)), reminder.id);
      expect(again).toMatchObject([{ runId: handed[0].runId, manual: true, attempt: 2 }]);
      const third = mine(await claimDueRuns(at(25 * MIN)), reminder.id);
      expect(third).toMatchObject([{ attempt: 3 }]);
      expect(mine(await claimDueRuns(at(37 * MIN)), reminder.id)).toEqual([]);
      expect((await runsOf(reminder.id))[0]).toMatchObject({ id: asked.ok ? asked.run!.runId : '', state: 'failed', manual: true });
      // The reminder itself is still on, for its own moment, and the failed extra run did not end it
      expect(await row(reminder.id)).toMatchObject({ state: 'on', nextDueAt: at(5 * HOUR), failuresInRow: 1 });
      expect(mine(await claimDueRuns(at(5 * HOUR + MIN)), reminder.id)).toMatchObject([{ manual: false, dueAt: iso(5 * HOUR) }]);
    });

    it('one run of an item at a time: a scheduled run waits while the run the owner asked for is running, and then comes once, never a backlog', async () => {
      const eli = await person('eli');
      const reminder = await set(eli, { words: 'Stretch', cadence: { type: 'once', at: at(15 * MIN).toISOString() } });
      await tap(eli, reminder.id, 'run', at(10 * MIN));
      const [manual] = mine(await claimDueRuns(at(11 * MIN)), reminder.id);
      expect(manual).toMatchObject({ manual: true, leaseUntil: iso(21 * MIN) });
      // It falls due while the extra run is still running: it is not started beside it, and it stays due
      expect(mine(await claimDueRuns(at(16 * MIN)), reminder.id)).toEqual([]);
      expect(mine(await claimDueRuns(at(17 * MIN)), reminder.id)).toEqual([]);
      expect(await row(reminder.id)).toMatchObject({ state: 'on', nextDueAt: at(15 * MIN) });
      expect(await runsOf(reminder.id)).toHaveLength(1);
      // The extra run is reported: the scheduled one comes, once
      await finishRun(manual.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(18 * MIN));
      const scheduled = mine(await claimDueRuns(at(19 * MIN)), reminder.id);
      expect(scheduled).toMatchObject([{ manual: false, dueAt: iso(15 * MIN) }]);
      expect(mine(await claimDueRuns(at(20 * MIN)), reminder.id)).toEqual([]);
      expect(await runsOf(reminder.id)).toHaveLength(2);
    });

    it('one run of an item at a time: a run the owner asked for waits for a scheduled run that is running, and is then handed out, or dropped when it was not taken up in time', async () => {
      const fay = await person('fay');
      const reminder = await set(fay, { kind: 'schedule', words: 'Drink water', cadence: hourly });
      const asked = await tap(fay, reminder.id, 'run', at(10 * MIN));
      if (!asked.ok) throw new Error('expected the run to be asked for');
      // A scheduled run of this item is running (made by the claim a moment before this ask)
      const item = await row(reminder.id);
      const going = await prisma.brickItemRun.create({ data: { itemId: reminder.id, dueAt: at(9 * MIN), revision: item.revision, claimedAt: at(10 * MIN), leaseUntil: at(20 * MIN) } });
      expect(mine(await claimDueRuns(at(12 * MIN)), reminder.id)).toEqual([]);
      expect((await prisma.brickItemRun.findUniqueOrThrow({ where: { id: asked.run!.runId } })).state).toBe('queued');
      // That run is reported: the one that was asked for is handed out
      await finishRun(going.id, { attempt: 1, state: 'done', outcome: 'spoke' }, at(13 * MIN));
      expect(mine(await claimDueRuns(at(14 * MIN)), reminder.id)).toMatchObject([{ runId: asked.run!.runId, manual: true }]);
    });

    it('does not end a one-off, and does not undo a pause: the item the owner paused can be run now and stays paused, for as long as that is its only pause', async () => {
      const dev = await person('dev');
      const once = await set(dev, { words: 'Call mum', cadence: { type: 'once', at: at(2 * HOUR).toISOString() } });
      await tap(dev, once.id, 'run', at(MIN));
      const [handed] = mine(await claimDueRuns(at(2 * MIN)), once.id);
      await finishRun(handed.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(3 * MIN));
      // A one-off with an extra run is not done: its own moment is still to come
      expect(await row(once.id)).toMatchObject({ state: 'on', nextDueAt: at(2 * HOUR), doneAt: null });

      // A schedule the owner paused: Run now still works; it is not switched on, and nothing is due
      const briefing = await set(dev, { kind: 'schedule', cadence: everyDay });
      await tap(dev, briefing.id, 'pause', at(4 * MIN));
      const paused = await row(briefing.id);
      const asked = await tap(dev, briefing.id, 'run', at(5 * MIN), 'p1');
      expect(asked).toMatchObject({ ok: true, run: { state: 'queued' }, item: { state: 'paused', nextDueAt: null } });
      expect(await row(briefing.id)).toMatchObject({ state: 'paused', nextDueAt: null, revision: paused.revision });
      const [ran] = mine(await claimDueRuns(at(6 * MIN)), briefing.id);
      expect(ran).toMatchObject({ manual: true });
      // Its own steps are allowed to go on while it is paused (the owner asked), and its report counts
      expect(await checkRun(ran.runId, 1, at(7 * MIN))).toEqual({ ok: true });
      expect(await finishRun(ran.runId, { attempt: 1, state: 'done', outcome: 'spoke', result: 'Sent' }, at(8 * MIN))).toMatchObject({ ok: true, applied: true, item: { state: 'paused', nextDueAt: null, lastRunAt: iso(8 * MIN) } });
      expect(await row(briefing.id)).toMatchObject({ state: 'paused', nextDueAt: null, pausedBy: 'owner' });
      // Nothing scheduled while paused, however long: and Resume still brings it back on its own rule
      expect(mine(await claimDueRuns(at(48 * HOUR)), briefing.id)).toEqual([]);
      expect(await tap(dev, briefing.id, 'resume', at(48 * HOUR))).toMatchObject({ ok: true, item: { state: 'on' } });
    });

    it('a pause or any change after the tap and before the run starts stops it; a pause during the run stops its next step', async () => {
      const edda = await person('edda');
      const briefing = await set(edda, { kind: 'schedule', cadence: hourly });
      await tap(edda, briefing.id, 'run', at(MIN));
      await tap(edda, briefing.id, 'pause', at(2 * MIN));
      expect(mine(await claimDueRuns(at(3 * MIN)), briefing.id)).toEqual([]);
      expect((await runsOf(briefing.id))[0]).toMatchObject({ state: 'dropped', manual: true, error: 'It changed before it ran' });
      // And while running: a pause stops its next outside step, as it does for a scheduled run
      await tap(edda, briefing.id, 'resume', at(4 * MIN));
      await tap(edda, briefing.id, 'run', at(5 * MIN));
      const [ran] = mine(await claimDueRuns(at(6 * MIN)), briefing.id);
      expect(await checkRun(ran.runId, 1, at(7 * MIN))).toEqual({ ok: true });
      await changeItem(edda.brickId, briefing.id, { userId: edda.uuid, action: 'change', change: { words: 'New words' } }, at(8 * MIN));
      expect(await checkRun(ran.runId, 1, at(9 * MIN))).toEqual({ ok: false, reason: 'changed' });
    });

    it('is refused where a scheduled run could not happen: a Brick that is off or deleted, a done item, a check under a paused goal, and one in the middle of a run', async () => {
      const finn = await person('finn');
      const briefing = await set(finn, { kind: 'schedule', cadence: hourly });
      // Done: Reopen is how it comes back
      const done = await set(finn, { kind: 'schedule', cadence: hourly });
      await tap(finn, done.id, 'done', at(MIN));
      expect(await tap(finn, done.id, 'run', at(2 * MIN))).toMatchObject({ ok: false, status: 409, code: 'wrong_state' });
      // A check runs only while its goal is on, and a paused goal pauses it: it is not run by itself
      const goal = await set(finn, { kind: 'goal', words: 'Sell the car', outcome: 'Sold', cadence: hourly });
      const check = await createItem(finn.brickId, { userId: finn.uuid, kind: 'reminder', words: 'Ring the buyer', cadence: { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] }, parentId: goal.id }, NOW);
      if (!check.ok) throw new Error('expected the check');
      await tap(finn, goal.id, 'pause', at(3 * MIN));
      expect(await tap(finn, check.item.id, 'run', at(4 * MIN))).toMatchObject({ ok: false, status: 409, code: 'needs_goal' });
      // The goal itself, paused by its owner, can be run now
      expect(await tap(finn, goal.id, 'run', at(5 * MIN), 'g1')).toMatchObject({ ok: true, run: { state: 'queued' } });
      // One that came with a template and is not turned on yet
      const routine = await set(finn, { kind: 'schedule', cadence: hourly });
      await prisma.brickItem.update({ where: { id: routine.id }, data: { state: 'paused', pausedBy: 'template', nextDueAt: null } });
      expect(await tap(finn, routine.id, 'run', at(6 * MIN))).toMatchObject({ ok: false, status: 409, code: 'needs_setup' });
      // Nothing is made for a Brick that is off (the one place an administrative hold on a Brick's work would be checked, beside this)
      await prisma.bot.update({ where: { id: finn.brickId }, data: { enabled: false } });
      expect(await tap(finn, briefing.id, 'run', at(7 * MIN))).toMatchObject({ ok: false, status: 409, code: 'off' });
      // What was already waiting is dropped, with why, when the Brick is off at the claim
      expect(mine(await claimDueRuns(at(8 * MIN)), goal.id)).toEqual([]);
      expect((await runsOf(goal.id))[0]).toMatchObject({ state: 'dropped', error: 'Its Brick is switched off' });
      await prisma.bot.update({ where: { id: finn.brickId }, data: { enabled: true } });

      // A deleted Brick is off too
      const gus = await person('gus');
      const second = await prisma.bot.findFirstOrThrow({ where: { id: gus.brickId } });
      const item = await set(gus, { kind: 'schedule', cadence: hourly });
      await deleteBrick(second.id, gus.id, NOW);
      expect(await tap(gus, item.id, 'run', at(MIN))).toMatchObject({ ok: false });
      // One run of an item at a time
      const hal = await person('hal');
      const busy = await set(hal, { kind: 'schedule', cadence: hourly });
      await tap(hal, busy.id, 'run', at(MIN));
      await claimDueRuns(at(2 * MIN));
      expect(await tap(hal, busy.id, 'run', at(3 * MIN))).toMatchObject({ ok: false, status: 409, code: 'busy' });
      // Once the lease is over (nothing reported), it is not busy any more
      expect(await tap(hal, busy.id, 'run', at(13 * MIN))).toMatchObject({ ok: true, run: { state: 'queued', replay: false } });
    });

    it('takes from the same room and the same runs a day as a scheduled run, and a reminder takes none', async () => {
      const ivy = await person('ivy');
      const watch = await set(ivy, { kind: 'watch', words: 'Flight', condition: 'It drops', cadence: hourly });
      const reminder = await set(ivy, { words: 'Call mum', cadence: { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] } });
      // Goals and tasks have used their whole share (30% of 30 replies)
      await prisma.botsAiProvider.upsert({ where: { providerId: 'universe-ai' }, create: { providerId: 'universe-ai', name: 'Universe AI', type: 'universe-ai', enabled: true }, update: {} });
      await prisma.botsAiUsage.createMany({ data: Array.from({ length: 9 }, () => ({ botId: ivy.brickId, providerId: 'universe-ai', talkedPersonId: ivy.id, channel: 'task', timestamp: at(MIN) })) });
      await prisma.replyWindow.upsert({ where: { key: `ua:person:${ivy.id}` }, create: { key: `ua:person:${ivy.id}`, startedAt: NOW }, update: { startedAt: NOW } });
      const refused = await tap(ivy, watch.id, 'run', at(2 * MIN));
      expect(refused).toMatchObject({ ok: false, status: 409, code: 'no_room' });
      expect(!refused.ok && typeof refused.until).toBe('string');
      // Nothing was left waiting, and the watch was not held or marked for it
      expect(await runsOf(watch.id)).toEqual([]);
      expect(await row(watch.id)).toMatchObject({ heldSince: null, nextDueAt: at(HOUR) });
      // A reminder is fixed text with no AI: it always runs
      expect(await tap(ivy, reminder.id, 'run', at(2 * MIN))).toMatchObject({ ok: true, run: { state: 'queued' } });

      // Runs a day: a person at the most gets no more by tapping, counting the ones already waiting
      const jon = await person('jon');
      const a = await set(jon, { kind: 'schedule', cadence: hourly });
      const b = await set(jon, { kind: 'schedule', cadence: hourly });
      await saveServerLimits({ bricks: { runsPerDay: 1 } }, jon.id);
      try {
        expect(await tap(jon, a.id, 'run', at(MIN))).toMatchObject({ ok: true });
        expect(await tap(jon, b.id, 'run', at(2 * MIN))).toMatchObject({ ok: false, status: 422, code: 'runs_a_day', limit: 1 });
        // The one that waits counts once it runs, too
        expect(mine(await claimDueRuns(at(3 * MIN)), a.id)).toHaveLength(1);
        expect(await tap(jon, b.id, 'run', at(4 * MIN))).toMatchObject({ ok: false, code: 'runs_a_day' });
      } finally {
        await saveServerLimits({ bricks: { runsPerDay: 24 } }, jon.id);
      }
    });

    it('a request that is not taken up in time, or whose usage is gone by then, is dropped with why; it never runs hours later', async () => {
      const kit = await person('kit');
      const briefing = await set(kit, { kind: 'schedule', cadence: hourly });
      await tap(kit, briefing.id, 'run', at(MIN));
      // The bot server was away: a quarter of an hour on, the tap is stale
      expect(mine(await claimDueRuns(at(20 * MIN)), briefing.id)).toEqual([]);
      expect((await runsOf(briefing.id))[0]).toMatchObject({ state: 'dropped', error: 'It was not taken up in time' });
      // A new tap is fine, and usage that went at the claim drops it
      await tap(kit, briefing.id, 'run', at(21 * MIN));
      await prisma.botsAiProvider.upsert({ where: { providerId: 'universe-ai' }, create: { providerId: 'universe-ai', name: 'Universe AI', type: 'universe-ai', enabled: true }, update: {} });
      await prisma.botsAiUsage.createMany({ data: Array.from({ length: 30 }, () => ({ botId: kit.brickId, providerId: 'universe-ai', talkedPersonId: kit.id, channel: 'dm', timestamp: at(MIN) })) });
      await prisma.replyWindow.upsert({ where: { key: `ua:person:${kit.id}` }, create: { key: `ua:person:${kit.id}`, startedAt: NOW }, update: { startedAt: NOW } });
      expect(mine(await claimDueRuns(at(22 * MIN)), briefing.id)).toEqual([]);
      expect((await runsOf(briefing.id))[1]).toMatchObject({ state: 'dropped', error: 'There was no room in the usage for goals and tasks' });
      // Dropped runs are on record; the item itself carries on untouched
      expect((await didByBrick(kit.id, kit.brickId)).runs.map((one) => one.state)).toEqual(['dropped', 'dropped']);
      expect(await row(briefing.id)).toMatchObject({ state: 'on', nextDueAt: at(HOUR), heldSince: null });
    });

    it('reads the limits once, before its transaction opens: it never takes a second connection while the transaction holds one', async () => {
      const zed = await person('zed');
      const briefing = await set(zed, { kind: 'schedule', cadence: hourly });
      const reads = botLimits.getBrickLimits as unknown as jest.Mock;
      reads.mockClear();
      expect(await tap(zed, briefing.id, 'run', at(MIN))).toMatchObject({ ok: true, run: { state: 'queued' } });
      // changeItem reads them before it opens the transaction; Run now itself reads none
      expect(reads).toHaveBeenCalledTimes(1);
    });

    it('a check the owner paused itself is still refused once its goal is paused, and a run asked for before that is dropped, not handed out', async () => {
      const ola = await person('ola');
      const goal = await set(ola, { kind: 'goal', words: 'Sell the bike', outcome: 'Sold', cadence: hourly });
      const make = async (words: string) => {
        const made = await createItem(ola.brickId, { userId: ola.uuid, kind: 'reminder', words, cadence: { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] }, parentId: goal.id }, NOW);
        if (!made.ok) throw new Error('expected the check');
        return made.item;
      };
      const mine1 = await make('Ring the buyer');
      const mine2 = await make('Post the advert');
      // Both checks were paused by the owner, one has a run asked for; then the goal is paused
      await tap(ola, mine1.id, 'pause', at(MIN));
      await tap(ola, mine2.id, 'resume', at(MIN));
      expect(await tap(ola, mine2.id, 'run', at(2 * MIN))).toMatchObject({ ok: true, run: { state: 'queued' } });
      await tap(ola, goal.id, 'pause', at(3 * MIN));
      expect(await tap(ola, mine1.id, 'run', at(4 * MIN))).toMatchObject({ ok: false, status: 409, code: 'needs_goal' });
      expect(mine(await claimDueRuns(at(5 * MIN)), mine2.id)).toEqual([]);
      expect(await runsOf(mine2.id)).toMatchObject([{ state: 'dropped', attempts: 0 }]);
    });

    it('a stale run that nobody took up is dropped by the next ask, which starts a new one instead of being told the old one still comes', async () => {
      const pip = await person('pip');
      const briefing = await set(pip, { kind: 'schedule', cadence: hourly });
      const first = await tap(pip, briefing.id, 'run', at(MIN));
      if (!first.ok) throw new Error('expected the run');
      // No server asked for it: it is still waiting a quarter of an hour on
      const second = await tap(pip, briefing.id, 'run', at(20 * MIN));
      expect(second).toMatchObject({ ok: true, run: { state: 'queued', replay: false } });
      expect(second.ok && second.run!.runId).not.toBe(first.run!.runId);
      expect(await runsOf(briefing.id)).toMatchObject([{ id: first.run!.runId, state: 'dropped', attempts: 0, error: 'It was not taken up in time' }, { state: 'queued' }]);
    });

    it('a Run now that reports done after the owner paused a one-off does not end the one-off: it was an extra run', async () => {
      const ray = await person('ray');
      const once = await set(ray, { words: 'Call the bank', cadence: { type: 'once', at: at(5 * HOUR).toISOString() } });
      await tap(ray, once.id, 'run', at(MIN));
      const [handed] = mine(await claimDueRuns(at(2 * MIN)), once.id);
      await tap(ray, once.id, 'pause', at(3 * MIN));
      await finishRun(handed.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(4 * MIN));
      // Still paused for its own time, not Done: resuming brings the reminder back
      expect(await row(once.id)).toMatchObject({ state: 'paused', doneAt: null });
      expect(await tap(ray, once.id, 'resume', at(5 * MIN))).toMatchObject({ ok: true, item: { state: 'on', nextDueAt: iso(5 * HOUR) } });
    });

    it('a refusal over the API carries the time usage is back, for the Brick to say', async () => {
      const body = await itemsRefused({ ok: false, status: 409, code: 'no_room', until: iso(3 * HOUR), error: 'Your usage for goals and tasks is used up for now' }).json();
      expect(body).toEqual({ error: 'Your usage for goals and tasks is used up for now', code: 'no_room', until: iso(3 * HOUR) });
    });

    it('a tap that was dropped never ran, so it never uses up the runs a day', async () => {
      const lou = await person('lou');
      const a = await set(lou, { kind: 'schedule', cadence: hourly });
      await saveServerLimits({ bricks: { runsPerDay: 1 } }, lou.id);
      try {
        await tap(lou, a.id, 'run', at(MIN));
        // Not taken up in time: dropped, never handed out
        expect(mine(await claimDueRuns(at(20 * MIN)), a.id)).toEqual([]);
        expect((await runsOf(a.id))[0]).toMatchObject({ state: 'dropped', attempts: 0 });
        // The day's one run is still free: a new tap is asked for, handed out and runs
        expect(await tap(lou, a.id, 'run', at(21 * MIN))).toMatchObject({ ok: true, run: { state: 'queued' } });
        const [handed] = mine(await claimDueRuns(at(22 * MIN)), a.id);
        expect(handed).toBeDefined();
        await finishRun(handed.runId, { attempt: 1, state: 'done', outcome: 'quiet' }, at(23 * MIN));
        // And the scheduled one at its own time is the one that now finds the day used up, as one that ran
        expect(mine(await claimDueRuns(at(HOUR + MIN)), a.id)).toEqual([]);
      } finally {
        await saveServerLimits({ bricks: { runsPerDay: 24 } }, lou.id);
      }
    });

    it('is handed only to a bot server that can run its kind; a watch that nothing tried stays waiting', async () => {
      const lea = await person('lea');
      const watch = await set(lea, { kind: 'watch', words: 'Flight', condition: 'It drops', cadence: hourly });
      await tap(lea, watch.id, 'run', at(MIN));
      expect(mine((await claimWork(at(2 * MIN), undefined, undefined, ['reminder'])).runs, watch.id)).toEqual([]);
      expect((await runsOf(watch.id))[0]).toMatchObject({ state: 'queued', attempts: 0 });
      expect(mine((await claimWork(at(3 * MIN), undefined, undefined, ['watch'])).runs, watch.id)).toMatchObject([{ manual: true, kind: 'watch' }]);
    });

    it('a watch that spoke on a run that was asked for is Done, as it is on its own run; the extra run counts in the person’s own limits like any other', async () => {
      const mo = await person('mo');
      const watch = await set(mo, { kind: 'watch', words: 'Flight', condition: 'It drops', cadence: hourly });
      await tap(mo, watch.id, 'run', at(MIN));
      const [ran] = mine(await claimDueRuns(at(2 * MIN)), watch.id);
      expect(await finishRun(ran.runId, { attempt: 1, state: 'done', outcome: 'spoke', result: 'It dropped to 92' }, at(3 * MIN))).toMatchObject({ ok: true, applied: true, item: { state: 'done', nextDueAt: null, result: 'It dropped to 92' } });
      expect(await row(watch.id)).toMatchObject({ state: 'done', pausedBy: null, regularDueAt: null, snoozedUntil: null });
    });

    it('the owner’s own tap on the screen is the same: the answer carries the run, and a refusal says why', async () => {
      const nia = await person('nia');
      const briefing = await set(nia, { kind: 'schedule', cadence: hourly });
      const ok = await changeFromScreen(nia.id, nia.brickId, briefing.id, { action: 'run', key: 'screen-1' });
      expect(ok).toMatchObject({ ok: true, run: { state: 'queued', replay: false }, item: { nextDueAt: iso(HOUR) } });
      expect(await changeFromScreen(nia.id, nia.brickId, briefing.id, { action: 'run', key: 'screen-1' })).toMatchObject({ ok: true, run: { replay: true } });
      await tap(nia, briefing.id, 'done', new Date());
      expect(await changeFromScreen(nia.id, nia.brickId, briefing.id, { action: 'run' })).toMatchObject({ ok: false, status: 409, code: 'wrong_state' });
    });
  });

  describe('Snooze moves one occurrence, never the rule (F04)', () => {
    it('8:00 snoozed to 8:10 still has 9:00 after it, not 9:10; a second tap is the same snooze; the next one can be snoozed again', async () => {
      const oli = await person('oli');
      await saveServerLimits({ bricks: { snooze: 10 } }, oli.id);
      try {
        const hourlyBriefing = await set(oli, { kind: 'schedule', words: 'Headlines', cadence: hourly });
        // 8:00 (the first due time) runs and the person taps Snooze on its message
        const [first] = mine(await claimDueRuns(at(HOUR)), hourlyBriefing.id);
        await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR + 5_000));
        const snoozed = await tap(oli, hourlyBriefing.id, 'snooze', at(HOUR + 10_000));
        expect(snoozed).toMatchObject({ ok: true, item: { nextDueAt: at(HOUR + 10_000 + 10 * MIN).toISOString(), snoozedUntil: at(HOUR + 10_000 + 10 * MIN).toISOString(), nextRegularAt: iso(2 * HOUR) } });
        const after = await row(hourlyBriefing.id);
        expect(after).toMatchObject({ nextDueAt: at(HOUR + 10_000 + 10 * MIN), regularDueAt: at(2 * HOUR) });
        // A double tap, and a late one before it comes, are the snooze as it is: not later again
        expect(await tap(oli, hourlyBriefing.id, 'snooze', at(HOUR + 11_000))).toMatchObject({ ok: true, item: { nextDueAt: at(HOUR + 10_000 + 10 * MIN).toISOString() } });
        expect(await tap(oli, hourlyBriefing.id, 'snooze', at(HOUR + 5 * MIN))).toMatchObject({ ok: true, item: { nextDueAt: at(HOUR + 10_000 + 10 * MIN).toISOString() } });
        expect((await row(hourlyBriefing.id)).revision).toBe(after.revision);
        // A server restart changes nothing: the snooze is in the database, read afresh
        expect(await readItem(oli.brickId, hourlyBriefing.id, oli.uuid)).toMatchObject({ ok: true, item: { snoozedUntil: at(HOUR + 10_000 + 10 * MIN).toISOString(), nextRegularAt: iso(2 * HOUR) } });
        // It does not run before the snoozed time, runs at it, and leaves the regular 9:00 to come
        expect(mine(await claimDueRuns(at(HOUR + 9 * MIN)), hourlyBriefing.id)).toEqual([]);
        const [snoozedRun] = mine(await claimDueRuns(at(HOUR + 11 * MIN)), hourlyBriefing.id);
        expect(snoozedRun).toMatchObject({ dueAt: at(HOUR + 10_000 + 10 * MIN).toISOString(), manual: false, late: false });
        expect(await row(hourlyBriefing.id)).toMatchObject({ nextDueAt: at(2 * HOUR), regularDueAt: null, snoozedUntil: null });
        await finishRun(snoozedRun.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR + 12 * MIN));
        const [regular] = mine(await claimDueRuns(at(2 * HOUR + MIN)), hourlyBriefing.id);
        expect(regular).toMatchObject({ dueAt: iso(2 * HOUR), late: false });
        expect(await row(hourlyBriefing.id)).toMatchObject({ nextDueAt: at(3 * HOUR) });
        // Done with the snoozed one, it can be snoozed again
        expect(await tap(oli, hourlyBriefing.id, 'snooze', at(2 * HOUR + 2 * MIN))).toMatchObject({ ok: true, item: { nextDueAt: at(2 * HOUR + 12 * MIN).toISOString(), nextRegularAt: iso(3 * HOUR) } });
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, oli.id);
      }
    });

    it('a snooze that reaches the next regular run is that regular run, never a second one: nothing is snoozed', async () => {
      const pam = await person('pam');
      await saveServerLimits({ bricks: { snooze: 90 } }, pam.id);
      try {
        const briefing = await set(pam, { kind: 'schedule', cadence: hourly });
        const [first] = mine(await claimDueRuns(at(HOUR)), briefing.id);
        await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
        const before = await row(briefing.id);
        // 90 minutes from 8:00 passes 9:00: it is the 9:00 run, one run, at the regular time
        expect(await tap(pam, briefing.id, 'snooze', at(HOUR))).toMatchObject({ ok: true, item: { nextDueAt: iso(2 * HOUR), snoozedUntil: null, nextRegularAt: iso(2 * HOUR) } });
        expect(await row(briefing.id)).toMatchObject({ nextDueAt: at(2 * HOUR), regularDueAt: null, snoozedUntil: null, revision: before.revision });
        // Exactly at it: the same
        await saveServerLimits({ bricks: { snooze: 60 } }, pam.id);
        expect(await tap(pam, briefing.id, 'snooze', at(HOUR))).toMatchObject({ ok: true, item: { snoozedUntil: null } });
        expect(mine(await claimDueRuns(at(2 * HOUR + MIN)), briefing.id)).toHaveLength(1);
        expect(await runsOf(briefing.id)).toHaveLength(2);
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, pam.id);
      }
    });

    it('snoozing one that is due and not yet run moves that run, and the rule carries on from where it was', async () => {
      const quin = await person('quin');
      await saveServerLimits({ bricks: { snooze: 10 } }, quin.id);
      try {
        const briefing = await set(quin, { kind: 'schedule', cadence: hourly });
        // 8:00 is due and the bot server has not asked yet; the tap is at 8:03: the 8:00 run becomes 8:13, and 9:00 is next after it
        expect(await tap(quin, briefing.id, 'snooze', at(HOUR + 3 * MIN))).toMatchObject({ ok: true, item: { nextDueAt: at(HOUR + 13 * MIN).toISOString(), nextRegularAt: iso(2 * HOUR) } });
        const runs = mine(await claimDueRuns(at(HOUR + 14 * MIN)), briefing.id);
        expect(runs).toMatchObject([{ dueAt: at(HOUR + 13 * MIN).toISOString() }]);
        expect(await row(briefing.id)).toMatchObject({ nextDueAt: at(2 * HOUR), regularDueAt: null });
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, quin.id);
      }
    });

    it('after an outage the snoozed run and the regular one are one catch-up: one run, then the next still to come, never a backlog', async () => {
      const rex = await person('rex');
      await saveServerLimits({ bricks: { snooze: 10 } }, rex.id);
      try {
        const briefing = await set(rex, { kind: 'schedule', cadence: hourly });
        const [first] = mine(await claimDueRuns(at(HOUR)), briefing.id);
        await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
        await tap(rex, briefing.id, 'snooze', at(HOUR));
        // The bot server is away for hours: both the snoozed 8:10 and the regular 9:00 (and 10:00, 11:00) have fallen due
        const back = mine(await claimDueRuns(at(4 * HOUR + 20 * MIN)), briefing.id);
        expect(back).toHaveLength(1);
        expect(back[0]).toMatchObject({ dueAt: at(HOUR + 10 * MIN).toISOString(), late: true });
        expect(await row(briefing.id)).toMatchObject({ nextDueAt: at(5 * HOUR), regularDueAt: null, snoozedUntil: null });
        expect(mine(await claimDueRuns(at(4 * HOUR + 21 * MIN)), briefing.id)).toEqual([]);
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, rex.id);
      }
    });

    it('a daily briefing keeps its time of day on its own zone whatever the owner’s zone is now, and a snoozed daily one is followed by the regular time', async () => {
      const sol = await person('sol');
      const daily = await set(sol, { kind: 'schedule', words: 'Morning', cadence: everyDay });
      // 07:30 in Kuwait is 04:30Z; the person later travels (their kept zone changes); the item keeps the zone it was set in
      const [ran] = mine(await claimDueRuns(at(24 * HOUR - 90 * MIN)), daily.id);
      expect(ran).toBeDefined();
      await finishRun(ran.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(24 * HOUR - 90 * MIN));
      await prisma.userPreference.update({ where: { userId_key: { userId: sol.id, key: 'timeZone' } }, data: { value: 'Europe/London' } });
      const regular = (await row(daily.id)).nextDueAt!;
      const snoozed = await tap(sol, daily.id, 'snooze', at(24 * HOUR - 89 * MIN));
      expect(snoozed).toMatchObject({ ok: true, item: { timeZone: 'Asia/Kuwait', nextRegularAt: regular.toISOString() } });
      expect((await row(daily.id)).regularDueAt).toEqual(regular);
      // Past the snoozed run, the next regular morning is still 07:30 in Kuwait, a day on, whatever the owner's zone is
      const [late] = mine(await claimDueRuns(at(24 * HOUR - 20 * MIN)), daily.id);
      expect(late).toBeDefined();
      expect(await row(daily.id)).toMatchObject({ nextDueAt: regular, regularDueAt: null, timeZone: 'Asia/Kuwait' });
    });

    it('an occurrence that waits for usage is already put off: snoozing it is the item as it is, never a place on the rule that is not one', async () => {
      const wes = await person('wes');
      const briefing = await set(wes, { kind: 'schedule', words: 'Headlines', cadence: hourly });
      await prisma.botsAiProvider.upsert({ where: { providerId: 'universe-ai' }, create: { providerId: 'universe-ai', name: 'Universe AI', type: 'universe-ai', enabled: true }, update: {} });
      await prisma.botsAiUsage.createMany({ data: Array.from({ length: 30 }, () => ({ botId: wes.brickId, providerId: 'universe-ai', talkedPersonId: wes.id, channel: 'dm', timestamp: at(MIN) })) });
      await prisma.replyWindow.upsert({ where: { key: `ua:person:${wes.id}` }, create: { key: `ua:person:${wes.id}`, startedAt: NOW }, update: { startedAt: NOW } });
      // It falls due with no room: it waits for the usage, due again when that is back
      expect(mine(await claimDueRuns(at(HOUR + MIN)), briefing.id)).toEqual([]);
      const held = await row(briefing.id);
      expect(held.heldSince).not.toBeNull();
      expect(held.nextDueAt!.getTime()).toBeGreaterThan(at(HOUR + MIN).getTime());
      // A snooze tap meets the same wait: nothing is moved, nothing is snoozed, and no stray place is made on the rule
      const snoozed = await tap(wes, briefing.id, 'snooze', at(HOUR + 2 * MIN));
      expect(snoozed).toMatchObject({ ok: true, item: { state: 'on' } });
      expect(await row(briefing.id)).toMatchObject({ nextDueAt: held.nextDueAt, regularDueAt: null, snoozedUntil: null, revision: held.revision });
      // The usage is back: it runs once, and the rule goes on from there with nothing extra
      await prisma.botsAiUsage.deleteMany({ where: { talkedPersonId: wes.id } });
      const handed = mine(await claimDueRuns(at(HOUR + 5 * MIN)), briefing.id);
      expect(handed).toHaveLength(1);
      await finishRun(handed[0].runId, { attempt: 1, state: 'done', outcome: 'quiet' }, at(HOUR + 6 * MIN));
      expect(await row(briefing.id)).toMatchObject({ regularDueAt: null, snoozedUntil: null, heldSince: null });
      expect(mine(await claimDueRuns(at(HOUR + 7 * MIN)), briefing.id)).toEqual([]);
      expect(await runsOf(briefing.id)).toHaveLength(1);
    });

    it('snoozing a repeating item changes nothing a run is about: a Run now that waits, or is running, goes on and reports', async () => {
      const kai = await person('kai');
      await saveServerLimits({ bricks: { snooze: 10 } }, kai.id);
      try {
        const briefing = await set(kai, { kind: 'schedule', cadence: hourly });
        const before = await row(briefing.id);
        const asked = await tap(kai, briefing.id, 'run', at(MIN));
        if (!asked.ok) throw new Error('expected the run');
        // Snoozed while the run waits: the run is not dropped
        expect(await tap(kai, briefing.id, 'snooze', at(2 * MIN))).toMatchObject({ ok: true, item: { state: 'on' } });
        expect(await row(briefing.id)).toMatchObject({ revision: before.revision, snoozedUntil: at(2 * MIN + 10 * MIN) });
        const [handed] = mine(await claimDueRuns(at(3 * MIN)), briefing.id);
        expect(handed).toMatchObject({ runId: asked.run!.runId, manual: true });
        // Still the same item as far as the run is concerned: it is allowed to go on and report
        expect(await checkRun(handed.runId, 1, at(4 * MIN))).toEqual({ ok: true });
        const done = await finishRun(handed.runId, { attempt: 1, state: 'done', outcome: 'spoke', result: 'Sent' }, at(5 * MIN));
        expect(done).toMatchObject({ ok: true, applied: true });
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, kai.id);
      }
    });

    it('a one-off snoozed is the one occurrence that moves, and a repeat tap while it waits is the snooze as it is', async () => {
      const tia = await person('tia');
      const once = await set(tia, { words: 'Call mum', cadence: { type: 'once', at: at(HOUR).toISOString() } });
      const [ran] = mine(await claimDueRuns(at(HOUR + MIN)), once.id);
      await finishRun(ran.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR + 2 * MIN));
      const snoozed = await tap(tia, once.id, 'snooze', at(HOUR + 3 * MIN));
      expect(snoozed).toMatchObject({ ok: true, item: { state: 'on', nextDueAt: at(2 * HOUR + 3 * MIN).toISOString(), snoozedUntil: at(2 * HOUR + 3 * MIN).toISOString() } });
      const revision = (await row(once.id)).revision;
      expect(await tap(tia, once.id, 'snooze', at(HOUR + 4 * MIN))).toMatchObject({ ok: true, item: { nextDueAt: at(2 * HOUR + 3 * MIN).toISOString() } });
      expect((await row(once.id)).revision).toBe(revision);
      // It ran, and can be snoozed again after
      const [again] = mine(await claimDueRuns(at(2 * HOUR + 4 * MIN)), once.id);
      await finishRun(again.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(2 * HOUR + 5 * MIN));
      expect(await row(once.id)).toMatchObject({ state: 'done', snoozedUntil: null, regularDueAt: null });
      expect(await tap(tia, once.id, 'snooze', at(2 * HOUR + 6 * MIN))).toMatchObject({ ok: true, item: { state: 'on', nextDueAt: at(3 * HOUR + 6 * MIN).toISOString() } });
    });

    it('pausing, finishing, deleting or giving it a new time ends a snoozed occurrence with the rest: nothing stale is left to run', async () => {
      const uma = await person('uma');
      await saveServerLimits({ bricks: { snooze: 10 } }, uma.id);
      try {
        for (const action of ['pause', 'done'] as const) {
          const briefing = await set(uma, { kind: 'schedule', cadence: hourly });
          const [first] = mine(await claimDueRuns(at(HOUR)), briefing.id);
          await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
          await tap(uma, briefing.id, 'snooze', at(HOUR));
          expect(await row(briefing.id)).toMatchObject({ snoozedUntil: at(HOUR + 10 * MIN) });
          await tap(uma, briefing.id, action, at(HOUR + MIN));
          expect(await row(briefing.id)).toMatchObject({ nextDueAt: null, regularDueAt: null, snoozedUntil: null });
          expect(mine(await claimDueRuns(at(3 * HOUR)), briefing.id)).toEqual([]);
        }
        // A new time: the old rule's snoozed occurrence goes with it
        const briefing = await set(uma, { kind: 'schedule', cadence: hourly });
        const [first] = mine(await claimDueRuns(at(HOUR)), briefing.id);
        await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
        await tap(uma, briefing.id, 'snooze', at(HOUR));
        await changeItem(uma.brickId, briefing.id, { userId: uma.uuid, action: 'change', change: { cadence: { type: 'every', minutes: 120 } } }, at(HOUR + MIN));
        expect(await row(briefing.id)).toMatchObject({ nextDueAt: at(HOUR + MIN + 2 * HOUR), regularDueAt: null, snoozedUntil: null });
        // A change that does not move its time leaves a snoozed occurrence alone
        const other = await set(uma, { kind: 'schedule', cadence: hourly });
        const [o] = mine(await claimDueRuns(at(HOUR)), other.id);
        await finishRun(o.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
        await tap(uma, other.id, 'snooze', at(HOUR));
        await changeItem(uma.brickId, other.id, { userId: uma.uuid, action: 'change', change: { words: 'New words' } }, at(HOUR + MIN));
        expect(await row(other.id)).toMatchObject({ nextDueAt: at(HOUR + 10 * MIN), regularDueAt: at(2 * HOUR), snoozedUntil: at(HOUR + 10 * MIN) });
        // And the database keeps the rule: only something that is on has a snoozed occurrence
        await expect(prisma.brickItem.update({ where: { id: other.id }, data: { state: 'paused', nextDueAt: null } })).rejects.toThrow();
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, uma.id);
      }
    });

    it('two servers asking at the same moment run a snoozed occurrence once, and the occurrence after it once', async () => {
      const vic = await person('vic');
      await saveServerLimits({ bricks: { snooze: 10 } }, vic.id);
      try {
        const briefing = await set(vic, { kind: 'schedule', cadence: hourly });
        const [first] = mine(await claimDueRuns(at(HOUR)), briefing.id);
        await finishRun(first.runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR));
        await tap(vic, briefing.id, 'snooze', at(HOUR));
        const snoozed = (await Promise.all([claimDueRuns(at(HOUR + 11 * MIN)), claimDueRuns(at(HOUR + 11 * MIN)), claimDueRuns(at(HOUR + 11 * MIN))])).flatMap((runs) => mine(runs, briefing.id));
        expect(snoozed).toHaveLength(1);
        await finishRun(snoozed[0].runId, { attempt: 1, state: 'done', outcome: 'spoke' }, at(HOUR + 12 * MIN));
        const regular = (await Promise.all([claimDueRuns(at(2 * HOUR + MIN)), claimDueRuns(at(2 * HOUR + MIN))])).flatMap((runs) => mine(runs, briefing.id));
        expect(regular).toHaveLength(1);
        expect((await runsOf(briefing.id)).map((one) => one.dueAt.toISOString())).toEqual([iso(HOUR), at(HOUR + 10 * MIN).toISOString(), iso(2 * HOUR)]);
      } finally {
        await saveServerLimits({ bricks: { snooze: 60 } }, vic.id);
      }
    });
  });
});
