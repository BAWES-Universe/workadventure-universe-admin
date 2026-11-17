import { prisma } from '@/lib/db';
import { getMeterSettings, recordMeterEvent, type RecordedEvent } from '@/lib/meter';
import { monthOf, type MeterEventInput } from '@/lib/meter-values';

/**
 * A spending stop for the use of connected ready-made Apps that Universe pays for (audit F3). Every other paid step already takes room
 * or credit before it spends; this one only wrote its use to the books. Its price is known before the call goes out (the provider's list
 * price, lib/composio-rates.ts), so the line in the books IS the reservation: it is written first, under one lock, and only if the month's
 * total and the person's own total still fit under the two Limits. Over either, nothing is written and the call is not made.
 *
 *  - `appUseCeilingMicros`: the most Universe may pay for this use, all people together, in a calendar month (UTC).
 *  - `appUseMemberCeilingMicros`: the most of that for one person.
 *
 * A Limit that is empty stops everything that costs: nothing is assumed (0 is a pause for the same reason). A free step (a lookup, a
 * price of 0) and a step whose price is not ours to know are never stopped here.
 */

export type AppUseWritten = RecordedEvent & { stopped?: 'month' | 'person' | 'not_set' | 'busy' };

export async function recordAppUseWithinCap(event: MeterEventInput, now: Date = new Date()): Promise<AppUseWritten> {
  const price = event.costMicros;
  if (price === null || price <= 0 || event.payerKind !== 'universe') return recordMeterEvent(event);
  try {
    return await countedUnderLock(event, price, now);
  } catch (error) {
    // The lock or the books did not answer in time: the use is held back (nothing was called), never let through unchecked and never a server error
    console.error('[AppUseCap] Could not check the limits:', error instanceof Error ? error.message : 'unknown');
    return { recorded: false, conflict: false, stopped: 'busy' };
  }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Whether one more use at this price fits under both Limits right now: null when it does, else which one stops it. Reads only. */
async function stoppedBy(tx: Tx | typeof prisma, personId: string | null, price: number, now: Date): Promise<'month' | 'person' | 'not_set' | null> {
  const settings = await getMeterSettings(tx);
  if (settings.appUseCeilingMicros === null || settings.appUseMemberCeilingMicros === null) return 'not_set';
  const month = monthOf(now);
  const where = { pool: 'chat', kind: 'app_use', route: 'app', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } };
  const [all, mine] = await Promise.all([
    tx.meterEvent.aggregate({ where, _sum: { costMicros: true } }),
    personId ? tx.meterEvent.aggregate({ where: { ...where, personKey: `person:${personId}` }, _sum: { costMicros: true } }) : Promise.resolve(null),
  ]);
  if (Number(all._sum.costMicros ?? 0) + price > settings.appUseCeilingMicros) return 'month';
  if (mine && Number(mine._sum.costMicros ?? 0) + price > settings.appUseMemberCeilingMicros) return 'person';
  return null;
}

/**
 * Whether a paid App step for this person would be let through now, so a job is not sent to an App that the spending stop would refuse
 * (the call itself still takes its room under the lock; this only reads). A free step always fits. A read that fails counts as no room.
 */
export async function appUseHasRoom(personId: string | null, priceMicros: number, now: Date = new Date()): Promise<boolean> {
  if (priceMicros <= 0) return true;
  try {
    return (await stoppedBy(prisma, personId, priceMicros, now)) === null;
  } catch (error) {
    console.error('[AppUseCap] Could not check the limits:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

async function countedUnderLock(event: MeterEventInput, price: number, now: Date): Promise<AppUseWritten> {
  return prisma.$transaction(async (tx) => {
    // One at a time for everyone: two calls at the same moment cannot both read the same total and both pass
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('app-use:cap'))`;
    // A call id seen before is a retry: it answers as one, and is never stopped for what it already counted
    const seen = await tx.meterEvent.findUnique({ where: { eventId: event.eventId }, select: { id: true } });
    if (seen) return recordMeterEvent(event, tx);
    const stopped = await stoppedBy(tx, event.personId ?? null, price, now);
    if (stopped) return { recorded: false, conflict: false, stopped };
    return recordMeterEvent(event, tx);
  }, { maxWait: 10_000, timeout: 20_000 });
}
