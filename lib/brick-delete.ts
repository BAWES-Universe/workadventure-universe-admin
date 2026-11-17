import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { endAllApprovals } from '@/lib/bot-actions';
import { pauseItemsOfDeletedBrick } from '@/lib/brick-items';
import { syncToolSignInNotices } from '@/lib/tool-signin';
import { stopComputerWork } from '@/lib/computer';
import { purgeBrick, sweepPurges } from '@/lib/brick-purge';
import { listBricks, listDeletedBricks, type BrickCard, type DeletedBrickCard } from '@/lib/brick-default';

/**
 * Deleting a Brick, with Undo (game #1996).
 *
 * A delete has two steps. The first is the owner's tap: the Brick stops at once and waits, off, under "Deleted" on its
 * owner's Bricks page. The second comes by itself when its days are over (a number a super admin can change, 7 to start
 * with): the Brick, its chat and what it remembers are removed for good. Until then Undo gives it back.
 *
 * What stops at the tap. The Brick is switched off in the same statement that marks it deleted, and the database keeps a
 * deleted Brick off, so everything that respects a bot's switch stops for it. `ownsBrick` answers no for it, so nobody
 * chats with it, reads it or changes it, its owner included, and its AI key is not served for it. Every approval it
 * remembered ends and every card of it that waits is closed.
 *
 * What Undo gives back. The Brick as its row is then: its chat, what it remembers, and its switch as it was. Nothing is
 * kept aside at the delete to be put back, so nothing that was withdrawn can return: an approval that ended stays ended,
 * and a key that was taken away while it waited is checked again on its next reply like any other day. An action that
 * was running at the delete keeps its own record and is never sent again.
 *
 * Its computer (game #2000). At the tap its jobs end and it stops (its files are kept, off, for Undo). Undo gives the Brick back but
 * starts no job again. At the second step the machine and every saved copy are deleted, with no copy made first (audit F08).
 *
 * What is never deleted. What the Brick made and a person owns: an artifact belongs to the person who asked for it, so it stays in
 * their artifacts after both steps, with a neutral line where the Brick's name was (lib/brick-purge.ts says everything that stays and why).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The owner deletes their Brick. Null when it is not theirs to delete: someone else's, a room bot, one that does not
 * exist. Asked twice (a double tap), the second answer is the same waiting Brick with the same end date.
 */
export async function deleteBrick(brickId: string, ownerId: string, now: Date = new Date()): Promise<DeletedBrickCard | null> {
  const { undoDays } = await getBrickLimits();
  const goneAt = new Date(now.getTime() + undoDays * DAY_MS);
  const deletedNow = await prisma.$transaction(async (tx) => {
    // One statement: the switch as it was is kept and turned off together with the mark, so a tap on the switch at the
    // same moment can't leave a deleted Brick on, or have Undo bring back the wrong state
    const marked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "bots"
      SET "deleted_at" = ${now}, "gone_at" = ${goneAt}, "enabled_before_delete" = "enabled", "enabled" = false,
          "updated_by_id" = ${ownerId}, "updated_at" = ${now}
      WHERE "id" = ${brickId} AND "owner_id" = ${ownerId} AND "room_id" IS NULL AND "deleted_at" IS NULL
      RETURNING "id"`);
    if (marked.length > 0) {
      await endAllApprovals(tx, brickId, now);
      // It stands nowhere while it waits (game #2005): its home and its visit are withdrawn with everything else, and Undo brings back neither
      await tx.brickHome.deleteMany({ where: { botId: brickId } });
      await tx.brickVisit.deleteMany({ where: { botId: brickId } });
      // Its goals and tasks stop at the same moment; Undo gives the Brick back without switching any of them on (game #2002)
      await pauseItemsOfDeletedBrick(tx, brickId);
    }
    return marked.length > 0;
  });
  // Its tools' sign-in cards on Orbit home go too: nobody manages a deleted Brick (it never throws)
  if (deletedNow) await syncToolSignInNotices(brickId);
  // Its computer's work stops at once too (game #2000): jobs end, the screen goes, files are saved and kept. Undo never restarts a job
  if (deletedNow) await stopComputerWork(brickId, 'deleted', now);
  return (await listDeletedBricks(ownerId, now)).find((card) => card.id === brickId) ?? null;
}

/**
 * Undo: the owner takes a deleted Brick back while its days last. Null when there is nothing of theirs to give back: it
 * is someone else's, it never was deleted by them, or its time has passed. Asked twice, the second answer is the same
 * Brick, back already.
 */
export async function undoBrickDelete(brickId: string, ownerId: string, now: Date = new Date()): Promise<BrickCard | null> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "bots"
    SET "enabled" = COALESCE("enabled_before_delete", true), "deleted_at" = NULL, "gone_at" = NULL, "enabled_before_delete" = NULL,
        "updated_by_id" = ${ownerId}, "updated_at" = ${now}
    WHERE "id" = ${brickId} AND "owner_id" = ${ownerId} AND "room_id" IS NULL AND "deleted_at" IS NOT NULL AND "gone_at" > ${now}`);
  return (await listBricks(ownerId)).find((card) => card.id === brickId) ?? null;
}

/** How many Bricks one sweep removes at most; the next sweep takes the rest. */
const SWEEP_BATCH = 200;
/** How many pages of that size one sweep reads, so it ends even when many Bricks wait. */
const SWEEP_PAGES = 10;

/** A deleted Brick that had to wait is marked as looked at now, which sends it behind the ones not looked at yet. */
async function markWaiting(brickId: string, now: Date): Promise<void> {
  await prisma.bot.updateMany({ where: { id: brickId, roomId: null, deletedAt: { not: null } }, data: { updatedAt: now } });
}

/**
 * The second step, the final purge (audit F08): every deleted Brick whose days are over is purged for good, in one transaction, with
 * everything it owned (see lib/brick-purge.ts). For one person when `ownerId` is given, else for everyone. Returns the ids purged, so the bot
 * server can close their chats.
 *
 * Nothing outside Orbit holds it back. A machine that cannot be removed now, a saved copy that cannot be deleted now: each is written down
 * with the purge and tried again by every sweep, with waits that grow, until the provider and the bucket both say it is done. A new backup is
 * never made first. The only thing that ever makes a Brick wait is our own books not yet having a line for what its computer ran: that is
 * money, it is only our own tables, and it cannot be caused by a provider.
 *
 * Nothing waits on this to be right: from the moment its days are over a deleted Brick is in no list and Undo no longer takes it, purged or
 * not. The sweep only does the clearing.
 */
export async function removeGoneBricks(now: Date = new Date(), ownerId?: string, batch: number = SWEEP_BATCH, pages: number = SWEEP_PAGES): Promise<string[]> {
  const removed: string[] = [];
  // Bricks that wait for the next sweep (their books are not written) are skipped by the next page here, so a run of them never keeps the
  // Bricks behind them from being removed
  const waiting: string[] = [];
  for (let page = 0; page < pages; page++) {
    const gone = await prisma.bot.findMany({
      where: { roomId: null, goneAt: { lte: now }, ...(ownerId ? { ownerId } : {}), ...(waiting.length ? { id: { notIn: waiting } } : {}) },
      select: { id: true },
      // Least recently looked at first: a Brick that waited is marked below and goes behind the rest, so across sweeps none is kept from its turn
      orderBy: [{ updatedAt: 'asc' }, { goneAt: 'asc' }],
      take: batch,
    });
    if (gone.length === 0) break;
    for (const { id } of gone) {
      const result = await purgeBrick(id, now);
      if (result !== 'purged') {
        // 'books': what its computer ran is not in the books yet, looked at again next sweep. 'not_due': Undo, or another sweep, got there first.
        if (result === 'books') console.warn(`[Brick delete] Brick ${id} waits: what its computer ran is not in the books yet`);
        waiting.push(id);
        await markWaiting(id, now);
        continue;
      }
      removed.push(id);
      await syncToolSignInNotices(id);
    }
    if (gone.length < batch) break;
  }
  // The outside deletions of every purged Brick that still has some, now (the ones just purged) or on their schedule (all of them). Never throws:
  // a failing provider must not lose the ids purged above, the bot server needs them to close those chats
  try {
    await sweepPurges(now, ownerId ? removed : undefined);
  } catch (error) {
    console.error('[Brick delete] The outside deletions of purged Bricks could not be tried:', error instanceof Error ? error.message : 'unknown');
  }
  return removed;
}
