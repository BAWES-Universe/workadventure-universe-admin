/**
 * The meter's words and rules (game #1998, Brick 7), with no database in them so tests and pages can read the same ones.
 * Saving the books is lib/meter.ts, taking room before a paid step is lib/meter-allowance.ts.
 *
 * Our own books: every app use, model call, computer minute, size change and stored byte is written once, against a person,
 * a Brick and a payer, and each figure says how sure it is. It runs in shadow first: it records and is compared with today's
 * counts, and enforces nothing new. Chat's money and a computer's money are two pools and never mix.
 */

export const METER_KINDS = ['model_call', 'speech', 'app_use', 'computer_time', 'size_change', 'stored_bytes'] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/** Chat (replies and voice, the shipped 5 hour allowance) and computer (what a Brick's computer costs) are kept apart. */
export const METER_POOLS = ['chat', 'computer'] as const;
export type MeterPool = (typeof METER_POOLS)[number];

export const METER_PAYERS = ['universe', 'person', 'unknown'] as const;
export type MeterPayer = (typeof METER_PAYERS)[number];

/** How sure a figure is: measured, estimated, paid by someone else (their bill, not ours) or unknown. An outage never proves "nothing was charged". */
export const METER_BASES = ['measured', 'estimated', 'paid_by_other', 'unknown'] as const;
export type MeterBasis = (typeof METER_BASES)[number];

export const METER_UNITS = ['call', 'token', 'second', 'minute', 'byte', 'use', 'reply'] as const;
export type MeterUnit = (typeof METER_UNITS)[number];

/** Where a paid thing is paid from unless the writer says otherwise: computer work is the computer pool, everything a reply does is chat's. */
export const DEFAULT_POOL: Record<MeterKind, MeterPool> = {
  model_call: 'chat',
  speech: 'chat',
  app_use: 'chat',
  computer_time: 'computer',
  size_change: 'computer',
  stored_bytes: 'computer',
};

const is = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** One thing that cost, or may have, as a writer says it. */
export interface MeterEventInput {
  /** What makes a write once: the same id again writes nothing. */
  eventId: string;
  kind: MeterKind;
  pool: MeterPool;
  occurredAt: Date;
  /** "person:<id>", "guest:<id>" or "unknown" */
  personKey: string;
  personId: string | null;
  botId: string | null;
  brick: boolean | null;
  payerKind: MeterPayer;
  payerPersonId: string | null;
  route: string | null;
  jobId: string | null;
  quantity: number;
  unit: MeterUnit;
  /** Millionths of a dollar; null when the price is not known, 0 for a real zero. */
  costMicros: number | null;
  basis: MeterBasis;
  sourceRef: string | null;
  detail: Record<string, unknown> | null;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, max) : null);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The largest detail a writer may attach, in characters once saved as text: detail is for a person to read later, never a place to put chat. */
export const MAX_DETAIL_CHARS = 4000;

/** A person's key as every reply window keeps it: a signed-in account, a guest by their own id, or nobody we could name. */
export function personKeyOf(person: { personId?: string | null; guestId?: string | null }): string {
  if (person.personId) return `person:${person.personId}`;
  if (person.guestId) return `guest:${person.guestId.slice(0, 255)}`;
  return 'unknown';
}

/**
 * One event from a writer, checked. `personKey` and `eventId` are required: an event nobody can be told apart by, or that is
 * charged to nobody, is not one the books can keep. The numbers must be whole and never negative; a price that is not known is
 * said as null (never 0, which would claim it was free).
 */
export function readMeterEvent(input: unknown): Checked<MeterEventInput> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const eventId = text(input.eventId, 255);
  if (!eventId) return { ok: false, error: 'eventId is required (up to 255 characters)' };
  if (!is(METER_KINDS, input.kind)) return { ok: false, error: `kind must be one of ${METER_KINDS.join(', ')}` };
  const kind = input.kind;
  const pool = input.pool === undefined || input.pool === null ? DEFAULT_POOL[kind] : input.pool;
  if (!is(METER_POOLS, pool)) return { ok: false, error: `pool must be one of ${METER_POOLS.join(', ')}` };
  // Everything a computer does is the computer pool; chat's money is never spent on it
  if (DEFAULT_POOL[kind] === 'computer' && pool !== 'computer') return { ok: false, error: `${kind} is always the computer pool` };
  const personKey = text(input.personKey, 320);
  if (!personKey || !(personKey === 'unknown' || personKey.startsWith('person:') || personKey.startsWith('guest:'))) {
    return { ok: false, error: 'personKey must be unknown, or person:<id> or guest:<id>' };
  }
  if (!is(METER_PAYERS, input.payerKind)) return { ok: false, error: `payerKind must be one of ${METER_PAYERS.join(', ')}` };
  if (!is(METER_BASES, input.basis)) return { ok: false, error: `basis must be one of ${METER_BASES.join(', ')}` };
  if (!is(METER_UNITS, input.unit)) return { ok: false, error: `unit must be one of ${METER_UNITS.join(', ')}` };
  if (!whole(input.quantity)) return { ok: false, error: 'quantity must be a whole number, 0 or more' };
  const costMicros = input.costMicros ?? null;
  if (costMicros !== null && !whole(costMicros)) return { ok: false, error: 'costMicros must be a whole number, 0 or more, or empty when the price is not known' };
  // A figure we have no number for cannot be called measured
  if (input.basis === 'measured' && costMicros === null) return { ok: false, error: 'a measured figure needs costMicros' };
  const occurredAt = input.occurredAt === undefined || input.occurredAt === null ? new Date() : new Date(input.occurredAt as string | number | Date);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, error: 'occurredAt is not a date' };
  let detail: Record<string, unknown> | null = null;
  if (input.detail !== undefined && input.detail !== null) {
    if (!isRecord(input.detail)) return { ok: false, error: 'detail must be an object' };
    if (JSON.stringify(input.detail).length > MAX_DETAIL_CHARS) return { ok: false, error: `detail is too long (up to ${MAX_DETAIL_CHARS} characters)` };
    detail = input.detail;
  }
  return {
    ok: true,
    value: {
      eventId,
      kind,
      pool,
      occurredAt,
      personKey,
      personId: text(input.personId, 255),
      botId: text(input.botId, 255),
      brick: typeof input.brick === 'boolean' ? input.brick : null,
      payerKind: input.payerKind,
      payerPersonId: text(input.payerPersonId, 255),
      route: text(input.route, 40),
      jobId: text(input.jobId, 255),
      quantity: input.quantity,
      unit: input.unit,
      costMicros,
      basis: input.basis,
      sourceRef: text(input.sourceRef, 255),
      detail,
    },
  };
}

/**
 * How sure a model call's cost is, from how its usage row says it was worked out (game #1173): the provider's own figure is
 * measured; a price from the list or a super admin's own rate is estimated; our own computer costs nothing we pay; anything
 * else is unknown. A call on someone else's key is theirs to pay, whatever it cost.
 */
export function basisOfCall(costBasis: string | null | undefined, paidByOther: boolean, costMicros: number | null): MeterBasis {
  if (paidByOther) return 'paid_by_other';
  if (costMicros === null || costBasis === 'unknown' || !costBasis) return 'unknown';
  if (costBasis === 'provider' || costBasis === 'own_computer') return 'measured';
  return 'estimated';
}

/** Calendar months in UTC, one calendar for everyone (the plan's I3). */
export function monthOf(now: Date): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

// ---------- Settings: every number is a super admin's ----------

/**
 * What a super admin sets for the meter. The money and the counts have no value until our own dev test gives one (the plan
 * proposes no numbers before real ones exist), so each starts empty, and room is refused until they are all set: a computer
 * never opens before its controls do. Only how long a running job's room is held has a recommended value.
 */
export interface MeterSettings {
  /** Computer allowance for each member, a month, in millionths of a dollar. */
  memberAllowanceMicros: number | null;
  /** The most our own computer pool may carry in a month: spent, reserved, not yet settled and kept storage, with the reserve. */
  poolCeilingMicros: number | null;
  /** Kept back for late settlement, stopping and recovery; never given to new work. */
  reserveMicros: number | null;
  /** What a gigabyte kept for a month costs us. */
  storageMicrosPerGbMonth: number | null;
  /** Jobs one member may have going at once. */
  atOnceMember: number | null;
  /** Jobs going at once, everyone together. */
  atOnceAll: number | null;
  /** What one use of a ready-made app costs us (the adapter's own price). Empty means the built-in estimate (APP_USE_MICROS_DEFAULT) is used. Not needed to open anything. */
  appUseMicros: number | null;
  /** How long room is held before a job must renew it, in minutes. */
  renewMinutes: number;
}

export const METER_RENEW_MINUTES_RECOMMENDED = 10;

/**
 * What one use of a ready-made app is counted at while no price is saved: the provider's published price for a call beyond its
 * included ones ($0.005 a call, composio.dev/pricing, read 13 Nov 2026). It is an estimate, written as such; a saved price replaces it.
 */
export const APP_USE_MICROS_DEFAULT = 5_000;

export const METER_SETTINGS_EMPTY: MeterSettings = {
  memberAllowanceMicros: null,
  poolCeilingMicros: null,
  reserveMicros: null,
  storageMicrosPerGbMonth: null,
  atOnceMember: null,
  atOnceAll: null,
  appUseMicros: null,
  renewMinutes: METER_RENEW_MINUTES_RECOMMENDED,
};

export interface MeterRange {
  min: number;
  max: number;
}

/** The values that can be saved, so a page can say "Between 1 and 1,440" before anything is sent. They are not limits on anyone. */
export const METER_RANGES: Record<keyof MeterSettings, MeterRange> = {
  memberAllowanceMicros: { min: 1, max: 1_000_000_000_000 },
  poolCeilingMicros: { min: 1, max: 1_000_000_000_000_000 },
  reserveMicros: { min: 0, max: 1_000_000_000_000_000 },
  storageMicrosPerGbMonth: { min: 0, max: 1_000_000_000_000 },
  atOnceMember: { min: 1, max: 100_000 },
  atOnceAll: { min: 1, max: 1_000_000 },
  appUseMicros: { min: 0, max: 1_000_000_000 },
  renewMinutes: { min: 1, max: 1_440 },
};

const NEEDED: (keyof MeterSettings)[] = ['memberAllowanceMicros', 'poolCeilingMicros', 'reserveMicros', 'storageMicrosPerGbMonth', 'atOnceMember', 'atOnceAll'];

const fits = (value: unknown, range: MeterRange): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** Saved settings read back: each value that is there and fits, empty (or the recommended renew time) for the rest. */
export function readMeterSettings(saved: unknown): MeterSettings {
  const out: MeterSettings = { ...METER_SETTINGS_EMPTY };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(METER_RANGES) as (keyof MeterSettings)[]) {
    if (fits(saved[key], METER_RANGES[key])) (out as unknown as Record<string, number>)[key] = saved[key] as number;
  }
  return out;
}

/** A change to the settings: only known names, each inside its range; null empties a money or count setting again. */
export function checkMeterSettings(input: unknown): Checked<Partial<MeterSettings>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<MeterSettings> = {};
  for (const [key, value] of Object.entries(input)) {
    const range = Object.prototype.hasOwnProperty.call(METER_RANGES, key) ? METER_RANGES[key as keyof MeterSettings] : undefined;
    if (!range) return { ok: false, error: `Unknown setting: ${key}` };
    if (value === null && (NEEDED.includes(key as keyof MeterSettings) || key === 'appUseMicros')) {
      (out as Record<string, null>)[key] = null;
      continue;
    }
    if (!fits(value, range)) return { ok: false, error: `${key} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    (out as Record<string, number>)[key] = value;
  }
  return { ok: true, value: out };
}

/** The settings room cannot be taken without, and that are still empty. */
export function missingSettings(settings: MeterSettings): (keyof MeterSettings)[] {
  return NEEDED.filter((key) => settings[key] === null);
}

// ---------- Extra usage ----------

export const GRANT_SETTLEMENTS = ['gift', 'to_bill'] as const;
export type GrantSettlement = (typeof GRANT_SETTLEMENTS)[number];

/** A grant as the allowance reads it. `multiplier` is null when it lifts the member's own limit. */
export interface GrantWindow {
  /** The grant's key: the last thing that settles which of two otherwise equal grants is drawn first, so row order never does. */
  key?: string;
  startsAt: Date;
  endsAt: Date;
  multiplier: number | null;
}

export interface AllowanceState {
  /** True while extra usage lifts the member's own limit. Our pool and capacity still hold. */
  unlimited: boolean;
  /** Spent this month so far, in millionths of a dollar. */
  usedMicros: number;
  /** What is left now; null when unlimited. */
  leftMicros: number | null;
}

/**
 * What a member has left of their month, from what they spent and the extra usage they were given.
 *
 *  - The usual allowance is `base`. Extra usage is a multiple of it for a while: 2 times adds `base` more, never a multiple of
 *    a multiple, so only the largest one running at a moment counts (a second grant beside a bigger one adds nothing).
 *  - Spending draws on the extra first, because it is the part that ends. So when it ends, only the extra goes: what is left of
 *    the usual allowance stays.
 *  - "No limit" lifts the member's own limit while it lasts and draws on nothing.
 *
 * `spends` are the costs this month. A spend whose cost is not known is not here: those are counted apart, never as 0.
 */
export function allowanceNow(base: number, spends: { at: Date; micros: number }[], grants: GrantWindow[], now: Date): AllowanceState {
  const { used, baseUsed, remaining, runningAt } = walkSpends(base, spends, grants);
  const current = runningAt(now);
  if (current && current.multiplier === null) return { unlimited: true, usedMicros: used, leftMicros: null };
  const extraLeft = current ? remaining.get(current)! : 0;
  return { unlimited: false, usedMicros: used, leftMicros: Math.max(0, base - baseUsed) + extraLeft };
}

/**
 * What each extra usage has taken so far above the usual allowance, in the order the grants came in: the cost drawn from it, in
 * millionths of a dollar. The same walk as `allowanceNow`, so the Costs page and the allowance never disagree about it.
 */
export function extraDrawn(base: number, spends: { at: Date; micros: number }[], grants: GrantWindow[]): number[] {
  const { drawn } = walkSpends(base, spends, grants);
  return grants.map((grant) => drawn.get(grant) ?? 0);
}

/**
 * Which of two running grants is drawn from first: the larger multiple; of two the same, the one that ends sooner (it is used up
 * first); then the one that started first; then the smaller key. Nothing depends on the order the grants were read in, so the
 * allowance a member sees and the cost the Costs page works out always walk the same way.
 */
function drawnBefore(grant: GrantWindow, best: GrantWindow): boolean {
  const rank = (window: GrantWindow) => window.multiplier ?? Infinity;
  if (rank(grant) !== rank(best)) return rank(grant) > rank(best);
  if (grant.endsAt.getTime() !== best.endsAt.getTime()) return grant.endsAt < best.endsAt;
  if (grant.startsAt.getTime() !== best.startsAt.getTime()) return grant.startsAt < best.startsAt;
  return (grant.key ?? '') < (best.key ?? '');
}

function walkSpends(base: number, spends: { at: Date; micros: number }[], grants: GrantWindow[]) {
  const remaining = new Map<GrantWindow, number>();
  const drawn = new Map<GrantWindow, number>();
  for (const grant of grants) remaining.set(grant, grant.multiplier === null ? Infinity : base * (grant.multiplier - 1));
  const runningAt = (at: Date): GrantWindow | null => {
    let best: GrantWindow | null = null;
    for (const grant of grants) {
      if (grant.startsAt > at || grant.endsAt <= at) continue;
      if (!best || drawnBefore(grant, best)) best = grant;
    }
    return best;
  };
  let used = 0;
  let baseUsed = 0;
  for (const spend of [...spends].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    used += spend.micros;
    const grant = runningAt(spend.at);
    const room = grant ? remaining.get(grant)! : 0;
    const fromExtra = grant ? Math.min(spend.micros, room) : 0;
    if (grant && fromExtra > 0) {
      remaining.set(grant, room - fromExtra);
      drawn.set(grant, (drawn.get(grant) ?? 0) + fromExtra);
    }
    baseUsed += spend.micros - fromExtra;
  }
  return { used, baseUsed, remaining, drawn, runningAt };
}

// ---------- What a person is told about their usage ----------

/** A bar says what is left, so a full bar is plenty and an empty one is out. */
export const LOW_LEFT = 0.2;

/** The plain words under a bar. Never a count of replies and never a price (plan S9). */
export type UsageWords = 'plenty' | 'half' | 'low' | 'out';

/** What is left, 0 to 1, in words: out at nothing, low at a fifth or less, "over half" above half, plenty for chat. */
export function usageWords(left: number): UsageWords {
  if (left <= 0) return 'out';
  if (left <= LOW_LEFT) return 'low';
  if (left > 0.5) return 'plenty';
  return 'half';
}

/** The first moment of next month, UTC: when a month's computer allowance starts again. */
export function nextMonthStart(now: Date): Date {
  return monthOf(now).end;
}
