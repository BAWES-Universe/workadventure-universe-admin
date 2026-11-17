import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { monthOf } from '@/lib/meter-values';

/**
 * What the Budget page reads from the books (meter_events, instant_runs, reservations and the computers), as plain sums. Every figure is what was
 * recorded: an event whose price is not known is counted apart (`unpriced`), never as 0. Reading only; nothing here writes and nothing here knows
 * a price, a budget or a limit.
 */

export interface Filter {
  pool?: string;
  kind?: string;
  route?: string;
  /** Events whose route is not this one (connected Apps are the "app" route; Instant has its own). */
  routeNot?: string;
  payer?: 'universe' | 'person';
}

type Db = Pick<typeof prisma, '$queryRaw'>;

const asNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

function conditions(filter: Filter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`payer_kind = ${filter.payer ?? 'universe'}`];
  if (filter.pool) parts.push(Prisma.sql`pool = ${filter.pool}`);
  if (filter.kind) parts.push(Prisma.sql`kind = ${filter.kind}`);
  if (filter.route) parts.push(Prisma.sql`route = ${filter.route}`);
  if (filter.routeNot) parts.push(Prisma.sql`COALESCE(route, '') <> ${filter.routeNot}`);
  return Prisma.join(parts, ' AND ');
}

export interface MonthSum {
  costMicros: number;
  events: number;
  /** Events with no price known yet. */
  unpriced: number;
  /** The part of the cost the provider has not settled yet. */
  unsettledMicros: number;
}

/** What one kind of use has cost this calendar month (UTC), and how many events had no price. */
export async function monthSum(filter: Filter, now: Date, db: Db = prisma): Promise<MonthSum> {
  const month = monthOf(now);
  const rows = await db.$queryRaw<{ cost: bigint; events: bigint; unpriced: bigint; unsettled: bigint }[]>`
    SELECT COALESCE(SUM(cost_micros), 0)::bigint AS cost,
           COUNT(*)::bigint AS events,
           COUNT(*) FILTER (WHERE cost_micros IS NULL)::bigint AS unpriced,
           COALESCE(SUM(cost_micros) FILTER (WHERE settled_at IS NULL), 0)::bigint AS unsettled
    FROM meter_events
    WHERE occurred_at >= ${month.start} AND occurred_at < ${month.end} AND ${conditions(filter)}`;
  const row = rows[0];
  return { costMicros: asNumber(row?.cost), events: asNumber(row?.events), unpriced: asNumber(row?.unpriced), unsettledMicros: asNumber(row?.unsettled) };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * What was spent in each of the last `days` periods of 24 hours before `now`, oldest first. Periods are counted back from now, so the newest is
 * never a partly gone calendar day that would make the pace look slow.
 */
export async function recentDays(filter: Filter, now: Date, days: number, db: Db = prisma): Promise<number[]> {
  const from = new Date(now.getTime() - days * DAY);
  const rows = await db.$queryRaw<{ age: number; micros: bigint }[]>`
    SELECT FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - occurred_at)) / 86400)::int AS age, COALESCE(SUM(cost_micros), 0)::bigint AS micros
    FROM meter_events
    WHERE occurred_at >= ${from} AND occurred_at < ${now} AND ${conditions(filter)}
    GROUP BY 1`;
  const out = new Array<number>(days).fill(0);
  for (const row of rows) {
    const age = Number(row.age);
    if (age >= 0 && age < days) out[days - 1 - age] = asNumber(row.micros);
  }
  return out;
}

/** Seconds of speech this month Universe AI paid for, heard and spoken apart (a use with no word for which part counts as heard). */
export async function speechSeconds(now: Date, db: Db = prisma): Promise<{ heard: number; spoken: number }> {
  const month = monthOf(now);
  const rows = await db.$queryRaw<{ part: string | null; seconds: bigint }[]>`
    SELECT detail->>'part' AS part, COALESCE(SUM(quantity), 0)::bigint AS seconds
    FROM meter_events
    WHERE kind = 'speech' AND payer_kind = 'universe' AND occurred_at >= ${month.start} AND occurred_at < ${month.end}
    GROUP BY 1`;
  let heard = 0;
  let spoken = 0;
  for (const row of rows) {
    if (row.part && ['speaking', 'spoken', 'speak'].includes(row.part)) spoken += asNumber(row.seconds);
    else heard += asNumber(row.seconds);
  }
  return { heard, spoken };
}

/** Instant's side of the books: what it may still owe (runs open at their top price) and what Composio has charged this month. Their own table, one read. */
export async function instantParts(now: Date, db: Db = prisma): Promise<{ openMicros: number; settledMicros: number; runs: number }> {
  const month = monthOf(now);
  const rows = await db.$queryRaw<{ open: bigint; settled: bigint; runs: bigint }[]>`
    SELECT
      COALESCE(SUM(top_micros) FILTER (WHERE state IN ('reserving', 'held', 'sent', 'ambiguous') OR provider_state = 'pending'), 0)::bigint AS open,
      COALESCE(SUM(provider_micros) FILTER (WHERE provider_state = 'settled' AND finished_at >= ${month.start} AND finished_at < ${month.end}), 0)::bigint AS settled,
      COUNT(*) FILTER (WHERE created_at >= ${month.start} AND created_at < ${month.end})::bigint AS runs
    FROM instant_runs`;
  const row = rows[0];
  return { openMicros: asNumber(row?.open), settledMicros: asNumber(row?.settled), runs: asNumber(row?.runs) };
}

/** What Instant was charged on each of the last `days` periods of 24 hours, oldest first (settled charges by the day they finished). */
export async function instantRecentDays(now: Date, days: number, db: Db = prisma): Promise<number[]> {
  const from = new Date(now.getTime() - days * DAY);
  const rows = await db.$queryRaw<{ age: number; micros: bigint }[]>`
    SELECT FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - finished_at)) / 86400)::int AS age, COALESCE(SUM(provider_micros), 0)::bigint AS micros
    FROM instant_runs
    WHERE provider_state = 'settled' AND finished_at >= ${from} AND finished_at < ${now}
    GROUP BY 1`;
  const out = new Array<number>(days).fill(0);
  for (const row of rows) {
    const age = Number(row.age);
    if (age >= 0 && age < days) out[days - 1 - age] = asNumber(row.micros);
  }
  return out;
}

export interface KeptRow {
  botId: string;
  name: string;
  ownerId: string | null;
  bytes: number;
  /** When the computer last worked; null when it never did. */
  lastWorkedAt: string | null;
  idle: boolean;
}

/** What is kept now, by Brick: the newest size recorded for each, with its owner and whether the owner's computer is idle. */
export async function keptByBrick(now: Date, idleDays: number | null, db: Db = prisma): Promise<KeptRow[]> {
  const rows = await db.$queryRaw<{ bot_id: string; name: string | null; owner_id: string | null; bytes: bigint; last_worked_at: Date | null }[]>`
    SELECT latest.bot_id, b.name, b.owner_id, latest.quantity AS bytes, c.last_worked_at
    FROM (
      SELECT DISTINCT ON (bot_id) bot_id, quantity FROM meter_events
      WHERE kind = 'stored_bytes' AND payer_kind = 'universe' AND bot_id IS NOT NULL
      ORDER BY bot_id, occurred_at DESC, recorded_at DESC
    ) latest
    LEFT JOIN bots b ON b.id = latest.bot_id
    LEFT JOIN brick_computers c ON c.bot_id = latest.bot_id
    WHERE latest.quantity > 0
    ORDER BY latest.quantity DESC`;
  const cutoff = idleDays === null ? null : now.getTime() - idleDays * DAY;
  return rows.map((row) => {
    const worked = row.last_worked_at ? new Date(row.last_worked_at) : null;
    return {
      botId: row.bot_id,
      name: row.name ?? 'A Brick',
      ownerId: row.owner_id,
      bytes: asNumber(row.bytes),
      lastWorkedAt: worked ? worked.toISOString() : null,
      // Never used, or not used since before the cutoff. With no cutoff saved nothing is called idle
      idle: cutoff !== null && (worked === null || worked.getTime() < cutoff),
    };
  });
}

export interface Queue {
  running: number;
  /** Jobs waiting in line, by the reason each waits (the job's own word for it). */
  waiting: Record<string, number>;
  oldestWaitMinutes: number | null;
}

/** Computer jobs going and waiting now, with why each waits. */
export async function queueNow(now: Date, db: Pick<typeof prisma, 'computerJob'> = prisma): Promise<Queue> {
  const [running, queued] = await Promise.all([
    db.computerJob.count({ where: { status: 'running' } }),
    db.computerJob.findMany({ where: { status: 'queued' }, select: { queuedFor: true, createdAt: true } }),
  ]);
  const waiting: Record<string, number> = {};
  let oldest: number | null = null;
  for (const job of queued) {
    const reason = job.queuedFor ?? 'turn';
    waiting[reason] = (waiting[reason] ?? 0) + 1;
    const minutes = Math.max(0, Math.round((now.getTime() - job.createdAt.getTime()) / 60_000));
    oldest = oldest === null ? minutes : Math.max(oldest, minutes);
  }
  return { running, waiting, oldestWaitMinutes: oldest };
}

export interface TaskCost {
  /** Cost per finished job, median and the high end, over this month's computer jobs priced so far. */
  jobs: number;
  medianMicros: number | null;
  highMicros: number | null;
}

/** What a computer job costs: the median and the 90th percentile of this month's jobs, from the cost on the books under each job's id. */
export async function computerJobCosts(now: Date, db: Db = prisma): Promise<TaskCost> {
  const month = monthOf(now);
  const rows = await db.$queryRaw<{ jobs: bigint; median: number | null; high: number | null }[]>`
    SELECT COUNT(*)::bigint AS jobs,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS median,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY cost) AS high
    FROM (
      SELECT job_id, SUM(cost_micros) AS cost FROM meter_events
      WHERE pool = 'computer' AND payer_kind = 'universe' AND job_id IS NOT NULL AND cost_micros IS NOT NULL
        AND occurred_at >= ${month.start} AND occurred_at < ${month.end}
      GROUP BY job_id
    ) per_job`;
  const row = rows[0];
  return { jobs: asNumber(row?.jobs), medianMicros: row?.median === null || row?.median === undefined ? null : Math.round(Number(row.median)), highMicros: row?.high === null || row?.high === undefined ? null : Math.round(Number(row.high)) };
}

/** Held room that ran out and is not settled yet: the part of the pool's envelope that is neither an event nor in time any more. */
export async function lapsedHeldMicros(now: Date, db: Pick<typeof prisma, 'meterReservation'> = prisma): Promise<number> {
  const month = monthOf(now);
  const rows = await db.meterReservation.aggregate({
    where: { state: 'held', expiresAt: { lte: now }, createdAt: { gte: month.start } },
    _sum: { amountMicros: true },
  });
  return asNumber(rows._sum.amountMicros);
}
