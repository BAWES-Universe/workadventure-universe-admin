import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { missingSettings, monthOf, type MeterSettings } from '@/lib/meter-values';
import { checkSpend, exposureOf } from '@/lib/spend-rules';
import type { ChargeClass } from '@/lib/spend-rules-values';

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
 *  - Two different "out"s: the member's own credit is used up ("allowance": they can ask for more), or our pool or every computer is
 *    taken ("pool", "busy": the job waits, and more for one person would not help). The member's own credit is not kept here any more: it
 *    is the credit lots (lib/computer-credit.ts), asked through the `personal` check a caller passes, in the same place in the order
 *    the old allowance was (after what the person said in chat, before jobs at once and the pool). This file is our side only.
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
  | { ok: false; reason: 'key_reused' }
  /** A rule the person said in chat (lib/spend-rules.ts) does not let this step take that much. Not an allowance that ran out: more credit would not help, changing the rule would. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

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

export type Room = { ok: true; reservation: Reservation; created: boolean; /** What a renewal added to the room, read under the pool's lock (0 when the room already covered the next stretch). */ addedMicros?: number } | NoRoom;

type Tx = Prisma.TransactionClient;

const MINUTE = 60 * 1000;
const POOL_LOCK = 'meter:pool';
/** The room held for one model call inside a job (lib/computer-calls.ts): it is not another job running. */
export const CALL_ROOM_PREFIX = 'computer:call:';
/** The room held for the disk of a machine that is about to be made: it is not a job running either, and it belongs to no person's allowance. */
export const DISK_ROOM_PREFIX = 'computer:diskroom:';
/** One room for each try of a job: a try that loses the writer's place gives back only its own, never the room of the one that won. */
/** One room for the disk of one try to start a job's machine: `attempt` (the try's own moment, as for the job's room) keeps two tries of the same job from giving each other's room back. */
export const diskRoomKey = (botId: string, jobId: string, attempt?: number) => `${DISK_ROOM_PREFIX}${botId}:${jobId}${attempt === undefined ? '' : `:${attempt}`}`;
/** The pool-only part of a model step's room (see `reserveRoom`): it starts with the call prefix, so it is never another job running. */
export const poolOnlyKey = (key: string): string => `${CALL_ROOM_PREFIX}pool:${key.slice(CALL_ROOM_PREFIX.length)}`;
const isNoJob = (key: string) => key.startsWith(CALL_ROOM_PREFIX) || key.startsWith(DISK_ROOM_PREFIX);

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
  /** What steps whose price is still unknown hold in the pool: each counts at the amount that was held for it until a receipt settles it (R4). Already inside `totalMicros`. */
  unknownHeldMicros: number;
  /** Whether kept storage is its own category (a storage budget is set): it is then not inside `totalMicros`, and `storageMicros` is checked against the budget. */
  storageBudgeted: boolean;
  /** Kept disks plus room held for disks about to be made: what the storage budget is checked against. */
  storageMicros: number;
  /** Chat's own spend this month, kept apart: the pool above never reads it and never takes from it. */
  chatMicros: number;
  /** Jobs going now, everyone together. */
  jobsRunning: number;
}

/**
 * The room that still counts at a moment: every reservation that is still held. Room that lapsed (a job that crashed or was abandoned, a step
 * whose outcome never came) keeps counting until it is settled or released, in whatever month it was taken, because what it spent is not known
 * (R4: an unknown cost never leaves the pool). Settling or releasing lapsed room is the sweep's; a lapsed hold that was settled is in the books
 * as events, and one settled with an unknown cost keeps counting through its event (see `envelopeIn`).
 */
function stillCounts(): Prisma.MeterReservationWhereInput {
  return { state: 'held' };
}

/** What keeping this many bytes costs for a month at the storage Limit: a gigabyte is 10^9 bytes, rounded up in whole millionths of a dollar, in BigInt so a very large disk cannot lose a digit. */
export function storageMonthMicros(bytes: bigint | number, settings: Pick<MeterSettings, 'storageMicrosPerGbMonth'>): number {
  const giga = BigInt(1_000_000_000);
  return Number((BigInt(bytes) * BigInt(settings.storageMicrosPerGbMonth ?? 0) + giga - BigInt(1)) / giga);
}

/** The computer pool's envelope at a moment. `settings` must have its money set (see `missingSettings`). */
export async function envelopeIn(tx: Tx, now: Date, settings: MeterSettings): Promise<Envelope> {
  const month = monthOf(now);
  const universeComputer: Prisma.MeterEventWhereInput = { pool: 'computer', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } };
  const [settled, unsettled, unknown, chat, held, kept, unknownHeld] = await Promise.all([
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: { not: null } }, _sum: { costMicros: true } }),
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: null }, _sum: { costMicros: true } }),
    tx.meterEvent.count({ where: { ...universeComputer, costMicros: null } }),
    tx.meterEvent.aggregate({ where: { pool: 'chat', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } }, _sum: { costMicros: true } }),
    tx.meterReservation.findMany({ where: stillCounts(), select: { amountMicros: true, expiresAt: true, reservationKey: true } }),
    // The newest size recorded for each bot: a disk is a level, not something that adds up
    tx.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT COALESCE(SUM(latest.quantity), 0)::bigint AS bytes FROM (
        SELECT DISTINCT ON (bot_id) quantity FROM meter_events
        WHERE kind = 'stored_bytes' AND payer_kind = 'universe' AND bot_id IS NOT NULL
        ORDER BY bot_id, occurred_at DESC, recorded_at DESC
      ) latest`,
    // A step that settled with no price known keeps counting at the amount that was held for it, until a late receipt gives its real cost (the same
    // update that gives the cost takes it out of this sum, so it is never counted twice nor dropped between the two)
    tx.$queryRaw<{ micros: bigint | null }[]>`
      SELECT COALESCE(SUM((detail->>'heldMicros')::bigint), 0)::bigint AS micros FROM meter_events
      WHERE pool = 'computer' AND payer_kind = 'universe' AND cost_micros IS NULL AND (detail->>'heldMicros') IS NOT NULL`,
  ]);
  let reserved = 0;
  let lapsed = 0;
  let heldDisk = 0;
  const storageBudgeted = settings.storageBudgetMicros !== null;
  for (const row of held) {
    const amount = Number(row.amountMicros);
    // Room held for the disk of a machine about to be made is storage: when storage has its own budget it is checked there, not in the pool's total
    if (row.reservationKey.startsWith(DISK_ROOM_PREFIX)) {
      heldDisk += amount;
      if (storageBudgeted) continue;
    }
    if (row.expiresAt > now) reserved += amount;
    else lapsed += amount;
  }
  // A gigabyte is 10^9 bytes; rounded up in whole millionths of a dollar, and in BigInt so a very large disk cannot lose a digit
  const keptStorageMicros = storageMonthMicros(kept[0]?.bytes ?? BigInt(0), settings);
  const committedMicros = asNumber(settled._sum.costMicros);
  const unknownHeldMicros = asNumber(unknownHeld[0]?.micros);
  const unsettledMicros = asNumber(unsettled._sum.costMicros) + lapsed;
  const reserveMicros = settings.reserveMicros ?? 0;
  // With a storage budget the disks we keep, and the room held for new ones, leave the pool's total (booked once, in their own category)
  const keptInPool = storageBudgeted ? 0 : keptStorageMicros;
  return {
    committedMicros,
    reservedMicros: reserved,
    unsettledMicros,
    keptStorageMicros,
    reserveMicros,
    totalMicros: committedMicros + reserved + unsettledMicros + unknownHeldMicros + keptInPool + reserveMicros,
    unknownEvents: unknown,
    unknownHeldMicros,
    storageBudgeted,
    storageMicros: keptStorageMicros + heldDisk,
    chatMicros: asNumber(chat._sum.costMicros),
    // The room held for one model call inside a job is not another job running
    jobsRunning: held.filter((row) => row.expiresAt > now && !isNoJob(row.reservationKey)).length,
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

/**
 * A caller's check of the member's own credit, asked inside the pool's lock: the refusal, or null to go on. Computers pass the credit
 * lots' check (lib/computer-credit.ts); nothing here knows how much a member has.
 */
export type PersonalCheck = (tx: Tx, extraMicros: number) => Promise<NoRoom | null>;

/** Whether `extra` more fits for this member and the pool; the reason it does not, or null. The member's own credit comes first: a member who used theirs up asks for more, whatever the pool holds. */
async function fits(tx: Tx, personId: string, extraMicros: number, now: Date, settings: MeterSettings, opts: { newJob: boolean; personal?: PersonalCheck; /** What the member's own credit is asked for, when it is less than what the pool holds (a model step: the member's estimate, and the provider's most in the pool). */ personalMicros?: number }): Promise<NoRoom | null> {
  const missing = missingSettings(settings);
  if (missing.length > 0) return { ok: false, reason: 'not_set', missing };
  if (opts.personal) {
    const no = await opts.personal(tx, opts.personalMicros ?? extraMicros);
    if (no) return no;
  }
  const envelope = await envelopeIn(tx, now, settings);
  if (opts.newJob) {
    const mine = await tx.meterReservation.count({ where: { personKey: `person:${personId}`, state: 'held', expiresAt: { gt: now }, NOT: [{ reservationKey: { startsWith: CALL_ROOM_PREFIX } }, { reservationKey: { startsWith: DISK_ROOM_PREFIX } }] } });
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
  input: { key: string; personId: string; amountMicros: number; botId?: string | null; jobId?: string | null; chargeClass?: ChargeClass; /** False for a step inside a job that already holds its place (a model call): it is not another job at once. */ newJob?: boolean; /** The member's own credit, asked in its place in the order (see `PersonalCheck`). */ personal?: PersonalCheck; /** More the pool holds for this step than the member's amount (a model step: the provider's most less the member's estimate). Held under its own key with no person, bot or job on it, counted by the pool only: the member's rules, credit and jobs at once never see it. */ poolOnlyMicros?: number },
  now: Date = new Date(),
): Promise<Room> {
  wholeMicros(input.amountMicros, 'amountMicros');
  const poolOnly = input.poolOnlyMicros ?? 0;
  if (poolOnly !== 0) wholeMicros(poolOnly, 'poolOnlyMicros');
  if (!input.key || input.key.length > 255) throw new RangeError('key is required (up to 255 characters)');
  return prisma.$transaction(async (tx): Promise<Room> => {
    await lockPool(tx);
    const already = await tx.meterReservation.findUnique({ where: { reservationKey: input.key } });
    if (already) {
      if (already.personKey !== `person:${input.personId}`) return { ok: false, reason: 'key_reused' };
      // Asking again for room that is still held is the same room. Room that was settled, released or lapsed is not a place to start a paid step from
      return already.state === 'held' && already.expiresAt > now ? { ok: true, reservation: viewOf(already), created: false } : { ok: false, reason: 'closed' };
    }
    // What the person said in chat comes first: a rule that does not let this step take that much stops it, whatever the allowance holds
    const ruled = await checkSpend({ payerPersonId: input.personId, botId: input.botId ?? null, taskKey: input.jobId ?? null, chargeClass: input.chargeClass ?? 'computer', amountMicros: input.amountMicros }, now, tx);
    if (!ruled.ok) return { ok: false, reason: 'rule', ruleId: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words };
    const settings = await getMeterSettings(tx);
    const no = await fits(tx, input.personId, input.amountMicros + poolOnly, now, settings, { newJob: input.newJob !== false, personal: input.personal, personalMicros: input.amountMicros });
    if (no) return no;
    const expiresAt = new Date(now.getTime() + settings.renewMinutes * MINUTE);
    const row = await tx.meterReservation.create({
      data: {
        reservationKey: input.key,
        personKey: `person:${input.personId}`,
        personId: input.personId,
        botId: input.botId ?? null,
        jobId: input.jobId ?? null,
        amountMicros: BigInt(input.amountMicros),
        state: 'held',
        expiresAt,
      },
    });
    // The rest of what the pool holds for this step, in the same transaction: both exist or neither does
    if (poolOnly > 0) {
      await tx.meterReservation.create({
        data: { reservationKey: poolOnlyKey(input.key), personKey: 'system:pool', personId: null, botId: null, jobId: null, amountMicros: BigInt(poolOnly), state: 'held', expiresAt },
      });
    }
    return { ok: true, reservation: viewOf(row), created: true };
  });
}

/**
 * Takes room in the pool for the disk of a machine that is about to be made, before anything is made (a hard stop: a disk the pool cannot carry
 * is never bought). The disk is billed whole for as long as the machine exists, so what the pool must hold is one month of it at the storage
 * Limit. The room belongs to no person (a disk is Universe's, not a member's allowance) and is released once the machine is made and its disk is
 * in the books as kept storage, or when the making fails. Asked again for the same job it is the same room (two jobs of one Brick starting together each hold their own: the pool counts both for a moment, the safe way round). Never throws for "no room".
 */
export async function reserveDiskRoom(input: { botId: string; jobId: string; bytes: number; attempt?: number }, now: Date = new Date()): Promise<{ ok: true } | NoRoom> {
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) return { ok: true };
  const key = diskRoomKey(input.botId, input.jobId, input.attempt);
  return prisma.$transaction(async (tx): Promise<{ ok: true } | NoRoom> => {
    await lockPool(tx);
    const settings = await getMeterSettings(tx);
    const missing = missingSettings(settings);
    if (missing.length > 0) return { ok: false, reason: 'not_set', missing };
    const amountMicros = storageMonthMicros(input.bytes, settings);
    const already = await tx.meterReservation.findUnique({ where: { reservationKey: key } });
    // Room that is still held is this room; room that was released or lapsed is not, and is asked for anew
    if (already && already.state === 'held' && already.expiresAt > now) return { ok: true };
    // The pool is asked even for a price of 0, so a pool that is already over its ceiling takes no new machine
    const envelope = await envelopeIn(tx, now, settings);
    if (envelope.storageBudgeted) {
      // Kept storage is its own category: the disks we keep and the room held for new ones are checked against the storage budget, once. A room
      // held for this same disk (it lapsed and is asked for again) is not counted twice
      const own = already && already.state === 'held' ? Number(already.amountMicros) : 0;
      if (envelope.storageMicros - own + amountMicros > (settings.storageBudgetMicros ?? 0)) return { ok: false, reason: 'pool' };
    } else if (envelope.totalMicros + amountMicros > (settings.poolCeilingMicros ?? 0)) return { ok: false, reason: 'pool' };
    // A price of 0 has nothing to hold (a reservation is for a sum above 0): the pool was asked all the same
    if (amountMicros <= 0) return { ok: true };
    const data = { personKey: 'system:disk', personId: null, botId: input.botId, jobId: null, amountMicros: BigInt(amountMicros), state: 'held', expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE), renewals: 0, settledMicros: null, closedAt: null, createdAt: now };
    if (already) await tx.meterReservation.update({ where: { id: already.id }, data });
    else await tx.meterReservation.create({ data: { reservationKey: key, ...data } });
    return { ok: true };
  });
}

/**
 * A job that keeps running renews its room: held for another `renewMinutes`, and `moreMicros` more when the next stretch needs
 * it. The extra passes the same checks as new room (the member's credit and the pool); if it does not, nothing changes and the
 * job saves its work and stops safely. A reservation that already lapsed, was settled or released is not renewed.
 */
export async function renewRoom(input: { key: string; moreMicros?: number; /** R9: bring the room up to this amount (the time used so far plus one stretch), read under the pool's lock: a renewal adds only what is not already held, and nothing when the room already covers it. Replaces `moreMicros`. */ upToMicros?: number; personal?: PersonalCheck }, now: Date = new Date()): Promise<Room> {
  if (input.moreMicros !== undefined && input.moreMicros !== 0) wholeMicros(input.moreMicros, 'moreMicros');
  if (input.upToMicros !== undefined) wholeMicros(input.upToMicros, 'upToMicros');
  return prisma.$transaction(async (tx): Promise<Room> => {
    await lockPool(tx);
    const row = await tx.meterReservation.findUnique({ where: { reservationKey: input.key } });
    if (!row || row.state !== 'held' || row.expiresAt <= now) return { ok: false, reason: 'closed' };
    const more = input.upToMicros !== undefined ? Math.max(0, input.upToMicros - Number(row.amountMicros)) : (input.moreMicros ?? 0);
    const settings = await getMeterSettings(tx);
    if (more > 0) {
      // More room for a job that runs is a new step for the rules too: the same ones that let it start decide whether it may take more.
      // The rules count what the job can still cost (the time used and the stretch its lease covers, see spend-rules), so the question is
      // what the renewal adds to that. What the renewal adds to what the job can still cost: its exposure through the new lease, less what it counts now (at minute five a
      // first stretch counts whole; renewed, it counts the five minutes used and the stretch the new lease covers)
      const before = exposureOf([row], settings.renewMinutes, now);
      const after = exposureOf([{ amountMicros: row.amountMicros + BigInt(more), renewals: row.renewals + 1, createdAt: row.createdAt, expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE) }], settings.renewMinutes, now);
      const ruled = await checkSpend(
        { payerPersonId: row.personId ?? '', botId: row.botId, taskKey: row.jobId, chargeClass: 'computer', amountMicros: Math.max(1, after - before) },
        now,
        tx,
      );
      if (!ruled.ok) return { ok: false, reason: 'rule', ruleId: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words };
      const no = await fits(tx, row.personId ?? '', more, now, settings, { newJob: false, personal: input.personal });
      if (no) return no;
    }
    const next = await tx.meterReservation.update({
      where: { id: row.id },
      data: { amountMicros: row.amountMicros + BigInt(more), expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE), renewals: { increment: 1 } },
    });
    return { ok: true, reservation: viewOf(next), created: false, addedMicros: more };
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
    return closeIn(tx, key, state, now, settledMicros);
  });
}

async function closeIn(tx: Tx, key: string, state: 'settled' | 'released', now: Date, settledMicros: number | null): Promise<Reservation | null> {
  const row = await tx.meterReservation.findUnique({ where: { reservationKey: key } });
  if (!row) return null;
  // Once it ended it stays as it ended: a second word, even a different one, changes nothing
  if (row.state !== 'held') return viewOf(row);
  const next = await tx.meterReservation.update({
    where: { id: row.id },
    data: { state, closedAt: now, settledMicros: settledMicros === null ? null : BigInt(settledMicros) },
  });
  return viewOf(next);
}

/**
 * R4: closing a step's room and booking what it cost happen in ONE step, under the pool's lock. The envelope is read under that same lock, so
 * it sees the room and its cost in the books, or neither: a cost is never counted twice nor dropped between the two. `book` writes the events
 * (and anything else that must go with the close) in the same transaction.
 */
export async function closeRoomsAndBook<T>(input: { settle?: { key: string; settledMicros: number }[]; release?: string[]; book: (tx: Tx) => Promise<T> }, now: Date = new Date()): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockPool(tx);
    const booked = await input.book(tx);
    for (const one of input.settle ?? []) await closeIn(tx, one.key, 'settled', now, one.settledMicros);
    for (const key of input.release ?? []) await closeIn(tx, key, 'released', now, null);
    return booked;
  });
}
