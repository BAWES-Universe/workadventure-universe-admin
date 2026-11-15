import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { paidBy, payerFromRow, payerOf, payerToRow, type PaidBy, type Payer } from '@/lib/paid-by';
import {
  activityIdOf,
  categoryOf,
  jobActivityIdOf,
  readActivityId,
  receiptLines,
  receiptLink,
  spentOf,
  type LineEvent,
  type ReceiptCategory,
  type ReceiptLine,
  type ReceiptState,
} from '@/lib/task-receipts-values';

/**
 * One receipt per task (paying spec 3, part O4): the Activity list on the Usage page. A line for each task, and on tap what it used
 * and who paid. The header is kept here (the title Brick gave it, who asked, who paid, what it was held up to and what it took).
 * What it used is never copied: it is read from the meter's books by the task's key (or its run), so a receipt can only say what
 * was recorded. A computer's job shows up without anyone opening a receipt for it.
 */

/** How many receipts one list holds, newest first. */
export const ACTIVITY_LISTED = 50;

export interface ActivityItem {
  id: string;
  title: string;
  /** ISO time: when it finished, or began while it has not. */
  at: string;
  state: ReceiptState;
  spentMicros: number | null;
  category: ReceiptCategory | null;
  payer: PaidBy['payer'];
  payerName: string | null;
  /** The label as the reader sees it ("Paid by you"). */
  paidBy: string;
  lines: ReceiptLine[];
  /** "Didn't work?" is offered: not while it is being checked, and not twice. */
  canReport: boolean;
}

type ReceiptRow = NonNullable<Awaited<ReturnType<typeof prisma.taskReceipt.findUnique>>>;

const toNumber = (value: bigint | number | null): number | null => (value === null ? null : Number(value));
const wholeMicros = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface OpenInput {
  botId: string;
  personId: string;
  taskKey: string;
  runId?: string | null;
  title: string;
  category?: ReceiptCategory | null;
  /** The most it can take while it runs ("up to $1.20"). */
  boundMicros?: number | null;
  /** Who pays when the caller knows it (a universe's funding account); otherwise it is worked out from the bot. */
  payer?: Payer;
}

/**
 * Opens a task's receipt, once per Brick and task: opening it again finds it and changes nothing (the first title and payer stand).
 * Returns the id the game uses and the link a reply can carry.
 */
export async function openReceipt(input: OpenInput, now: Date = new Date()): Promise<{ id: string; link: string; created: boolean }> {
  if (!input.taskKey || input.taskKey.length > 255) throw new RangeError('taskKey is required (up to 255 characters)');
  if (input.boundMicros !== undefined && input.boundMicros !== null && !wholeMicros(input.boundMicros)) throw new RangeError('boundMicros must be a whole number, 0 or more');
  const title = input.title.trim().slice(0, 120) || 'A task';
  const payer = input.payer ?? (await payerOf(input.botId));
  const row = payerToRow(payer);
  const created = await prisma.taskReceipt.createMany({
    data: [
      {
        botId: input.botId,
        personId: input.personId,
        taskKey: input.taskKey,
        runId: input.runId ?? null,
        title,
        category: input.category ?? null,
        boundMicros: input.boundMicros === undefined || input.boundMicros === null ? null : BigInt(input.boundMicros),
        startedAt: now,
        ...row,
      },
    ],
    skipDuplicates: true,
  });
  const found = await prisma.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
  if (!found) throw new Error('receipt not found after opening');
  // One Brick's task is one person's: a key used for someone else is the first one's, and whoever asked has a bug to find
  if (found.personId !== input.personId) throw new RangeError('taskKey belongs to another person');
  const id = activityIdOf(found.id);
  return { id, link: receiptLink(id), created: created.count > 0 };
}

export type Closed = { ok: true; id: string; state: ReceiptState } | { ok: false; reason: 'not_found' };

/**
 * Closes a task's receipt: done, refunded (a failure on our side: nothing was taken, whatever was held is given back) or checking (an
 * answer did not come back, and it is being looked into before anything is tried again). `checking` can still become done or
 * refunded; once a receipt is done or refunded it stays as it ended, so a second word, even a different one, changes nothing.
 */
export async function closeReceipt(
  input: { botId: string; taskKey: string; personId: string; state: ReceiptState; chargedMicros?: number | null },
  now: Date = new Date(),
): Promise<Closed> {
  if (input.chargedMicros !== undefined && input.chargedMicros !== null && !wholeMicros(input.chargedMicros)) throw new RangeError('chargedMicros must be a whole number, 0 or more');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${input.botId}:${input.taskKey}`}))`;
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
    if (!row || row.personId !== input.personId) return { ok: false, reason: 'not_found' };
    if (row.state === 'done' || row.state === 'refunded') return { ok: true, id: activityIdOf(row.id), state: row.state };
    const charged = input.state === 'refunded' ? 0 : (input.chargedMicros ?? null);
    const next = await tx.taskReceipt.update({
      where: { id: row.id },
      data: { state: input.state, chargedMicros: charged === null ? null : BigInt(charged), endedAt: input.state === 'checking' ? null : now },
    });
    return { ok: true, id: activityIdOf(next.id), state: next.state as ReceiptState };
  });
}

interface Header {
  id: string;
  title: string;
  at: Date;
  state: ReceiptState;
  category: ReceiptCategory | null;
  chargedMicros: number | null;
  payer: Payer;
  botId: string;
  taskKey: string;
  runId: string | null;
  problemAt: Date | null;
}

const headerOfRow = (row: ReceiptRow): Header => ({
  id: activityIdOf(row.id),
  title: row.title,
  at: row.endedAt ?? row.startedAt,
  state: row.state as ReceiptState,
  category: row.category as ReceiptCategory | null,
  chargedMicros: toNumber(row.chargedMicros),
  payer: payerFromRow(row),
  botId: row.botId,
  taskKey: row.taskKey,
  runId: row.runId,
  problemAt: row.problemAt,
});

/**
 * The books' events for a set of tasks, in one read: by the task's own key, or by the run the task's chat model calls were made under.
 * A run's own events (no job on them) belong to one task: the first receipt opened for that run (a run can have several receipts, and
 * each must not show the same run-wide cost again). An event that belongs to a job is only ever that job's.
 */
async function eventsFor(headers: readonly Header[]): Promise<Map<string, LineEvent[]>> {
  const out = new Map<string, LineEvent[]>();
  if (headers.length === 0) return out;
  const keys = headers.map((header) => header.taskKey);
  const bots = [...new Set(headers.map((header) => header.botId))];
  const runs = [...new Set(headers.map((header) => header.runId).filter((run): run is string => !!run))];
  const [rows, opened] = await Promise.all([
    prisma.$queryRaw<Array<{ kind: string; route: string | null; quantity: bigint; costMicros: bigint | null; detail: unknown; jobId: string | null; botId: string | null }>>(Prisma.sql`
    SELECT "kind", "route", "quantity", "cost_micros" AS "costMicros", "detail", "job_id" AS "jobId", "bot_id" AS "botId"
    FROM meter_events
    WHERE "job_id" = ANY(${keys}::text[])
       OR ("job_id" IS NULL AND "bot_id" = ANY(${bots}::text[]) AND ${runs.length > 0 ? Prisma.sql`"detail"->>'runId' = ANY(${runs}::text[])` : Prisma.sql`FALSE`})`),
    runs.length === 0 ? Promise.resolve([]) : prisma.taskReceipt.findMany({ where: { runId: { in: runs } }, select: { id: true, botId: true, runId: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] }),
  ]);
  // The receipt that owns each run's own events: the first one opened for it
  const ownerOfRun = new Map<string, string>();
  for (const row of opened) {
    const key = `${row.botId}:${row.runId}`;
    if (!ownerOfRun.has(key)) ownerOfRun.set(key, activityIdOf(row.id));
  }
  for (const header of headers) {
    const runKey = `${header.botId}:${header.runId}`;
    // A computer job with no receipt of its own takes its run's events only when no receipt owns them
    const owner = header.runId !== null && (ownerOfRun.get(runKey) ?? header.id) === header.id;
    const mine = rows.filter(
      (row) =>
        row.botId === header.botId && (row.jobId === header.taskKey || (owner && row.jobId === null && isRecord(row.detail) && row.detail.runId === header.runId)),
    );
    out.set(
      header.id,
      mine.map((row) => ({ kind: row.kind, route: row.route, quantity: Number(row.quantity), costMicros: row.costMicros === null ? null : Number(row.costMicros), detail: row.detail })),
    );
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function itemOf(header: Header, events: readonly LineEvent[], botName: string, readerId: string): ActivityItem {
  const lines = receiptLines(events, botName);
  const who = paidBy(header.payer, readerId);
  return {
    id: header.id,
    title: header.title,
    at: header.at.toISOString(),
    state: header.state,
    spentMicros: spentOf(header.state, header.chargedMicros, lines),
    category: categoryOf(header.category, events),
    payer: who.payer,
    payerName: who.payerName,
    paidBy: who.label,
    lines,
    canReport: header.state !== 'checking' && header.problemAt === null,
  };
}

/**
 * The Activity list of a person: their finished tasks, newest first, at most `ACTIVITY_LISTED`. Tasks that are still running are not
 * listed (their status is in the chat). Reads only; it never starts or changes anything.
 */
export async function activityFor(personId: string, limit: number = ACTIVITY_LISTED): Promise<ActivityItem[]> {
  const [rows, jobs] = await Promise.all([
    prisma.taskReceipt.findMany({ where: { personId, state: { not: 'running' } }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: limit }),
    // A job a rule the person said refused before it ever ran took nothing and did nothing: it is not a task they had, so it is not listed
    prisma.computerJob.findMany({ where: { personId, status: { in: ['done', 'stopped', 'failed'] }, endedAt: { not: null }, OR: [{ endedBy: null }, { endedBy: { not: 'rule' } }, { startedAt: { not: null } }] }, orderBy: [{ endedAt: 'desc' }, { id: 'desc' }], take: limit }),
  ]);
  const headers = rows.map(headerOfRow);
  // A computer's job with a receipt of its own is that receipt: shown once
  const kept = new Set(rows.map((row) => `${row.botId}:${row.taskKey}`));
  const youPay = (id: string): Payer => ({ kind: 'person', personId: id, name: null });
  const computerHeaders: Header[] = jobs
    .filter((job) => !kept.has(`${job.botId}:${job.id}`))
    .map((job) => ({
      id: jobActivityIdOf(job.id),
      title: job.title,
      at: job.endedAt ?? job.createdAt,
      // Filled in below from what the books say it took
      state: 'done' as ReceiptState,
      category: 'computer' as ReceiptCategory,
      chargedMicros: null,
      payer: youPay(personId),
      botId: job.botId,
      taskKey: job.id,
      runId: job.runId,
      problemAt: null,
    }));
  const all = [...headers, ...computerHeaders];
  const [events, bots] = await Promise.all([eventsFor(all), prisma.bot.findMany({ where: { id: { in: [...new Set(all.map((header) => header.botId))] } }, select: { id: true, name: true } })]);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const failedJobs = new Set(jobs.filter((job) => job.status === 'failed').map((job) => jobActivityIdOf(job.id)));
  const items = all.map((header) => {
    const forHeader = events.get(header.id) ?? [];
    // A computer job that failed and took nothing is "refunded, nothing taken"
    const took = forHeader.some((event) => event.kind === 'computer_time' && (event.costMicros ?? 0) > 0);
    const state: ReceiptState = failedJobs.has(header.id) && !took ? 'refunded' : header.state;
    return itemOf({ ...header, state }, forHeader, names.get(header.botId) ?? 'Brick', personId);
  });
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)).slice(0, limit);
}

export type Reported = { ok: true; outcome: 'sent' } | { ok: false; reason: 'not_found' };

/**
 * "Didn't work?" on a receipt: the report is kept once. The answer says what happened to it: `sent` is the one thing this does by
 * itself (it reaches the people who run Universe, with no words of the person's kept). A refund or a re-delivery needs the task's own
 * recovery (the Instant executor's), which answers `refunded`, `redelivered`, `retrying` or `credit` through this same route when it
 * has made one. Only the person who asked can report their own task.
 */
export async function reportProblem(personId: string, activityId: string, now: Date = new Date()): Promise<Reported> {
  const read = readActivityId(activityId);
  if (!read) return { ok: false, reason: 'not_found' };
  if (read.kind === 'receipt') {
    const row = await prisma.taskReceipt.findUnique({ where: { id: read.id } });
    if (!row || row.personId !== personId || row.state === 'running') return { ok: false, reason: 'not_found' };
    if (row.problemAt === null) await prisma.taskReceipt.updateMany({ where: { id: row.id, problemAt: null }, data: { problemAt: now } });
    return { ok: true, outcome: 'sent' };
  }
  const job = await prisma.computerJob.findUnique({ where: { id: read.id } });
  if (!job || job.personId !== personId || job.endedAt === null) return { ok: false, reason: 'not_found' };
  // The job has no receipt of its own yet: one is made now, so the report has somewhere to be kept
  const took = await prisma.meterEvent.aggregate({ where: { jobId: job.id, kind: 'computer_time' }, _sum: { costMicros: true } });
  const state: ReceiptState = job.status === 'failed' && Number(took._sum.costMicros ?? 0) === 0 ? 'refunded' : 'done';
  await prisma.taskReceipt.createMany({
    data: [{ botId: job.botId, personId, taskKey: job.id, runId: job.runId, title: job.title.slice(0, 120), category: 'computer', state, payerKind: 'person', payerPersonId: personId, startedAt: job.startedAt ?? job.createdAt, endedAt: job.endedAt }],
    skipDuplicates: true,
  });
  await prisma.taskReceipt.updateMany({ where: { botId: job.botId, taskKey: job.id, personId, problemAt: null }, data: { problemAt: now } });
  return { ok: true, outcome: 'sent' };
}
