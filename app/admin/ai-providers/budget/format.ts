import type { Limit } from '../../components/limits';
import type { NumberView } from '@/lib/budget/types';

/** Money on the page: millionths of a dollar as dollars, cents only when there are cents, no cents from a hundred dollars up. */
export function money(micros: number): string {
  const value = micros / 1_000_000;
  if (Math.abs(value) >= 100) return `$${Math.round(value).toLocaleString('en')}`;
  const whole = Math.abs(value % 1) < 1e-9;
  if (!whole && Math.abs(value) < 0.1) return `$${value.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString('en', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** The scale from a number's saved unit to the unit the page shows and types. */
export const SCALE: Record<NumberView['unit'], { per: number; shown: string }> = {
  micros: { per: 1_000_000, shown: 'dollars' },
  seconds: { per: 3600, shown: 'hours' },
  bps: { per: 100, shown: 'percent' },
  percent: { per: 1, shown: 'percent' },
  count: { per: 1, shown: 'times' },
  minutes: { per: 1, shown: 'minutes' },
  days: { per: 1, shown: 'days' },
};

/** The words for the unit of a count: jobs for jobs at once, give-backs for give-backs. */
const COUNT_WORDS: Record<string, string> = { 'meter:atOnceMember': 'jobs', 'meter:atOnceAll': 'jobs', 'instant:pauseMinRuns': 'runs', 'instant:goodwillPerPersonPerMonth': 'give-backs' };

export const toShown = (view: Pick<NumberView, 'unit'>, raw: number): number => raw / SCALE[view.unit].per;
export const toSaved = (view: Pick<NumberView, 'unit'>, shown: number): number => Math.round(shown * SCALE[view.unit].per);

/** A number as a row of the Limits kind (what Details shows): value and range in the units a person reads. Empty is "Not set", with no suggested value. */
export function limitOf(view: NumberView): Limit {
  const unit = view.unit === 'count' ? (COUNT_WORDS[view.id] ?? 'times') : SCALE[view.unit].shown;
  const when = view.lastChange ? `Last changed by ${view.lastChange.by}, ${new Date(view.lastChange.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : null;
  return {
    id: view.id,
    label: view.label,
    hint: view.hint,
    unit,
    value: view.value === null ? 0 : toShown(view, view.value),
    recommended: -1,
    unset: view.value === null,
    options: [],
    range: { min: toShown(view, view.range.min), max: toShown(view, view.range.max), whole: view.unit === 'count' || view.unit === 'minutes' || view.unit === 'days' || view.unit === 'percent' },
    changed: when ?? undefined,
  };
}

/** Where a month turns, as a date a person reads. */
export const dayWords = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const timeWords = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "Today at 1:05 PM", "Yesterday at 9:40 PM" or "16 Nov". */
export function whenWords(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `Today at ${timeWords(iso)}`;
  if (days === 1) return `Yesterday at ${timeWords(iso)}`;
  return dayWords(iso);
}

/** A value of a number in words, for the history: money in dollars, hours, a percent, or "not set". */
export function valueWords(unit: NumberView['unit'], raw: number | null): string {
  if (raw === null) return 'not set';
  if (unit === 'micros') return money(raw);
  const shown = toShown({ unit }, raw);
  if (unit === 'seconds') return `${shown.toLocaleString('en', { maximumFractionDigits: 2 })} hours`;
  if (unit === 'bps' || unit === 'percent') return `${shown.toLocaleString('en', { maximumFractionDigits: 2 })}%`;
  return `${shown.toLocaleString('en')} ${SCALE[unit].shown === 'times' ? '' : SCALE[unit].shown}`.trim();
}
