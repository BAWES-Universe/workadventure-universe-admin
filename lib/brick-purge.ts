import * as Sentry from '@sentry/nextjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { computerTimeInBooks, providerFor } from '@/lib/computer';
import { recordKeptBytes } from '@/lib/computer-disk';
import { deleteAllArchives } from '@/lib/computer-archives';
import { lockPurgeAlone } from '@/lib/brick-purge-lock';

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
 *  3. The outside deletions, tried again by every sweep with growing waits until the provider and the bucket both say it is done. The Brick's
 *     chat rooms are one of them (register R29): only the bot server holds the chat account, so the purge sets `chatPending` and the bot server
 *     asks for the list (GET /api/brick-chat-purges), redacts what the Brick said, blanks its profile, leaves and forgets its rooms, and confirms
 *     (POST). What people said in those rooms stays with them. None of these deletions needs a new backup: nothing is saved before an erasure,
 *     and a machine or a saved copy that is already gone is the answer wanted.
 *
 * What stays, on purpose and nothing else:
 *  - What the Brick made and a person or team owns: artifacts (Artifact rows). The Brick's name on them is replaced with a neutral line.
 *    The files it made in chats belong to the person too (they stay where the chat put them; the Brick's list of them goes).
 *  - Accounting: amounts, ids and dates of what it cost, and the line of when the machine's disk stopped being billed. Never a chat, a title,
 *    a name or any text: the titles of its task receipts are replaced, and what a voice note was kept for is erased.
 *  - A retry note (BrickPurge) until the outside deletions are confirmed, and after that a bare marker with the Brick's id, for good, so a bot
 *    server that still holds the Brick (however long after) cannot write its memory or chats back. Nothing else guards that: the chat and
 *    memory tables do not point at a Brick. It holds no content, only the id the books already keep.
 */

const MINUTE_MS = 60 * 1000;
/** After each failed try the wait grows: 1 min, 5, 15, 1 h, 6 h, then every 6 h until it works. */
const RETRY_WAITS_MINUTES = [1, 5, 15, 60, 360];
/** How many outside deletions one sweep tries at most; the next sweep takes the rest. */
const PURGE_BATCH = 50;
/** What replaces the Brick's name on what it made. */
export const DELETED_MAKER_NAME = 'A deleted Brick';
/** What replaces the title of a task receipt (the same line a receipt without a title always had). */
const DELETED_TASK_TITLE = 'A task';

/** True when a purge note or marker for this Brick exists (the marker is never removed): the Brick was purged, and nothing may be saved for it any more. */
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
      // Alone against every save a bot server makes for this Brick: one that began first is finished before this goes on (and its rows are
      // deleted below), one that comes after waits for the marker written below and then finds it
      await lockPurgeAlone(tx, id);
      const brick = await tx.bot.findFirst({ where, select: { ownerId: true } });
      if (!brick) return false;
      // What is read here is read before the Brick goes: its machine, and the files people sent it that live at the uploader. The computer row is held
      // while it is read: a machine asked for at this moment either has its mark written before it (and is looked for) or finds the row gone and makes none
      await tx.$queryRaw`SELECT 1 FROM "brick_computers" WHERE "bot_id" = ${id} FOR UPDATE`;
      const computer = await tx.brickComputer.findUnique({ where: { botId: id }, select: { provider: true, providerRef: true, machine: true, makeTriedAt: true } });
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
      // What is left outside Orbit. A computer record means a machine may exist (also one made and never written down) and a saved copy may be in the bucket;
      // a save under way (its row is written before it starts) means a copy may land whatever the record says
      const saving = (await tx.savedCopyWrite.count({ where: botId })) > 0;
      // A cold Brick has no machine: the pack-away deleted it and the provider confirmed it gone, and a return claims the row (`restoring`) before it makes one.
      // Its copies are what is left. (A listing of machines is only ever a look for one that was made and never written down.)
      // A record that never had a machine asked for (`none`, no reference, never tried) has none to look for either: the listing could not find what was never made,
      // and on an account with many machines it could never prove it, so the purge would wait for ever
      const neverMade = !!computer && computer.machine === 'none' && !computer.providerRef && !computer.makeTriedAt;
      const machineMayExist = !!computer && computer.machine !== 'cold' && !neverMade;
      await tx.brickPurge.upsert({
        where: botId,
        create: { botId: id, ownerId: brick.ownerId, provider: computer?.provider ?? null, providerRef: computer?.providerRef ?? null, machinePending: machineMayExist, copyPending: !!computer || saving, chatPending: true, nextTryAt: now, purgedAt: now },
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
  if (!note.machinePending && !note.copyPending && !note.chatPending && note.doneAt) return { done: true, left: [] };
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
        await provider.removeAllFor?.(botId, { recorded: !!note.providerRef });
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
      // A copy that began being written while these were deleted has its own row: the Brick is not clear of copies until none is left
      if ((await prisma.computerArchive.count({ where: { botId } })) > 0) throw new Error('a copy was still being written');
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
        // A save that began before this purge may still be running, or may have stopped after its copy landed: the files are only gone when no
        // save can still put one there. Its row is read BEFORE the delete, so a row that is stale by now (its server is gone) was over before the
        // delete began and the delete took what it left; a live one means look again later, and the row is what tells the next try
        const writes = await prisma.savedCopyWrite.findMany({ where: { botId }, select: { id: true, expiresAt: true } });
        await provider.deleteSavedCopy(botId);
        const live = writes.filter((write) => write.expiresAt > now);
        if (live.length > 0) {
          left.push('saved files: a save was still running');
        } else {
          if (writes.length > 0) await prisma.savedCopyWrite.deleteMany({ where: { id: { in: writes.map((write) => write.id) } } });
          // A save that began after the rows were read has seen the purge marker (written before any of this), and ends without leaving a copy
          copyGone = (await prisma.savedCopyWrite.count({ where: { botId, expiresAt: { gt: now } } })) === 0;
          if (!copyGone) left.push('saved files: a save was still running');
        }
      } catch (error) {
        console.error('[Brick purge] Saved files could not be deleted:', error instanceof Error ? error.message : 'unknown');
        left.push('saved files');
      }
    }
  }
  // What is kept stops being counted in the books only when everything kept is confirmed gone: a machine still at its provider is still billed
  // Done only when the books also say nothing is kept any more: a line that could not be written is tried again with the rest, never dropped
  // The chat rooms are cleared by the bot server, which confirms; until it does the purge is not finished (and a failure to hear is said to the team like any other)
  if (note.chatPending) left.push('chat rooms');
  let finished = machineGone && copyGone && !note.chatPending;
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
 * Tries every purged Brick that still has something to delete outside and is due. The markers of finished ones stay. Returns how many
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
  return finished;
}

export interface ChatPurge {
  botId: string;
}

/** A page of the list the bot server reads: at most this many unless it asks for fewer. */
export const CHAT_PURGES_PAGE = 100;

/**
 * The purged Bricks whose chat rooms the bot server still has to clear, the oldest first. Only the Brick's id: nothing it or a person said.
 * A page starts after the Brick `after` (the last one of the page before), so a few that cannot be cleared for now never hide the ones behind
 * them: they stay listed (and pending) and the bot server reads on past them.
 */
export async function pendingChatPurges(take = CHAT_PURGES_PAGE, after?: string): Promise<ChatPurge[]> {
  const from = after ? await prisma.brickPurge.findUnique({ where: { botId: after }, select: { purgedAt: true, botId: true } }) : null;
  return prisma.brickPurge.findMany({
    where: {
      chatPending: true,
      ...(from ? { OR: [{ purgedAt: { gt: from.purgedAt } }, { purgedAt: from.purgedAt, botId: { gt: from.botId } }] } : {}),
    },
    select: { botId: true },
    orderBy: [{ purgedAt: 'asc' }, { botId: 'asc' }],
    take,
  });
}

/**
 * The bot server cleared these Bricks' chat rooms (or they never had any). Orbit forgets them as pending only now, and not before, so a restart in
 * between loses none; then the rest of what is left outside is tried at once, so a purge that waited only for the chat is finished now and not at
 * the next sweep. Unknown ids and a Brick already confirmed are ignored. Returns how many were confirmed.
 */
export async function confirmChatPurges(botIds: string[], now: Date = new Date()): Promise<number> {
  if (botIds.length === 0) return 0;
  const { count } = await prisma.brickPurge.updateMany({ where: { botId: { in: botIds }, chatPending: true }, data: { chatPending: false } });
  // Only a purge that was waiting for nothing but the chat is finished here; a machine or saved copy still to delete keeps its own waits
  const waiting = await prisma.brickPurge.findMany({ where: { botId: { in: botIds }, chatPending: false, doneAt: null, machinePending: false, copyPending: false }, select: { botId: true } });
  for (const { botId } of waiting) {
    try {
      await finishOutside(botId, now);
    } catch (error) {
      // The note is there and the next sweep tries again
      console.error('[Brick purge] A purged Brick could not be finished after its chats were cleared:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return count;
}
