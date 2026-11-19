import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordMeterEvent, type RecordedEvent } from '@/lib/meter';
import type { MeterEventInput } from '@/lib/meter-values';
import { INSTANT_PROVIDER } from '@/lib/instant/values';

/**
 * The meter event of an Instant run (`instant:<run id>`), made from what the run itself says, and kept right.
 *
 * The run's row is the truth: Composio's settlement gives the provider amount and its basis, and the credit books' own acknowledgement gives what
 * the person was charged. The event is a copy of that for the books, so it can be rebuilt from the run at any time: nothing here asks the App,
 * the credit books or the wallet for anything. A run that is settled and has no event (the write was refused), or whose event says something other than
 * the run (it was written before the books confirmed the charge), is a gap that is found from the rows themselves (`gapsSql`), so no separate record of
 * it can be lost, and it is mended by the sweep a few at a time (`repairInstantReporting`). Mending the same run again changes nothing.
 */

export type Row = Prisma.InstantRunGetPayload<object>;

/**
 * What the person was charged, as the event says it: the amount the credit books confirmed, 0 when the hold was given back or the run failed (the person
 * paid nothing: a zero, not "not known"), and null while the books have not said yet (the receipt shows that as pending, never as a charge nobody confirmed).
 */
export function customerAmountOf(run: Pick<Row, 'customerState' | 'customerMicros' | 'state'>): number | null {
  if (run.customerState === 'charged' && run.customerMicros !== null) return Number(run.customerMicros);
  if (run.customerState === 'released' || run.state === 'failed') return 0;
  return null;
}

const basisOf = (run: Pick<Row, 'providerBasis'>) => (run.providerBasis === 'measured' ? 'measured' : 'estimated');

/** The event a settled run stands for, or null while the run is not settled with the provider (it has no cost to write yet). */
export function instantEventOf(run: Row): MeterEventInput | null {
  if (run.providerState !== 'settled' || run.providerMicros === null || !run.finishedAt) return null;
  const micros = Number(run.providerMicros);
  return {
    eventId: `instant:${run.id}`,
    kind: 'app_use',
    pool: 'chat',
    // The day the run was settled, never the day it was mended
    occurredAt: run.finishedAt,
    personKey: `person:${run.personId}`,
    personId: run.personId,
    botId: run.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'instant',
    jobId: null,
    quantity: 1,
    unit: 'use',
    costMicros: micros,
    basis: basisOf(run),
    sourceRef: `instant_runs:${run.id}`,
    detail: {
      instant: true,
      provider: INSTANT_PROVIDER,
      ...(run.taskKey ? { taskKey: run.taskKey } : {}),
      tool: run.toolSlug,
      toolkit: run.toolkit,
      runId: run.id,
      customerMicros: customerAmountOf(run),
      basis: basisOf(run),
      state: run.state,
    },
  };
}

export type ReportResult = 'written' | 'corrected' | 'same' | 'skipped';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Makes the event of this run say what the run says: writes it when it is missing, corrects it when its amounts differ. A correction keeps what the event
 * said before in its own detail (`corrections`, the latest few), so it stays auditable. Safe to say twice and from two places at once: the event row is
 * held while it is compared, and a second say finds nothing to change. It touches only the event: no App is called, nothing is debited, and a use is counted once
 * (the event id is the run's own).
 */
export async function reportInstantRun(run: Row, now: Date = new Date()): Promise<ReportResult> {
  const wanted = instantEventOf(run);
  if (!wanted) return 'skipped';
  const first = await prisma.meterEvent.findUnique({ where: { eventId: wanted.eventId }, select: { id: true } });
  if (!first) {
    const done: RecordedEvent = await recordMeterEvent(wanted);
    // Written by someone else between the look and the write: that one is compared like any other below
    if (done.recorded) return 'written';
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM meter_events WHERE event_id = ${wanted.eventId} FOR UPDATE`;
    const event = await tx.meterEvent.findUnique({ where: { eventId: wanted.eventId } });
    if (!event) return 'skipped' as const;
    const detail = isRecord(event.detail) ? event.detail : {};
    const was = { customerMicros: typeof detail.customerMicros === 'number' ? detail.customerMicros : null, costMicros: event.costMicros === null ? null : Number(event.costMicros), basis: event.basis };
    const becomes = { customerMicros: customerAmountOf(run), costMicros: wanted.costMicros, basis: wanted.basis };
    if (was.customerMicros === becomes.customerMicros && was.costMicros === becomes.costMicros && was.basis === becomes.basis) return 'same' as const;
    // The books saying what the person was charged, where the event said pending, is the event being filled in; anything else that changes is a correction and is kept
    const fillingIn = was.customerMicros === null && was.costMicros === becomes.costMicros && was.basis === becomes.basis;
    const before = Array.isArray(detail.corrections) ? detail.corrections.slice(-4) : [];
    await tx.meterEvent.update({
      where: { eventId: wanted.eventId },
      data: {
        costMicros: wanted.costMicros === null ? null : BigInt(wanted.costMicros),
        basis: wanted.basis,
        detail: { ...detail, ...(wanted.detail ?? {}), ...(fillingIn ? (before.length > 0 ? { corrections: before } : {}) : { corrections: [...before, { at: now.toISOString(), was, now: becomes }] }) } as Prisma.InputJsonValue,
      },
    });
    return 'corrected' as const;
  });
}

/**
 * The settled runs whose event is missing or says something other than the run: the run's own rows are the record of it, so a gap cannot be forgotten.
 * Each part must read the same as `instantEventOf` and `customerAmountOf` (the tests keep them together).
 */
const gapsSql = Prisma.sql`
  FROM instant_runs r LEFT JOIN meter_events e ON e.event_id = 'instant:' || r.id
  WHERE r.provider_state = 'settled' AND r.provider_micros IS NOT NULL AND r.finished_at IS NOT NULL
    AND (
      e.id IS NULL
      OR e.cost_micros IS DISTINCT FROM r.provider_micros
      OR e.basis IS DISTINCT FROM (CASE WHEN r.provider_basis = 'measured' THEN 'measured' ELSE 'estimated' END)
      OR (e.detail->>'customerMicros') IS DISTINCT FROM (CASE WHEN r.customer_state = 'charged' AND r.customer_micros IS NOT NULL THEN r.customer_micros::text WHEN r.customer_state = 'released' OR r.state = 'failed' THEN '0' ELSE NULL END)
    )`;

export interface ReportingGaps {
  /** Settled runs with no event at all. */
  missing: number;
  /** Settled runs whose event says other amounts than the run. */
  wrong: number;
  /** When the oldest of them was settled, or null when there is none. */
  oldestAt: Date | null;
}

/** How many gaps there are now (or among the runs settled in a span of days) and how old the oldest is. */
export async function instantReportingGaps(span?: { from: Date; to: Date }): Promise<ReportingGaps> {
  const within = span ? Prisma.sql`AND r.finished_at >= ${span.from} AND r.finished_at <= ${span.to}` : Prisma.empty;
  const [row] = await prisma.$queryRaw<{ missing: number; wrong: number; oldest: Date | null }[]>(Prisma.sql`
    SELECT (COUNT(*) FILTER (WHERE e.id IS NULL))::int AS missing, (COUNT(*) FILTER (WHERE e.id IS NOT NULL))::int AS wrong, MIN(r.finished_at) AS oldest ${gapsSql} ${within}`);
  return { missing: row?.missing ?? 0, wrong: row?.wrong ?? 0, oldestAt: row?.oldest ?? null };
}

/** Runs of a span of days that Composio has not settled yet: they cost us, and nothing is on the books for them until it does. */
export async function instantRunsUnsettled(span: { from: Date; to: Date }): Promise<number> {
  return prisma.instantRun.count({ where: { providerState: 'pending', createdAt: { gte: span.from, lte: span.to } } });
}

const CURSOR_KEY = 'instant-reporting-cursor';

async function readCursor(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } });
  const after = isRecord(row?.value) ? row?.value.after : null;
  return typeof after === 'string' ? after : null;
}

async function writeCursor(after: string | null): Promise<void> {
  const value = { after };
  await prisma.appSetting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value }, update: { value } });
}

export interface ReportingRepair {
  looked: number;
  written: number;
  corrected: number;
  failed: number;
  /** The gaps still there after this pass, and the age of the oldest. */
  remaining: ReportingGaps;
}

/** The most runs mended in one pass: the sweep is never held up by a long list, and a long list is finished over several passes. */
export const REPAIR_BATCH = 100;

/**
 * Mends a bounded batch of gaps, from where the last pass stopped (the place is kept in the database, so a restart goes on from it; after the end it starts again
 * from the top). A run that could not be mended now stays a gap and is tried again when the pass comes round to it, so one that keeps failing never keeps the
 * others from being mended. Nothing is asked of an App or the credit books.
 */
export async function repairInstantReporting(opts: { limit?: number; now?: Date } = {}): Promise<ReportingRepair> {
  const limit = Math.max(1, Math.min(opts.limit ?? REPAIR_BATCH, 1000));
  const now = opts.now ?? new Date();
  const pick = async (after: string | null) =>
    prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT r.id ${gapsSql} ${after === null ? Prisma.empty : Prisma.sql`AND r.id > ${after}`} ORDER BY r.id LIMIT ${limit}`);
  const cursor = await readCursor();
  let ids = await pick(cursor);
  // The end was reached: go back to the top (once, in this same pass)
  if (ids.length === 0 && cursor !== null) ids = await pick(null);
  const out: ReportingRepair = { looked: ids.length, written: 0, corrected: 0, failed: 0, remaining: { missing: 0, wrong: 0, oldestAt: null } };
  for (const { id } of ids) {
    try {
      const run = await prisma.instantRun.findUnique({ where: { id } });
      const done = run ? await reportInstantRun(run, now) : 'skipped';
      if (done === 'written') out.written++;
      else if (done === 'corrected') out.corrected++;
    } catch (error) {
      out.failed++;
      console.error('[Instant] Could not mend the meter event of a run:', error instanceof Error ? error.message : 'unknown');
    }
  }
  // The place moves past what was looked at, mended or not (the ones that failed come round again); with nothing left to look at it goes back to the top
  await writeCursor(ids.length >= limit ? ids[ids.length - 1].id : null).catch((error) => console.error('[Instant] Could not keep the place of the meter repair:', error instanceof Error ? error.message : 'unknown'));
  out.remaining = await instantReportingGaps();
  return out;
}
