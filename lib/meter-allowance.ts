import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { allowanceNow, missingSettings, monthOf, type AllowanceState, type MeterSettings } from '@/lib/meter-values';

/**
 * One allowance per member, shared by all their Bricks, and the envelope around everything we pay for (game #1998, Brick 7).
 *
 * SHADOW: nothing in Universe asks for room yet, so nothing is stopped by this. It is here to be proven first (with a pretend
 * provider, in tests, and beside today's limits) before a computer is allowed to ask. What it decides it decides for real: room
 * is taken under one lock, so two steps asked for at the same moment can never both take the last of it.
 *
 *  - Room is reserved before a paid step, and a job that keeps running renews it. A reservation ends as settled or released, never gone.
 *  - What is committed, reserved and not yet settled, kept storage and a reserve are one envelope. Nothing new is admitted past it.
 *  - Chat's money is kept apart: this reads the computer pool only, so using it up never takes from what chat has.
 *  - Two different "out"s: the member's own allowance is used up ("allowance": they can ask for more), or our pool or every computer is
 *    taken ("pool", "busy": the job waits, and more for one person would not help).
 *  - Settings that are not set yet refuse room ("not_set"): a computer does not open before its controls do.
 */

export type NoRoom =
  /** A setting the meter cannot work without is still empty. */
  | { ok: false; reason: 'not_set'; missing: (keyof MeterSettings)[] }
  /** The member's own allowance is used up. */
  | { ok: false; reason: 'allowance'; leftMicros: number }
  /** Jobs at once are taken, for this member or for everyone: wait in line. */
  | { ok: false; reason: 'busy' }
  /** Our own pool has no more room for new work. */
  | { ok: false; reason: 'pool' }
  /** The reservation is not one that is held and in time any more: stop safely. */
  | { ok: false; reason: 'closed' }
  /** The key was used before for someone else: the first stands, and whoever asked has a bug to find. */
  | { ok: false; reason: 'key_reused' };

export interface Reservation {
  key: string;
  personKey: string;
  botId: string | null;
  jobId: string | null;
  amountMicros: number;
  state: 'held' | 'settled' | 'released';
  expiresAt: Date;
  renewals: number;
  settledMicros: number | null;
}

export type Room = { ok: true; reservation: Reservation; created: boolean } | NoRoom;

type Tx = Prisma.TransactionClient;

const MINUTE = 60 * 1000;
const POOL_LOCK = 'meter:pool';

const viewOf = (row: { reservationKey: string; personKey: string; botId: string | null; jobId: string | null; amountMicros: bigint; state: string; expiresAt: Date; renewals: number; settledMicros: bigint | null }): Reservation => ({
  key: row.reservationKey,
  personKey: row.personKey,
  botId: row.botId,
  jobId: row.jobId,
  amountMicros: Number(row.amountMicros),
  state: row.state as Reservation['state'],
  expiresAt: row.expiresAt,
  renewals: row.renewals,
  settledMicros: row.settledMicros === null ? null : Number(row.settledMicros),
});

const asNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

/** One member's computer month: what they spent in order and the extra usage they were given, worked into what is left. */
export async function memberAllowance(personId: string, now: Date, settings: MeterSettings, db: Pick<Tx, 'meterEvent' | 'meterGrant'> = prisma): Promise<AllowanceState | null> {
  if (settings.memberAllowanceMicros === null) return null;
  const month = monthOf(now);
  const [events, grants] = await Promise.all([
    // What a member spends from the computer allowance: computer-pool work we pay for, tied to them. Their chat is another allowance.
    db.meterEvent.findMany({
      where: { pool: 'computer', payerKind: 'universe', personKey: `person:${personId}`, costMicros: { not: null }, occurredAt: { gte: month.start, lt: month.end } },
      select: { occurredAt: true, costMicros: true },
    }),
    db.meterGrant.findMany({ where: { personId, endsAt: { gt: month.start }, startsAt: { lt: month.end } }, select: { startsAt: true, endsAt: true, multiplier: true, noLimit: true } }),
  ]);
  return allowanceNow(
    settings.memberAllowanceMicros,
    events.map((event) => ({ at: event.occurredAt, micros: asNumber(event.costMicros) })),
    grants.map((grant) => ({ startsAt: grant.startsAt, endsAt: grant.endsAt, multiplier: grant.noLimit ? null : grant.multiplier })),
    now,
  );
}

export interface Envelope {
  /** Spent this month on computer work, and settled by the provider. */
  committedMicros: number;
  /** Room held for steps that have not happened yet. */
  reservedMicros: number;
  /** Spent or held whose settlement is still to come: recorded but not settled, and reservations that lapsed. */
  unsettledMicros: number;
  /** What the disks we keep will cost for a month. */
  keptStorageMicros: number;
  /** Kept back, never given to new work. */
  reserveMicros: number;
  /** All of those together; new work is admitted only while this plus the new step stays inside the pool's ceiling. */
  totalMicros: number;
  /** Computer events this month with no price known: counted here, never as 0. */
  unknownEvents: number;
  /** Chat's own spend this month, kept apart: the pool above never reads it and never takes from it. */
  chatMicros: number;
  /** Jobs going now, everyone together. */
  jobsRunning: number;
}

/** The computer pool's envelope at a moment. `settings` must have its money set (see `missingSettings`). */
export async function envelopeIn(tx: Tx, now: Date, settings: MeterSettings): Promise<Envelope> {
  const month = monthOf(now);
  const universeComputer: Prisma.MeterEventWhereInput = { pool: 'computer', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } };
  const [settled, unsettled, unknown, chat, held, kept] = await Promise.all([
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: { not: null } }, _sum: { costMicros: true } }),
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: null }, _sum: { costMicros: true } }),
    tx.meterEvent.count({ where: { ...universeComputer, costMicros: null } }),
    tx.meterEvent.aggregate({ where: { pool: 'chat', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } }, _sum: { costMicros: true } }),
    tx.meterReservation.findMany({ where: { state: 'held' }, select: { amountMicros: true, expiresAt: true } }),
    // The newest size recorded for each bot: a disk is a level, not something that adds up
    tx.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT COALESCE(SUM(latest.quantity), 0)::bigint AS bytes FROM (
        SELECT DISTINCT ON (bot_id) quantity FROM meter_events
        WHERE kind = 'stored_bytes' AND payer_kind = 'universe' AND bot_id IS NOT NULL
        ORDER BY bot_id, occurred_at DESC, recorded_at DESC
      ) latest`,
  ]);
  let reserved = 0;
  let lapsed = 0;
  for (const row of held) {
    if (row.expiresAt > now) reserved += Number(row.amountMicros);
    else lapsed += Number(row.amountMicros);
  }
  // A gigabyte is 10^9 bytes; rounded up in whole millionths of a dollar, and in BigInt so a very large disk cannot lose a digit
  const bytes = kept[0]?.bytes ?? BigInt(0);
  const perGb = BigInt(settings.storageMicrosPerGbMonth ?? 0);
  const giga = BigInt(1_000_000_000);
  const keptStorageMicros = Number((bytes * perGb + giga - BigInt(1)) / giga);
  const committedMicros = asNumber(settled._sum.costMicros);
  const unsettledMicros = asNumber(unsettled._sum.costMicros) + lapsed;
  const reserveMicros = settings.reserveMicros ?? 0;
  return {
    committedMicros,
    reservedMicros: reserved,
    unsettledMicros,
    keptStorageMicros,
    reserveMicros,
    totalMicros: committedMicros + reserved + unsettledMicros + keptStorageMicros + reserveMicros,
    unknownEvents: unknown,
    chatMicros: asNumber(chat._sum.costMicros),
    jobsRunning: held.filter((row) => row.expiresAt > now).length,
  };
}

/** The envelope as it stands now, for a page or a check. Empty settings read as zero ceilings, so look at `missingSettings` too. */
export async function currentEnvelope(now: Date = new Date()): Promise<Envelope> {
  const settings = await getMeterSettings();
  return envelopeIn(prisma, now, settings);
}

async function lockPool(tx: Tx): Promise<void> {
  // One lock for every step, always taken first: two steps asked for at the same moment are settled one after the other
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${POOL_LOCK}))`;
}

/** Whether `extra` more fits for this member and the pool; the reason it does not, or null. The member's own allowance comes first: a member who used theirs up asks for more, whatever the pool holds. */
async function fits(tx: Tx, personId: string, extraMicros: number, now: Date, settings: MeterSettings, opts: { newJob: boolean }): Promise<NoRoom | null> {
  const missing = missingSettings(settings);
  if (missing.length > 0) return { ok: false, reason: 'not_set', missing };
  const allowance = await memberAllowance(personId, now, settings, tx);
  if (allowance && !allowance.unlimited) {
    const held = await tx.meterReservation.aggregate({ where: { personKey: `person:${personId}`, state: 'held' }, _sum: { amountMicros: true } });
    const left = (allowance.leftMicros ?? 0) - asNumber(held._sum.amountMicros);
    if (left < extraMicros) return { ok: false, reason: 'allowance', leftMicros: Math.max(0, left) };
  }
  const envelope = await envelopeIn(tx, now, settings);
  if (opts.newJob) {
    const mine = await tx.meterReservation.count({ where: { personKey: `person:${personId}`, state: 'held', expiresAt: { gt: now } } });
    if (mine >= (settings.atOnceMember ?? 0) || envelope.jobsRunning >= (settings.atOnceAll ?? 0)) return { ok: false, reason: 'busy' };
  }
  if (envelope.totalMicros + extraMicros > (settings.poolCeilingMicros ?? 0)) return { ok: false, reason: 'pool' };
  return null;
}

const wholeMicros = (value: number, what: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${what} must be a whole number above 0`);
};

/**
 * Takes room for a paid step, once per key: asking again for the same step finds the same reservation and takes nothing more.
 * The room is held for `renewMinutes`; a job that is still running renews it (below), and one that is not lets it lapse, which
 * the envelope keeps counting until it is settled or released. Never throws for "no room": that is an answer.
 */
export async function reserveRoom(
  input: { key: string; personId: string; amountMicros: number; botId?: string | null; jobId?: string | null },
  now: Date = new Date(),
): Promise<Room> {
  wholeMicros(input.amountMicros, 'amountMicros');
  if (!input.key || input.key.length > 255) throw new RangeError('key is required (up to 255 characters)');
  return prisma.$transaction(async (tx): Promise<Room> => {
    await lockPool(tx);
    const already = await tx.meterReservation.findUnique({ where: { reservationKey: input.key } });
    if (already) return already.personKey === `person:${input.personId}` ? { ok: true, reservation: viewOf(already), created: false } : { ok: false, reason: 'key_reused' };
    const settings = await getMeterSettings(tx);
    const no = await fits(tx, input.personId, input.amountMicros, now, settings, { newJob: true });
    if (no) return no;
    const row = await tx.meterReservation.create({
      data: {
        reservationKey: input.key,
        personKey: `person:${input.personId}`,
        personId: input.personId,
        botId: input.botId ?? null,
        jobId: input.jobId ?? null,
        amountMicros: BigInt(input.amountMicros),
        state: 'held',
        expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE),
      },
    });
    return { ok: true, reservation: viewOf(row), created: true };
  });
}

/**
 * A job that keeps running renews its room: held for another `renewMinutes`, and `moreMicros` more when the next stretch needs
 * it. The extra passes the same checks as new room (the member's allowance and the pool); if it does not, nothing changes and the
 * job saves its work and stops safely. A reservation that already lapsed, was settled or released is not renewed.
 */
export async function renewRoom(input: { key: string; moreMicros?: number }, now: Date = new Date()): Promise<Room> {
  const more = input.moreMicros ?? 0;
  if (more !== 0) wholeMicros(more, 'moreMicros');
  return prisma.$transaction(async (tx): Promise<Room> => {
    await lockPool(tx);
    const row = await tx.meterReservation.findUnique({ where: { reservationKey: input.key } });
    if (!row || row.state !== 'held' || row.expiresAt <= now) return { ok: false, reason: 'closed' };
    const settings = await getMeterSettings(tx);
    if (more > 0) {
      const no = await fits(tx, row.personId ?? '', more, now, settings, { newJob: false });
      if (no) return no;
    }
    const next = await tx.meterReservation.update({
      where: { id: row.id },
      data: { amountMicros: row.amountMicros + BigInt(more), expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE), renewals: { increment: 1 } },
    });
    return { ok: true, reservation: viewOf(next), created: false };
  });
}

/** The step happened: its room is given back, and what it really cost is in the books as events. Safe to say twice. */
export async function settleRoom(input: { key: string; settledMicros: number }, now: Date = new Date()): Promise<Reservation | null> {
  return close(input.key, 'settled', now, input.settledMicros);
}

/** The step never happened: its room is given back. Safe to say twice. */
export async function releaseRoom(input: { key: string }, now: Date = new Date()): Promise<Reservation | null> {
  return close(input.key, 'released', now, null);
}

async function close(key: string, state: 'settled' | 'released', now: Date, settledMicros: number | null): Promise<Reservation | null> {
  return prisma.$transaction(async (tx) => {
    await lockPool(tx);
    const row = await tx.meterReservation.findUnique({ where: { reservationKey: key } });
    if (!row) return null;
    // Once it ended it stays as it ended: a second word, even a different one, changes nothing
    if (row.state !== 'held') return viewOf(row);
    const next = await tx.meterReservation.update({
      where: { id: row.id },
      data: { state, closedAt: now, settledMicros: settledMicros === null ? null : BigInt(settledMicros) },
    });
    return viewOf(next);
  });
}
