import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { allowanceNow, missingSettings, monthOf, type AllowanceState, type MeterSettings } from '@/lib/meter-values';
import { checkSpend, exposureOf } from '@/lib/spend-rules';
import { computerBase, computerCredit, computerDraws, issueComputerCredit } from '@/lib/computer-credit';
import type { Db } from '@/lib/credit-store';
import { termsOf, type ChargeClass } from '@/lib/spend-rules-values';

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
  /** Our own pool has no more room for new work. `full` is true when it has none even for the smallest step (the envelope is at its ceiling), false when it only refused a step for its own size. */
  | { ok: false; reason: 'pool'; full?: boolean }
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

export type Room = { ok: true; reservation: Reservation; created: boolean } | NoRoom;

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

/** A member's computer month, with what it is made of. */
export interface MemberAllowance extends AllowanceState {
  /** The monthly allowance for this member: the default, or what an exception that reaches them says (a different amount, or none). */
  baseMicros: number;
  /** Credit given on purpose that they can draw on now (a gift, credit to be billed): part of what is left, drawn before the allowance. */
  creditMicros: number;
  /** What that credit was given: the "of" beside it. */
  creditTotalMicros: number;
}

type AllowanceDb = Db & Pick<Tx, 'meterEvent' | 'meterGrant'>;

/**
 * One member's computer month: what they spent in order and the extra usage they were given, worked into what is left, and beside it the
 * credit given to them on purpose (lib/computer-credit.ts), which is drawn first. What a step drew from credit is not counted against the
 * allowance, so credit is spent once and the allowance is never charged for it.
 */
export async function memberAllowance(personId: string, now: Date, settings: MeterSettings, db: AllowanceDb = prisma): Promise<MemberAllowance | null> {
  if (settings.memberAllowanceMicros === null) return null;
  const month = monthOf(now);
  const [events, grants, draws, base] = await Promise.all([
    // What a member spends from the computer allowance: computer-pool work we pay for, tied to them. Their chat is another allowance.
    db.meterEvent.findMany({
      where: { pool: 'computer', payerKind: 'universe', personKey: `person:${personId}`, costMicros: { not: null }, occurredAt: { gte: month.start, lt: month.end } },
      select: { eventId: true, occurredAt: true, costMicros: true },
    }),
    db.meterGrant.findMany({ where: { personId, cancelledAt: null, endsAt: { gt: month.start }, startsAt: { lt: month.end } }, select: { grantKey: true, startsAt: true, endsAt: true, multiplier: true, noLimit: true } }),
    computerDraws(db, personId, month.start, month.end),
    computerBase(db, personId, now, settings.memberAllowanceMicros),
  ]);
  const state = allowanceNow(
    base,
    events.map((event) => ({ at: event.occurredAt, micros: Math.max(0, asNumber(event.costMicros) - (draws.get(event.eventId) ?? 0)) })),
    grants.map((grant) => ({ key: grant.grantKey, startsAt: grant.startsAt, endsAt: grant.endsAt, multiplier: grant.noLimit ? null : grant.multiplier })),
    now,
  );
  const credit = await computerCredit(db, personId, now);
  return { ...state, leftMicros: state.leftMicros === null ? null : state.leftMicros + credit.availableMicros, baseMicros: base, creditMicros: credit.availableMicros, creditTotalMicros: credit.totalMicros };
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
  /** The reservations that ran out and were never settled or released, read from the very rows `unsettledMicros` counts them from (so the two can never disagree, whatever settles or releases meanwhile). */
  lapsed: { count: number; micros: number; oldestLapsedAt: Date | null };
}

/**
 * The room that still counts at a moment: held and still in time, or held and lapsed within the month it was taken in. Room that
 * lapsed (a job that crashed or was abandoned) keeps counting until it is settled or released, because what it spent is not known;
 * but it counts only in its own month, since anything it really cost is in the books as events dated then. Settling or releasing
 * lapsed room is the job runner's (game #2000); until it does, a lapsed hold never reaches past the month it was taken in.
 */
function stillCounts(now: Date): Prisma.MeterReservationWhereInput {
  return { state: 'held', OR: [{ expiresAt: { gt: now } }, { createdAt: { gte: monthOf(now).start } }] };
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
  const [settled, unsettled, unknown, chat, held, kept] = await Promise.all([
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: { not: null } }, _sum: { costMicros: true } }),
    tx.meterEvent.aggregate({ where: { ...universeComputer, settledAt: null }, _sum: { costMicros: true } }),
    tx.meterEvent.count({ where: { ...universeComputer, costMicros: null } }),
    tx.meterEvent.aggregate({ where: { pool: 'chat', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } }, _sum: { costMicros: true } }),
    tx.meterReservation.findMany({ where: stillCounts(now), select: { amountMicros: true, expiresAt: true, reservationKey: true } }),
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
  let lapsedCount = 0;
  let oldestLapsedAt: Date | null = null;
  for (const row of held) {
    if (row.expiresAt > now) reserved += Number(row.amountMicros);
    else {
      lapsed += Number(row.amountMicros);
      lapsedCount += 1;
      if (!oldestLapsedAt || row.expiresAt < oldestLapsedAt) oldestLapsedAt = row.expiresAt;
    }
  }
  // A gigabyte is 10^9 bytes; rounded up in whole millionths of a dollar, and in BigInt so a very large disk cannot lose a digit
  const keptStorageMicros = storageMonthMicros(kept[0]?.bytes ?? BigInt(0), settings);
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
    // The room held for one model call inside a job is not another job running
    jobsRunning: held.filter((row) => row.expiresAt > now && !isNoJob(row.reservationKey)).length,
    lapsed: { count: lapsedCount, micros: lapsed, oldestLapsedAt },
  };
}

/** The size of room a new model call asks for, as far as the readiness check can tell (a few cents: a call of the usual size). The real size is each call's own; this is only what "a call would be refused" is judged by. */
export const USUAL_CALL_ROOM_MICROS = 20_000;

export interface PoolStatus {
  ceilingMicros: number;
  /** committed + reserved + unsettled + keptStorage + reserve: what `fits` compares to the ceiling. */
  totalMicros: number;
  committedMicros: number;
  reservedMicros: number;
  /** Spent and not settled yet, and the lapsed holds below (they are counted here too: it is the sum `fits` reads). */
  unsettledMicros: number;
  keptStorageMicros: number;
  reserveMicros: number;
  chatMicros: number;
  /** Room that ran out and was never settled or released: what it spent is not known, so it keeps counting. A leak shows here. */
  lapsed: { count: number; micros: number; oldestLapsedAt: Date | null };
  /** What is left under the ceiling (never below 0). */
  leftMicros: number;
  /** A new call of the usual size would be refused for the pool now. */
  refusing: boolean;
}

/** The pool as `fits` sees it, in parts, with the lapsed holds counted apart (how many, how much, and since when the oldest ran out). Reads only. Null when the usage controls are not set. */
export async function poolStatusNow(now: Date = new Date()): Promise<PoolStatus | null> {
  const settings = await getMeterSettings();
  if (missingSettings(settings).length > 0) return null;
  // One read of the reservations, the envelope's own: the lapsed holds are counted from the same rows its unsettled spend counts them from, so a settlement or release in between can never leave
  // `lapsed` larger than `unsettled` (a negative "recorded and not settled" in the check)
  const envelope = await envelopeIn(prisma, now, settings);
  const ceilingMicros = settings.poolCeilingMicros ?? 0;
  return {
    ceilingMicros,
    totalMicros: envelope.totalMicros,
    committedMicros: envelope.committedMicros,
    reservedMicros: envelope.reservedMicros,
    unsettledMicros: envelope.unsettledMicros,
    keptStorageMicros: envelope.keptStorageMicros,
    reserveMicros: envelope.reserveMicros,
    chatMicros: envelope.chatMicros,
    lapsed: envelope.lapsed,
    leftMicros: Math.max(0, ceilingMicros - envelope.totalMicros),
    // The same comparison `fits` makes for a call of the usual size
    refusing: envelope.totalMicros + USUAL_CALL_ROOM_MICROS > ceilingMicros,
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
/** Room held for a person's steps that still counts against what they can start: held and in time, or ran out and not yet settled or released. */
export async function heldRoom(personId: string, now: Date, db: Pick<Tx, 'meterReservation'> = prisma): Promise<number> {
  const held = await db.meterReservation.aggregate({ where: { personKey: `person:${personId}`, ...stillCounts(now) }, _sum: { amountMicros: true } });
  return asNumber(held._sum.amountMicros);
}

async function fits(tx: Tx, personId: string, extraMicros: number, now: Date, settings: MeterSettings, opts: { newJob: boolean }): Promise<NoRoom | null> {
  const missing = missingSettings(settings);
  if (missing.length > 0) return { ok: false, reason: 'not_set', missing };
  const allowance = await memberAllowance(personId, now, settings, tx);
  if (allowance && !allowance.unlimited) {
    const left = (allowance.leftMicros ?? 0) - (await heldRoom(personId, now, tx));
    if (left < extraMicros) return { ok: false, reason: 'allowance', leftMicros: Math.max(0, left) };
  }
  const envelope = await envelopeIn(tx, now, settings);
  if (opts.newJob) {
    const mine = await tx.meterReservation.count({ where: { personKey: `person:${personId}`, state: 'held', expiresAt: { gt: now }, NOT: [{ reservationKey: { startsWith: CALL_ROOM_PREFIX } }, { reservationKey: { startsWith: DISK_ROOM_PREFIX } }] } });
    if (mine >= (settings.atOnceMember ?? 0) || envelope.jobsRunning >= (settings.atOnceAll ?? 0)) return { ok: false, reason: 'busy' };
  }
  if (envelope.totalMicros + extraMicros > (settings.poolCeilingMicros ?? 0)) return { ok: false, reason: 'pool', full: envelope.totalMicros + 1 > (settings.poolCeilingMicros ?? 0) };
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
  input: { key: string; personId: string; amountMicros: number; botId?: string | null; jobId?: string | null; chargeClass?: ChargeClass; /** False for a step inside a job that already holds its place (a model call): it is not another job at once. */ newJob?: boolean },
  asked?: Date,
): Promise<Room> {
  wholeMicros(input.amountMicros, 'amountMicros');
  if (!input.key || input.key.length > 255) throw new RangeError('key is required (up to 255 characters)');
  const room = await reserveRoomOnce(input, asked);
  // The allowance is used up: credit given to this person that has not reached them yet (it is issued when it is first needed) may cover it. Looked for
  // only now, so a step that has room never pays for the look, and asked once more, so a step is never refused for credit that was due
  if (!room.ok && room.reason === 'allowance' && (await issueComputerCredit(input.personId, asked ?? new Date())) > 0) return reserveRoomOnce(input, asked);
  return room;
}

async function reserveRoomOnce(
  input: { key: string; personId: string; amountMicros: number; botId?: string | null; jobId?: string | null; chargeClass?: ChargeClass; newJob?: boolean },
  asked?: Date,
): Promise<Room> {
  return prisma.$transaction(async (tx): Promise<Room> => {
    await lockPool(tx);
    // The time is read once the lock is held, unless the caller fixed it
    const now = asked ?? new Date();
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
    const no = await fits(tx, input.personId, input.amountMicros, now, settings, { newJob: input.newJob !== false });
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
        // The first stretch, at the price it was taken at (see `terms` on the schema)
        terms: [{ at: now.getTime(), micros: input.amountMicros, stretchMs: settings.renewMinutes * MINUTE }],
        // The same moment as the first stretch, so the lease starts when it was authorized and not when the insert happened to run
        createdAt: now,
      },
    });
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
    if (envelope.totalMicros + amountMicros > (settings.poolCeilingMicros ?? 0)) return { ok: false, reason: 'pool' };
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
 * it. The extra passes the same checks as new room (the member's allowance and the pool); if it does not, nothing changes and the
 * job saves its work and stops safely. A reservation that already lapsed, was settled or released is not renewed.
 */
export async function renewRoom(input: { key: string; moreMicros?: number }, asked?: Date): Promise<Room> {
  const more = input.moreMicros ?? 0;
  if (more !== 0) wholeMicros(more, 'moreMicros');
  return prisma.$transaction((tx) => renewRoomIn(tx, input, asked));
}

/**
 * `renewRoom` inside a transaction the caller already holds (it takes the pool's lock first, like every step): for a caller that must decide to renew and renew as ONE step under a lock of its own (a computer job's renewal,
 * under the job's cutoff lock with its row locked, so a renewal never adds room for a worker that no longer owns the job).
 */
export async function renewRoomIn(tx: Tx, input: { key: string; moreMicros?: number }, asked?: Date): Promise<Room> {
  const more = input.moreMicros ?? 0;
  if (more !== 0) wholeMicros(more, 'moreMicros');
  {
    await lockPool(tx);
    // The time is read once the lock is held (a renewal that waited for the lock past the end of its lease is a lapsed hold), unless the caller fixed it
    const now = asked ?? new Date();
    const row = await tx.meterReservation.findUnique({ where: { reservationKey: input.key } });
    if (!row || row.state !== 'held' || row.expiresAt <= now) return { ok: false, reason: 'closed' };
    const settings = await getMeterSettings(tx);
    const stretchMs = settings.renewMinutes * MINUTE;
    // Each stretch keeps the price it was taken at: this renewal's stretch is priced at the room it holds (one that adds no room keeps the price the
    // lease last had). A lease with no terms (an older row) stays without, and is counted as equal stretches.
    const terms = termsOf(row.terms);
    // A request stamped before the last stretch on record was overtaken by a renewal that took the lock first: there is nothing to add, and the
    // lease stays as that renewal left it (appending an older stretch would put the history out of order and pull the end back)
    if (terms && now.getTime() < terms[terms.length - 1].at) return { ok: true, reservation: viewOf(row), created: false };
    const nextTerms = terms ? [...terms, { at: now.getTime(), micros: more > 0 ? more : terms[terms.length - 1].micros, stretchMs }] : null;
    if (more > 0) {
      // More room for a job that runs is a new step for the rules too: the same ones that let it start decide whether it may take more.
      // The rules count what the job can still cost (the time used and the stretch its lease covers, see spend-rules), so the question is
      // what the renewal adds to that. What the renewal adds to what the job can still cost: its exposure through the new lease, less what it counts now (at minute five a
      // first stretch counts whole; renewed, it counts the five minutes used and the stretch the new lease covers)
      const lease = { amountMicros: row.amountMicros, renewals: row.renewals, createdAt: row.createdAt, expiresAt: row.expiresAt, terms: row.terms };
      const renewed = { amountMicros: row.amountMicros + BigInt(more), renewals: row.renewals + 1, createdAt: row.createdAt, expiresAt: new Date(now.getTime() + stretchMs), terms: nextTerms };
      const before = exposureOf([lease], settings.renewMinutes, now);
      const after = exposureOf([renewed], settings.renewMinutes, now);
      const ruled = await checkSpend(
        // What the renewal adds, and nothing when exposure does not grow (a job exactly at its cap may go on to the end of the lease it holds)
        { payerPersonId: row.personId ?? '', botId: row.botId, taskKey: row.jobId, chargeClass: 'computer', amountMicros: Math.max(0, after - before), renewal: { before: lease, after: renewed, renewMinutes: settings.renewMinutes } },
        now,
        tx,
      );
      if (!ruled.ok) return { ok: false, reason: 'rule', ruleId: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words };
      const no = await fits(tx, row.personId ?? '', more, now, settings, { newJob: false });
      if (no) return no;
    }
    const next = await tx.meterReservation.update({
      where: { id: row.id },
      data: { amountMicros: row.amountMicros + BigInt(more), expiresAt: new Date(now.getTime() + settings.renewMinutes * MINUTE), renewals: { increment: 1 }, ...(nextTerms ? { terms: nextTerms.map((term) => ({ at: term.at, micros: term.micros, stretchMs: term.stretchMs })) } : {}) },
    });
    return { ok: true, reservation: viewOf(next), created: false };
  }
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
  return prisma.$transaction((tx) => closeIn(tx, key, state, now, settledMicros));
}

/**
 * `releaseRoom` inside a transaction the caller already holds (it takes the pool's lock first, like every step): for a caller that must decide to release and release as ONE step under a lock of its own,
 * so nothing can use the room between the decision and the release.
 */
export async function releaseRoomIn(tx: Tx, input: { key: string }, now: Date = new Date()): Promise<Reservation | null> {
  return closeIn(tx, input.key, 'released', now, null);
}

/**
 * `settleRoom` inside a transaction the caller already holds (it takes the pool's lock first, like every step): for a caller that must settle a room in the same commit as the decision it settles for
 * (a computer job's pause, under the job's cutoff lock with its row locked, so the time so far is settled exactly once and the room is never left held for a job that holds nothing).
 */
export async function settleRoomIn(tx: Tx, input: { key: string; settledMicros: number }, now: Date = new Date()): Promise<Reservation | null> {
  return closeIn(tx, input.key, 'settled', now, input.settledMicros);
}

async function closeIn(tx: Tx, key: string, state: 'settled' | 'released', now: Date, settledMicros: number | null): Promise<Reservation | null> {
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
}
