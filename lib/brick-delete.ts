import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { endAllApprovals } from '@/lib/bot-actions';
import { pauseItemsOfDeletedBrick } from '@/lib/brick-items';
import { deleteWithHiddenBotData } from '@/lib/bot-privacy';
import { syncToolSignInNotices } from '@/lib/tool-signin';
import { stopComputerWork, removeMachineBeforeDelete } from '@/lib/computer';
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
 * Its computer (game #2000). At the tap its jobs end and it stops, its files saved and kept. Undo gives the Brick back but starts
 * no job again. At the second step the machine is removed only after its files were saved.
 *
 * What is never deleted. Everything the Brick made: an artifact belongs to the person who asked for it and only names
 * the Brick that made it (Artifact.makerBotId), so it stays in their artifacts after both steps.
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

/**
 * The second step: every deleted Brick whose days are over is removed for good, with its saved chats and what it
 * remembers (a Brick's are always hidden, so they go in the same transaction, see deleteWithHiddenBotData). For one
 * person when `ownerId` is given, else for everyone. Returns the ids removed, so the bot server can close their chats.
 *
 * Nothing waits on this to be right: from the moment its days are over a deleted Brick is in no list and Undo no longer
 * takes it, removed or not. The sweep only clears the rows away.
 */
export async function removeGoneBricks(now: Date = new Date(), ownerId?: string, batch: number = SWEEP_BATCH): Promise<string[]> {
  const removed: string[] = [];
  // Bricks that wait for the next sweep (their computer's files were not saved) are skipped by the next page here, so a run of them
  // never keeps the Bricks behind them from being removed
  const waiting: string[] = [];
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const gone = await prisma.bot.findMany({
      where: { roomId: null, goneAt: { lte: now }, ...(ownerId ? { ownerId } : {}), ...(waiting.length ? { id: { notIn: waiting } } : {}) },
      select: { id: true },
      orderBy: { goneAt: 'asc' },
      take: batch,
    });
    if (gone.length === 0) break;
    for (const { id } of gone) {
      // Its computer goes only after its files were saved; if that did not happen the Brick waits for the next sweep (game #2000)
      if (!(await removeMachineBeforeDelete(id))) {
        // Kept for the next sweep, and said so: a computer that cannot be saved or removed (its provider is off or changed) is looked at, not lost quietly
        console.warn(`[Brick delete] Brick ${id} waits: its computer's files could not be saved or its machine could not be removed`);
        waiting.push(id);
        continue;
      }
      // Still only one whose time has passed: the condition is asked again in the delete itself
      const where = { id, roomId: null, goneAt: { lte: now } };
      const { count } = await deleteWithHiddenBotData(where, () => prisma.bot.deleteMany({ where }));
      if (count === 0) {
        waiting.push(id);
        continue;
      }
      removed.push(id);
      await syncToolSignInNotices(id);
    }
    if (gone.length < batch) break;
  }
  return removed;
}
