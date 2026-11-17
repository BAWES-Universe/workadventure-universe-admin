/**
 * The forecast of one area's month (billing consensus v2, P6), with no database in it. It reads the recent days of use, not the whole month, so a
 * month that started slowly and is speeding up is not flattered. It says its sample (which days), when it was read, whether it had little to go on
 * and whether one day carried much of it. It never promises days of notice: a burst can reach a budget sooner, and the page says so.
 */

export interface ForecastInput {
  /** Spent so far this month, in millionths of a dollar. */
  spentMicros: number;
  /** Room held for work not yet done, which will count when it is. */
  heldMicros: number;
  /** The month's budget, or null when the area has no budget in money (chat). */
  budgetMicros: number | null;
  /** What was spent on each of the recent days, oldest first, one entry per day read (a day with nothing is 0). */
  recentDays: number[];
  /** The days read: how many of them had any use. */
  now: Date;
  monthStart: Date;
  monthEnd: Date;
  /** The settings that shape a reading. */
  sparseDays: number;
  burstPercent: number;
}

export interface Forecast {
  /** Where the month ends at the recent pace: spent so far, plus the days left at the recent daily average. */
  monthEndMicros: number;
  /** The recent daily average, in millionths of a dollar. */
  dailyMicros: number;
  /** When the budget is reached at that pace; null when it is not reached this month, or there is no budget. */
  runsOutAt: Date | null;
  /** Share of the budget used (spent plus held), as a percent; null without a budget. */
  usedPercent: number | null;
  /** How many days were read, and how many of those had use. */
  sampleDays: number;
  daysWithUse: number;
  /** The days read had little to go on. */
  sparse: boolean;
  /** One day carries more than the burst share of what was read. */
  burst: boolean;
  /** The sample is read as of this moment. */
  readAt: Date;
}

const DAY = 24 * 60 * 60 * 1000;

export function forecast(input: ForecastInput): Forecast {
  const days = input.recentDays.length;
  const total = input.recentDays.reduce((sum, value) => sum + Math.max(0, value), 0);
  const withUse = input.recentDays.filter((value) => value > 0).length;
  const dailyMicros = days > 0 ? total / days : 0;
  const msLeft = Math.max(0, input.monthEnd.getTime() - input.now.getTime());
  const daysLeft = msLeft / DAY;
  const monthEndMicros = Math.round(input.spentMicros + input.heldMicros + dailyMicros * daysLeft);
  const biggest = input.recentDays.reduce((max, value) => Math.max(max, value), 0);
  // One day is only a burst when there are several days to compare it with
  const burst = days >= 2 && total > 0 && (biggest / total) * 100 > input.burstPercent;
  const used = input.spentMicros + input.heldMicros;
  let runsOutAt: Date | null = null;
  if (input.budgetMicros !== null && used < input.budgetMicros && dailyMicros > 0) {
    const msToRunOut = ((input.budgetMicros - used) / dailyMicros) * DAY;
    if (input.now.getTime() + msToRunOut < input.monthEnd.getTime()) runsOutAt = new Date(input.now.getTime() + msToRunOut);
  }
  if (input.budgetMicros !== null && used >= input.budgetMicros) runsOutAt = input.now;
  return {
    monthEndMicros,
    dailyMicros: Math.round(dailyMicros),
    runsOutAt,
    usedPercent: input.budgetMicros !== null && input.budgetMicros > 0 ? (used / input.budgetMicros) * 100 : input.budgetMicros === 0 ? 100 : null,
    sampleDays: days,
    daysWithUse: withUse,
    sparse: withUse < input.sparseDays,
    burst,
    readAt: input.now,
  };
}

/** A whole-number amount of micros rounded up to a tidy step for a suggested budget: whole dollars from ten dollars, cents below that. */
export function tidyUp(micros: number): number {
  if (micros <= 0) return 0;
  const dollars = micros / 1_000_000;
  const step = dollars >= 100 ? 10 : dollars >= 10 ? 1 : 0.1;
  return Math.round(Math.ceil(dollars / step - 1e-9) * step * 1_000_000);
}

export interface Suggestion {
  micros: number;
  words: string;
}

/**
 * The two suggested budgets from the forecast: the first lasts the month with a little room, the second is the headroom. Both are above the
 * budget now, or they are not offered. The percents are saved settings, never ours.
 */
export function suggestions(monthEndMicros: number, budgetMicros: number, roomPercent: number | null, headroomPercent: number | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (roomPercent !== null) out.push({ micros: tidyUp((monthEndMicros * roomPercent) / 100), words: 'Lasts the month at this pace, with a little room' });
  if (headroomPercent !== null) out.push({ micros: tidyUp((monthEndMicros * headroomPercent) / 100), words: `${Number((headroomPercent / 100).toFixed(2))} times the forecast` });
  const above = out.filter((entry) => entry.micros > budgetMicros);
  // Two that came out the same are one
  return above.filter((entry, index) => above.findIndex((other) => other.micros === entry.micros) === index);
}
