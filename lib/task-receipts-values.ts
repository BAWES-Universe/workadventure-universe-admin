/**
 * What one task's receipt says (paying spec 3, part O4): one line for each task in Activity, and on tap what it used and who paid.
 * Written from what the meter's books recorded for the task, never from anything anybody said, and in plain words: Apps, computer,
 * Universe AI. This file is only the words and the sums; lib/task-receipts.ts reads the books.
 */

export type ReceiptState = 'done' | 'refunded' | 'checking';
/** How a task came to end, from what its actions came to: all worked, some did (partial), none did. A task that is not over has none. */
export type ReceiptOutcome = 'done' | 'partial' | 'refunded';
/** How one Instant action of a task ended. A failed one took nothing from the person: its hold went back. */
export type ActionOutcome = 'worked' | 'failed';

/** What a receipt keeps of each Instant action: the run, the App it was for, and how it ended. Never what was asked or answered. */
export interface ReceiptAction {
  run: string;
  label: string;
  outcome: ActionOutcome;
}

/** The states of an Instant run that has not ended: still going out, or its answer did not come back and nobody can say whether it ran. */
export const RUN_OPEN_STATES = ['reserving', 'held', 'sent', 'ambiguous'] as const;

/** The part of an Instant run's record a receipt reads. */
export interface RunRecord {
  id: string;
  state: string;
  toolkit: string;
}

/**
 * What a task's Instant runs came to, read from the runs' own final states and nothing else (never from the books' meter rows: a model
 * call's row is not proof that an App worked).
 *  - `open`: a run has not ended, so the task cannot be settled yet.
 *  - A refused run never went out (a rule, no credit, not offered, or it crashed before sending), so it is not an action of the task.
 *  - A succeeded run worked. Every other ended run did not (a failed one, or one nobody could vouch for when its wait ended: the person's favour).
 *  - Every action worked: done. Some did and some did not: partial. None did, or there was none: refunded, nothing taken.
 */
export function outcomeOfRuns(runs: readonly RunRecord[]): { open: boolean; outcome: ReceiptOutcome; actions: ReceiptAction[] } {
  const open = runs.some((run) => (RUN_OPEN_STATES as readonly string[]).includes(run.state));
  const actions = runs
    .filter((run) => run.state !== 'refused' && !(RUN_OPEN_STATES as readonly string[]).includes(run.state))
    .map((run): ReceiptAction => ({ run: run.id, label: run.toolkit, outcome: run.state === 'succeeded' ? 'worked' : 'failed' }));
  const worked = actions.filter((action) => action.outcome === 'worked').length;
  const outcome: ReceiptOutcome = worked === 0 ? 'refunded' : worked === actions.length ? 'done' : 'partial';
  return { open, outcome, actions };
}

/** The receipt's state for an outcome: partly done is still done (something worked and may have been taken); only none-worked is refunded. */
export const stateOfOutcome = (outcome: ReceiptOutcome): 'done' | 'refunded' => (outcome === 'refunded' ? 'refunded' : 'done');

/** Reads the actions a receipt stored back, dropping anything that is not the shape written. */
export function readActions(value: unknown): ReceiptAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReceiptAction[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { run, label, outcome } = entry as Record<string, unknown>;
    return typeof run === 'string' && typeof label === 'string' && (outcome === 'worked' || outcome === 'failed') ? [{ run, label, outcome }] : [];
  });
}
export type ReceiptCategory = 'apps' | 'computer';

/** One line of "what it used". `amountMicros` is what it took from credit; empty when it took none or the price is not known yet (the note says which). */
export interface ReceiptLine {
  label: string;
  amountMicros?: number;
  note?: string;
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
function instantTaken(event: LineEvent): number | null {
  if (isRecord(event.detail) && event.detail.instant === true) return typeof event.detail.customerMicros === 'number' ? event.detail.customerMicros : null;
  return event.costMicros;
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
  priced: boolean;
  charged: boolean;
  note?: string;
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
      const found = group(`instant:${name ?? ''}`, 0, name ? `Instant ${name}` : 'Instant Apps', true);
      found.count += event.quantity;
      const taken = instantTaken(event);
      if (taken === null) found.unpriced = true;
      else {
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
  const charged = lines.filter((line) => line.amountMicros !== undefined || line.note === 'Price not known yet');
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
