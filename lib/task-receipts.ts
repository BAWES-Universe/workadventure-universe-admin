import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { givenBackJob } from '@/lib/computer-values';
import { RELAY_UNREACHABLE } from '@/lib/computer-faults';
import { refundStatesFor } from '@/lib/computer-refunds';
import { paidBy, payerFromRow, payerOf, payerToRow, type PaidBy, type Payer } from '@/lib/paid-by';
import {
  activityIdOf,
  categoryOf,
  computerTakenOf,
  givenBackCall,
  givenBackTime,
  instantTaken,
  jobActivityIdOf,
  outcomeOfActions,
  outcomeOfRuns,
  readActions,
  receiptLines,
  receiptLink,
  RUN_OPEN_STATES,
  spentOf,
  stateOfOutcome,
  settlingForRun,
  takenForRun,
  withComputerRefund,
  type ActionOutcome,
  type ActivityOutcome,
  type LineEvent,
  type ReceiptAction,
  type ReceiptCategory,
  type ReceiptLine,
  type ReceiptOutcome,
  type ReceiptState,
} from '@/lib/task-receipts-values';
import { actionWords, HOLD_BEING_RELEASED, HOLD_RELEASED, NOTHING_TAKEN, outcomeNote, outcomeTextOf, type NoteFacts } from '@/lib/task-receipt-words';
import { isOver } from '@/lib/computer-values';
import { isUnconfirmedRun } from '@/lib/instant/values';

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
  /**
   * How the task came to end: done (every step worked), partial, failed (it did not finish and something was taken for it), unconfirmed (nobody could confirm an action),
   * refunded, stopped (a computer job was stopped before it finished: at the person's spending rule, or by them), deciding (nothing was verified and Orbit is still deciding whether
   * the computer's cost is given back: it is charged provisionally meanwhile) or refund_pending (the cost is owed back and the books have not acknowledged it yet).
   * `state` stays done for everything but refunded, since something worked or was taken.
   */
  outcome: ActivityOutcome;
  /** The words for `outcome` ("Partly done"; see `lib/task-receipt-words.ts`). */
  outcomeText: string;
  /** The sentence under a partly done receipt ("Two steps worked and one didn’t. Nothing was taken for the one that didn’t."); null otherwise. */
  outcomeNote: string | null;
  /** Each Instant action of the task and how it ended. Empty for a task with none (a computer's). */
  actions: ActivityAction[];
  /** What the person pays for the task, net of anything given back: null when nothing, and while a refund is still pending (the net amount is said once it is settled). */
  spentMicros: number | null;
  /** The computer's cost the books have acknowledged giving back, in whole micros. Absent when none. */
  returnedMicros?: number;
  /** The computer's cost still owed back to the person: not acknowledged by the books yet ("$0.03 refund pending"). Absent when none. */
  refundPendingMicros?: number;
  category: ReceiptCategory | null;
  payer: PaidBy['payer'];
  payerName: string | null;
  /** The label as the reader sees it ("Paid by you"). */
  paidBy: string;
  lines: ReceiptLine[];
}

export interface ActivityAction {
  label: string;
  outcome: ActionOutcome;
  /** "Gmail · didn't work" */
  text: string;
  /** "Nothing taken" for an action that did not work or could not be confirmed ("Hold being released" while its credit is still on hold); null for one that did (what it took is on the receipt's own lines). */
  takenText: string | null;
  /**
   * What was taken from credit for this action, in whole micros: only for an action that worked and whose price the books know (zero is a
   * price). Absent for an action that did not work (nothing was taken) and while the price is not known yet (the receipt's line says "Price not known yet").
   */
  amountMicros?: number;
  /** For an action nobody could confirm whose hold the credit books have since acknowledged giving back: what came back, in whole micros. Absent while the hold is still on, and for any other action. */
  releasedMicros?: number;
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
 * How long an open receipt's lease lasts after it is opened or renewed. Well past the bot server's own retries (it gives up on a call after
 * 150 s) and the longest an Instant run can take. Internal, not a person-facing limit: nobody sets it.
 */
export const RECEIPT_LEASE_MS = 10 * 60 * 1000;

/**
 * A computer's receipt is on no lease: its job is its own record (it can run for hours), and `settleReceipt` reads the job. A receipt opened
 * without a category for a computer job's id gets a lease, but the sweep leaves it while that job runs and ends it with the job.
 */
const hasLease = (category: string | null | undefined): boolean => category !== 'computer';

const leaseFrom = (now: Date): Date => new Date(now.getTime() + RECEIPT_LEASE_MS);

export interface OpenedReceipt {
  id: string;
  link: string;
  created: boolean;
  payer: Payer;
  /** The turn the receipt is on. Send it with every close and renewal. */
  generation: number;
  /** When the lease runs out unless it is renewed; null for a receipt with none (a computer's) or one that is not running. */
  leaseUntil: Date | null;
}

/**
 * Opens a task's receipt, once per Brick and task: opening it again finds it and changes nothing (the first title and payer stand), except
 * that opening a receipt that is still running renews its lease. Returns the id the game uses and the link a reply can carry, and the
 * generation and lease it is on.
 */
export async function openReceipt(input: OpenInput, now: Date = new Date()): Promise<OpenedReceipt> {
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
        leaseUntil: hasLease(input.category) ? leaseFrom(now) : null,
        ...row,
      },
    ],
    skipDuplicates: true,
  });
  let found = await prisma.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
  if (!found) throw new Error('receipt not found after opening');
  // One Brick's task is one person's: a key used for someone else is the first one's, and whoever asked has a bug to find
  if (found.personId !== input.personId) throw new RangeError('taskKey belongs to another person');
  // Opening again is a sign the task is alive: a receipt still running (and on a lease) is renewed, never moved to another state
  if (created.count === 0 && found.state === 'running' && found.leaseUntil !== null) {
    // Under the receipt's lock, like settling is: a renewal and a settlement of the same task never overlap
    const task = { botId: input.botId, taskKey: input.taskKey };
    found = await prisma.$transaction(async (tx) => {
      await receiptLock(tx, task.botId, task.taskKey);
      await tx.taskReceipt.updateMany({ where: { id: found!.id, state: 'running', leaseUntil: { lt: leaseFrom(now) } }, data: { leaseUntil: leaseFrom(now) } });
      return (await tx.taskReceipt.findUnique({ where: { id: found!.id } })) ?? found!;
    });
  }
  const id = activityIdOf(found.id);
  // The payer is the one stored on the receipt: a replay after ownership changed still names who paid then
  return { id, link: receiptLink(id), created: created.count > 0, payer: payerFromRow(found), generation: found.generation, leaseUntil: found.state === 'running' ? found.leaseUntil : null };
}

/** Where a receipt stands right now. `running` is a task that has not ended; it is never a word the bot server sends. */
export type ReceiptNow = ReceiptState | 'running';

export type Closed = { ok: true; id: string; state: ReceiptNow; generation: number; stale?: true } | { ok: false; reason: 'not_found' };

type Tx = Prisma.TransactionClient;
type Row = NonNullable<Awaited<ReturnType<Tx['taskReceipt']['findUnique']>>>;
type Task = { botId: string; personId: string; taskKey: string };

const receiptLock = (tx: Tx, botId: string, taskKey: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${botId}:${taskKey}`}))`;

/** The task's Instant runs, as their own records say. */
const runRecordsOf = (tx: Tx, task: Task) =>
  tx.instantRun.findMany({ where: { botId: task.botId, personId: task.personId, taskKey: task.taskKey }, select: { id: true, state: true, toolkit: true, reason: true, detail: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

const leaseLapsed = (row: Pick<Row, 'leaseUntil'>, now: Date): boolean => row.leaseUntil !== null && row.leaseUntil.getTime() <= now.getTime();
const isTerminal = (state: string): boolean => state === 'done' || state === 'refunded';
const asActions = (actions: readonly ReceiptAction[]): Prisma.InputJsonValue => actions.map((action) => ({ run: action.run, label: action.label, outcome: action.outcome }));

/** Writes the end of a task: its state, how it came to end, and each action. `chargedMicros` is only kept for a task where something worked. */
const endReceipt = async (tx: Tx, row: Row, outcome: ReceiptOutcome, actions: readonly ReceiptAction[], now: Date, charged: number | null = null): Promise<ReceiptState> => {
  const state = stateOfOutcome(outcome);
  const kept = state === 'refunded' ? BigInt(0) : charged !== null ? BigInt(charged) : row.chargedMicros;
  await tx.taskReceipt.update({ where: { id: row.id }, data: { state, outcome, actions: asActions(actions), chargedMicros: kept, endedAt: row.endedAt && isTerminal(row.state) ? row.endedAt : now, leaseUntil: null } });
  return state;
};

/**
 * Closes a task's receipt: done, refunded (a failure on our side: nothing was taken, whatever was held is given back) or checking (an
 * answer did not come back, and it is being looked into before anything is tried again). It can be sent any number of times: once a
 * receipt has ended, a second word, even a different one, changes nothing.
 *
 * What a task came to is read from its Instant runs' own records, not from the word the bot server sends: that word says the task is over,
 * and Orbit says how it went (done when every action worked, partly done when some did, refunded when none did). The bot server's
 * done or refunded stands only for a task with no Instant run that went out (a computer's, one of Apps that never reached Orbit's runs, or one whose every run was refused
 * before it ran), so a charge the word carries is never zeroed by a run that never went out.
 * While one of the task's runs has not ended (its answer did not come back and the lookup is still waiting), the receipt is left in
 * `checking` and the run's settling ends it (`settleReceipt`): the bot server can say done before Orbit knows what happened to a run, and
 * that must never freeze the receipt.
 *
 * `generation` is the turn the close was sent for (from opening or renewing the receipt). A close for an older turn than the receipt is
 * on changes nothing and answers with the generation it is on, so a late repeat never ends a newer turn. Without it, the close is for the
 * turn the receipt is on (a bot server that does not send one yet).
 */
export async function closeReceipt(
  input: { botId: string; taskKey: string; personId: string; state: ReceiptState; chargedMicros?: number | null; generation?: number },
  now: Date = new Date(),
): Promise<Closed> {
  if (input.chargedMicros !== undefined && input.chargedMicros !== null && !wholeMicros(input.chargedMicros)) throw new RangeError('chargedMicros must be a whole number, 0 or more');
  return prisma.$transaction(async (tx) => {
    await receiptLock(tx, input.botId, input.taskKey);
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
    if (!row || row.personId !== input.personId) return { ok: false, reason: 'not_found' };
    const id = activityIdOf(row.id);
    if (input.generation !== undefined && input.generation < row.generation) return { ok: true, id, state: row.state as ReceiptNow, generation: row.generation, stale: true };
    const runs = await runRecordsOf(tx, input);
    const view = outcomeOfRuns(runs);
    if (isTerminal(row.state)) {
      // Ended already: the word changes nothing. Only a task whose run records say otherwise is put right: a run that landed after the word,
      // or one still going (then a newer turn is on it)
      if (view.open) return { ok: true, id, state: await reopenForOpenRun(tx, row), generation: row.generation + 1 };
      const state = view.actions.length === 0 ? (row.state as ReceiptState) : await reconcileEnded(tx, row, view, await jobOf(tx, input), now);
      return { ok: true, id, state, generation: row.generation };
    }
    // The bot server's word is the task's end; an open run means the task is not settled yet, whatever the word is
    if (view.open) {
      await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', outcome: null, endedAt: null, leaseUntil: null } });
      return { ok: true, id, state: 'checking', generation: row.generation };
    }
    // A task whose computer job is still running is not over, whatever the word is (the job is its own record): it waits in checking, and ends
    // when the job does (the bot server's close once the job is over, or the sweep)
    const job = await jobOf(tx, input);
    if (job && !isOver(job.status)) {
      await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', outcome: null, endedAt: null, leaseUntil: null } });
      return { ok: true, id, state: 'checking', generation: row.generation };
    }
    if (view.actions.length > 0) {
      // Every run has ended and some went out: the run records say how it went, whatever the word was
      const state = await endReceipt(tx, row, outcomeWithJob(view, job), view.actions, now, input.chargedMicros ?? null);
      return { ok: true, id, state, generation: row.generation };
    }
    if (input.state === 'checking') {
      // Nothing of it reached Orbit's runs yet: it is looked at again (the request may still arrive), then ended by the sweep
      await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', outcome: null, endedAt: null, leaseUntil: null } });
      return { ok: true, id, state: 'checking', generation: row.generation };
    }
    // A job that ran and failed is failed whatever the word says; otherwise the bot server's word stands for a task with no action that went out
    const outcome: ReceiptOutcome = jobFailed(job) ? 'failed' : input.state === 'refunded' ? 'refunded' : 'done';
    const state = await endReceipt(tx, row, outcome, [], now, input.chargedMicros ?? null);
    return { ok: true, id, state, generation: row.generation };
  });
}

type JobRow = { status: string; endedBy: string | null; startedAt: Date | null } | null;
const jobOf = (tx: Tx, task: Task): Promise<JobRow> => tx.computerJob.findFirst({ where: { id: task.taskKey, botId: task.botId, personId: task.personId }, select: { status: true, endedBy: true, startedAt: true } });

/** The task ran a computer job for the person: it started and did not fail on our side (a job given back did nothing for them). */
const jobRan = (job: JobRow): job is NonNullable<JobRow> => job !== null && job.startedAt !== null && !givenBackJob(job.status, job.endedBy);
/** That job did not finish: it failed after running (the agent gave up, or it hit its turn cap) or was stopped before it finished (their spending rule, or their own Stop), and its time is the person's like any other run. */
const jobFailed = (job: JobRow): boolean => jobRan(job) && (job?.status === 'failed' || job?.status === 'stopped');

/**
 * What a task came to, from its Instant runs and its computer job if it has one. A job that ran is a step of the task: finished it worked; failed or
 * stopped before it finished (a spending rule, or the person's own Stop) it did not. So a failed job with every App failed is `failed` ("It didn't finish": the computer time
 * is the person's), never done; a job that finished with an App that did not work is partly done. A job that never ran, or failed on our
 * side (`givenBackJob`), did nothing for the person: the Apps alone decide.
 */
const outcomeWithJob = (view: ReturnType<typeof outcomeOfRuns>, job: JobRow): ReceiptOutcome => {
  if (!jobRan(job)) return view.outcome;
  const outcome = outcomeOfActions([...view.actions.map((action) => action.outcome), job.status === 'done' ? 'worked' : 'failed']);
  // Nothing was verified and a job that ran took the person's time: not "nothing taken" (neither refunded nor unconfirmed, both of which are stored as refunded and
  // leave the job's time out of what the task took). The action that could not be confirmed still says so on its own line
  return outcome === 'refunded' || outcome === 'unconfirmed' ? 'failed' : outcome;
};

/** A task with no Instant action that went out and a computer job that is over: the job's own record says how it went. */
const outcomeOfJobAlone = (job: NonNullable<JobRow>): ReceiptOutcome => (jobFailed(job) ? 'failed' : 'done');

/**
 * A receipt that has ended whose runs now say it came to something else is put right from the run records (a run that landed after the word
 * said the task was over): the books already charged what they charged, and the receipt must not say "nothing taken" over it. A receipt that
 * ended before actions were written down (no actions at all) is left as it ended.
 */
async function reconcileEnded(tx: Tx, row: Row, view: ReturnType<typeof outcomeOfRuns>, job: JobRow, now: Date): Promise<ReceiptState> {
  if (row.actions === null) return row.state as ReceiptState;
  const outcome = outcomeWithJob(view, job);
  const same = row.outcome === outcome && JSON.stringify(readActions(row.actions)) === JSON.stringify(view.actions);
  if (same) return row.state as ReceiptState;
  return endReceipt(tx, row, outcome, view.actions, now);
}

/** A receipt that ended while a run of its task has not ended: a newer turn is on it, so it is put back to checking on the next generation. */
async function reopenForOpenRun(tx: Tx, row: Row): Promise<ReceiptState> {
  await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', outcome: null, actions: Prisma.DbNull, endedAt: null, leaseUntil: null, generation: { increment: 1 } } });
  return 'checking';
}

export type Renewed = { ok: true; id: string; state: ReceiptNow; generation: number; leaseUntil: Date | null; renewed: boolean; stale?: true } | { ok: false; reason: 'not_found' };

/**
 * Renews a running receipt's lease: the bot server says the task is alive (a run starts, a turn ends). A renewal for an older generation
 * than the receipt is on changes nothing and answers with the generation it is on, so the bot server can follow it. A receipt that is not running (the
 * sweep ended it after its lease ran out, or the task was closed) is not brought back by a renewal: Orbit puts a receipt back to
 * checking itself, on the next generation, when a run of the task turns up (`settleReceipt`). Safe to say any number of times.
 */
export async function renewReceipt(input: Task & { generation?: number }, now: Date = new Date()): Promise<Renewed> {
  return prisma.$transaction(async (tx) => {
    await receiptLock(tx, input.botId, input.taskKey);
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: input.botId, taskKey: input.taskKey } } });
    if (!row || row.personId !== input.personId) return { ok: false, reason: 'not_found' };
    const id = activityIdOf(row.id);
    const state = row.state as ReceiptNow;
    if (input.generation !== undefined && input.generation < row.generation) return { ok: true, id, state, generation: row.generation, leaseUntil: state === 'running' ? row.leaseUntil : null, renewed: false, stale: true };
    if (row.state !== 'running' || row.leaseUntil === null) return { ok: true, id, state, generation: row.generation, leaseUntil: null, renewed: false };
    const next = leaseFrom(now);
    const leaseUntil = row.leaseUntil.getTime() >= next.getTime() ? row.leaseUntil : next;
    if (leaseUntil !== row.leaseUntil) await tx.taskReceipt.update({ where: { id: row.id }, data: { leaseUntil } });
    return { ok: true, id, state, generation: row.generation, leaseUntil, renewed: true };
  });
}

/**
 * Orbit's own sign of life for a task: one of its runs is about to go out, so a running receipt's lease is extended whether or not the bot
 * server renews it. Under the receipt's lock, so it never overlaps a settlement that read the old lease: either the extension commits first
 * (and the settlement sees a live lease) or the settlement does (and the receipt is no longer running, so nothing is extended). Never throws a person-facing error.
 */
export async function touchLeaseForRun(task: Task, now: Date = new Date()): Promise<void> {
  const next = leaseFrom(now);
  await prisma.$transaction(async (tx) => {
    await receiptLock(tx, task.botId, task.taskKey);
    await tx.taskReceipt.updateMany({ where: { botId: task.botId, personId: task.personId, taskKey: task.taskKey, state: 'running', leaseUntil: { not: null, lt: next } }, data: { leaseUntil: next } });
  });
}

/**
 * Orbit's own word on a task's receipt from what its Instant runs came to. Called when a run ends or is looked up, and by the sweep, so a
 * crash between a run's ending and this, a bot server that went away, or a close that never arrived never leaves one behind. Safe to say
 * twice and any number of times; never asks a person, never calls a model, never starts anything outside.
 *
 * What a task came to is read from the runs' own records (`outcomeOfRuns`), never from the meter's rows. Money shown on the receipt is still
 * read from the books by the task's key.
 *
 *  - Receipt running with its lease still on: left as it is (the task is alive and can make more runs), whatever its runs came to.
 *  - Receipt running with its lease run out: the bot server went quiet. It moves to checking and is settled as below.
 *  - Receipt in checking, a run still open: stays in checking until every run has ended.
 *  - Receipt done or refunded, and a run of the task still open: back to checking on the next generation (the run turned up after the word).
 *  - Every run ended (running with a lapsed lease, checking, or ended): done when all worked, partly done when some did, refunded, nothing
 *    taken, when none did. A refused run never went out and is not an action. A run nobody could vouch for when its wait ended counts as
 *    not worked: the person's favour. A receipt that had ended and does not agree with its runs is put right.
 *  - No Instant run that went out (none at all, or every one refused), running with a lapsed lease, or in checking past the bot server's own retries: refunded, nothing taken (nothing
 *    was ever sent). A model call's row in the books never makes it done. A computer's receipt is read from its job instead: ended when the
 *    job is over, and left alone while it still runs.
 */
export async function settleReceipt(task: Task, now: Date = new Date(), unwatchedBefore: Date | null = null): Promise<ReceiptNow | null> {
  return prisma.$transaction(async (tx) => {
    await receiptLock(tx, task.botId, task.taskKey);
    const row = await tx.taskReceipt.findUnique({ where: { botId_taskKey: { botId: task.botId, taskKey: task.taskKey } } });
    if (!row || row.personId !== task.personId) return null;
    const runs = await runRecordsOf(tx, task);
    const view = outcomeOfRuns(runs);
    const lapsed = leaseLapsed(row, now);
    if (view.open) {
      if (row.state === 'checking') return 'checking';
      if (row.state === 'running') {
        if (!lapsed) return 'running';
        await tx.taskReceipt.update({ where: { id: row.id }, data: { state: 'checking', leaseUntil: null, endedAt: null } });
        return 'checking';
      }
      return reopenForOpenRun(tx, row);
    }
    // A computer's job is its own record, whatever category the receipt was opened under
    const job = await jobOf(tx, task);
    if (view.actions.length > 0) {
      if (isTerminal(row.state)) return reconcileEnded(tx, row, view, job, now);
      // A task whose computer job is still running is not over, whatever its Instant runs came to: it waits (running or checking) for the job, then ends from the runs
      if (job && !isOver(job.status)) return row.state as ReceiptNow;
      // A running receipt on no lease (a computer's) is the job's: with the job over (or no job of that key after a lease's age) it is as good as lapsed
      if (row.state === 'running' && !lapsed && !(row.leaseUntil === null && jobEnded(row, job, now))) return 'running';
      return endReceipt(tx, row, outcomeWithJob(view, job), view.actions, now);
    }
    // No Instant run that went out (none at all, or every one refused before it ran)
    if (isTerminal(row.state)) return row.state as ReceiptState;
    // A receipt waits for its job while it runs, and ends with it (one opened without a category for a job's id is the job's too). A running one
    // with no lease ends when its job is over, or, when no job of that key exists at all, once it is as old as a lease; a checking one, or one
    // whose lease ran out, only after the bot server's own retries.
    if (job && !isOver(job.status)) return row.state as ReceiptNow;
    if (job || row.category === 'computer') {
      const waited = row.state === 'running' ? job !== null || row.startedAt.getTime() + RECEIPT_LEASE_MS <= now.getTime() : unwatchedBefore !== null && row.updatedAt < unwatchedBefore;
      if (!waited) return row.state as ReceiptNow;
      return endReceipt(tx, row, job ? outcomeOfJobAlone(job) : 'refunded', [], now);
    }
    const quiet = row.state === 'running' ? lapsed : unwatchedBefore !== null && row.updatedAt < unwatchedBefore;
    if (!quiet) return row.state as ReceiptNow;
    return endReceipt(tx, row, 'refunded', [], now);
  });
}

/** A running receipt on no lease: its computer job is over, or no job of its key exists after a lease's age (it is the job's own record that says so). */
const jobEnded = (row: Row, job: { status: string } | null, now: Date): boolean => (job ? isOver(job.status) : row.startedAt.getTime() + RECEIPT_LEASE_MS <= now.getTime());

/** How long a receipt in checking with no Instant run waits before it is ended: well past the bot server's own retries (it gives up after 150 s). Internal, not a person-facing limit. */
export const UNWATCHED_CHECKING_WAIT_MS = 15 * 60 * 1000;

/**
 * The sweep over receipts that need an end, oldest first, so none depends on the bot server or on the person writing again:
 *  - running, with a lease that has run out; a computer's running receipt (no lease) once its job is over, or once it is a lease old with no job at all;
 *  - in checking: those with Instant runs once every run has ended, those with none after `UNWATCHED_CHECKING_WAIT_MS`
 *    (a computer's receipt only once its job is over);
 *  - ended, with a run of its task that has not ended (it turned up after the word), or one that ended and the receipt has not recorded (the hook that records it did not finish),
 *    or an action recorded as unknown whose run the provider's log has since confirmed (the receipt is updated in place).
 * Returns how many left `running` or `checking` in this pass.
 */
export async function settleCheckingReceipts(limit: number, now: Date = new Date(), unwatchedWaitMs: number = UNWATCHED_CHECKING_WAIT_MS): Promise<number> {
  const unwatchedBefore = new Date(now.getTime() - unwatchedWaitMs);
  const leaseBefore = new Date(now.getTime() - RECEIPT_LEASE_MS);
  const open = Prisma.raw(RUN_OPEN_STATES.map((state) => `'${state}'`).join(', '));
  const rows = await prisma.$queryRaw<Array<{ botId: string; personId: string; taskKey: string }>>(Prisma.sql`
    SELECT r."bot_id" AS "botId", r."person_id" AS "personId", r."task_key" AS "taskKey"
    FROM task_receipts r
    WHERE (
      (r."state" = 'running' AND r."lease_until" IS NOT NULL AND r."lease_until" <= ${now}
        AND NOT EXISTS (SELECT 1 FROM computer_jobs j WHERE j."id" = r."task_key" AND j."status" NOT IN ('done', 'stopped', 'failed')))
      OR (r."state" = 'running' AND r."category" = 'computer' AND r."lease_until" IS NULL AND (
        EXISTS (SELECT 1 FROM computer_jobs j WHERE j."id" = r."task_key" AND j."status" IN ('done', 'stopped', 'failed'))
        OR (r."started_at" <= ${leaseBefore} AND NOT EXISTS (SELECT 1 FROM computer_jobs j WHERE j."id" = r."task_key"))))
      OR (r."state" = 'checking' AND (
        (r."updated_at" < ${unwatchedBefore}
          AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key")
          AND NOT EXISTS (SELECT 1 FROM computer_jobs j WHERE j."id" = r."task_key" AND j."status" NOT IN ('done', 'stopped', 'failed')))
        OR (EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key") AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" IN (${open}))
          AND NOT EXISTS (SELECT 1 FROM computer_jobs j WHERE j."id" = r."task_key" AND j."status" NOT IN ('done', 'stopped', 'failed')))
      ))
      OR (r."state" IN ('done', 'refunded') AND (
        EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" IN (${open}))
        -- A run that went out and ended, and is not among the actions the receipt recorded: it landed after the word and the hook that records it did not finish (a retry of the same work, never a new action)
        -- (A receipt that ended before this existed has no actions written down at all: it is left as it ended, never judged afresh.)
        OR (r."actions" IS NOT NULL AND EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" <> 'refused' AND i."state" NOT IN (${open})
          AND NOT (r."actions" @> jsonb_build_array(jsonb_build_object('run', i."id")))))
        -- An action recorded as unknown whose run has since been confirmed either way by the provider's own log: the same receipt is put right (a later confirmed success updates it, and what the person was charged stays the run's own)
        OR (r."actions" @> jsonb_build_array(jsonb_build_object('outcome', 'unknown')) AND EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key"
          AND i."state" = 'failed' AND i."reason" = 'unclear' AND i."detail"->'lateEvidence'->>'status' IN ('success', 'failed')
          AND r."actions" @> jsonb_build_array(jsonb_build_object('run', i."id", 'outcome', 'unknown'))))
      ))
    )
    ORDER BY COALESCE(r."lease_until", r."updated_at") ASC
    LIMIT ${limit}`);
  let settled = 0;
  for (const row of rows) {
    const state = await settleReceipt(row, now, unwatchedBefore).catch((error) => {
      console.error('[Receipts] Could not settle a receipt:', error instanceof Error ? error.message : 'unknown');
      return null;
    });
    if (state && state !== 'checking' && state !== 'running') settled += 1;
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
  outcome: ReceiptOutcome | null;
  actions: ReceiptAction[];
  /**
   * How the task's computer job came out, when one ran for the person: the agent finished it (`worked`), gave up (`failed`), it was stopped before it finished (`stopped`), or it
   * failed on our side so none of its cost is the person's (`returned`). None when no job ran.
   */
  job: 'worked' | 'failed' | 'stopped' | 'returned' | null;
  /** Why a stopped job stopped (the job's own `ended_by`: rule, person, allowance, pool). */
  stoppedBy: string | null;
  /** What became of a computer cost that was given back: what the books acknowledged giving back, and what they still owe the person. */
  refund: { returnedMicros: number; pendingMicros: number };
  /** Orbit has not decided yet whether the failed job's cost is given back (the person is charged provisionally): an outside effect still to confirm, or limits missing. */
  deciding: 'effect' | 'limits' | null;
  /** The computer was given back because it could not reach our own model service (Orbit's decision names that reason): said as that, never as a problem with the work. */
  unreachable?: boolean;
  /** Runs of the task nobody could confirm whose credit is still on hold. */
  heldRuns: ReadonlySet<string>;
  /** Runs of the task nobody could confirm whose hold the credit books acknowledged giving back, and how much came back (whole micros). */
  releasedRuns: ReadonlyMap<string, number>;
  /** Runs of the task that were let go unconfirmed (the run's own state says so: its reason is `unclear`), whatever late evidence says its action did: such a run is never charged, now or later. */
  letGoRuns: ReadonlySet<string>;
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
  outcome: row.outcome as ReceiptOutcome | null,
  actions: readActions(row.actions),
  job: null,
  stoppedBy: null,
  refund: { returnedMicros: 0, pendingMicros: 0 },
  deciding: null,
  heldRuns: new Set<string>(),
  releasedRuns: new Map<string, number>(),
  letGoRuns: new Set<string>(),
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
    prisma.$queryRaw<Array<{ kind: string; route: string | null; payerKind: string | null; quantity: bigint; costMicros: bigint | null; detail: unknown; jobId: string | null; botId: string | null }>>(Prisma.sql`
    SELECT "kind", "route", "payer_kind" AS "payerKind", "quantity", "cost_micros" AS "costMicros", "detail", "job_id" AS "jobId", "bot_id" AS "botId"
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
      mine.map((row) => ({ kind: row.kind, route: row.route, payerKind: row.payerKind, quantity: Number(row.quantity), costMicros: row.costMicros === null ? null : Number(row.costMicros), detail: row.detail })),
    );
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * How a task reads at the time of reading. A computer job that ran is a step of the task, read from the job's own record (so a receipt that
 * was settled before this existed, or before the job's last word, is still put right):
 *  - a job that failed (the agent gave up) with nothing else that worked is `failed`, never done; one stopped before it finished is `stopped` (a spending rule or their own
 *    Stop: starting a computer is not proof it finished); one that failed on our side is a step that did not work whose cost is the books' to give back;
 *  - nothing verified and the computer's cost owed back but not acknowledged by the books is `refund_pending`, never refunded;
 *  - nothing verified and Orbit still deciding whether to give the cost back is `deciding`.
 * Without a job, the stored outcome stands (a state put right at read time, refunded, wins over it).
 */
function outcomeOfHeader(header: Header): ActivityOutcome {
  // Nothing was taken: refunded, or (when nobody could confirm an action) said as that, never as a failure
  // (a job our own pool cut off, whose time was given back, is still a stopped job: said as that, with its time given back)
  if (header.state === 'refunded') return header.outcome === 'unconfirmed' ? 'unconfirmed' : header.job === 'returned' && header.stoppedBy === 'pool' ? 'stopped' : 'refunded';
  const pending = header.refund.pendingMicros > 0;
  if (header.job !== null) {
    const outcome = outcomeOfActions([...header.actions.map((action) => action.outcome), header.job === 'worked' ? 'worked' : 'failed']);
    if (outcome === 'refunded' || outcome === 'unconfirmed') {
      // Nothing was verified. A cost given back is the books' to say: refunded only once they acknowledged it, and never while Orbit is still deciding
      if (header.job === 'returned') return pending ? 'refund_pending' : header.stoppedBy === 'pool' && outcome === 'refunded' ? 'stopped' : outcome === 'refunded' ? 'failed' : outcome;
      if (header.job === 'stopped') return 'stopped';
      return header.deciding !== null ? 'deciding' : 'failed';
    }
    return outcome;
  }
  return header.outcome === 'partial' || header.outcome === 'failed' || header.outcome === 'unconfirmed' ? header.outcome : 'done';
}

function itemOf(header: Header, events: readonly LineEvent[], botName: string, readerId: string): ActivityItem {
  const who = paidBy(header.payer, readerId);
  // A hold is pending for any run whose credit is still on hold and that was let go unconfirmed (or whose action did not work), whatever its action says now: late evidence, that
  // it failed or that it worked, does not give the credit back, only the books do. `heldRuns` holds exactly those runs
  const holdPending = header.actions.some((action) => header.heldRuns.has(action.run));
  const stated = outcomeOfHeader(header);
  // "Refunded, nothing taken" is not said while a hold is still on: it reads as not finished (with the release wording) until the books acknowledge the release
  const outcome: ActivityOutcome = holdPending && stated === 'refunded' ? 'failed' : stated;
  // The computer's line says what became of a cost that was given back: "Refund pending" until the books acknowledge it, then "Given back"
  const lines = withComputerRefund(receiptLines(events, botName), header.refund);
  // Once the books acknowledged giving a hold back, the amount that came back is said (never before: a hold still on is "being released")
  const releasedOf = (run: string): number => header.releasedRuns.get(run) ?? 0;
  const releasedMicros = holdPending ? 0 : header.actions.reduce((sum, action) => (action.outcome === 'unknown' || (action.outcome === 'worked' && header.letGoRuns.has(action.run)) ? sum + releasedOf(action.run) : sum), 0);
  const computerMicros = header.job === null || header.job === 'returned' ? undefined : (computerTakenOf(events) ?? null);
  // What the person pays net of anything given back, said once it is settled: never while a refund is pending (their credit is not back yet)
  const spent = header.refund.pendingMicros > 0 ? null : spentOf(header.state, header.chargedMicros, lines);
  const appCharges = header.job === null ? [] : header.actions.filter((action) => action.outcome === 'worked' && !header.letGoRuns.has(action.run)).map((action) => ({ label: action.label, micros: takenForRun(events, action.run), ...(settlingForRun(events, action.run) ? { settling: true } : {}) }));
  const facts: NoteFacts = {
    ...(header.job === null ? {} : { job: header.job, ...(computerMicros === undefined ? {} : { computerMicros }) }),
    holdPending,
    ...(releasedMicros > 0 ? { releasedMicros } : {}),
    ...(header.refund.returnedMicros > 0 ? { returnedMicros: header.refund.returnedMicros } : {}),
    ...(header.refund.pendingMicros > 0 ? { refundPendingMicros: header.refund.pendingMicros } : {}),
    ...(header.deciding === null ? {} : { deciding: header.deciding }),
    ...(header.job === 'returned' && header.unreachable ? { unreachable: true } : {}),
    ...(header.stoppedBy === null ? {} : { stoppedBy: header.stoppedBy }),
    ...(appCharges.length > 0 ? { appCharges } : {}),
    ...(spent !== null ? { netMicros: spent } : {}),
  };
  return {
    id: header.id,
    title: header.title,
    at: header.at.toISOString(),
    // An unconfirmed action's credit still on hold is not given back yet: the task is not shown as refunded until it is. A cost still owed back is not refunded either
    state: (holdPending || header.refund.pendingMicros > 0) && header.state === 'refunded' ? 'done' : header.state,
    // `state` stays done for a task that partly worked or that took something and did not finish; a state put right at read time wins over the stored outcome
    outcome,
    outcomeText: outcomeTextOf(outcome, { stoppedBy: header.stoppedBy, refundPendingMicros: header.refund.pendingMicros, givenBack: header.job === 'returned' }),
    outcomeNote: outcomeNote(outcome, header.actions, facts),
    actions: header.actions.map((action): ActivityAction => {
      // A run let go unconfirmed was never charged and is never charged later (its hold goes back whatever late evidence says), so a worked action on it shows no amount taken: its hold wording
      // comes from the run's own money state, not from what the action says now. An ordinary worked run shows what the books took (or settlement pending), as ever
      const letGo = header.letGoRuns.has(action.run);
      const held = header.heldRuns.has(action.run);
      const taken = action.outcome === 'worked' && !letGo ? takenForRun(events, action.run) : null;
      const wasReleased = (action.outcome === 'unknown' || (action.outcome === 'worked' && letGo)) && !held && header.releasedRuns.has(action.run);
      const released = wasReleased ? releasedOf(action.run) : 0;
      const takenText = held ? HOLD_BEING_RELEASED : released > 0 || (action.outcome === 'worked' && wasReleased) ? HOLD_RELEASED : action.outcome === 'worked' ? null : NOTHING_TAKEN;
      return { label: action.label, outcome: action.outcome, text: actionWords(action.label, action.outcome), takenText, ...(taken === null ? {} : { amountMicros: taken }), ...(released > 0 ? { releasedMicros: released } : {}) };
    }),
    spentMicros: spent,
    ...(header.refund.returnedMicros > 0 && header.refund.pendingMicros === 0 ? { returnedMicros: header.refund.returnedMicros } : {}),
    ...(header.refund.pendingMicros > 0 ? { refundPendingMicros: header.refund.pendingMicros } : {}),
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
 * that went out (a refused one went nowhere) and nothing charged in the books for its key or its run (a call whose cost is not known is not "nothing charged":
 * it stays, as the Costs report counts it unpriced, never hidden as free). Every request of it was refused before it ran (a rule, no
 * credit, not offered) or never arrived, so nothing happened and nothing was taken, and there is nothing for the person to read or act on.
 */
async function receiptsNewest(personId: string, limit: number): Promise<ReceiptRow[]> {
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r."id" FROM task_receipts r
    WHERE r."person_id" = ${personId} AND r."state" NOT IN ('running', 'checking')
      AND NOT (
        r."state" = 'refunded' AND COALESCE(r."category", '') = 'apps'
        AND NOT EXISTS (SELECT 1 FROM instant_runs i WHERE i."bot_id" = r."bot_id" AND i."person_id" = r."person_id" AND i."task_key" = r."task_key" AND i."state" <> 'refused')
        AND NOT EXISTS (SELECT 1 FROM meter_events m WHERE m."bot_id" = r."bot_id" AND (m."kind" <> 'model_call' OR m."cost_micros" IS NULL OR m."cost_micros" > 0) AND (
          m."job_id" = r."task_key"
          OR (m."job_id" IS NULL AND m."detail"->>'taskKey' = r."task_key")
          -- A charged use made under the task's run that names no task of its own is shown on a receipt of that run (see eventsFor): never hide it. Uncharged lines (the Brick's own thinking) are not money taken.
          OR (m."job_id" IS NULL AND r."run_id" IS NOT NULL AND m."detail"->>'runId' = r."run_id" AND m."detail"->>'taskKey' IS NULL AND ((m."kind" = 'app_use' AND m."route" = 'instant') OR m."kind" = 'computer_time')
            -- ...only on the receipt that owns the run's own events: the first one opened for it, as eventsFor says
            AND NOT EXISTS (SELECT 1 FROM task_receipts o WHERE o."bot_id" = r."bot_id" AND o."run_id" = r."run_id" AND (o."started_at" < r."started_at" OR (o."started_at" = r."started_at" AND o."id" < r."id"))))
        ))
      )
    ORDER BY COALESCE(r."ended_at", r."started_at") DESC, r."id" DESC
    LIMIT ${limit}`);
  if (ids.length === 0) return [];
  // The state is checked again as the rows are read: a receipt that moved to checking between the two reads is not listed (it is under investigation)
  const rows = await prisma.taskReceipt.findMany({ where: { id: { in: ids.map((row) => row.id) }, state: { notIn: ['running', 'checking'] } } });
  const order = new Map(ids.map((row, index) => [row.id, index]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** What the books say became of a computer job's cost, per job: what was acknowledged given back, what is still owed, and whether Orbit is still deciding. */
interface ComputerMoney {
  returnedMicros: number;
  pendingMicros: number;
  deciding: 'effect' | 'limits' | null;
  /** Orbit's decision gave the job back because the computer could not reach our own service. */
  unreachable: boolean;
}

/**
 * Reads, for the computer jobs of a list, the money states a receipt must not say "refunded" over before they are true: what the books gave back and what they still owe for a job
 * that failed on our side (`refundStatesFor`: the refund obligations and the settled credit holds), and the give-back decision of a failed job that is still `pending` (an outside effect to confirm, or limits missing:
 * the person is charged provisionally and Orbit is still deciding). Reads only.
 */
async function computerMoneyOf(jobs: readonly { id: string; given: boolean }[]): Promise<Map<string, ComputerMoney>> {
  const out = new Map<string, ComputerMoney>();
  if (jobs.length === 0) return out;
  const givenIds = jobs.filter((job) => job.given).map((job) => job.id);
  const [refunds, decisions, reached] = await Promise.all([
    refundStatesFor(givenIds),
    prisma.computerGiveBackDecision.findMany({ where: { jobId: { in: jobs.map((job) => job.id) }, state: 'pending' }, select: { jobId: true, basis: true } }),
    givenIds.length === 0 ? [] : prisma.computerGiveBackDecision.findMany({ where: { jobId: { in: givenIds }, state: 'given', reason: RELAY_UNREACHABLE }, select: { jobId: true } }),
  ]);
  const entry = (id: string): ComputerMoney => {
    let found = out.get(id);
    if (!found) {
      found = { returnedMicros: 0, pendingMicros: 0, deciding: null, unreachable: false };
      out.set(id, found);
    }
    return found;
  };
  for (const [id, state] of refunds) Object.assign(entry(id), state);
  for (const decision of decisions) entry(decision.jobId).deciding = decision.basis === 'effect_unresolved' ? 'effect' : 'limits';
  for (const decision of reached) entry(decision.jobId).unreachable = true;
  return out;
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
      outcome: null,
      actions: [],
      job: null,
      stoppedBy: null,
      refund: { returnedMicros: 0, pendingMicros: 0 },
      deciding: null,
      heldRuns: new Set<string>(),
      releasedRuns: new Map<string, number>(),
      letGoRuns: new Set<string>(),
    }));
  const all = [...headers, ...computerHeaders];
  const [events, bots] = await Promise.all([eventsFor(all), prisma.bot.findMany({ where: { id: { in: [...new Set(all.map((header) => header.botId))] } }, select: { id: true, name: true } })]);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  // Failed on our side: the same endings `recordComputerTime` gives back
  // (by bot and task key: a job with a receipt of its own is shown as that receipt, whose id is not the job's)
  // The jobs behind the selected receipts too: the receipts and the jobs are each cut to the newest few on their own, so a receipt can be kept
  // while its job is not among the newest jobs
  const listedJobIds = new Set(jobs.map((job) => job.id));
  const receiptJobKeys = rows.map((row) => row.taskKey).filter((key) => !listedJobIds.has(key));
  const behindReceipts = receiptJobKeys.length === 0 ? [] : await prisma.computerJob.findMany({ where: { personId, id: { in: receiptJobKeys } }, select: { id: true, botId: true, status: true, endedBy: true, startedAt: true } });
  const jobRows = new Map([...jobs, ...behindReceipts].map((job) => [`${job.botId}:${job.id}`, job]));
  const failedJobs = new Set([...jobRows.values()].filter((job) => givenBackJob(job.status, job.endedBy)).map((job) => `${job.botId}:${job.id}`));
  const computerMoney = await computerMoneyOf([...jobRows.values()].map((job) => ({ id: job.id, given: givenBackJob(job.status, job.endedBy) })));
  // Runs of these tasks whose credit is on hold or was given back and that were let go unconfirmed, or did not work (nobody could confirm them, or later evidence said they failed): said as
  // a hold being released, or released, not as a charge or as "nothing taken", until the books acknowledge the release. A run let go unconfirmed (its own reason is `unclear`) keeps that
  // wording when late evidence says it WORKED too: it was never charged and never will be. An ordinary run that worked is not one of these, and waits for its settlement as ever
  const actionOutcomeOf = new Map(all.flatMap((header) => header.actions.map((action) => [action.run, action.outcome] as const)));
  const money = actionOutcomeOf.size === 0 ? [] : await prisma.instantRun.findMany({ where: { id: { in: [...actionOutcomeOf.keys()] }, customerState: { in: ['held', 'released'] } }, select: { id: true, customerState: true, holdMicros: true, reason: true, state: true } });
  const moneyRows = money.filter((run) => actionOutcomeOf.get(run.id) !== 'worked' || isUnconfirmedRun(run));
  const letGo = new Set(money.filter((run) => isUnconfirmedRun(run)).map((run) => run.id));
  const held = new Set(moneyRows.filter((run) => run.customerState === 'held').map((run) => run.id));
  const released = new Map(moneyRows.filter((run) => run.customerState === 'released').map((run) => [run.id, Number(run.holdMicros)] as const));
  const items = all.map((header) => {
    const forHeader = events.get(header.id) ?? [];
    // A computer job that failed is "refunded, nothing taken" only when the books show nothing was taken: a price not known yet is not "nothing"
    // (the platform's model calls count too: one still written against the person is something taken; a call on their own key never was)
    const money = computerMoney.get(header.taskKey);
    const mayHaveTaken =
      forHeader.some(
        (event) =>
          ((event.kind === 'computer_time' && !givenBackTime(event)) || (event.kind === 'model_call' && event.payerKind === 'universe' && !givenBackCall(event))) &&
          (event.costMicros === null || event.costMicros > 0),
      ) ||
      // An App's charge is something taken however the computer ended: a Gmail that went out and was charged is never hidden behind a refunded computer. A price not known yet is not "nothing"
      forHeader.some((event) => event.kind === 'app_use' && event.route === 'instant' && (instantTaken(event) === null || (instantTaken(event) ?? 0) > 0)) ||
      // A cost owed back and not acknowledged by the books is still on the person: it is not refunded until they say so
      (money?.pendingMicros ?? 0) > 0;
    // A receipt already stored as refunded does not hold either while something is still on the person: until it is given back it reads as done
    const key = `${header.botId}:${header.taskKey}`;
    const failed = failedJobs.has(key);
    // An App that WORKED (verified by its own run, and not one let go unconfirmed) is work the person has whatever it took: a Gmail that went out for nothing (a zero charge, or a hold the books gave back)
    // keeps the task partly done beside a computer that was given back. Verified work is looked at on its own, apart from what is still payable, before a task is called refunded
    const verifiedWork = header.actions.some((action) => action.outcome === 'worked' && !letGo.has(action.run));
    const state: ReceiptState = failed ? (!mayHaveTaken && !verifiedWork ? 'refunded' : header.state === 'refunded' ? 'done' : header.state) : header.state;
    const jobRow = jobRows.get(key) ?? null;
    // A job still going has not come out yet; one that never started did nothing
    const over = jobRow !== null && isOver(jobRow.status) && jobRow.startedAt !== null;
    const job: Header['job'] = !over ? null : givenBackJob(jobRow.status, jobRow.endedBy) ? 'returned' : jobRow.status === 'failed' ? 'failed' : jobRow.status === 'stopped' ? 'stopped' : 'worked';
    return itemOf({ ...header, state, job, stoppedBy: jobRow?.status === 'stopped' ? jobRow.endedBy ?? null : null, refund: job === 'returned' ? { returnedMicros: money?.returnedMicros ?? 0, pendingMicros: money?.pendingMicros ?? 0 } : { returnedMicros: 0, pendingMicros: 0 }, deciding: job === 'failed' ? money?.deciding ?? null : null, unreachable: job === 'returned' && money?.unreachable === true, heldRuns: new Set(header.actions.filter((action) => held.has(action.run)).map((action) => action.run)), releasedRuns: new Map(header.actions.filter((action) => released.has(action.run)).map((action) => [action.run, released.get(action.run) as number] as const)), letGoRuns: new Set(header.actions.filter((action) => letGo.has(action.run)).map((action) => action.run)) }, forHeader, names.get(header.botId) ?? 'Brick', personId);
  });
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)).slice(0, limit);
}
