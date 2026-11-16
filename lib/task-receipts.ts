import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { paidBy, payerFromRow, payerOf, payerToRow, type PaidBy, type Payer } from '@/lib/paid-by';
import {
  activityIdOf,
  categoryOf,
  jobActivityIdOf,
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
export async function openReceipt(input: OpenInput, now: Date = new Date()): Promise<{ id: string; link: string; created: boolean; payer: Payer }> {
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
  // The payer is the one stored on the receipt: a replay after ownership changed still names who paid then
  return { id, link: receiptLink(id), created: created.count > 0, payer: payerFromRow(found) };
}

export type Closed = { ok: true; id: string; state: ReceiptState } | { ok: false; reason: 'not_found' };

/** A run of an Instant tool that has not ended yet: still going out, or its answer did not come back and nobody can say whether it ran. */
const RUN_OPEN_STATES = ['reserving', 'held', 'sent', 'ambiguous'];

const receiptLock = (tx: Prisma.TransactionClient, botId: string, taskKey: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${botId}:${taskKey}`}))`;

/**
 * Closes a task's receipt: done, refunded (a failure on our side: nothing was taken, whatever was held is given back) or checking (an
 * answer did not come back, and it is being looked into before anything is tried again). `checking` can still become done or
 * refunded; once a receipt is done or refunded it stays as it ended, so a second word, even a different one, changes nothing.
 *
 * The bot server's word is the task's end, not the money's: while one of the task's Instant runs has not ended (its answer did not come
 * back and the lookup is still waiting), a done or refunded word leaves the receipt in checking, and the run's settling ends it
 * (`settleReceipt`). The bot server can say done before Orbit knows what happened to a run, and that must never freeze the receipt.
 */
export async function closeReceipt(
  input: { botId: string; taskKey: string; personId: string; state: ReceiptState; chargedMicros?: number | null },
  now: Date = new Date(),
): Promise<Closed> {
  if (input.chargedMicros !== undefined && input.chargedMicros !== null && !wholeMicros(input.chargedMicros)) throw new RangeError('chargedMicros must be a whole number, 0 or more');
  return prisma.$transaction(async (tx) => {
    await receiptLock(tx, input.botId, input.taskKey);
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
    if (!row || row.personId !== input.personId) return { ok: false, reason: 'not_found' };
    if (row.state === 'done' || row.state === 'refunded') return { ok: true, id: activityIdOf(row.id), state: row.state };
    const waiting = input.state !== 'checking' && (await openRunsOf(tx, input)) > 0;
    const state: ReceiptState = waiting ? 'checking' : input.state;
    const charged = state === 'refunded' ? 0 : (input.chargedMicros ?? null);
    const next = await tx.taskReceipt.update({
      where: { id: row.id },
      data: { state, chargedMicros: charged === null ? null : BigInt(charged), endedAt: state === 'checking' ? null : now },
    });
    return { ok: true, id: activityIdOf(next.id), state: next.state as ReceiptState };
  });
}

const openRunsOf = (tx: Prisma.TransactionClient, task: { botId: string; personId: string; taskKey: string }) =>
  tx.instantRun.count({ where: { botId: task.botId, personId: task.personId, taskKey: task.taskKey, state: { in: RUN_OPEN_STATES } } });

/**
 * Orbit's own word on a task's receipt from what its Instant runs came to. Called when a run ends or is looked up, and by the sweep for
 * a receipt still in checking (so a crash between a run's ending and this never leaves one behind). Safe to say twice and any number of
 * times; never asks a person, never calls a model.
 *
 * "Checking" means the task has ended (the bot server said so) and Orbit is still waiting to learn what a run of it came to. Orbit never
 * ends a task the bot server has not ended: a task still running keeps running while one of its runs is unclear, however that run ends,
 * because the task can still make more runs.
 *
 *  - Receipt done or refunded, and a run of the task still open: back to checking (the bot server's word came before Orbit knew).
 *  - Receipt in checking, every run ended: done when any run worked (what it took is read from the books by the task's key), and
 *    refunded, nothing taken, when none did. Runs nobody could vouch for when their wait ended count as not worked: the person's favour.
 *  - Receipt in checking, a run still open: stays in checking. One run ending never ends a task that has another still open.
 *  - Receipt running, or done/refunded with every run ended: left as it is. A task with no Instant run (a computer's) is not touched.
 */
export async function settleReceipt(task: { botId: string; personId: string; taskKey: string }, now: Date = new Date(), unwatchedBefore: Date | null = null): Promise<ReceiptState | null> {
  return prisma.$transaction(async (tx) => {
    await receiptLock(tx, task.botId, task.taskKey);
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: task.botId, taskKey: task.taskKey } } });
    if (!row || row.personId !== task.personId) return null;
    const runs = await tx.instantRun.findMany({ where: { botId: task.botId, personId: task.personId, taskKey: task.taskKey }, select: { state: true } });
    if (runs.length === 0) {
      // A task with no Instant run has nothing here to look up, and the bot server may have closed it as checking because its request never
      // reached Orbit. Once it has waited well past the bot server's own retries, it is ended so it never stays hidden for good: refunded
      // (nothing was ever sent, so nothing was taken) when the books hold nothing for its key, done (what it took is read from the books) otherwise.
      if (row.state === 'checking' && unwatchedBefore !== null && row.updatedAt < unwatchedBefore) {
        const recorded = await tx.meterEvent.count({ where: { OR: [{ jobId: task.taskKey, botId: task.botId }, { botId: task.botId, detail: { path: ['taskKey'], equals: task.taskKey } }] } });
        const state: ReceiptState = recorded === 0 ? 'refunded' : 'done';
        await tx.taskReceipt.update({ where: { id: row.id }, data: { state, chargedMicros: recorded === 0 ? BigInt(0) : row.chargedMicros, endedAt: now } });
        return state;
      }
      return row.state as ReceiptState;
    }
    if (runs.some((run) => RUN_OPEN_STATES.includes(run.state))) {
      if (row.state === 'checking' || row.state === 'running') return row.state as ReceiptState;
      await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', endedAt: null } });
      return 'checking';
    }
    if (row.state !== 'checking') return row.state as ReceiptState;
    const worked = runs.some((run) => run.state === 'succeeded');
    const state: ReceiptState = worked ? 'done' : 'refunded';
    await tx.taskReceipt.update({ where: { id: row.id }, data: { state, chargedMicros: worked ? row.chargedMicros : BigInt(0), endedAt: now } });
    return state;
  });
}

/** How long a receipt in checking with no Instant run waits before it is ended: well past the bot server's own retries (it gives up after 150 s). Internal, not a person-facing limit. */
export const UNWATCHED_CHECKING_WAIT_MS = 15 * 60 * 1000;

/**
 * Receipts still in checking: the sweep says each one again. Oldest first. Those with Instant runs are settled once every run has ended; those
 * with none are ended after `UNWATCHED_CHECKING_WAIT_MS`, so none stays hidden for good.
 */
export async function settleCheckingReceipts(limit: number, now: Date = new Date(), unwatchedWaitMs: number = UNWATCHED_CHECKING_WAIT_MS): Promise<number> {
  const unwatchedBefore = new Date(now.getTime() - unwatchedWaitMs);
  const rows = await prisma.$queryRaw<Array<{ botId: string; personId: string; taskKey: string }>>(Prisma.sql`
    SELECT r."bot_id" AS "botId", r."person_id" AS "personId", r."task_key" AS "taskKey"
    FROM task_receipts r
    WHERE r."state" = 'checking'
      AND (
        (r."updated_at" < ${unwatchedBefore} AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key"))
        OR (EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key") AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" IN ('reserving', 'held', 'sent', 'ambiguous')))
      )
    ORDER BY r."updated_at" ASC
    LIMIT ${limit}`);
  let settled = 0;
  for (const row of rows) {
    const state = await settleReceipt(row, now, unwatchedBefore).catch((error) => {
      console.error('[Receipts] Could not settle a receipt:', error instanceof Error ? error.message : 'unknown');
      return null;
    });
    if (state && state !== 'checking') settled += 1;
  }
  return settled;
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
       OR ("job_id" IS NULL AND "bot_id" = ANY(${bots}::text[]) AND "detail"->>'taskKey' = ANY(${keys}::text[]))
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
        row.botId === header.botId &&
        (row.jobId === header.taskKey ||
          // A run of an Instant tool says which task it belongs to: it is that task's, whatever run the task came from
          (row.jobId === null && isRecord(row.detail) && row.detail.taskKey === header.taskKey) ||
          // A run's events with no task of their own go to the receipt that owns the run; an event that names another task is that task's only
          (owner && row.jobId === null && isRecord(row.detail) && row.detail.runId === header.runId && (row.detail.taskKey === undefined || row.detail.taskKey === header.taskKey))),
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
  };
}

/**
 * The person's finished receipts (a task still being looked up is not finished: it shows when it settles), newest by the time Activity shows
 * (when it ended, else when it began), before the limit is applied. An Apps task that came to nothing is not listed: refunded, with no run
 * that went out (a refused one went nowhere) and nothing in the books for its key. Every request of it was refused before it ran (a rule, no
 * credit, not offered) or never arrived, so nothing happened and nothing was taken, and there is nothing for the person to read or act on.
 */
async function receiptsNewest(personId: string, limit: number): Promise<ReceiptRow[]> {
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r."id" FROM task_receipts r
    WHERE r."person_id" = ${personId} AND r."state" NOT IN ('running', 'checking')
      AND NOT (
        r."state" = 'refunded' AND COALESCE(r."category", '') = 'apps'
        AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" <> 'refused')
        AND NOT EXISTS (SELECT 1 FROM meter_events m WHERE m."bot_id" = r."bot_id" AND (m."job_id" = r."task_key" OR (m."job_id" IS NULL AND m."detail"->>'taskKey' = r."task_key")))
      )
    ORDER BY COALESCE(r."ended_at", r."started_at") DESC, r."id" DESC
    LIMIT ${limit}`);
  if (ids.length === 0) return [];
  const rows = await prisma.taskReceipt.findMany({ where: { id: { in: ids.map((row) => row.id) } } });
  const order = new Map(ids.map((row, index) => [row.id, index]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * The Activity list of a person: their finished tasks, newest first, at most `ACTIVITY_LISTED`. Tasks that are still running are not
 * listed (their status is in the chat), and neither is one the system is still looking up (an answer did not come back): it is listed
 * as done or refunded once the lookup settles, so nobody reads a state they cannot act on. Reads only; it never starts or changes anything.
 */
export async function activityFor(personId: string, limit: number = ACTIVITY_LISTED): Promise<ActivityItem[]> {
  const [rows, jobs] = await Promise.all([
    receiptsNewest(personId, limit),
    // A job a rule the person said refused before it ever ran took nothing and did nothing: it is not a task they had, so it is not listed
    prisma.computerJob.findMany({ where: { personId, status: { in: ['done', 'stopped', 'failed'] }, endedAt: { not: null }, OR: [{ endedBy: null }, { endedBy: { not: 'rule' } }, { startedAt: { not: null } }] }, orderBy: [{ endedAt: 'desc' }, { id: 'desc' }], take: limit }),
  ]);
  const headers = rows.map(headerOfRow);
  // A computer's job with a receipt of its own is that receipt: shown once. One whose receipt is still being looked up (checking) is not
  // listed either, so it does not come back as the job's own line
  const lookingUp = jobs.length === 0 ? [] : await prisma.taskReceipt.findMany({ where: { personId, state: 'checking', taskKey: { in: jobs.map((job) => job.id) } }, select: { botId: true, taskKey: true } });
  const kept = new Set([...rows, ...lookingUp].map((row) => `${row.botId}:${row.taskKey}`));
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
    }));
  const all = [...headers, ...computerHeaders];
  const [events, bots] = await Promise.all([eventsFor(all), prisma.bot.findMany({ where: { id: { in: [...new Set(all.map((header) => header.botId))] } }, select: { id: true, name: true } })]);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const failedJobs = new Set(jobs.filter((job) => job.status === 'failed').map((job) => jobActivityIdOf(job.id)));
  const items = all.map((header) => {
    const forHeader = events.get(header.id) ?? [];
    // A computer job that failed is "refunded, nothing taken" only when the books show nothing was taken: a price not known yet is not "nothing"
    const mayHaveTaken = forHeader.some((event) => event.kind === 'computer_time' && (event.costMicros === null || event.costMicros > 0));
    const state: ReceiptState = failedJobs.has(header.id) && !mayHaveTaken ? 'refunded' : header.state;
    return itemOf({ ...header, state }, forHeader, names.get(header.botId) ?? 'Brick', personId);
  });
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)).slice(0, limit);
}
