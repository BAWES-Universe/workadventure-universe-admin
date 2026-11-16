import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';

/**
 * The disk of a Brick's computer goes into the books (audit F4). The provider bills a machine's whole disk for as long as the machine
 * exists, awake or asleep, and the computer pool's envelope counts the disks kept (lib/meter-allowance.ts reads the newest `stored_bytes` of
 * each Brick). Nothing wrote that size, so a kept disk counted as nothing and the pool's ceiling did not see it. A disk is a level, not an
 * amount that adds up: one line when the machine is made (its disk), one with 0 when it is taken away, and the newest line stands.
 * Never throws and never holds a job: the books are not a reason a computer fails.
 */
export async function recordKeptDisk(input: { botId: string; ref: string; bytes: number | null; gone?: boolean; now?: Date }): Promise<void> {
  const bytes = input.gone ? 0 : input.bytes;
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return;
  try {
    const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { ownerId: true } });
    await recordMeterEvent({
      eventId: `computer:disk:${input.ref}:${input.gone ? 'gone' : 'made'}`.slice(0, 255),
      kind: 'stored_bytes',
      pool: 'computer',
      occurredAt: input.now ?? new Date(),
      personKey: personKeyOf({ personId: bot?.ownerId ?? null }),
      personId: bot?.ownerId ?? null,
      botId: input.botId,
      brick: true,
      payerKind: 'universe',
      payerPersonId: null,
      route: 'computer',
      jobId: null,
      quantity: bytes,
      unit: 'byte',
      // A disk's cost is worked out from its size and the storage price when the books are read, not written on the line
      costMicros: 0,
      basis: 'estimated',
      sourceRef: `brick_computers:${input.botId}`,
      detail: { ref: input.ref },
    });
  } catch (error) {
    console.error('[Computer] Could not write the disk to the books:', error instanceof Error ? error.message : 'unknown');
  }
}
