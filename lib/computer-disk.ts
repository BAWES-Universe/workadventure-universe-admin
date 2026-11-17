import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';

/**
 * What Universe keeps for a Brick's computer goes into the books as one level (audit F4): the machine's disk (the provider bills a whole disk for
 * as long as the machine exists, awake or asleep) and the saved copy of its files (kept in our own bucket, lib/agent37/saved-copies.ts). The
 * computer pool's envelope counts the newest level of each Brick (lib/meter-allowance.ts) and the Costs page shows it as "Files we keep", so
 * what is kept costs the ceiling its place. A level is not an amount that adds up: a line is written when it changes (a machine made, taken
 * away, or a new copy saved), and the newest line stands. Nothing is written when the level did not change.
 * Never throws and never holds a job: the books are not a reason a computer fails.
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
}): Promise<void> {
  try {
    const machine = input.machineBytes !== null && Number.isSafeInteger(input.machineBytes) && input.machineBytes > 0 ? input.machineBytes : 0;
    let copy = 0;
    if (input.copyBytes !== undefined) {
      copy = input.copyBytes !== null && Number.isSafeInteger(input.copyBytes) && input.copyBytes > 0 ? input.copyBytes : 0;
    } else {
      const row = await prisma.brickComputer.findUnique({ where: { botId: input.botId }, select: { filesBytes: true, filesSavedAt: true } });
      copy = row?.filesSavedAt ? Number(row.filesBytes) : 0;
    }
    const level = machine + copy;
    const newest = await prisma.meterEvent.findFirst({
      where: { kind: 'stored_bytes', payerKind: 'universe', botId: input.botId },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
      select: { quantity: true },
    });
    // Nothing kept and nothing ever written: there is no level to say. The same level as the newest one is already the answer.
    if (newest ? Number(newest.quantity) === level : level === 0) return;
    const ownerId = input.ownerId !== undefined ? input.ownerId : (await prisma.bot.findUnique({ where: { id: input.botId }, select: { ownerId: true } }))?.ownerId ?? null;
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
    });
  } catch (error) {
    console.error('[Computer] Could not write what is kept to the books:', error instanceof Error ? error.message : 'unknown');
  }
}
