import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { ownerAskingThrough } from '@/lib/brick-make';
import { TIME_ZONE_KEY, WORKWEEK_KEY, firstDue, isTimeZone, nextDue, readCadence, readWorkweek, repeatMinutes, type Cadence } from '@/lib/brick-item-time';

/**
 * Goals and tasks (game #2002, Brick 11): Universe's own scheduler.
 *
 * A person gives their Brick a reminder, a schedule, a watch or a goal in their own words, and it keeps working while they
 * are away. Orbit keeps every one with its owner, its Brick, what it is, how often, the zone it was set in, when it is next
 * due, its state and who set it. The bot server asks Orbit for what is due and runs it; no provider timer ever starts a run.
 *
 * What holds everywhere:
 *  - A run happens once per due time. The pair (item, due time) is unique in the database and an item is claimed under a row
 *    lock, so two servers, a retry or a double ask never run the same due time twice.
 *  - Paused, done or deleted means nothing more runs, and a Brick that is off or deleted runs nothing. Every change that must
 *    stop work that already started (pause, done, delete, change, reopen) raises the item's revision; a run belongs to one
 *    revision, and the bot server asks again before each step that reaches outside Universe (`checkRun`).
 *  - After an outage there is at most one catch-up: a reminder or briefing comes once and says it is late, a watch or a goal
 *    does one fresh check. Never a backlog.
 *  - Only the owner sets one, in their own Brick's direct messages (the bot server only asks on their behalf). The Brick for
 *    guests never sets one: it has no bot row. Deleting a Brick pauses all its items at once and Undo never switches them
 *    back on.
 *  - Never AI in the background for someone who did not ask: an account that never asked for one has no rows, so nothing
 *    runs for it.
 */

export const ITEM_KINDS = ['reminder', 'schedule', 'watch', 'goal'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_STATES = ['on', 'paused', 'done', 'deleted'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Times a run that was claimed but never reported is handed out again (with the same run id) before it counts as failed. */
const MAX_TRIES = 3;
const MINUTE = 60 * 1000;
/** Inside the scheduler only, never a setting: a run this far behind its time is told as late. */
const LATE_GRACE = 15 * MINUTE;
const DAY = 24 * 60 * MINUTE;
/** How many due items one ask for work looks at. The next ask takes the rest. */
const CLAIM_BATCH = 50;

export const stepsSchema = z.array(z.object({ text: z.string().trim().min(1).max(200), state: z.enum(['todo', 'doing', 'done']) }).strict()).max(30);
const person = z.string().trim().min(1).max(320);
const words = z.string().trim().min(1, 'words cannot be empty').max(2000, 'words must be at most 2000 characters');
const line = (max: number) => z.string().trim().min(1).max(max);

/** A new reminder, schedule, watch or goal, as the bot server sends it for the owner of the Brick that asks. */
export const newItemSchema = z
  .object({
    userId: person,
    kind: z.enum(ITEM_KINDS),
    words,
    /** A watch: when it should speak. */
    condition: line(1000).nullish(),
    /** A goal: the outcome the person named. */
    outcome: line(1000).nullish(),
    cadence: z.unknown(),
    /** The zone the person's words were meant in. None: the zone Orbit keeps for them. */
    timeZone: z.string().max(64).nullish(),
    /** A goal with no timed check says what it waits for. */
    waitingFor: line(300).nullish(),
    /** The goal that set this check for itself. Only a goal of the same person; makes it `setBy` brick. */
    parentId: z.string().max(64).nullish(),
  })
  .strict();
export type NewItemInput = z.infer<typeof newItemSchema>;

/** What can change on an item. Nothing here changes its Brick, owner or who set it. */
export const itemChangeSchema = z
  .object({
    words: words.optional(),
    condition: line(1000).nullish(),
    outcome: line(1000).nullish(),
    cadence: z.unknown().optional(),
    timeZone: z.string().max(64).optional(),
    waitingFor: line(300).nullish(),
    statusLine: line(300).nullish(),
    steps: stepsSchema.optional(),
  })
  .strict();

export const ITEM_ACTIONS = ['pause', 'resume', 'done', 'reopen', 'delete', 'change'] as const;
export const itemActionSchema = z
  .object({
    userId: person,
    action: z.enum(ITEM_ACTIONS),
    /** done: the result in a line. */
    result: line(1000).nullish(),
    change: itemChangeSchema.optional(),
  })
  .strict();

export interface ItemView {
  id: string;
  brickId: string;
  kind: ItemKind;
  words: string;
  condition: string | null;
  outcome: string | null;
  cadence: Cadence;
  timeZone: string;
  nextDueAt: string | null;
  waitingFor: string | null;
  statusLine: string | null;
  steps: { text: string; state: 'todo' | 'doing' | 'done' }[];
  state: ItemState;
  setBy: 'you' | 'brick';
  revision: number;
  parentId: string | null;
  pausedBy: 'owner' | 'brick_deleted' | 'goal' | null;
  result: string | null;
  doneAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

type ItemRow = Prisma.BrickItemGetPayload<object>;

function viewOf(row: ItemRow): ItemView {
  const steps = stepsSchema.safeParse(row.steps);
  return {
    id: row.id,
    brickId: row.botId,
    kind: row.kind as ItemKind,
    words: row.words,
    condition: row.condition,
    outcome: row.outcome,
    cadence: readCadence(row.cadence) ?? { type: 'none' },
    timeZone: row.timeZone,
    nextDueAt: row.nextDueAt?.toISOString() ?? null,
    waitingFor: row.waitingFor,
    statusLine: row.statusLine,
    steps: steps.success ? steps.data : [],
    state: row.state as ItemState,
    setBy: row.setBy === 'brick' ? 'brick' : 'you',
    revision: row.revision,
    parentId: row.parentId,
    pausedBy: row.pausedBy === 'owner' || row.pausedBy === 'brick_deleted' || row.pausedBy === 'goal' ? row.pausedBy : null,
    result: row.result,
    doneAt: row.doneAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type Refused = {
  ok: false;
  status: 400 | 404 | 409 | 422;
  error: string;
  /** What the bot server can say to the person, as a code: needs_time_zone, too_often, too_many, past, off. */
  code?: 'needs_time_zone' | 'too_often' | 'too_many' | 'past' | 'off' | 'needs_wait' | 'needs_goal' | 'wrong_state';
  /** The setting that decided it, when there is one. */
  limit?: number;
};

/** The person's own settings the Brick reads before it sets anything: their zone and the days they work. Never guessed. */
export async function itemSettings(viaBrickId: string, userId: string): Promise<({ ok: true; timeZone: string | null; workdays: number[] | null } & { limits: Awaited<ReturnType<typeof getBrickLimits>> }) | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const [rows, limits] = await Promise.all([
    prisma.userPreference.findMany({ where: { userId: ownerId, key: { in: [TIME_ZONE_KEY, WORKWEEK_KEY] } }, select: { key: true, value: true } }),
    getBrickLimits(),
  ]);
  const zone = rows.find((row) => row.key === TIME_ZONE_KEY)?.value;
  return {
    ok: true,
    timeZone: isTimeZone(zone) ? zone : null,
    workdays: readWorkweek(rows.find((row) => row.key === WORKWEEK_KEY)?.value),
    limits,
  };
}

/** Keeps the days a person works (their answer to the Brick's one-line question). Only for the owner of the Brick that asks. */
export async function keepWorkweek(viaBrickId: string, userId: string, days: number[]): Promise<{ ok: true; workdays: number[] } | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const workdays = readWorkweek({ days });
  if (!workdays) return { ok: false, status: 400, error: 'days must be 1 to 7 different days, 0 (Sunday) to 6' };
  const value = { days: workdays } as Prisma.InputJsonValue;
  await prisma.userPreference.upsert({ where: { userId_key: { userId: ownerId, key: WORKWEEK_KEY } }, create: { userId: ownerId, key: WORKWEEK_KEY, value }, update: { value } });
  return { ok: true, workdays };
}

/** The owner's items for one of their Bricks, the ones still wanted (not deleted), the soonest due first. */
export async function listItems(viaBrickId: string, userId: string): Promise<{ ok: true; items: ItemView[] } | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const rows = await prisma.brickItem.findMany({
    where: { ownerId, botId: viaBrickId, state: { not: 'deleted' } },
    orderBy: [{ nextDueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return { ok: true, items: rows.map(viewOf) };
}

/** One item of the owner's, for the Brick it belongs to. */
export async function readItem(viaBrickId: string, itemId: string, userId: string): Promise<{ ok: true; item: ItemView } | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const row = await prisma.brickItem.findFirst({ where: { id: itemId, ownerId, botId: viaBrickId, state: { not: 'deleted' } } });
  return row ? { ok: true, item: viewOf(row) } : { ok: false, status: 404, error: 'Not found' };
}

/** Which cadences make sense for each kind: a reminder is a moment or a daily time; a watch or briefing repeats; a goal repeats or just waits, never a single moment. */
function cadenceFits(kind: ItemKind, cadence: Cadence): boolean {
  if (kind === 'reminder') return cadence.type === 'once' || cadence.type === 'daily';
  if (kind === 'schedule') return cadence.type === 'daily' || cadence.type === 'every';
  if (kind === 'watch') return cadence.type === 'every' || cadence.type === 'daily';
  // A goal lasts until its outcome is reached, so it is never a single moment: a date it cares about is a check it sets (a reminder or a
  // watch under it). It repeats, or it just waits and says for what.
  return cadence.type !== 'once';
}

/**
 * What a cadence needs to be set, as a refusal when it can't be: a shorter wait than the setting allows, a moment that has
 * already passed, or (goal) nothing timed and nothing to say it waits for.
 */
function cadenceProblem(kind: ItemKind, cadence: Cadence | null, timeZone: string, now: Date, shortestRepeat: number, waitingFor: string | null | undefined): Refused | null {
  if (!cadence) return { ok: false, status: 400, error: 'cadence must be once (at), daily (time and days), every (minutes) or none' };
  if (!cadenceFits(kind, cadence)) return { ok: false, status: 400, error: `a ${kind} cannot use a ${cadence.type} cadence` };
  const gap = repeatMinutes(cadence);
  if (gap !== null && gap < shortestRepeat) return { ok: false, status: 422, code: 'too_often', limit: shortestRepeat, error: `the shortest wait between two runs is ${shortestRepeat} minutes` };
  if (cadence.type === 'none' && !waitingFor) return { ok: false, status: 422, code: 'needs_wait', error: 'a goal with no timed check says what it waits for (waitingFor)' };
  if (cadence.type !== 'none' && firstDue(cadence, timeZone, now) === null) return { ok: false, status: 422, code: 'past', error: 'that time has already passed' };
  return null;
}

/**
 * The owner gives their Brick a reminder, a schedule, a watch or a goal. It starts "on" and is due at its first time. A
 * check a goal sets for itself (`parentId`) is "set by Brick"; everything else is "set by you". Refused, with a code the
 * Brick can say plainly: no zone known yet, asked to repeat too often, the person has too many, or the time has passed.
 */
export async function createItem(viaBrickId: string, input: NewItemInput, now: Date = new Date()): Promise<{ ok: true; item: ItemView } | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, input.userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const brick = await prisma.bot.findUnique({ where: { id: viaBrickId }, select: { enabled: true } });
  // A Brick that is switched off runs nothing, so nothing is set for it
  if (!brick?.enabled) return { ok: false, status: 409, code: 'off', error: 'This Brick is switched off' };
  const cadence = readCadence(input.cadence);
  const limits = await getBrickLimits();
  let timeZone = input.timeZone ?? null;
  if (timeZone !== null && !isTimeZone(timeZone)) return { ok: false, status: 400, error: 'timeZone must be a time zone like Asia/Kuwait' };
  if (timeZone === null) {
    const kept = (await prisma.userPreference.findUnique({ where: { userId_key: { userId: ownerId, key: TIME_ZONE_KEY } }, select: { value: true } }))?.value;
    if (!isTimeZone(kept)) return { ok: false, status: 422, code: 'needs_time_zone', error: 'No time zone is kept for this person yet' };
    timeZone = kept;
  }
  if (input.kind === 'watch' && !input.condition) return { ok: false, status: 400, error: 'a watch needs the condition it speaks for' };
  if (input.kind === 'goal' && !input.outcome) return { ok: false, status: 400, error: 'a goal needs the outcome the person named' };
  const problem = cadenceProblem(input.kind, cadence, timeZone, now, limits.shortestRepeat, input.waitingFor);
  if (problem) return problem;
  const settled = cadence as Cadence;
  const due = firstDue(settled, timeZone, now);

  return prisma.$transaction(async (tx) => {
    // One at a time per person, so two asks that arrive together can't both take the last place
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-items:${ownerId}`}))`;
    // The Brick is looked at again under a lock held to the insert: deleting it (or switching it off) waits for this one, and pauses what it
    // made, or comes first and this one is refused. Nothing is ever set on a Brick that is gone.
    const alive = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "bots" WHERE "id" = ${viaBrickId} AND "enabled" = true AND "deleted_at" IS NULL FOR SHARE`);
    if (!alive.length) return { ok: false as const, status: 409 as const, code: 'off' as const, error: 'This Brick is switched off' };
    let parentId: string | null = null;
    if (input.parentId) {
      const goal = await tx.brickItem.findFirst({ where: { id: input.parentId, ownerId, botId: viaBrickId, kind: 'goal', state: 'on' }, select: { id: true } });
      if (!goal) return { ok: false as const, status: 422 as const, code: 'needs_goal' as const, error: 'A check is set by a goal of this person that is on' };
      // A goal may set as many checks as a person may have goals and tasks, never more: checks are not a way round the limit
      const checks = await tx.brickItem.count({ where: { parentId: goal.id, state: { in: ['on', 'paused'] } } });
      if (checks >= limits.itemsPerPerson) return { ok: false as const, status: 422 as const, code: 'too_many' as const, limit: limits.itemsPerPerson, error: `${limits.itemsPerPerson} checks for one goal is the most` };
      parentId = goal.id;
    } else {
      const have = await tx.brickItem.count({ where: { ownerId, parentId: null, state: { in: ['on', 'paused'] } } });
      if (have >= limits.itemsPerPerson) return { ok: false as const, status: 422 as const, code: 'too_many' as const, limit: limits.itemsPerPerson, error: `${limits.itemsPerPerson} goals and tasks at once is the most` };
    }
    const row = await tx.brickItem.create({
      data: {
        ownerId,
        botId: viaBrickId,
        kind: input.kind,
        words: input.words,
        condition: input.kind === 'watch' ? input.condition ?? null : null,
        outcome: input.kind === 'goal' ? input.outcome ?? null : null,
        cadence: settled as unknown as Prisma.InputJsonValue,
        timeZone: timeZone!,
        nextDueAt: due,
        waitingFor: settled.type === 'none' ? input.waitingFor ?? null : null,
        setBy: parentId ? 'brick' : 'you',
        parentId,
      },
    });
    return { ok: true as const, item: viewOf(row) };
  });
}

type Tx = Prisma.TransactionClient;

/** Locks one item for the rest of the transaction and reads it. Everything that changes an item goes through this. */
async function lockedItem(tx: Tx, where: { id: string; ownerId?: string; botId?: string }): Promise<ItemRow | null> {
  const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "brick_items"
    WHERE "id" = ${where.id}
      ${where.ownerId ? Prisma.sql`AND "owner_id" = ${where.ownerId}` : Prisma.empty}
      ${where.botId ? Prisma.sql`AND "bot_id" = ${where.botId}` : Prisma.empty}
    FOR UPDATE`);
  return found.length ? tx.brickItem.findUnique({ where: { id: where.id } }) : null;
}

/** Gives the checks a goal set the goal's own change (pause, resume, done, delete), in the same transaction. */
async function moveChecks(tx: Tx, goalId: string, from: ItemState[], data: Prisma.BrickItemUpdateManyMutationInput, now: Date, recompute: boolean, onlyPausedBy?: string[]) {
  const checks = await tx.brickItem.findMany({ where: { parentId: goalId, state: { in: from }, ...(onlyPausedBy ? { pausedBy: { in: onlyPausedBy } } : {}) } });
  for (const check of checks) {
    const cadence = readCadence(check.cadence);
    // A one-off check whose moment passed while its goal was paused is due now, once, like a one-off that is resumed on its own
    const due = recompute && cadence ? (firstDue(cadence, check.timeZone, now) ?? (cadence.type === 'once' ? now : null)) : null;
    await tx.brickItem.update({ where: { id: check.id }, data: { ...data, nextDueAt: due, revision: { increment: 1 } } });
  }
}

/** Whether the goal a check belongs to is on. */
async function goalIsOn(tx: Tx, goalId: string): Promise<boolean> {
  return (await tx.brickItem.findUnique({ where: { id: goalId }, select: { state: true } }))?.state === 'on';
}

const wrongState = (state: string): Refused => ({ ok: false, status: 409, code: 'wrong_state', error: `That is not possible while it is ${state}` });

/**
 * The owner's change to one item: pause, resume, done (with its result), reopen, delete, or change what it says or when.
 * Every one raises the revision, so a run that already started is dropped at its next outside step, and nothing new starts
 * once the change is saved. Pausing, finishing or deleting a goal does the same to the checks it set, and only those.
 * Asked twice (a double tap) the second answer is the item as it is now.
 */
export async function changeItem(viaBrickId: string, itemId: string, input: z.infer<typeof itemActionSchema>, now: Date = new Date()): Promise<{ ok: true; item: ItemView } | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, input.userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const limits = await getBrickLimits();
  return prisma.$transaction(async (tx) => {
    // The person's lock comes first, before any row, the same order as setting one (createItem): so a change, a reopen and a new check
    // under the same goal can never wait on each other in a circle
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-items:${ownerId}`}))`;
    const row = await lockedItem(tx, { id: itemId, ownerId, botId: viaBrickId });
    if (!row || row.state === 'deleted') return { ok: false as const, status: 404 as const, error: 'Not found' };
    const cadence = readCadence(row.cadence) ?? ({ type: 'none' } as Cadence);
    const bump = { revision: { increment: 1 } };
    const finish = async (data: Prisma.BrickItemUpdateInput) => ({ ok: true as const, item: viewOf(await tx.brickItem.update({ where: { id: row.id }, data })) });

    switch (input.action) {
      case 'pause': {
        if (row.state === 'paused') return { ok: true as const, item: viewOf(row) };
        if (row.state !== 'on') return wrongState(row.state);
        await moveChecks(tx, row.id, ['on'], { state: 'paused', pausedBy: 'goal' }, now, false);
        return finish({ state: 'paused', pausedBy: 'owner', nextDueAt: null, ...bump });
      }
      case 'resume': {
        if (row.state === 'on') return { ok: true as const, item: viewOf(row) };
        if (row.state !== 'paused') return wrongState(row.state);
        const bot = await tx.bot.findUnique({ where: { id: row.botId }, select: { enabled: true, deletedAt: true } });
        if (!bot?.enabled || bot.deletedAt) return { ok: false as const, status: 409 as const, code: 'off' as const, error: 'This Brick is switched off' };
        // A check runs only while its goal is on: it is brought back by its goal's Resume, not on its own under a paused goal
        if (row.parentId && !(await goalIsOn(tx, row.parentId))) return { ok: false as const, status: 409 as const, code: 'needs_goal' as const, error: 'A check comes back only while its goal is on' };
        // One that was meant for a moment that has passed while it was paused is due now, once; the rest carry on from now
        const due = cadence.type === 'once' ? (firstDue(cadence, row.timeZone, now) ?? now) : firstDue(cadence, row.timeZone, now);
        // Only the checks its own pause (or the deleted Brick) stopped: one the person paused by itself stays paused
        await moveChecks(tx, row.id, ['paused'], { state: 'on', pausedBy: null }, now, true, ['goal', 'brick_deleted']);
        return finish({ state: 'on', pausedBy: null, nextDueAt: due, ...bump });
      }
      case 'done': {
        if (row.state === 'done') return { ok: true as const, item: viewOf(row) };
        await moveChecks(tx, row.id, ['on', 'paused'], { state: 'done', pausedBy: null, doneAt: now }, now, false);
        return finish({ state: 'done', pausedBy: null, nextDueAt: null, doneAt: now, result: input.result ?? row.result, ...bump });
      }
      case 'reopen': {
        if (row.state === 'on') return { ok: true as const, item: viewOf(row) };
        if (row.state !== 'done') return wrongState(row.state);
        const bot = await tx.bot.findUnique({ where: { id: row.botId }, select: { enabled: true, deletedAt: true } });
        if (!bot?.enabled || bot.deletedAt) return { ok: false as const, status: 409 as const, code: 'off' as const, error: 'This Brick is switched off' };
        // Reopening takes a place again, so it keeps to the same limits as setting a new one: the person's goals and tasks, and for a check
        // its goal's checks, and its goal has to be on (this change holds the person's lock, so nothing else of theirs changes meanwhile)
        if (row.parentId) {
          if (!(await goalIsOn(tx, row.parentId))) return { ok: false as const, status: 409 as const, code: 'needs_goal' as const, error: 'A check comes back only while its goal is on' };
          const checks = await tx.brickItem.count({ where: { parentId: row.parentId, state: { in: ['on', 'paused'] } } });
          if (checks >= limits.itemsPerPerson) return { ok: false as const, status: 422 as const, code: 'too_many' as const, limit: limits.itemsPerPerson, error: `${limits.itemsPerPerson} checks for one goal is the most` };
        } else {
          const have = await tx.brickItem.count({ where: { ownerId, parentId: null, state: { in: ['on', 'paused'] } } });
          if (have >= limits.itemsPerPerson) return { ok: false as const, status: 422 as const, code: 'too_many' as const, limit: limits.itemsPerPerson, error: `${limits.itemsPerPerson} goals and tasks at once is the most` };
        }
        // Starts again from the new revision, counted from now: a one-off that has passed is due now, once
        const due = cadence.type === 'once' ? (firstDue(cadence, row.timeZone, now) ?? now) : firstDue(cadence, row.timeZone, now);
        return finish({ state: 'on', pausedBy: null, doneAt: null, result: null, nextDueAt: due, failuresInRow: 0, ...bump });
      }
      case 'delete': {
        await moveChecks(tx, row.id, ['on', 'paused', 'done'], { state: 'deleted', pausedBy: null }, now, false);
        return finish({ state: 'deleted', pausedBy: null, nextDueAt: null, ...bump });
      }
      case 'change': {
        const change = input.change;
        if (!change || Object.keys(change).length === 0) return { ok: false as const, status: 400 as const, error: 'change says what to change' };
        if (row.state === 'deleted') return wrongState(row.state);
        let timeZone = row.timeZone;
        if (change.timeZone !== undefined) {
          if (!isTimeZone(change.timeZone)) return { ok: false as const, status: 400 as const, error: 'timeZone must be a time zone like Asia/Kuwait' };
          timeZone = change.timeZone;
        }
        const nextCadence = change.cadence === undefined ? cadence : readCadence(change.cadence);
        const waitingFor = change.waitingFor === undefined ? row.waitingFor : change.waitingFor;
        const kind = row.kind as ItemKind;
        // A one-off is kept as the instant it means, so a new zone alone moves nothing for it; a time of day or a repeat is read on the zone's clock
        const rescheduled = change.cadence !== undefined || (change.timeZone !== undefined && nextCadence?.type !== 'once');
        if (rescheduled) {
          const problem = cadenceProblem(kind, nextCadence, timeZone, now, limits.shortestRepeat, waitingFor);
          if (problem) return problem;
        } else if (!nextCadence) {
          return { ok: false as const, status: 400 as const, error: 'cadence is not readable' };
        }
        if (nextCadence?.type === 'none' && !waitingFor) return { ok: false as const, status: 422 as const, code: 'needs_wait' as const, error: 'a goal with no timed check says what it waits for (waitingFor)' };
        if (kind === 'watch' && change.condition === null) return { ok: false as const, status: 400 as const, error: 'a watch needs the condition it speaks for' };
        if (kind === 'goal' && change.outcome === null) return { ok: false as const, status: 400 as const, error: 'a goal needs the outcome the person named' };
        const settled = nextCadence as Cadence;
        // A one-off that was claimed has no next due time while its run is in flight. Changing it drops that run (its revision moved), so it is
        // due again now, with its new words: never left on with nothing due
        const due = row.state === 'on' ? (rescheduled ? firstDue(settled, timeZone, now) : (row.nextDueAt ?? (settled.type === 'once' ? now : null))) : null;
        return finish({
          words: change.words ?? row.words,
          condition: kind === 'watch' && change.condition !== undefined ? change.condition : row.condition,
          outcome: kind === 'goal' && change.outcome !== undefined ? change.outcome : row.outcome,
          cadence: settled as unknown as Prisma.InputJsonValue,
          timeZone,
          nextDueAt: due,
          waitingFor: settled.type === 'none' ? waitingFor ?? null : null,
          statusLine: change.statusLine === undefined ? row.statusLine : change.statusLine,
          steps: (change.steps ?? row.steps) as Prisma.InputJsonValue,
          ...bump,
        });
      }
    }
  });
}

/**
 * Deleting a Brick stops every item it has, at once and in the same transaction as the delete: they are paused (not
 * deleted), so the person still sees them, and Undo gives the Brick back without switching any of them on. Items already
 * done stay as they are.
 */
export async function pauseItemsOfDeletedBrick(db: Tx, botId: string): Promise<number> {
  const { count } = await db.brickItem.updateMany({
    where: { botId, state: 'on' },
    data: { state: 'paused', pausedBy: 'brick_deleted', nextDueAt: null, revision: { increment: 1 } },
  });
  return count;
}

export interface ClaimedRun {
  runId: string;
  itemId: string;
  brickId: string;
  /** The owner as the bot server names people: their game uuid. */
  userId: string;
  kind: ItemKind;
  words: string;
  condition: string | null;
  outcome: string | null;
  steps: ItemView['steps'];
  statusLine: string | null;
  timeZone: string;
  /** The occurrence this run is for; a late one still says when it was due. */
  dueAt: string;
  revision: number;
  /** A reminder or briefing that comes after an outage: Brick says so in its own words ("I ran the 8:00 check now, 20 minutes late"). */
  late: boolean;
  /** A watch or goal check run after an outage: one fresh check, nothing replayed. */
  fresh: boolean;
  /** 1 for a new run; more when it is handed out again after its lease ran out (same run id, so an outside effect is looked up first). */
  attempt: number;
  /** When the run is given up if it has not reported. */
  leaseUntil: string;
}

const claimedOf = (run: Prisma.BrickItemRunGetPayload<{ include: { item: { include: { owner: { select: { uuid: true } } } } } }>): ClaimedRun => {
  const steps = stepsSchema.safeParse(run.item.steps);
  return {
    runId: run.id,
    itemId: run.itemId,
    brickId: run.item.botId,
    userId: run.item.owner.uuid,
    kind: run.item.kind as ItemKind,
    words: run.item.words,
    condition: run.item.condition,
    outcome: run.item.outcome,
    steps: steps.success ? steps.data : [],
    statusLine: run.item.statusLine,
    timeZone: run.item.timeZone,
    dueAt: run.dueAt.toISOString(),
    revision: run.revision,
    late: run.late,
    fresh: run.fresh,
    attempt: run.attempts,
    leaseUntil: run.leaseUntil.toISOString(),
  };
};
const RUN_INCLUDE = { item: { include: { owner: { select: { uuid: true } } } } } as const;

/** A one-off (a single moment, never a goal) has no next time: when its run fails for good it ends, it is never left on with nothing due. */
function endsOnFailure(item: { kind: string; cadence: Prisma.JsonValue }): boolean {
  return item.kind !== 'goal' && readCadence(item.cadence)?.type === 'once';
}
function endedOneOff(now: Date): Prisma.BrickItemUpdateInput {
  return { state: 'done', nextDueAt: null, doneAt: now, revision: { increment: 1 } };
}

/**
 * What the bot server runs now. First the runs it was handed and never reported, whose lease is over: handed out again with
 * the same run id (so a message that went out is found by that id, never written twice), or, after the third try, failed.
 * Then everything that has fallen due, one run each. One item per transaction under a row lock that skips what another
 * server holds, so two asks at the same moment split the work and never share it.
 */
export async function claimDueRuns(now: Date = new Date(), limit = CLAIM_BATCH): Promise<ClaimedRun[]> {
  const limits = await getBrickLimits();
  const lease = new Date(now.getTime() + limits.longestRun * MINUTE);
  const out: ClaimedRun[] = [];

  // Runs handed out and never reported
  const lapsed = await prisma.brickItemRun.findMany({ where: { state: 'claimed', leaseUntil: { lte: now } }, orderBy: { leaseUntil: 'asc' }, take: limit, select: { id: true, itemId: true } });
  for (const { id, itemId } of lapsed) {
    try {
      const again = await prisma.$transaction(async (tx) => {
        // The item first, then its run: the same order as every other writer (finishRun, the claim below), so a run that is handed out
        // again at the moment its server reports can never wait on each other
        const item = await lockedItem(tx, { id: itemId });
        const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "brick_item_runs" WHERE "id" = ${id} AND "state" = 'claimed' AND "lease_until" <= ${now} FOR UPDATE SKIP LOCKED`);
        if (!locked.length) return null;
        const run = await tx.brickItemRun.findUniqueOrThrow({ where: { id }, include: RUN_INCLUDE });
        // Only while the item is still the same and still on: a run for something that changed is dropped, not retried
        const stillOn = !!item && item.state === 'on' && item.revision === run.revision;
        if (!stillOn) {
          await tx.brickItemRun.update({ where: { id }, data: { state: 'dropped', finishedAt: now } });
          return null;
        }
        // And only while its Brick is on: a Brick that is off or deleted is not handed anything. A one-off that was claimed has no next
        // time, so it is due again now, and runs once when the Brick is back.
        const bot = await tx.bot.findUnique({ where: { id: run.item.botId }, select: { enabled: true, deletedAt: true } });
        if (!bot?.enabled || bot.deletedAt) {
          await tx.brickItemRun.update({ where: { id }, data: { state: 'dropped', finishedAt: now } });
          if (readCadence(item.cadence)?.type === 'once') await tx.brickItem.update({ where: { id: item.id }, data: { nextDueAt: now } });
          return null;
        }
        if (run.attempts >= MAX_TRIES) {
          await tx.brickItemRun.update({ where: { id }, data: { state: 'failed', error: 'It did not finish in time', finishedAt: now } });
          await tx.brickItem.update({ where: { id: run.itemId }, data: { failuresInRow: { increment: 1 }, lastRunAt: now, ...(endsOnFailure(item) ? endedOneOff(now) : {}) } });
          return null;
        }
        return tx.brickItemRun.update({ where: { id }, data: { attempts: { increment: 1 }, leaseUntil: lease }, include: RUN_INCLUDE });
      });
      if (again) out.push(claimedOf(again));
    } catch (error) {
      // One run that could not be taken (a deadlock Postgres broke, a dropped connection) never discards what is already claimed:
      // it stays claimed and is looked at again by the next ask
      console.error('[BrickItems] Could not hand a run out again:', error instanceof Error ? error.message : 'unknown');
    }
  }

  // What has fallen due. Only an item that is on, whose Brick is on and not deleted and still its owner's
  const due = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT i."id" FROM "brick_items" i
    JOIN "bots" b ON b."id" = i."bot_id"
    WHERE i."state" = 'on' AND i."next_due_at" <= ${now}
      AND b."enabled" = true AND b."deleted_at" IS NULL AND b."room_id" IS NULL AND b."owner_id" = i."owner_id"
      -- A person who is at their runs a day is left out here, so what they hold back never fills the batch ahead of everyone else
      AND (i."kind" = 'reminder' OR (
        SELECT count(*) FROM "brick_item_runs" r JOIN "brick_items" j ON j."id" = r."item_id"
        WHERE j."owner_id" = i."owner_id" AND j."kind" <> 'reminder' AND r."claimed_at" > ${new Date(now.getTime() - DAY)}
      ) < ${limits.runsPerDay})
    ORDER BY i."next_due_at" ASC, i."id" ASC
    LIMIT ${limit}`);
  for (const { id } of due) {
    let claimed: Prisma.BrickItemRunGetPayload<{ include: typeof RUN_INCLUDE }> | null = null;
    try {
      claimed = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT i."id" FROM "brick_items" i
          JOIN "bots" b ON b."id" = i."bot_id"
          WHERE i."id" = ${id} AND i."state" = 'on' AND i."next_due_at" <= ${now}
            AND b."enabled" = true AND b."deleted_at" IS NULL AND b."room_id" IS NULL AND b."owner_id" = i."owner_id"
          FOR UPDATE OF i SKIP LOCKED`);
        if (!locked.length) return null;
        const item = await tx.brickItem.findUniqueOrThrow({ where: { id } });
        const dueAt = item.nextDueAt!;
        const cadence = readCadence(item.cadence);
        const behind = now.getTime() - dueAt.getTime();
        const overdue = behind > LATE_GRACE;
        const reminderLike = item.kind === 'reminder' || item.kind === 'schedule';

        // Runs a day: watches, schedules and goals together, per person. A reminder is fixed text with no AI and never uses them.
        if (item.kind !== 'reminder') {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-runs:${item.ownerId}`}))`;
          const today = await tx.brickItemRun.count({ where: { claimedAt: { gt: new Date(now.getTime() - DAY) }, item: { ownerId: item.ownerId, kind: { not: 'reminder' } } } });
          if (today >= limits.runsPerDay) return null;
        }

        // The run, once per item and due time: the unique pair is the backstop under the row lock
        const made = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          INSERT INTO "brick_item_runs" ("id", "item_id", "due_at", "revision", "claimed_at", "lease_until", "late", "fresh")
          VALUES (${randomUUID()}, ${id}, ${dueAt}, ${item.revision}, ${now}, ${lease}, ${overdue && reminderLike}, ${overdue && !reminderLike})
          ON CONFLICT ("item_id", "due_at") DO NOTHING
          RETURNING "id"`);
        // The next one is the first still to come: after an outage everything missed but this one is skipped, never replayed
        const next = cadence ? nextDue(cadence, item.timeZone, dueAt, now) : null;
        await tx.brickItem.update({ where: { id }, data: { nextDueAt: next } });
        if (!made.length) return null;
        return tx.brickItemRun.findUniqueOrThrow({ where: { id: made[0].id }, include: RUN_INCLUDE });
      });
    } catch (error) {
      console.error('[BrickItems] Could not claim a due item:', error instanceof Error ? error.message : 'unknown');
    }
    if (claimed) out.push(claimedOf(claimed));
  }
  return out;
}

export const runReportSchema = z
  .object({
    state: z.enum(['done', 'failed']),
    /** The try the bot server holds (`attempt` of the run it was handed). A report for an older try, after the run was handed out again, is refused. */
    attempt: z.number().int().min(1),
    /** quiet: nothing to say; spoke: it said something; waiting: it needs something and says what. */
    outcome: z.enum(['quiet', 'spoke', 'waiting']).nullish(),
    /** The run in a line, for "Everything Brick did". */
    result: line(1000).nullish(),
    error: line(300).nullish(),
    /** A goal's progress after this run. Applied only while the item is still the revision the run was claimed for. */
    progress: z.object({ statusLine: line(300).nullish(), steps: stepsSchema.optional(), waitingFor: line(300).nullish() }).strict().optional(),
    /** A goal that reached the outcome the person named: it closes itself, stops its own checks and moves to Done. */
    reached: z.boolean().optional(),
  })
  .strict();

export type RunCheck = { ok: true } | { ok: false; reason: 'changed' | 'paused' | 'done' | 'deleted' | 'off' | 'finished' | 'not_found' | 'stale' };

/**
 * May this run take its next step? Asked by the bot server before every step that reaches outside Universe (a send, a
 * change in an app, paying), not once per run: the answer is no from the moment a change to the item is saved, or its Brick
 * is switched off or deleted, so nothing new starts and anything already sent is reconciled.
 */
export async function checkRun(runId: string, attempt: number): Promise<RunCheck> {
  const run = await prisma.brickItemRun.findUnique({ where: { id: runId }, include: { item: { include: { bot: { select: { enabled: true, deletedAt: true } } } } } });
  if (!run) return { ok: false, reason: 'not_found' };
  if (run.state !== 'claimed') return { ok: false, reason: 'finished' };
  // Handed out again to another try: this one stops, so it can never carry on beside the newer one
  if (run.attempts !== attempt) return { ok: false, reason: 'stale' };
  const { item } = run;
  if (item.state === 'paused') return { ok: false, reason: 'paused' };
  if (item.state === 'done') return { ok: false, reason: 'done' };
  if (item.state === 'deleted') return { ok: false, reason: 'deleted' };
  if (!item.bot.enabled || item.bot.deletedAt) return { ok: false, reason: 'off' };
  if (item.revision !== run.revision) return { ok: false, reason: 'changed' };
  return { ok: true };
}

export type RunFinished = { ok: true; item: ItemView; applied: boolean; failuresInRow: number } | { ok: false; status: 404 | 409; error: string };

/**
 * The bot server reports how a run went. The run is recorded as reported, always: every run, failed ones too, is in
 * "Everything Brick did" at once. What it means for the item (the next due time, a goal's progress, a watch that spoke, a
 * reminder that was sent) is applied only while the item is still at the revision the run was claimed for; after a pause,
 * a change or a delete it is not (`applied` false). Reported twice, the first report stands.
 */
export async function finishRun(runId: string, report: z.infer<typeof runReportSchema>, now: Date = new Date()): Promise<RunFinished> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.brickItemRun.findUnique({ where: { id: runId }, select: { itemId: true } });
    if (!found) return { ok: false as const, status: 404 as const, error: 'Run not found' };
    const item = await lockedItem(tx, { id: found.itemId });
    const run = await tx.brickItemRun.findUnique({ where: { id: runId } });
    if (!item || !run) return { ok: false as const, status: 404 as const, error: 'Run not found' };
    if (run.state !== 'claimed') return { ok: false as const, status: 409 as const, error: 'This run was already reported' };
    if (run.attempts !== report.attempt) return { ok: false as const, status: 409 as const, error: 'This run was handed out again, so this try can no longer report it' };

    await tx.brickItemRun.update({
      where: { id: runId },
      data: { state: report.state, outcome: report.outcome ?? null, result: report.result ?? null, error: report.state === 'failed' ? report.error ?? 'It did not work' : null, finishedAt: now },
    });
    // Whether the item is still what the run was claimed for
    const applied = item.revision === run.revision && item.state === 'on';
    const failuresInRow = report.state === 'failed' ? item.failuresInRow + 1 : 0;
    if (!applied) {
      return { ok: true as const, item: viewOf(item), applied: false, failuresInRow: item.failuresInRow };
    }

    const kind = item.kind as ItemKind;
    const cadence = readCadence(item.cadence);
    const data: Prisma.BrickItemUpdateInput = { lastRunAt: now, failuresInRow };
    if (report.progress && kind === 'goal') {
      if (report.progress.statusLine !== undefined) data.statusLine = report.progress.statusLine;
      if (report.progress.steps !== undefined) data.steps = report.progress.steps;
      if (report.progress.waitingFor !== undefined) data.waitingFor = report.progress.waitingFor;
    }
    // A one-off ends with its one run: once it was sent, or when that run failed (it has no next time to come back on, so left on
    // it would sit there forever and count against the person's limit). The failed run stays in "Everything Brick did".
    // A goal is never a one-off: it lasts until the outcome is reached (goalReached below), whatever its first check was.
    const oneOffSent = kind !== 'goal' && cadence?.type === 'once' && (report.state === 'done' || report.state === 'failed');
    // A watch speaks only when its condition is met, says so once, then moves to Done (Reopen starts it again)
    const watchSpoke = kind === 'watch' && report.state === 'done' && report.outcome === 'spoke';
    const goalReached = kind === 'goal' && report.state === 'done' && report.reached === true;
    if (oneOffSent || watchSpoke || goalReached) {
      Object.assign(data, { state: 'done', nextDueAt: null, doneAt: now, result: report.result ?? item.result, revision: { increment: 1 } });
      if (goalReached) await moveChecks(tx, item.id, ['on', 'paused'], { state: 'done', pausedBy: null, doneAt: now }, now, false);
    }
    const updated = await tx.brickItem.update({ where: { id: item.id }, data });
    return { ok: true as const, item: viewOf(updated), applied: true, failuresInRow };
  });
}
