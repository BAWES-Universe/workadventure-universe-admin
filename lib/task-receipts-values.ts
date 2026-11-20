/**
 * What one task's receipt says (paying spec 3, part O4): one line for each task in Activity, and on tap what it used and who paid.
 * Written from what the meter's books recorded for the task, never from anything anybody said, and in plain words: Apps, computer,
 * Universe AI. This file is only the words and the sums; lib/task-receipts.ts reads the books.
 */

import { HOLD_BEING_RELEASED, SETTLEMENT_PENDING } from '@/lib/task-receipt-words';

export type ReceiptState = 'done' | 'refunded' | 'checking';
/**
 * How a task came to end, from what its actions and its computer job came to.
 *  - done: everything worked. partial: a verified step worked and another did not, or could not be confirmed.
 *  - failed: nothing was verified and something was taken for it (a computer job that ran and failed): "It didn't finish", with what was taken.
 *  - unconfirmed: nothing was verified and at least one action could not be confirmed (its delivery is unknown).
 *  - refunded: nothing worked and nothing was taken. A task that is not over has none.
 */
export type ReceiptOutcome = 'done' | 'partial' | 'refunded' | 'failed' | 'unconfirmed';
/**
 * What Activity says a task came to at the time of reading: the stored outcome, or one read from what is true now.
 *  - stopped: a computer job was stopped before it finished (at the person's spending rule, or by them): starting a computer is not proof it finished.
 *  - deciding: nothing was verified and Orbit is still deciding whether the computer's cost is given back (the person is charged provisionally meanwhile).
 *  - refund_pending: the computer's cost is owed back and the books have not acknowledged it yet ("$0.03 refund pending"), so it is not "refunded" yet.
 */
export type ActivityOutcome = ReceiptOutcome | 'stopped' | 'deciding' | 'refund_pending';
/**
 * How one Instant action of a task ended: it worked (the run's own record says so, or the provider's log confirmed it later), it did not
 * (the provider said so), or `unknown`: nobody could confirm whether it went out. An unknown action is never called a failure, and what
 * was taken for it is its own record's to say.
 */
export type ActionOutcome = 'worked' | 'failed' | 'unknown';
export const ACTION_OUTCOMES: readonly ActionOutcome[] = ['worked', 'failed', 'unknown'];
export const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = ['done', 'partial', 'refunded', 'failed', 'unconfirmed'];

/** What a receipt keeps of each Instant action: the run, the App it was for, and how it ended. Never what was asked or answered. */
export interface ReceiptAction {
  run: string;
  label: string;
  outcome: ActionOutcome;
}

/** The states of an Instant run that has not ended: still going out, or its answer did not come back and nobody can say whether it ran. */
export const RUN_OPEN_STATES = ['reserving', 'held', 'sent', 'ambiguous'] as const;

/** The part of an Instant run's record a receipt reads. `reason` and `detail` only say whether an ended run was one nobody could confirm, and whether the provider's log confirmed it later. */
export interface RunRecord {
  id: string;
  state: string;
  toolkit: string;
  reason?: string | null;
  detail?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the provider's own log said of a run that was let go unconfirmed, when it turned up later (the executor writes it on the run as `detail.lateEvidence`). */
export function lateEvidenceOf(detail: unknown): 'success' | 'failed' | null {
  if (!isObject(detail) || !isObject(detail.lateEvidence)) return null;
  return detail.lateEvidence.status === 'success' ? 'success' : detail.lateEvidence.status === 'failed' ? 'failed' : null;
}

/** How an ended run's action came out, from the run's own record. */
export function actionOutcomeOfRun(run: Pick<RunRecord, 'state' | 'reason' | 'detail'>): ActionOutcome {
  if (run.state === 'succeeded') return 'worked';
  // A run let go unconfirmed: the provider's log, found later, is what settles it (a success updates the action; a failure is a failure)
  if (run.reason === 'unclear') {
    const late = lateEvidenceOf(run.detail);
    return late === 'success' ? 'worked' : late === 'failed' ? 'failed' : 'unknown';
  }
  return 'failed';
}

/** What a set of steps came to: all worked is done; some worked and some not is partial; none worked is unconfirmed when any could not be confirmed, else refunded (nothing taken: a caller that knows something was taken says failed). */
export function outcomeOfActions(steps: readonly ActionOutcome[]): ReceiptOutcome {
  const worked = steps.filter((step) => step === 'worked').length;
  if (worked === steps.length && steps.length > 0) return 'done';
  if (worked > 0) return 'partial';
  return steps.some((step) => step === 'unknown') ? 'unconfirmed' : 'refunded';
}

/**
 * What a task's Instant runs came to, read from the runs' own final states and nothing else (never from the books' meter rows: a model
 * call's row is not proof that an App worked).
 *  - `open`: a run has not ended, so the task cannot be settled yet.
 *  - A refused run never went out (a rule, no credit, not offered, or it crashed before sending), so it is not an action of the task.
 *  - A succeeded run worked; a failed one did not; one nobody could confirm (and the provider's log has not said since) is unknown.
 *  - See `outcomeOfActions` for what they add up to. A computer job the task ran is added by the caller (`outcomeWithJob` in task-receipts.ts).
 */
export function outcomeOfRuns(runs: readonly RunRecord[]): { open: boolean; outcome: ReceiptOutcome; actions: ReceiptAction[] } {
  const open = runs.some((run) => (RUN_OPEN_STATES as readonly string[]).includes(run.state));
  const actions = runs
    .filter((run) => run.state !== 'refused' && !(RUN_OPEN_STATES as readonly string[]).includes(run.state))
    .map((run): ReceiptAction => ({ run: run.id, label: run.toolkit, outcome: actionOutcomeOfRun(run) }));
  return { open, outcome: outcomeOfActions(actions.map((action) => action.outcome)), actions };
}

/**
 * The receipt's state for an outcome: refunded when nothing was taken (none worked and nothing was charged: refunded, or nobody could confirm
 * it and its hold is given back); done for everything else, since something worked or something was taken.
 */
export const stateOfOutcome = (outcome: ReceiptOutcome): 'done' | 'refunded' => (outcome === 'refunded' || outcome === 'unconfirmed' ? 'refunded' : 'done');

/** Reads the actions a receipt stored back, dropping anything that is not the shape written. */
export function readActions(value: unknown): ReceiptAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReceiptAction[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { run, label, outcome } = entry as Record<string, unknown>;
    return typeof run === 'string' && typeof label === 'string' && (ACTION_OUTCOMES as readonly unknown[]).includes(outcome) ? [{ run, label, outcome: outcome as ActionOutcome }] : [];
  });
}
export type ReceiptCategory = 'apps' | 'computer';

/** One line of "what it used". `amountMicros` is what it took from credit; empty when it took none or the price is not known yet (the note says which). */
export interface ReceiptLine {
  label: string;
  amountMicros?: number;
  note?: string;
  /** On the computer's line when its cost was given back and the books acknowledged it: what came back, in whole micros. */
  returnedMicros?: number;
}

/** The part of a meter event a line is made from. */
export interface LineEvent {
  kind: string;
  route: string | null;
  /** Who paid, when the books say ('universe' is the platform); a call on someone's own key is not the platform's. */
  payerKind?: string | null;
  quantity: number;
  costMicros: number | null;
  detail: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A computer's time that was given back: the job failed on our side, so none of it was taken from the person. */
export const givenBackTime = (event: Pick<LineEvent, 'kind' | 'detail'>): boolean => event.kind === 'computer_time' && isRecord(event.detail) && event.detail.givenBack === true;

/** A model call the platform paid for that was given back: written against nobody because its job failed on our side. */
export const givenBackCall = (event: Pick<LineEvent, 'kind' | 'detail'>): boolean => event.kind === 'model_call' && isRecord(event.detail) && event.detail.givenBack === true;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/**
 * What an Instant use took from the person's credit. The executor's own record of a run carries two figures: the provider's charge to us
 * (`costMicros`) and what the person was charged (`detail.customerMicros`); only the second is theirs, and a run whose charge is not known
 * yet has none. A use recorded without the executor's mark is read by its cost as before.
 */
export function instantTaken(event: LineEvent): number | null {
  if (isRecord(event.detail) && event.detail.instant === true) return typeof event.detail.customerMicros === 'number' ? event.detail.customerMicros : null;
  return event.costMicros;
}

/**
 * What one Instant run took from the person, read from that run's own meter event (by the run's id): its charge when the books know it
 * (a failed run released its hold, so zero), null when there is no record of it yet or its price is not known yet. Never guessed.
 */
export function takenForRun(events: readonly LineEvent[], runId: string): number | null {
  const found = events.find((event) => event.kind === 'app_use' && event.route === 'instant' && isRecord(event.detail) && event.detail.runId === runId);
  return found ? instantTaken(found) : null;
}

/** The name of an App an Instant use was for, when the event carries it. Only a short name; never anything a person wrote. */
function appName(detail: unknown): string | null {
  const app = isRecord(detail) && typeof detail.app === 'string' ? detail.app.trim() : '';
  return app && app.length <= 40 ? app : null;
}

/** What the model's own thinking ran on, for the note. */
const thinkingOn = (route: string | null): string => (route === 'own-key' ? 'Your own key' : 'Universe AI');

interface Group {
  order: number;
  label: string;
  micros: number;
  unpriced: boolean;
  /** An Instant run whose charge the credit books have not acknowledged yet: it may already have been debited, so it is "settlement pending", not a price nobody knows. */
  settling?: boolean;
  /** An Instant run that failed or could not be confirmed and whose hold is still reserved: it is being released. */
  releasing?: boolean;
  priced: boolean;
  charged: boolean;
  note?: string;
}

/**
 * The computer's line of a receipt, once it is known what became of a cost that was given back. A cost the books have not yet acknowledged giving back is
 * "Refund pending", never "Nothing": the credit is not back until they say so. One that came back says so and what came back. Any other line is left as it is.
 */
export function withComputerRefund(lines: readonly ReceiptLine[], refund: { returnedMicros: number; pendingMicros: number }): ReceiptLine[] {
  return lines.map((line) => {
    if (!line.label.startsWith('Computer') || line.amountMicros !== undefined || line.note !== 'Nothing') return line;
    if (refund.pendingMicros > 0) return { label: line.label, note: 'Refund pending' };
    if (refund.returnedMicros > 0) return { label: line.label, note: 'Returned', returnedMicros: refund.returnedMicros };
    return line;
  });
}

/**
 * What the computer's time took from the person for a task, in whole micros: undefined when no time was written against them (none booked,
 * or all of it given back), null while any of it has no price yet (never a made-up total).
 */
export function computerTakenOf(events: readonly LineEvent[]): number | null | undefined {
  const mine = events.filter((event) => event.kind === 'computer_time' && !givenBackTime(event));
  if (mine.length === 0) return undefined;
  if (mine.some((event) => event.costMicros === null)) return null;
  return mine.reduce((sum, event) => sum + (event.costMicros ?? 0), 0);
}

/**
 * The lines of a receipt, in a fixed order (Instant, computer, Apps you connected, the Brick's own thinking, speaking), one line
 * for each kind of thing, with counts and amounts added up. A use with no price known is said plainly ("Price not known yet"), never as 0.
 * Sizes of disks and other bookkeeping are not part of a task and are left out.
 */
export function receiptLines(events: readonly LineEvent[], botName: string): ReceiptLine[] {
  const groups = new Map<string, Group & { count: number; seconds: number }>();
  const group = (key: string, order: number, label: string, charged: boolean) => {
    let found = groups.get(key);
    if (!found) {
      found = { order, label, micros: 0, unpriced: false, priced: false, charged, count: 0, seconds: 0 };
      groups.set(key, found);
    }
    return found;
  };
  for (const event of events) {
    if (event.kind === 'app_use' && event.route === 'instant') {
      const name = appName(event.detail);
      const label = name ? `Instant ${name}` : 'Instant Apps';
      const taken = instantTaken(event);
      if (taken === null) {
        const detail = isRecord(event.detail) ? event.detail : {};
        if (detail.instant !== true || event.costMicros === null) {
          const found = group(`instant:${name ?? ''}`, 0, label, true);
          found.count += event.quantity;
          found.unpriced = true;
        } else {
          // A run whose hold is being given back (it failed, or could not be confirmed) and a run whose charge the books have not acknowledged are two different
          // things the person is waiting on, so they are two lines: one never hides the other (the second may already have been debited)
          const releasing = detail.unconfirmed === true || detail.state === 'failed';
          const found = group(`instant:${name ?? ''}:${releasing ? 'releasing' : 'settling'}`, 0, label, true);
          found.count += event.quantity;
          if (releasing) found.releasing = true;
          else found.settling = true;
        }
      } else {
        const found = group(`instant:${name ?? ''}`, 0, label, true);
        found.count += event.quantity;
        found.micros += taken;
        found.priced = true;
      }
    } else if (event.kind === 'computer_time') {
      // Time of a job that failed on our side: shown, but never taken from the person (it was written against nobody)
      const found = group('computer', 1, 'Computer', !givenBackTime(event));
      found.seconds += event.quantity;
      if (givenBackTime(event)) continue;
      if (event.costMicros === null) found.unpriced = true;
      else {
        found.micros += event.costMicros;
        found.priced = true;
      }
    } else if (event.kind === 'app_use') {
      const found = group('app', 2, 'Apps you connected', false);
      found.count += event.quantity;
    } else if (event.kind === 'model_call') {
      const found = group(`thinking:${thinkingOn(event.route)}`, 3, `${botName}'s own thinking`, false);
      found.note = thinkingOn(event.route);
    } else if (event.kind === 'speech') {
      const found = group(`speech:${thinkingOn(event.route)}`, 4, 'Speaking', false);
      found.note = thinkingOn(event.route);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((found): ReceiptLine => {
      let label = found.label;
      if (found.count > 0) label = `${label}, ${plural(found.count, 'use', 'uses')}`;
      if (found.seconds > 0) label = `${label}, ${found.seconds >= 3600 ? plural(Math.round(found.seconds / 3600), 'hour', 'hours') : plural(Math.max(1, Math.round(found.seconds / 60)), 'minute', 'minutes')}`;
      if (!found.charged) return found.note ? { label, note: found.note } : { label, note: 'Nothing' };
      // What it took from credit: the known part, and when some use has no price yet, that is said and no total is made up
      if (found.unpriced) return { label, note: 'Price not known yet' };
      if (found.releasing) return { label, note: HOLD_BEING_RELEASED };
      if (found.settling) return { label, note: SETTLEMENT_PENDING };
      return found.priced ? { label, amountMicros: found.micros } : { label, note: 'Nothing' };
    });
}

/**
 * What a task took from credit, in whole micros, or null when nothing was taken or it cannot be known yet. The receipt's own figure
 * (set when the task settled) wins; otherwise the charged lines added up, and only when every one of them has a price.
 */
export function spentOf(state: ReceiptState, chargedMicros: number | null, lines: readonly ReceiptLine[]): number | null {
  if (state === 'refunded') return null;
  // What the books recorded decides, so the total always agrees with the lines under it. A charge the caller sent only stands in when the
  // books give no total (nothing recorded yet, or a price not known yet)
  const charged = lines.filter((line) => line.amountMicros !== undefined || line.note === 'Price not known yet' || line.note === SETTLEMENT_PENDING || line.note === HOLD_BEING_RELEASED);
  if (charged.length > 0 && charged.every((line) => line.amountMicros !== undefined)) {
    const total = charged.reduce((sum, line) => sum + (line.amountMicros ?? 0), 0);
    return total > 0 ? total : null;
  }
  if (chargedMicros !== null) return chargedMicros > 0 ? chargedMicros : null;
  return null;
}

/** The category a task is about: what it was opened as, else what it was charged as. */
export function categoryOf(opened: ReceiptCategory | null, events: readonly LineEvent[]): ReceiptCategory | null {
  if (opened) return opened;
  if (events.some((event) => event.kind === 'app_use' && event.route === 'instant')) return 'apps';
  if (events.some((event) => event.kind === 'computer_time')) return 'computer';
  return null;
}

/** The id the game uses for one receipt: a stored receipt, or a computer's job that has none stored. */
export const RECEIPT_PREFIX = 'act_';
export const JOB_PREFIX = 'act_job_';

export const activityIdOf = (receiptId: string): string => `${RECEIPT_PREFIX}${receiptId}`;
export const jobActivityIdOf = (jobId: string): string => `${JOB_PREFIX}${jobId}`;

export type ReadId = { kind: 'receipt'; id: string } | { kind: 'job'; id: string };

export function readActivityId(value: string): ReadId | null {
  if (value.startsWith(JOB_PREFIX) && value.length > JOB_PREFIX.length) return { kind: 'job', id: value.slice(JOB_PREFIX.length) };
  if (value.startsWith(RECEIPT_PREFIX) && value.length > RECEIPT_PREFIX.length) return { kind: 'receipt', id: value.slice(RECEIPT_PREFIX.length) };
  return null;
}

/** The link a reply can carry so a person lands on the receipt: the game opens Usage on Activity with it open. */
export const receiptLink = (activityId: string): string => `[What it used](#usage=${activityId})`;
