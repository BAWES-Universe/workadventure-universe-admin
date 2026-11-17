/**
 * The Budget page's own settings, with no database in them (billing consensus v2, P1, P6 and the page's acceptance rules). Every number the page
 * shows is a saved value: the budgets and limits live in the meter's settings and Instant's limits, and the numbers that shape the page itself (the
 * warning levels, how a forecast is read, how big a suggested raise is) live in the `budget` setting. The starting values are written by a migration
 * that never overwrites a saved value; nothing here holds one. A setting that is not there reads as empty, and the page says so.
 */

export const BUDGET_SETTING_KEY = 'budget';

export interface BudgetSettings {
  /** The three levels, as a percent of a budget, at which Orbit warns. */
  warnFirstPercent: number | null;
  warnSecondPercent: number | null;
  warnThirdPercent: number | null;
  /** How many days of recent use a forecast is read from. */
  sampleDays: number | null;
  /** Fewer days with use than this and the forecast says it has little to go on. */
  sparseDays: number | null;
  /** One day carrying more than this share of the sample is said to be a burst. */
  burstPercent: number | null;
  /** The first suggested raise: the forecast plus this much room, as a percent of the forecast. */
  raiseRoomPercent: number | null;
  /** The second suggested raise: this percent of the forecast. */
  raiseHeadroomPercent: number | null;
  /** A computer kept for a person who has not used one for this many days is called idle on the Storage row. */
  idleDays: number | null;
  /** How often Orbit looks at the budgets and the company accounts for something to warn about, when a super admin has Orbit open, in minutes. */
  checkMinutes: number | null;
}

export const BUDGET_SETTINGS_EMPTY: BudgetSettings = {
  warnFirstPercent: null,
  warnSecondPercent: null,
  warnThirdPercent: null,
  sampleDays: null,
  sparseDays: null,
  burstPercent: null,
  raiseRoomPercent: null,
  raiseHeadroomPercent: null,
  idleDays: null,
  checkMinutes: null,
};

export interface BudgetRange {
  min: number;
  max: number;
}

/** What can be saved, so the page says "Between 1 and 100" before anything is sent. These limit nobody. */
export const BUDGET_RANGES: Record<keyof BudgetSettings, BudgetRange> = {
  warnFirstPercent: { min: 1, max: 100 },
  warnSecondPercent: { min: 1, max: 100 },
  warnThirdPercent: { min: 1, max: 100 },
  sampleDays: { min: 1, max: 31 },
  sparseDays: { min: 1, max: 31 },
  burstPercent: { min: 1, max: 100 },
  raiseRoomPercent: { min: 100, max: 10_000 },
  raiseHeadroomPercent: { min: 100, max: 10_000 },
  idleDays: { min: 1, max: 3_650 },
  checkMinutes: { min: 1, max: 1_440 },
};

export const BUDGET_LABELS: Record<keyof BudgetSettings, { label: string; hint: string; unit: 'percent' | 'days' | 'minutes' }> = {
  checkMinutes: { label: 'Minutes between checks for warnings', hint: 'While a super admin has Orbit open, Orbit looks this often at the budgets and company accounts and tells you what needs a notice.', unit: 'minutes' },
  idleDays: { label: 'Days before a kept computer is called idle', hint: 'Storage shows what is kept for people who have not used their computer for this many days.', unit: 'days' },
  warnFirstPercent: { label: 'First line', hint: 'A quiet line on the page when an area has used this much of its budget.', unit: 'percent' },
  warnSecondPercent: { label: 'First notice', hint: 'A notice in Orbit, with the date it runs out, when an area has used this much.', unit: 'percent' },
  warnThirdPercent: { label: 'Second notice', hint: 'The notice again at this much.', unit: 'percent' },
  sampleDays: { label: 'Days a forecast is read from', hint: 'The forecast looks at this many recent days. A burst can still reach a budget sooner.', unit: 'days' },
  sparseDays: { label: 'Fewest days of use for a steady forecast', hint: 'With fewer days of use than this the page says the forecast has little to go on.', unit: 'days' },
  burstPercent: { label: 'A burst is one day with this share of the sample', hint: 'One day that carries more than this share of the days read is shown as a burst.', unit: 'percent' },
  raiseRoomPercent: { label: 'Suggested raise: lasts the month, with room', hint: 'The first suggestion is the forecast plus a little room, as a percent of the forecast (110 is a tenth more).', unit: 'percent' },
  raiseHeadroomPercent: { label: 'Suggested raise: headroom', hint: 'The second suggestion is this percent of the forecast (150 is one and a half times).', unit: 'percent' },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fits = (value: unknown, range: BudgetRange): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** Saved settings read back: each value that is there and fits, empty for the rest. */
export function readBudgetSettings(saved: unknown): BudgetSettings {
  const out: BudgetSettings = { ...BUDGET_SETTINGS_EMPTY };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(BUDGET_RANGES) as (keyof BudgetSettings)[]) {
    if (fits(saved[key], BUDGET_RANGES[key])) out[key] = saved[key] as number;
  }
  return out;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A change to the page's settings: known names only, each inside its range. The warning levels must stay in order, or it is refused with the reason. */
export function checkBudgetSettings(input: unknown, current: BudgetSettings): Checked<Partial<BudgetSettings>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<BudgetSettings> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(BUDGET_RANGES, key)) return { ok: false, error: `Unknown setting: ${key}` };
    const range = BUDGET_RANGES[key as keyof BudgetSettings];
    if (!fits(value, range)) return { ok: false, error: `${key} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    (out as Record<string, number>)[key] = value;
  }
  const next = { ...current, ...out };
  const { warnFirstPercent: first, warnSecondPercent: second, warnThirdPercent: third } = next;
  if (first !== null && second !== null && first >= second) return { ok: false, error: 'The first line must come before the first notice' };
  if (second !== null && third !== null && second >= third) return { ok: false, error: 'The first notice must come before the second' };
  if (first !== null && third !== null && first >= third) return { ok: false, error: 'The first line must come before the second notice' };
  if (next.raiseRoomPercent !== null && next.raiseHeadroomPercent !== null && next.raiseRoomPercent > next.raiseHeadroomPercent) return { ok: false, error: 'The first suggested raise must not be above the second' };
  return { ok: true, value: out };
}
