import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { METER_RANGES, checkMeterSettings, type MeterSettings } from '@/lib/meter-values';
import { getInstantLimits, saveInstantLimits } from '@/lib/instant/state';
import { INSTANT_LIMIT_RANGES, checkInstantLimits, type InstantLimits } from '@/lib/instant/values';
import { BUDGET_LABELS, BUDGET_RANGES, BUDGET_SETTING_KEY, checkBudgetSettings, readBudgetSettings, type BudgetSettings } from '@/lib/budget/values';
import { changesBetween, recordChanges, type BudgetStore } from '@/lib/budget/history';

/**
 * Every number on the Budget page, in one list: where it is saved, what it is called, which area and group it belongs to and what unit it is in.
 * The list holds words and places, never an amount: a value comes from the store it is saved in, its range from that store's own table of ranges,
 * and a number whose store does not hold it yet (a setting another change adds) is simply not there until it is. Saving goes through the store's
 * own save function, which writes the change history in the same transaction, and is read back before the page says it is in effect.
 */

export type AreaKey = 'chat' | 'speech' | 'apps' | 'computers' | 'storage';
export type NumberGroup = 'budget' | 'person' | 'capacity' | 'reserve' | 'price' | 'credit' | 'warning' | 'forecast' | 'instant';
export type NumberUnit = 'micros' | 'seconds' | 'count' | 'bps' | 'minutes' | 'percent' | 'days';
export type AppsLine = 'connected' | 'instant' | 'code';

export interface NumberDef {
  /** `${store}:${key}`, the id the page and the history use. */
  id: string;
  store: BudgetStore;
  key: string;
  group: NumberGroup;
  area: AreaKey | null;
  line?: AppsLine;
  label: string;
  hint: string;
  unit: NumberUnit;
  /** True for the number that is an area's (or an Apps line's) monthly budget: the page raises it. */
  budget?: boolean;
}

const meter = (key: string, group: NumberGroup, area: AreaKey | null, label: string, hint: string, unit: NumberUnit, extra: Partial<NumberDef> = {}): NumberDef => ({ id: `meter:${key}`, store: 'meter', key, group, area, label, hint, unit, ...extra });
const instant = (key: keyof InstantLimits, group: NumberGroup, label: string, hint: string, unit: NumberUnit, extra: Partial<NumberDef> = {}): NumberDef => ({ id: `instant:${key}`, store: 'instant', key, group, area: 'apps', label, hint, unit, line: 'instant', ...extra });

/**
 * The meter's numbers and Instant's. `speechBudgetMicros` and `storageBudgetMicros` are the budgets the backend work for speech and storage adds
 * to the meter's settings; until the store holds them they are not on the page (see `available`).
 */
export const NUMBER_DEFS: NumberDef[] = [
  meter('speechBudgetMicros', 'budget', 'speech', 'Speech budget', 'The most Universe pays for listening and speaking on Universe AI in a month, all people together.', 'micros', { budget: true }),
  meter('appUseCeilingMicros', 'budget', 'apps', 'Connected Apps', 'The most Universe pays for the use of connected Apps in a month, all people together.', 'micros', { budget: true, line: 'connected' }),
  instant('exposureCeilingMicros', 'budget', 'Instant Apps', 'The most Instant Apps may owe Composio: runs not finished, runs whose charge is not known yet, and the month’s settled charges.', 'micros', { budget: true }),
  meter('poolCeilingMicros', 'budget', 'computers', 'Computers budget', 'The most the computer pool may carry in a month: spent, set aside, not yet settled, and the part kept back for late bills.', 'micros', { budget: true }),
  meter('storageBudgetMicros', 'budget', 'storage', 'Storage budget', 'The most Universe pays for new storage in a month: new resting disks, packed away copies and files.', 'micros', { budget: true }),

  meter('speechMemberCeilingSeconds', 'person', 'speech', 'Speech for one person', 'Seconds of listening plus speaking Universe AI pays for one person in a month. Reaching it offers Ask for more.', 'seconds'),
  meter('speechCeilingSeconds', 'person', 'speech', 'Speech hours for everyone', 'Seconds of listening plus speaking, all people together. Counted as capacity beside the money.', 'seconds'),
  meter('appUseMemberCeilingMicros', 'person', 'apps', 'Apps for one person', 'What one person’s Bricks may use on connected Apps at Universe’s cost in a month.', 'micros', { line: 'connected' }),
  meter('memberAllowanceMicros', 'person', 'computers', 'Computer allowance for each member', 'What a member’s Bricks can use on computers in a month. Reaching it offers Ask for more.', 'micros'),
  instant('goodwillPerPersonPerMonth', 'person', 'Give-backs one person may have in a month', 'For “Didn’t work” on an Instant App. Empty: nothing is given back.', 'count'),

  meter('atOnceMember', 'capacity', 'computers', 'Jobs at once: one member', 'Computer jobs one member may have going at once.', 'count'),
  meter('atOnceAll', 'capacity', 'computers', 'Jobs at once: everyone together', 'Computer jobs going at once on the whole platform. Capacity, not money.', 'count'),

  meter('reserveMicros', 'reserve', 'computers', 'Kept back for late bills', 'Part of the Computers budget, for bills that arrive after a job ends. Never given to new work.', 'micros'),

  meter('storageMicrosPerGbMonth', 'price', 'storage', 'Disk, a gigabyte a month', 'What a gigabyte kept for a month costs Universe. Used for what is kept and what next month owes.', 'micros'),
  meter('appUseMicros', 'price', 'apps', 'One price for every App step', 'Replaces the provider’s list prices for a paid step. Empty means the list prices are used.', 'micros', { line: 'connected' }),
  instant('maxRunMicros', 'price', 'Most one Instant run may cost', 'Tools whose top price is above this are not offered. Includes Composio’s call fee.', 'micros'),
  instant('markupBps', 'price', 'Added to Composio’s charge for what the person pays', 'In hundredths of a percent (1,000 is 10%). Empty: the person pays Composio’s charge as it is.', 'bps'),

  meter('rolloutBudgetMicros', 'credit', null, 'Rollout budget for grants', 'What Universe funds in credit in a month: defaults, gifts and renewals. Empty: nothing is given out.', 'micros'),
  instant('goodwillBudgetMicros', 'credit', 'Most given back for “Didn’t work” in a month', 'Everyone together, calendar month (UTC). Empty: nothing is given back.', 'micros'),
  instant('goodwillMaxMicros', 'credit', 'Most one give-back may be', 'Empty: nothing is given back for “Didn’t work”.', 'micros'),

  instant('pauseFailureRateBps', 'instant', 'Pause Instant when this share of runs fail', 'In hundredths of a percent (500 is 5%). Read over the failure window, once enough runs happened.', 'bps'),
  instant('pauseMinRuns', 'instant', 'Fewest runs before that check applies', 'So one failure out of two runs is not an alarm.', 'count'),
  instant('pauseWindowMinutes', 'instant', 'Failure window', 'Minutes of recent runs the pause check reads.', 'minutes'),
  instant('sentWaitMinutes', 'instant', 'Wait before looking up a run with no answer', 'Minutes.', 'minutes'),
  instant('unclearWaitMinutes', 'instant', 'How long an unclear run is looked up for', 'Minutes, from when it went out.', 'minutes'),
  instant('chargeWaitMinutes', 'instant', 'Wait for Composio’s charge', 'Minutes. After that the top price stands as an estimate until the monthly check.', 'minutes'),

  ...(Object.keys(BUDGET_LABELS) as (keyof BudgetSettings)[]).map(
    (key): NumberDef => ({
      id: `budget:${key}`,
      store: 'budget',
      key,
      group: key.startsWith('warn') || key === 'checkMinutes' ? 'warning' : 'forecast',
      area: null,
      label: BUDGET_LABELS[key].label,
      hint: BUDGET_LABELS[key].hint,
      unit: BUDGET_LABELS[key].unit,
    }),
  ),
];

export const numberById = (id: string): NumberDef | undefined => NUMBER_DEFS.find((def) => def.id === id);

/** The range a number can be saved in, from its own store's table; null when that store does not hold the number. */
export function rangeOf(def: NumberDef): { min: number; max: number } | null {
  if (def.store === 'meter') return Object.prototype.hasOwnProperty.call(METER_RANGES, def.key) ? METER_RANGES[def.key as keyof MeterSettings] : null;
  if (def.store === 'instant') return Object.prototype.hasOwnProperty.call(INSTANT_LIMIT_RANGES, def.key) ? INSTANT_LIMIT_RANGES[def.key as keyof InstantLimits] : null;
  return BUDGET_RANGES[def.key as keyof BudgetSettings] ?? null;
}

/** Whether the store holds this number now. */
export const available = (def: NumberDef): boolean => rangeOf(def) !== null;

export interface Values {
  meter: MeterSettings;
  instant: InstantLimits;
  budget: BudgetSettings;
}

type Db = Pick<typeof prisma, 'appSetting'>;

/** The budget page's own saved settings; empty where nothing is saved. A read that fails reads as empty and is logged. */
export async function getBudgetSettings(db: Db = prisma): Promise<BudgetSettings> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: BUDGET_SETTING_KEY } });
    return readBudgetSettings(row?.value);
  } catch (error) {
    console.error('[Budget] Could not read the page settings:', error instanceof Error ? error.message : 'unknown');
    return readBudgetSettings(null);
  }
}

/** Saves a change on top of what is saved and writes its history in the same transaction; returns all the page's settings as saved. */
export async function saveBudgetSettings(change: Partial<BudgetSettings>, userId: string): Promise<BudgetSettings> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('budget:settings'))`;
    const row = await tx.appSetting.findUnique({ where: { key: BUDGET_SETTING_KEY } });
    const saved = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...saved, ...change };
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: BUDGET_SETTING_KEY }, create: { key: BUDGET_SETTING_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    await recordChanges(tx, changesBetween('budget', Object.keys(change), saved, next), userId);
    return readBudgetSettings(next);
  });
}

export async function readValues(): Promise<Values> {
  const [meterSettings, instantLimits, budget] = await Promise.all([getMeterSettings(), getInstantLimits(), getBudgetSettings()]);
  return { meter: meterSettings, instant: instantLimits, budget };
}

export const valueOf = (def: NumberDef, values: Values): number | null => {
  const store = values[def.store] as unknown as Record<string, unknown>;
  const value = store[def.key];
  return typeof value === 'number' ? value : null;
};

export type SaveResult = { ok: true; value: number | null; inEffect: boolean } | { ok: false; status: 400 | 404; error: string };

/**
 * Saves one number. It must be one the page knows and the store holds, and inside its range (the same check the store's own route makes), so
 * a raise outside the range is refused with a plain line and nothing is written. `inEffect` is true only when a fresh read of the store, after
 * the save, gives the value that was asked for: the page says "in effect" on that and nothing else.
 */
export async function saveNumber(id: string, value: number | null, userId: string): Promise<SaveResult> {
  const def = numberById(id);
  if (!def || !available(def)) return { ok: false, status: 404, error: 'That number is not on this page' };
  const range = rangeOf(def)!;
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.min || value > range.max)) {
    return { ok: false, status: 400, error: `${def.label} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
  }
  if (def.store === 'meter') {
    const checked = checkMeterSettings({ [def.key]: value });
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    await saveMeterSettings(checked.value, userId);
  } else if (def.store === 'instant') {
    const checked = checkInstantLimits({ [def.key]: value });
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    await saveInstantLimits(checked.value, userId);
  } else {
    if (value === null) return { ok: false, status: 400, error: `${def.label} can’t be emptied` };
    const checked = checkBudgetSettings({ [def.key]: value }, await getBudgetSettings());
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    await saveBudgetSettings(checked.value, userId);
  }
  // Read back from the store, the way every check reads it: this is what the next request will see
  const now = valueOf(def, await readValues());
  return { ok: true, value: now, inEffect: now === value };
}
