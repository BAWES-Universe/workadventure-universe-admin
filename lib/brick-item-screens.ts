import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { changeItem, itemActionSchema, readItem, viewOf, type ItemKind, type ItemView, type Refused } from '@/lib/brick-items';
import type { z } from 'zod';

/**
 * What the game's own screens read about goals and tasks (game #2002): the "Goals and tasks" group on a Brick's page, the one row on the
 * Bricks page that lists them across all Bricks, and "Everything Brick did". All of it is for the signed-in owner, over their session:
 * only their own, a super admin gets their own like anyone, and a Brick that waits deleted is not one of them.
 *
 * Nothing here holds what was said in a chat. A run is a line ("Reminded", "It dropped to 92") and when it ran; the game links to the
 * Brick's chat for the rest.
 */

/** Which part of the Brick's page a row sits in: "In progress" (goals), "Scheduled" (reminders, briefings, watches) or "Done". */
export type ItemGroup = 'progress' | 'scheduled' | 'done';

export interface ScreenItem extends ItemView {
  brickName: string;
  group: ItemGroup;
  /** The checks a goal set for itself, nested under it so a person sees one goal, not its machinery. */
  checks: ItemView[];
}

const groupOf = (item: ItemView): ItemGroup => (item.state === 'done' ? 'done' : item.kind === 'goal' ? 'progress' : 'scheduled');

/**
 * The owner's goals and tasks that are still wanted, on one Brick or across all of theirs, each with its Brick's name. A goal's own
 * checks are nested under it. Items of a Brick that waits deleted are left out until Undo. The soonest due first within a group.
 */
export async function itemsForScreen(ownerId: string, brickId?: string): Promise<ScreenItem[]> {
  const rows = await prisma.brickItem.findMany({
    where: { ownerId, ...(brickId ? { botId: brickId } : {}), state: { not: 'deleted' }, bot: { roomId: null, deletedAt: null } },
    include: { bot: { select: { name: true } } },
    orderBy: [{ nextDueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const views = rows.map((row) => ({ view: viewOf(row), brickName: row.bot.name }));
  const checks = new Map<string, ItemView[]>();
  for (const { view } of views) if (view.parentId) checks.set(view.parentId, [...(checks.get(view.parentId) ?? []), view]);
  return views
    .filter(({ view }) => !view.parentId)
    .map(({ view, brickName }) => ({ ...view, brickName, group: groupOf(view), checks: checks.get(view.id) ?? [] }));
}

/** One run as "Everything Brick did" lists it. */
export interface DidRun {
  runId: string;
  itemId: string;
  brickId: string;
  /** What the item asked for, in the person's words, so a row reads on its own. */
  words: string;
  kind: ItemKind;
  /** When it was due, and when it came to an end (empty while it runs). */
  dueAt: string;
  finishedAt: string | null;
  state: 'claimed' | 'done' | 'failed' | 'dropped';
  /** quiet (nothing to say), spoke (it said something), waiting (it needed something), or empty. */
  outcome: 'quiet' | 'spoke' | 'waiting' | null;
  /** The result in a line, or why it failed. */
  result: string | null;
  error: string | null;
  late: boolean;
  fresh: boolean;
}

const PAGE = 50;

/**
 * Everything one Brick did for its owner by itself, newest first, failed runs and quiet checks included: nothing it did on its own is
 * hidden. `before` (a due time from the last page) asks for the next page; `next` is the cursor for it, or null at the end.
 */
export async function didByBrick(ownerId: string, brickId: string, before?: Date): Promise<{ runs: DidRun[]; next: string | null }> {
  const rows = await prisma.brickItemRun.findMany({
    where: { item: { ownerId, botId: brickId }, ...(before ? { claimedAt: { lt: before } } : {}) },
    orderBy: [{ claimedAt: 'desc' }, { id: 'desc' }],
    take: PAGE + 1,
    include: { item: { select: { words: true, kind: true, botId: true } } },
  });
  const page = rows.slice(0, PAGE);
  return {
    runs: page.map((run) => ({
      runId: run.id,
      itemId: run.itemId,
      brickId: run.item.botId,
      words: run.item.words,
      kind: run.item.kind as ItemKind,
      dueAt: run.dueAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      state: run.state as DidRun['state'],
      outcome: run.outcome === 'quiet' || run.outcome === 'spoke' || run.outcome === 'waiting' ? run.outcome : null,
      result: run.result,
      error: run.error,
      late: run.late,
      fresh: run.fresh,
    })),
    next: rows.length > PAGE ? page[page.length - 1].claimedAt.toISOString() : null,
  };
}

/** Whether this Brick is the signed-in person's own and not waiting deleted: what the screens' routes check first. */
export async function ownsBrickNow(brickId: string, userId: string): Promise<boolean> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  return !!brick && ownsBrick(brick, userId);
}

/**
 * The owner's own tap on a screen: Pause, Resume, Mark done, Reopen, Snooze, Delete, or a change. The same rules as the Brick's own
 * (revision, nothing new starts once it is saved), asked over the person's session instead of by the bot server.
 */
export async function changeFromScreen(ownerId: string, brickId: string, itemId: string, input: Omit<z.infer<typeof itemActionSchema>, 'userId'>): Promise<{ ok: true; item: ItemView } | Refused> {
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { uuid: true } });
  if (!owner) return { ok: false, status: 404, error: 'Brick not found' };
  return changeItem(brickId, itemId, { ...input, userId: owner.uuid });
}

/** One item for the owner's own screen. */
export async function readFromScreen(ownerId: string, brickId: string, itemId: string) {
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { uuid: true } });
  if (!owner) return { ok: false as const, status: 404 as const, error: 'Brick not found' };
  return readItem(brickId, itemId, owner.uuid);
}
