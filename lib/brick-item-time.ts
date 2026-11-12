/**
 * Time for goals and tasks (game #2002, Brick 11). No database here: when something is due, in the person's own time zone.
 *
 * A reminder, a schedule, a watch or a goal is due by one of four cadences:
 *  - `once`: one moment ("remind me at 5 pm"), kept as the instant it means.
 *  - `daily`: a time of day on chosen weekdays ("every workday at 7:30"), read on the clock of the time zone the item was
 *    set in. Travelling never moves it.
 *  - `every`: a number of minutes ("check every hour"), anchored on when it first fell due.
 *  - `none`: no timed check: a goal that waits for something (it says what in its own words).
 *
 * Clock changes: a time that does not exist (the clock jumps over it) runs at the next valid moment, which is the moment
 * the clock jumps; a time that happens twice runs once, the first time.
 */

export type Cadence =
  | { type: 'once'; at: string }
  | { type: 'daily'; time: string; days: number[] }
  | { type: 'every'; minutes: number }
  | { type: 'none' };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Whether this is a time zone the runtime knows ("Asia/Kuwait", "Europe/London", "UTC"). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let one = formatters.get(timeZone);
  if (!one) {
    one = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, one);
  }
  return one;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What the clock on the wall of `timeZone` reads at this instant. */
export function localParts(at: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour === 24 ? 0 : parts.hour, minute: parts.minute };
}

/** Minutes the zone is ahead of UTC at this instant (Kuwait: 180). */
function offsetMinutes(at: number, timeZone: string): number {
  const local = localParts(at, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((asUtc - Math.floor(at / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The instant the wall clock of `timeZone` reads this date and time. A time that happens twice gives the first; a time that
 * does not exist gives the moment the clock jumps over it.
 */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMinutes(wall - DAY, timeZone);
  const after = offsetMinutes(wall + DAY, timeZone);
  const valid: number[] = [];
  for (const offset of new Set([before, after])) {
    const candidate = wall - offset * MINUTE;
    if (offsetMinutes(candidate, timeZone) === offset) valid.push(candidate);
  }
  if (valid.length > 0) return Math.min(...valid);
  // The clock jumps over this time: the first instant the zone is on its new offset
  let low = wall - DAY;
  let high = wall + DAY;
  while (high - low > MINUTE) {
    const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE;
    if (offsetMinutes(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return high;
}

export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A cadence as the bot server sends it, or null when it is not one. Days are 0 (Sunday) to 6, each once, in order. */
export function readCadence(value: unknown): Cadence | null {
  if (!isRecord(value)) return null;
  if (value.type === 'none') return { type: 'none' };
  if (value.type === 'once') {
    if (typeof value.at !== 'string') return null;
    const at = new Date(value.at);
    return Number.isNaN(at.getTime()) ? null : { type: 'once', at: at.toISOString() };
  }
  if (value.type === 'every') {
    return typeof value.minutes === 'number' && Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 525_600 ? { type: 'every', minutes: value.minutes } : null;
  }
  if (value.type === 'daily') {
    if (typeof value.time !== 'string' || !TIME_OF_DAY.test(value.time)) return null;
    if (!Array.isArray(value.days) || value.days.length === 0 || value.days.length > 7) return null;
    const days = [...new Set(value.days)];
    if (days.length !== value.days.length || !days.every((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) return null;
    return { type: 'daily', time: value.time, days: (days as number[]).sort((a, b) => a - b) };
  }
  return null;
}

/** The first moment strictly after `after` that a daily cadence falls on, in this zone. */
function nextDaily(cadence: { time: string; days: number[] }, timeZone: string, after: number): number | null {
  const [hour, minute] = cadence.time.split(':').map(Number);
  const today = localParts(after, timeZone);
  // A week and a day always holds one of any weekday, and one more for a clock change that moves it
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    if (!cadence.days.includes(date.getUTCDay())) continue;
    const at = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (at > after) return at;
  }
  return null;
}

/**
 * When it is first due, counted from `from` (when it was set or switched on again): `once` its own moment (nothing when that
 * is already past), `daily` the next such time, `every` one step on, `none` never.
 */
export function firstDue(cadence: Cadence, timeZone: string, from: Date): Date | null {
  switch (cadence.type) {
    case 'once': {
      const at = Date.parse(cadence.at);
      return at > from.getTime() ? new Date(at) : null;
    }
    case 'daily': {
      const at = nextDaily(cadence, timeZone, from.getTime());
      return at === null ? null : new Date(at);
    }
    case 'every':
      return new Date(from.getTime() + cadence.minutes * MINUTE);
    case 'none':
      return null;
  }
}

/**
 * When it is due after the occurrence that was due at `dueAt`, with `now` as the clock. Never one that is already past:
 * after an outage this skips every missed occurrence but the one being run now, so there is never a backlog. Null when it
 * does not come again.
 */
export function nextDue(cadence: Cadence, timeZone: string, dueAt: Date, now: Date): Date | null {
  switch (cadence.type) {
    case 'once':
    case 'none':
      return null;
    case 'daily': {
      const at = nextDaily(cadence, timeZone, Math.max(dueAt.getTime(), now.getTime()));
      return at === null ? null : new Date(at);
    }
    case 'every': {
      const step = cadence.minutes * MINUTE;
      const behind = Math.max(0, now.getTime() - dueAt.getTime());
      return new Date(dueAt.getTime() + (Math.floor(behind / step) + 1) * step);
    }
  }
}

/** The shortest gap between two runs of a cadence, in minutes, to compare with "shortest repeat". Null when it does not repeat. */
export function repeatMinutes(cadence: Cadence): number | null {
  if (cadence.type === 'every') return cadence.minutes;
  // Once a day at most, on any days
  if (cadence.type === 'daily') return 24 * 60;
  return null;
}

export const TIME_ZONE_KEY = 'timeZone';
export const WORKWEEK_KEY = 'workweek';

/** The days a Brick works the week by (0 is Sunday): Sun to Thu, Mon to Fri, or the days the person named. Never guessed from a country. */
export function readWorkweek(value: unknown): number[] | null {
  if (value === 'sun-thu') return [0, 1, 2, 3, 4];
  if (value === 'mon-fri') return [1, 2, 3, 4, 5];
  if (typeof value === 'object' && value !== null && Array.isArray((value as { days?: unknown }).days)) {
    const days = (value as { days: unknown[] }).days;
    const clean = [...new Set(days)];
    if (clean.length > 0 && clean.length <= 7 && clean.every((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) return (clean as number[]).sort((a, b) => a - b);
  }
  return null;
}
