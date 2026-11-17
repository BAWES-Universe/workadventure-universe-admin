import * as Sentry from '@sentry/nextjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { computerTimeInBooks, providerFor } from '@/lib/computer';
import { recordKeptBytes } from '@/lib/computer-disk';
import { deleteAllArchives } from '@/lib/computer-archives';

/**
 * The final purge of a deleted Brick (audit F08, GPT 6.10; Khalid, 17 Nov: when a Brick is deleted, delete EVERYTHING, keep nothing).
 *
 * Three things that used to be one are now apart:
 *  1. The reversible delete: the tap. The Brick is off, its work and approvals stop, and everything is kept (access disabled) until Undo's days are over.
 *  2. The purge, here, once those days are over. In ONE transaction the Brick's own rows go (most by the database's cascade: goals, approvals,
 *     settings, grants, files, voice, its computer's record and jobs), and what no foreign key reaches goes with them: saved chats, memory,
 *     what it was asked to forget, its notes on metrics and tests, its spend rules and prepared setups. What is left to delete OUTSIDE Orbit
 *     (the machine at its provider, the saved files in our bucket, files people sent it that live at the uploader) is written down in the same
 *     transaction, so a Brick that is gone always has that note, and no Brick is ever left half-deleted.
 *  3. The outside deletions, tried again by every sweep with growing waits until the provider and the bucket both say it is done. They never
 *     need a new backup: nothing is saved before an erasure, and a machine or a saved copy that is already gone is the answer wanted.
 *
 * What stays, on purpose and nothing else:
 *  - What the Brick made and a person or team owns: artifacts (Artifact rows). The Brick's name on them is replaced with a neutral line.
 *    The files it made in chats belong to the person too (they stay where the chat put them; the Brick's list of them goes).
 *  - Accounting: amounts, ids and dates of what it cost, and the line of when the machine's disk stopped being billed. Never a chat, a title,
 *    a name or any text: the titles of its task receipts are replaced, and what a voice note was kept for is erased.
 *  - A retry note (BrickPurge) until the outside deletions are confirmed, and a bare marker with the Brick's id for PURGE_MARKER_DAYS after,
 *    so a bot server that still holds the Brick cannot write its memory or chats back. It holds no content.
 */

/** How long the bare marker stays after everything outside was confirmed deleted. */
export const PURGE_MARKER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** After each failed try the wait grows: 1 min, 5, 15, 1 h, 6 h, then every 6 h until it works. */
const RETRY_WAITS_MINUTES = [1, 5, 15, 60, 360];
/** How many outside deletions one sweep tries at most; the next sweep takes the rest. */
const PURGE_BATCH = 50;
/** What replaces the Brick's name on what it made. */
export const DELETED_MAKER_NAME = 'A deleted Brick';
/** What replaces the title of a task receipt (the same line a receipt without a title always had). */
const DELETED_TASK_TITLE = 'A task';

/** True while a purge note or marker for this Brick exists: the Brick was purged, and nothing may be saved for it any more. */
export async function isPurged(botId: string): Promise<boolean> {
  return (await prisma.brickPurge.count({ where: { botId } })) > 0;
}

export type Purged = 'purged' | 'books' | 'not_due';

/**
 * Purges one Brick whose days are over. 'books' when what its computer ran is not in the books yet (our own table: it does not wait on a
 * provider or a backup) and 'not_due' when it is not a Brick whose time has passed (Undo came first, or it is already gone). Never saves
 * anything first. Safe to ask again.
 */
export async function purgeBrick(id: string, now: Date = new Date()): Promise<Purged> {
  if (!(await computerTimeInBooks(id, now))) return 'books';
  const where = { id, roomId: null, goneAt: { lte: now } };
  const done = await prisma.$transaction(
    async (tx) => {
      const brick = await tx.bot.findFirst({ where, select: { ownerId: true } });
      if (!brick) return false;
      // What is read here is read before the Brick goes: its machine, and the files people sent it that live at the uploader
      const computer = await tx.brickComputer.findUnique({ where: { botId: id }, select: { provider: true, providerRef: true } });
      const sent = await tx.botFile.findMany({ where: { botId: id, source: 'person', bucket: { not: null }, fileId: { not: null } }, select: { bucket: true, fileId: true } });
      // The delete itself decides: a Brick Undo took back at this moment is not touched (nothing below runs for it)
      const { count } = await tx.bot.deleteMany({ where });
      if (count === 0) return false;
      const botId = { botId: id };
      await tx.botsConversation.deleteMany({ where: botId });
      await tx.botsMemory.deleteMany({ where: botId });
      await tx.botMemoryForget.deleteMany({ where: botId });
      await tx.botMemoryItemForget.deleteMany({ where: botId });
      await tx.botsMetric.deleteMany({ where: botId });
      await tx.botsTestResult.deleteMany({ where: botId });
      await tx.spendRule.deleteMany({ where: botId });
      await tx.appKeyRequest.deleteMany({ where: botId });
      // Money stays; what was said does not: a task receipt keeps its amounts and loses its title and sponsor's name, a voice note keeps its seconds and cost
      await tx.taskReceipt.updateMany({ where: botId, data: { title: DELETED_TASK_TITLE, payerName: null } });
      await tx.voiceNoteTurn.updateMany({ where: botId, data: { buffer: null, bufferUntil: null, providerRefs: Prisma.DbNull } });
      // What it made belongs to its person: it stays, with a neutral name instead of the Brick's
      await tx.artifact.updateMany({ where: { makerBotId: id }, data: { makerName: DELETED_MAKER_NAME } });
      // Files people sent it are taken out of the uploader by the bot server, from the list that already exists for it (a restart never forgets one)
      if (sent.length > 0) {
        await tx.botFileRemoval.createMany({ data: sent.map((file) => ({ botId: id, bucket: file.bucket as string, fileId: file.fileId as string })), skipDuplicates: true });
      }
      // What is left outside Orbit. A computer record means a machine may exist (also one made and never written down) and a saved copy may be in the bucket
      await tx.brickPurge.upsert({
        where: botId,
        create: { botId: id, ownerId: brick.ownerId, provider: computer?.provider ?? null, providerRef: computer?.providerRef ?? null, machinePending: !!computer, copyPending: !!computer, nextTryAt: now, purgedAt: now },
        update: {},
      });
      return true;
    },
    { timeout: 60_000 },
  );
  return done ? 'purged' : 'not_due';
}

export interface Outside {
  /** Nothing is left to delete outside: the provider and the bucket both said so. */
  done: boolean;
  /** What is still to do, in words for the log. Never a message from the provider. */
  left: string[];
}

/**
 * Tries what is left outside Orbit for one purged Brick: its machine at the provider and its saved files in our bucket, each apart (one that
 * fails does not hold the other). Each one that works is written down at once, together with the line to the books that its storage stopped
 * being kept, so a later try only does what is left. Fails quietly into the note: the next sweep tries again after a longer wait.
 */
export async function finishOutside(botId: string, now: Date = new Date()): Promise<Outside> {
  const note = await prisma.brickPurge.findUnique({ where: { botId } });
  if (!note) return { done: true, left: [] };
  if (!note.machinePending && !note.copyPending && note.doneAt) return { done: true, left: [] };
  const provider = providerFor({ provider: note.provider ?? 'none' });
  const left: string[] = [];
  let machineGone = !note.machinePending;
  let copyGone = !note.copyPending;
  if (note.machinePending) {
    if (!provider) {
      left.push('machine: no provider for it on this server');
    } else {
      try {
        if (note.providerRef) await provider.remove(note.providerRef);
        await provider.removeAllFor?.(botId);
        machineGone = true;
      } catch (error) {
        console.error('[Brick purge] A machine could not be removed:', error instanceof Error ? error.message : 'unknown');
        left.push('machine');
      }
    }
  }
  if (note.copyPending) {
    // The copies cold storage keeps (rows and their objects) go with the saved copy; a Brick that never was cold has none
    let coldGone = true;
    try {
      await deleteAllArchives(botId);
    } catch (error) {
      coldGone = false;
      console.error('[Brick purge] Cold storage copies could not be deleted:', error instanceof Error ? error.message : 'unknown');
      left.push('cold storage copies');
    }
    if (!coldGone) {
      // Nothing more is tried for the saved files until these are gone too: both are confirmed before anything is called deleted
    } else if (!provider?.deleteSavedCopy) {
      left.push('saved files: no provider for them on this server');
    } else {
      try {
        await provider.deleteSavedCopy(botId);
        copyGone = true;
      } catch (error) {
        console.error('[Brick purge] Saved files could not be deleted:', error instanceof Error ? error.message : 'unknown');
        left.push('saved files');
      }
    }
  }
  // What is kept stops being counted in the books only when everything kept is confirmed gone: a machine still at its provider is still billed
  // Done only when the books also say nothing is kept any more: a line that could not be written is tried again with the rest, never dropped
  let finished = machineGone && copyGone;
  if (finished && !(await recordKeptBytes({ botId, reason: 'gone', machineBytes: null, copyBytes: 0, ownerId: note.ownerId }))) {
    finished = false;
    left.push('books');
  }
  const attempts = note.attempts + 1;
  await prisma.brickPurge.update({
    where: { botId },
    data: {
      machinePending: !machineGone,
      copyPending: !copyGone,
      attempts,
      lastTriedAt: now,
      ...(finished ? { doneAt: now, providerRef: null } : { nextTryAt: new Date(now.getTime() + RETRY_WAITS_MINUTES[Math.min(attempts - 1, RETRY_WAITS_MINUTES.length - 1)] * MINUTE_MS) }),
    },
  });
  if (!finished && (attempts === 5 || attempts % 50 === 0)) {
    // Said where the team looks: an erasure that keeps failing is never quiet. No id of a person, no content.
    Sentry.captureMessage(`A purged Brick's outside deletion has failed ${attempts} times (${left.join(', ')})`, { level: 'error', tags: { area: 'bricks', botId } });
  }
  return { done: finished, left };
}

/**
 * Tries every purged Brick that still has something to delete outside and is due, then removes markers whose days are over. Returns how many
 * were finished now. `only` limits it to these Bricks (the ones just purged for one person).
 */
export async function sweepPurges(now: Date = new Date(), only?: string[], batch: number = PURGE_BATCH): Promise<number> {
  const due = await prisma.brickPurge.findMany({
    where: { doneAt: null, nextTryAt: { lte: now }, ...(only ? { botId: { in: only } } : {}) },
    select: { botId: true },
    orderBy: [{ nextTryAt: 'asc' }, { botId: 'asc' }],
    take: batch,
  });
  let finished = 0;
  for (const { botId } of due) {
    try {
      if ((await finishOutside(botId, now)).done) finished++;
    } catch (error) {
      // The database failed under the note: it is still there, and the next sweep tries again
      console.error('[Brick purge] A purged Brick could not be finished:', error instanceof Error ? error.message : 'unknown');
    }
  }
  if (!only) await prisma.brickPurge.deleteMany({ where: { doneAt: { lt: new Date(now.getTime() - PURGE_MARKER_DAYS * DAY_MS) } } });
  return finished;
}
