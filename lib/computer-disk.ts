import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';

/**
 * What Universe keeps for a Brick's computer goes into the books as one level (audit F4): the machine's disk (the provider bills a whole disk for
 * as long as the machine exists, awake or asleep) and the saved copy of its files (kept in our own bucket, lib/agent37/saved-copies.ts). The
 * computer pool's envelope counts the newest level of each Brick (lib/meter-allowance.ts) and the Costs page shows it as "Files we keep", so
 * what is kept costs the ceiling its place. A level is not an amount that adds up: a line is written when it changes (a machine made, taken
 * away, or a new copy saved), and the newest line stands. Nothing is written when the level did not change.
 * Never throws and never holds a job: the books are not a reason a computer fails. Says whether the books now say what was asked (true also when
 * nothing needed writing), so a caller that must not forget a line, such as a purge, can try again.
 */
export async function recordKeptBytes(input: {
  botId: string;
  /** What made this write, only to keep the lines apart and to read them later. */
  reason: 'made' | 'gone' | 'saved';
  /** The disk of the machine that exists now, in bytes; null or 0 when there is none. */
  machineBytes: number | null;
  /** The size of the saved copy; when not given, the one on the Brick's computer record. */
  copyBytes?: number | null;
  now?: Date;
  /** The Brick's owner, for a Brick whose row is already gone (a purge confirming its outside deletions): else read from the Brick. */
  ownerId?: string | null;
  /**
   * Write only while the Brick's computer is still packed away (cold, no machine): the check and the write happen under a lock on the computer's row, which a
   * return must also take to claim the Brick, so a return cannot make its machine and write its disk between the check and this line (the line would then
   * say the new disk is not there). When the Brick is not cold any more nothing is written and the books are as they should be (true).
   */
  onlyWhileCold?: boolean;
}): Promise<boolean> {
  try {
    if (input.onlyWhileCold) {
      return await prisma.$transaction(async (tx) => {
        const cold = await tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${input.botId} AND "machine" = 'cold' AND "provider_ref" IS NULL FOR UPDATE`;
        if (cold.length === 0) return true;
        return writeLevel(tx, input);
      });
    }
    return await writeLevel(prisma, input);
  } catch (error) {
    console.error('[Computer] Could not write what is kept to the books:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

async function writeLevel(
  db: Db,
  input: { botId: string; reason: 'made' | 'gone' | 'saved'; machineBytes: number | null; copyBytes?: number | null; now?: Date; ownerId?: string | null },
): Promise<boolean> {
  const machine = input.machineBytes !== null && Number.isSafeInteger(input.machineBytes) && input.machineBytes > 0 ? input.machineBytes : 0;
  let copy = 0;
  if (input.copyBytes !== undefined) {
    copy = input.copyBytes !== null && Number.isSafeInteger(input.copyBytes) && input.copyBytes > 0 ? input.copyBytes : 0;
  } else {
    const row = await db.brickComputer.findUnique({ where: { botId: input.botId }, select: { filesBytes: true, filesSavedAt: true } });
    copy = row?.filesSavedAt ? Number(row.filesBytes) : 0;
  }
  const level = machine + copy;
  const newest = await db.meterEvent.findFirst({
    where: { kind: 'stored_bytes', payerKind: 'universe', botId: input.botId },
    orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    select: { quantity: true },
  });
  // Nothing kept and nothing ever written: there is no level to say. The same level as the newest one is already the answer.
  if (newest ? Number(newest.quantity) === level : level === 0) return true;
  const ownerId = input.ownerId !== undefined ? input.ownerId : (await db.bot.findUnique({ where: { id: input.botId }, select: { ownerId: true } }))?.ownerId ?? null;
  const now = input.now ?? new Date();
  await recordMeterEvent({
    eventId: `computer:kept:${input.botId}:${input.reason}:${now.getTime()}:${level}`.slice(0, 255),
    kind: 'stored_bytes',
    pool: 'computer',
    occurredAt: now,
    personKey: personKeyOf({ personId: ownerId }),
    personId: ownerId,
    botId: input.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'computer',
    jobId: null,
    quantity: level,
    unit: 'byte',
    // What is kept costs by its size and the storage Limit when the books are read, not on the line
    costMicros: 0,
    basis: 'estimated',
    sourceRef: `brick_computers:${input.botId}`,
    detail: { reason: input.reason, machineBytes: machine, copyBytes: copy },
  }, db);
  return true;
}
