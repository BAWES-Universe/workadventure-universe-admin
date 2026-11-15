/**
 * What one task's receipt says (paying spec 3, part O4): one line for each task in Activity, and on tap what it used and who paid.
 * Written from what the meter's books recorded for the task, never from anything anybody said, and in plain words: Apps, computer,
 * Universe AI. This file is only the words and the sums; lib/task-receipts.ts reads the books.
 */

export type ReceiptState = 'done' | 'refunded' | 'checking';
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
  quantity: number;
  costMicros: number | null;
  detail: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

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
      if (event.costMicros === null) found.unpriced = true;
      else {
        found.micros += event.costMicros;
        found.priced = true;
      }
    } else if (event.kind === 'computer_time') {
      const found = group('computer', 1, 'Computer', true);
      found.seconds += event.quantity;
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
