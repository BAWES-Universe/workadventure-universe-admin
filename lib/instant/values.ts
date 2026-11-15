import { createHash } from 'crypto';
import { DIRECT_EXECUTION_MICROS, RATE_MICROS } from '@/lib/composio-rates';

/**
 * The bounded Instant executor's words and rules (spec O2), with no database in them so the executor, the sweep and the tests read
 * the same ones.
 *
 * Instant tools run on Composio's own accounts and are charged to OUR prepaid balance. Composio's session has no dollar cap, its
 * balance check is asynchronous, and its price strings are descriptions, not bounds. So nothing here trusts them: a tool is offered
 * only when OUR table holds a top price for it that the arguments cannot exceed, and that price is what is held before the run.
 *
 * Money is in millionths of a dollar ("micros"): $0.007 is 7,000.
 */

export const INSTANT_PROVIDER = 'composio';

/** The account name Composio's own docs give for choosing an Instant account on purpose when running a tool. */
export const INSTANT_ACCOUNT = 'instant_account';

/** Bumped whenever the table below changes, and kept on every run so a run can be read against the table that bounded it. */
export const INSTANT_PRICE_VERSION = '2026-11-15.1';

/** When the prices below were read from Composio's own tool listing (GET /tools/{slug}?include_pricing=true), live. */
export const INSTANT_PRICES_READ_ON = '2026-11-15';

/** The most text and the most items one run may carry, so a "bounded by its arguments" price is bounded for real. */
const MAX_URLS = 20;
const MAX_TEXT = 2_000;

/**
 * One tool of the trusted table. `micros` is what Composio's Instant price comes to for the call; the top price a run is held at
 * adds Composio's normal call fee for the app and the direct execution add-on (an Instant run is sent outside a Session), which
 * Composio's page says are charged besides the Instant price. `bound` returns how many of the priced units the arguments can
 * ask for, or null when they cannot be held to a number (then the run is refused, never guessed).
 */
interface InstantTool {
  toolkit: string;
  /** Composio's Instant price for one unit, in micros, as its own listing states it (the description in `listed`). */
  unitMicros: number;
  /** The words Composio's listing gave for the price on the day it was read: the drift check compares the live words with these. */
  listed: string;
  /** How many units the arguments can cost at most (a whole number of 1 or more), or null when they cannot be bounded. */
  bound: (args: Record<string, unknown>) => number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string argument that is there and short enough, or null. Used so a bound never depends on text the model could stretch without limit. */
const shortText = (value: unknown): string | null => (typeof value === 'string' && value.trim() && value.length <= MAX_TEXT ? value : null);

// ---------- What arguments a run may carry ----------

/** One argument's rule: true when its value cannot make the call cost more than the priced unit. */
type ArgRule = (value: unknown) => boolean;

const textArg: ArgRule = (v) => shortText(v) !== null;
const flag = (only?: boolean): ArgRule => (v) => typeof v === 'boolean' && (only === undefined || v === only);
const whole = (min: number, max: number): ArgRule => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const number = (min: number, max: number): ArgRule => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const oneOf = (...allowed: string[]): ArgRule => (v) => typeof v === 'string' && allowed.includes(v);
const textList = (max: number): ArgRule => (v) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((item) => shortText(item) !== null);
const smallObject: ArgRule = (v) => isRecord(v) && JSON.stringify(v).length <= 500;

/** A search is priced per search: the most results it may ask for. Above this the provider's own price steps up. */
const MAX_RESULTS = 10;

/**
 * The arguments each tool may carry, each with the rule that keeps it inside its priced unit. An argument not listed is not known
 * to be free (more results, deeper search, page contents, a pro model), so a call carrying one is not bounded and is refused;
 * the schema a Brick is offered is cut to these too, so it is never invited to ask for what would be refused.
 */
const ALLOWED: Record<string, { args: Record<string, ArgRule>; required: string[] }> = {
  EXA_SEARCH: {
    args: {
      query: textArg,
      numResults: whole(1, MAX_RESULTS),
      category: textArg,
      moderation: flag(),
      userLocation: textArg,
      includeDomains: textList(20),
      excludeDomains: textList(20),
      includeText: textList(1),
      excludeText: textList(1),
      startPublishedDate: textArg,
      endPublishedDate: textArg,
    },
    required: ['query'],
  },
  EXA_ANSWER: { args: { query: textArg, model: oneOf('exa') }, required: ['query'] },
  TAVILY_SEARCH: {
    args: { query: textArg, max_results: whole(1, MAX_RESULTS), search_depth: oneOf('basic'), include_domains: textList(20), exclude_domains: textList(20) },
    required: ['query'],
  },
  GOOGLE_MAPS_GEOCODE_ADDRESS_WITH_QUERY: { args: { address_query: textArg, region_code: textArg, language_code: textArg }, required: ['address_query'] },
  GOOGLE_MAPS_GEOCODE_LOCATION: {
    args: { latitude: number(-90, 90), longitude: number(-180, 180), regionCode: textArg, languageCode: textArg, types: textList(20) },
    required: ['latitude', 'longitude'],
  },
  GOOGLE_MAPS_GEOCODE_PLACE: { args: { place_id: textArg, regionCode: textArg, languageCode: textArg }, required: ['place_id'] },
  GOOGLE_MAPS_AUTOCOMPLETE: {
    args: {
      input: textArg,
      origin: smallObject,
      regionCode: textArg,
      inputOffset: whole(0, 2_000),
      languageCode: textArg,
      locationBias: smallObject,
      sessionToken: textArg,
      includedRegionCodes: textList(15),
      locationRestriction: smallObject,
      includedPrimaryTypes: textList(5),
    },
    required: ['input'],
  },
};

/** One priced unit when every argument is one the tool is known to carry at that price, and the needed ones are there; else null. */
function oneUnit(tool: string, args: Record<string, unknown>): number | null {
  const rules = ALLOWED[tool];
  if (!rules) return null;
  for (const [key, value] of Object.entries(args)) {
    const rule = Object.prototype.hasOwnProperty.call(rules.args, key) ? rules.args[key] : undefined;
    if (!rule || !rule(value)) return null;
  }
  return rules.required.every((key) => args[key] !== undefined) ? 1 : null;
}

/** The argument names a Brick may use on a tool, or null for a tool that is not in the table; for cutting the schema it is offered. */
export function instantAllowedArguments(tool: string): { names: string[]; required: string[] } | null {
  const rules = Object.prototype.hasOwnProperty.call(ALLOWED, tool) ? ALLOWED[tool] : undefined;
  if (rules) return { names: Object.keys(rules.args), required: rules.required };
  return tool === 'EXA_GET_CONTENTS_ACTION' ? { names: [...EXA_CONTENTS_KEYS], required: [] } : null;
}

/** The arguments of Exa's contents tool that are known not to add to its price. Any other argument could, so a call with one is not bounded. */
const EXA_CONTENTS_KEYS = new Set(['urls', 'ids', 'text', 'highlights', 'summary', 'livecrawl', 'livecrawl_timeout']);

/**
 * EXA_GET_CONTENTS_ACTION is priced "per page per content type": the bound is the pages asked for times the content types asked for
 * (text, highlights, summary; text when none is named). Missing pages, too many, or an argument that is not known to be free, is
 * refused: an unstated count is not a bound.
 */
function exaContentsBound(args: Record<string, unknown>): number | null {
  if (Object.keys(args).some((key) => !EXA_CONTENTS_KEYS.has(key))) return null;
  // Pages are counted from BOTH lists: a call naming urls and ids may be charged for each, so the bound is their sum
  const lists = [args.urls, args.ids].filter((list) => list !== undefined);
  if (lists.some((list) => !Array.isArray(list))) return null;
  const urls = (lists as unknown[][]).flat();
  if (urls.length < 1 || urls.length > MAX_URLS || urls.some((url) => typeof url !== 'string' || !url || url.length > MAX_TEXT)) return null;
  const kinds = ['text', 'highlights', 'summary'].filter((key) => args[key] !== undefined && args[key] !== false && args[key] !== null).length;
  return urls.length * Math.max(1, kinds);
}

/**
 * The trusted table of Instant tools Universe offers, read from Composio's live tool listing on 15 Nov 2026. Every row is one flat
 * price per call (or per page, bounded by the arguments). A tool is not here when its price depends on options we cannot see in
 * the arguments ("basic" scrapes and searches, "$2 max" generations, per-pair route matrices): those are offered only after each
 * gets its own rule and review. Adding a tool is a code change with its own tests, never a setting a model or a page can make.
 */
const TABLE: Record<string, InstantTool> = {
  EXA_SEARCH: { toolkit: 'exa', unitMicros: 7_000, listed: '$0.007 per search', bound: (args) => oneUnit('EXA_SEARCH', args) },
  EXA_ANSWER: { toolkit: 'exa', unitMicros: 5_000, listed: '$0.005 per answer', bound: (args) => oneUnit('EXA_ANSWER', args) },
  EXA_GET_CONTENTS_ACTION: { toolkit: 'exa', unitMicros: 1_000, listed: '$0.001 per page per content type', bound: exaContentsBound },
  TAVILY_SEARCH: { toolkit: 'tavily', unitMicros: 8_000, listed: '$0.008 per web search.', bound: (args) => oneUnit('TAVILY_SEARCH', args) },
  GOOGLE_MAPS_GEOCODE_ADDRESS_WITH_QUERY: { toolkit: 'google_maps', unitMicros: 5_000, listed: '$0.005 per address geocoding request', bound: (args) => oneUnit('GOOGLE_MAPS_GEOCODE_ADDRESS_WITH_QUERY', args) },
  GOOGLE_MAPS_GEOCODE_LOCATION: { toolkit: 'google_maps', unitMicros: 5_000, listed: '$0.005 per reverse geocoding request', bound: (args) => oneUnit('GOOGLE_MAPS_GEOCODE_LOCATION', args) },
  GOOGLE_MAPS_GEOCODE_PLACE: { toolkit: 'google_maps', unitMicros: 5_000, listed: '$0.005 per place geocoding request', bound: (args) => oneUnit('GOOGLE_MAPS_GEOCODE_PLACE', args) },
  GOOGLE_MAPS_AUTOCOMPLETE: { toolkit: 'google_maps', unitMicros: 2_830, listed: '$0.00283 per request', bound: (args) => oneUnit('GOOGLE_MAPS_AUTOCOMPLETE', args) },
};

/** The call fee Composio adds to a managed-account tool run (its rate card tier for the app) and the direct execution add-on. */
function feeMicros(toolkit: string): number {
  // Google Maps is "from $0.01" on the rate card; every other tool of the table is in "all other managed apps" ($0.0005)
  return (toolkit === 'google_maps' ? RATE_MICROS.managed_maps : RATE_MICROS.managed_other) + DIRECT_EXECUTION_MICROS;
}

export type Admission =
  | { ok: true; tool: string; toolkit: string; topMicros: number; priceVersion: string; units: number }
  | { ok: false; reason: 'not_offered' | 'unbounded' };

/**
 * Whether a tool may run as an Instant run, and the top price it is held at. `not_offered`: no row for it. `unbounded`: a row, but
 * these arguments cannot be held to a number. A price that is not a whole number above zero is never offered.
 */
export function admitInstantTool(tool: string, args: unknown): Admission {
  const row = Object.prototype.hasOwnProperty.call(TABLE, tool) ? TABLE[tool] : undefined;
  if (!row) return { ok: false, reason: 'not_offered' };
  const units = row.bound(isRecord(args) ? args : {});
  if (units === null || !Number.isSafeInteger(units) || units < 1) return { ok: false, reason: 'unbounded' };
  const topMicros = units * row.unitMicros + feeMicros(row.toolkit);
  if (!Number.isSafeInteger(topMicros) || topMicros < 1) return { ok: false, reason: 'unbounded' };
  return { ok: true, tool, toolkit: row.toolkit, topMicros, priceVersion: INSTANT_PRICE_VERSION, units };
}

/** What Universe offers: each tool's slug and app, and the most one run of the simplest kind costs (for a list, never for holding a run). */
export function instantCatalog(): { tool: string; toolkit: string; fromMicros: number }[] {
  return Object.entries(TABLE).map(([tool, row]) => ({ tool, toolkit: row.toolkit, fromMicros: row.unitMicros + feeMicros(row.toolkit) }));
}

/** The words Composio's own listing gave for each tool's price when the table was read, for the drift check. */
export function instantListedPrices(): { tool: string; listed: string; unitMicros: number }[] {
  return Object.entries(TABLE).map(([tool, row]) => ({ tool, listed: row.listed, unitMicros: row.unitMicros }));
}

/** Whether a tool slug is one the table offers at all. */
export const isInstantTool = (tool: string): boolean => Object.prototype.hasOwnProperty.call(TABLE, tool);

// ---------- Exact money ----------

/**
 * A dollar amount as text ("0.007", "$0.007", 0.007) to whole micros, rounded UP, with exact decimal arithmetic (no floating point
 * on money). Null for anything that is not a plain non-negative decimal. A figure with more than six decimals rounds up, so a
 * charge is never read as less than it was.
 */
export function usdToMicros(value: unknown): number | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    // Numbers come as shortest round trip text; very small ones use exponent notation, which toFixed spells out
    text = value.toFixed(12);
  } else if (typeof value === 'string') {
    text = value.trim().replace(/^\$/, '');
  } else return null;
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]) * BigInt(1_000_000);
  const fraction = (match[2] ?? '').padEnd(12, '0');
  const micros = BigInt(fraction.slice(0, 6));
  const rest = BigInt(fraction.slice(6)) > BigInt(0) ? BigInt(1) : BigInt(0);
  const total = whole + micros + rest;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

/** The charge Composio reported for one run, in micros, from the shapes its docs and logs show: an object with an amount, or the amount itself. Null when it is not there or cannot be read (never zero). */
export function readInstantCharge(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (isRecord(value)) {
    const currency = value.currency ?? value.currency_code;
    if (typeof currency === 'string' && currency.toUpperCase() !== 'USD') return null;
    for (const key of ['amount', 'usd', 'total', 'charge', 'value']) {
      if (value[key] !== undefined) return usdToMicros(value[key]);
    }
    return null;
  }
  return usdToMicros(value);
}

/** The most a run may cost the person, from the top price: with the markup a super admin set (0 or none: the person pays Composio's charge as it is), rounded up. */
export function holdFor(topMicros: number, markupBps: number | null): number {
  const bps = markupBps ?? 0;
  return Number((BigInt(topMicros) * BigInt(10_000 + bps) + BigInt(9_999)) / BigInt(10_000));
}

/** What the person is charged for a charge of Composio's, never more than what was held. The part past the hold is ours. */
export function customerChargeFor(providerMicros: number, holdMicros: number, markupBps: number | null): number {
  const bps = markupBps ?? 0;
  const price = Number((BigInt(providerMicros) * BigInt(10_000 + bps) + BigInt(9_999)) / BigInt(10_000));
  return Math.min(price, holdMicros);
}

/** A stable fingerprint of what was asked, so two asks for the very same thing can be told apart from two different ones. Never the arguments themselves. */
export function argsFingerprint(tool: string, args: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify([tool, sort(args)])).digest('hex');
}

/**
 * The id a run is sent to Composio under. It is made from our run id and is nothing of a person's, so Composio's log of the run
 * can be found by it exactly and a lookup never has to guess from the tool and the time.
 */
export const providerUserIdFor = (runId: string): string => `universe-instant-${runId}`;

// ---------- Settings the executor works from ----------

/**
 * What a super admin sets for Instant (Limits). The money and the counts have no value until a real one is given, so each of them
 * starts empty and Instant refuses to run until they are all set, like a computer: nothing is assumed. The times carry a
 * recommended value, as the meter's renew time does.
 */
export interface InstantLimits {
  /** The most one run may cost, all fees included. A tool whose top price is above it is not offered. */
  maxRunMicros: number | null;
  /** The most our own exposure to Composio may reach: held for runs not finished, runs whose charge is not known, and the month's settled charges. */
  exposureCeilingMicros: number | null;
  /** Past this share (in basis points) of recent runs that ended as failures, Instant pauses itself. */
  pauseFailureRateBps: number | null;
  /** The fewest recent runs that rate is read from, so one failure out of two is not an alarm. */
  pauseMinRuns: number | null;
  /** The most that may be given back for "Didn't work" in a month, everyone together; empty means no goodwill give-backs. */
  goodwillBudgetMicros: number | null;
  /** The most one goodwill give-back may be; empty means none. */
  goodwillMaxMicros: number | null;
  /** The most give-backs one person may have in a month; empty means none. */
  goodwillPerPersonPerMonth: number | null;
  /** A share added to Composio's charge for what the person pays, in basis points. Empty: the person pays Composio's charge as it is. */
  markupBps: number | null;
  /** How long a run that went out and has no answer is waited for before it is looked up, in minutes. */
  sentWaitMinutes: number;
  /** How long an unclear run is looked up for before it is closed on what is known, in minutes. */
  unclearWaitMinutes: number;
  /** How long a charge not yet reported is waited for before it is settled at the top price, in minutes. */
  chargeWaitMinutes: number;
  /** How long failures are read over for the pause check, in minutes. */
  pauseWindowMinutes: number;
}

export const INSTANT_LIMITS_RECOMMENDED = { sentWaitMinutes: 5, unclearWaitMinutes: 30, chargeWaitMinutes: 60, pauseWindowMinutes: 60 };

export const INSTANT_LIMITS_EMPTY: InstantLimits = {
  maxRunMicros: null,
  exposureCeilingMicros: null,
  pauseFailureRateBps: null,
  pauseMinRuns: null,
  goodwillBudgetMicros: null,
  goodwillMaxMicros: null,
  goodwillPerPersonPerMonth: null,
  markupBps: null,
  ...INSTANT_LIMITS_RECOMMENDED,
};

/** The words a Limits row shows for each setting: its name, a hint, and the unit the number is in. The numbers are a super admin's, never ours. */
export const INSTANT_LIMIT_LABELS: Record<keyof InstantLimits, { label: string; hint: string; unit: 'micros' | 'bps' | 'count' | 'minutes' }> = {
  maxRunMicros: { label: 'Most one Instant run may cost', hint: 'Tools whose top price is above this are not offered. Includes Composio’s call fee.', unit: 'micros' },
  exposureCeilingMicros: { label: 'Most Instant may owe Composio', hint: 'Held for runs not finished, runs whose charge is not known yet, and the month’s settled charges. New runs stop at it.', unit: 'micros' },
  pauseFailureRateBps: { label: 'Pause Instant when this share of runs fail', hint: 'In hundredths of a percent (500 is 5%). Read over the failure window, once enough runs happened.', unit: 'bps' },
  pauseMinRuns: { label: 'Fewest runs before that check applies', hint: 'So one failure out of two runs is not an alarm.', unit: 'count' },
  goodwillBudgetMicros: { label: 'Most given back for “Didn’t work” in a month', hint: 'Everyone together, calendar month (UTC). Empty: nothing is given back for “Didn’t work”. A failure Universe sees is never charged, whatever this is.', unit: 'micros' },
  goodwillMaxMicros: { label: 'Most one give-back may be', hint: 'Empty: nothing is given back for “Didn’t work”.', unit: 'micros' },
  goodwillPerPersonPerMonth: { label: 'Give-backs one person may have in a month', hint: 'Empty: nothing is given back for “Didn’t work”.', unit: 'count' },
  markupBps: { label: 'Added to Composio’s charge for what the person pays', hint: 'In hundredths of a percent (1,000 is 10%). Empty: the person pays Composio’s charge as it is.', unit: 'bps' },
  sentWaitMinutes: { label: 'Wait before looking up a run with no answer', hint: 'Minutes.', unit: 'minutes' },
  unclearWaitMinutes: { label: 'How long an unclear run is looked up for', hint: 'Minutes, from when it went out. After that it is closed on what is known and the person’s hold goes back.', unit: 'minutes' },
  chargeWaitMinutes: { label: 'Wait for Composio’s charge', hint: 'Minutes. After that the top price stands as an estimate until the monthly check.', unit: 'minutes' },
  pauseWindowMinutes: { label: 'Failure window', hint: 'Minutes of recent runs the pause check reads.', unit: 'minutes' },
};

export const INSTANT_LIMIT_RANGES: Record<keyof InstantLimits, { min: number; max: number }> = {
  maxRunMicros: { min: 1, max: 1_000_000_000 },
  exposureCeilingMicros: { min: 1, max: 1_000_000_000_000_000 },
  pauseFailureRateBps: { min: 1, max: 10_000 },
  pauseMinRuns: { min: 1, max: 100_000 },
  goodwillBudgetMicros: { min: 0, max: 1_000_000_000_000_000 },
  goodwillMaxMicros: { min: 0, max: 1_000_000_000 },
  goodwillPerPersonPerMonth: { min: 0, max: 10_000 },
  markupBps: { min: 0, max: 100_000 },
  sentWaitMinutes: { min: 1, max: 1_440 },
  unclearWaitMinutes: { min: 1, max: 10_080 },
  chargeWaitMinutes: { min: 1, max: 10_080 },
  pauseWindowMinutes: { min: 1, max: 10_080 },
};

/** The settings a run cannot start without. */
export const INSTANT_NEEDED: (keyof InstantLimits)[] = ['maxRunMicros', 'exposureCeilingMicros', 'pauseFailureRateBps', 'pauseMinRuns'];

const fitsRange = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** Saved settings read back: each value that is there and fits, empty (or the recommended time) for the rest. */
export function readInstantLimits(saved: unknown): InstantLimits {
  const out: InstantLimits = { ...INSTANT_LIMITS_EMPTY };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(INSTANT_LIMIT_RANGES) as (keyof InstantLimits)[]) {
    if (fitsRange(saved[key], INSTANT_LIMIT_RANGES[key])) (out as unknown as Record<string, number>)[key] = saved[key] as number;
  }
  return out;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A change to the settings: only known names, each inside its range; null empties a money or count setting again. */
export function checkInstantLimits(input: unknown): Checked<Partial<Record<keyof InstantLimits, number | null>>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<Record<keyof InstantLimits, number | null>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(INSTANT_LIMIT_RANGES, key)) return { ok: false, error: `Unknown setting: ${key}` };
    const name = key as keyof InstantLimits;
    const timed = name in INSTANT_LIMITS_RECOMMENDED;
    if (value === null && !timed) {
      out[name] = null;
      continue;
    }
    if (!fitsRange(value, INSTANT_LIMIT_RANGES[name])) return { ok: false, error: `${key} must be a whole number from ${INSTANT_LIMIT_RANGES[name].min.toLocaleString('en')} to ${INSTANT_LIMIT_RANGES[name].max.toLocaleString('en')}` };
    out[name] = value;
  }
  return { ok: true, value: out };
}

export function missingInstantLimits(limits: InstantLimits): (keyof InstantLimits)[] {
  return INSTANT_NEEDED.filter((key) => limits[key] === null);
}

// ---------- What a run ended as ----------

/** What the caller (the bot server) is told, in fixed words: never a message from Composio. */
export type InstantReason =
  | 'not_set' // the limits are not set yet
  | 'paused' // Instant stopped itself or was stopped
  | 'rule' // a rule the owner said in chat says no (its own words are given)
  | 'not_offered' // no such tool in the table
  | 'unbounded' // these arguments cannot be held to a price
  | 'too_costly' // the top price is above the most one run may cost
  | 'exposure_full' // our own limit with the provider is reached
  | 'credit_used_up' // the person's Instant Apps credit does not cover it
  | 'credit_unavailable' // the credit books could not be read: nothing ran
  | 'not_owner' // only the Brick's owner's own requests run Instant
  | 'already_checking' // the very same ask is still being looked up
  | 'provider_off' // Composio refused: Instant is not switched on for the tool
  | 'provider_empty' // Composio's balance is empty
  | 'provider_failed' // it ran and did not work (nothing charged to the person)
  | 'invalid_request' // Composio did not accept the details, so it did not run (nothing charged to the person)
  | 'unclear'; // no answer: being looked up

export type InstantOutcome =
  | { status: 'done'; runId: string; ok: true; data: unknown; chargedMicros: number; pending: boolean; recovered?: boolean }
  | { status: 'failed'; runId: string; reason: InstantReason; message: string }
  | { status: 'checking'; runId: string }
  | { status: 'refused'; reason: InstantReason; runId?: string; leftMicros?: number | null; words?: string }
  | { status: 'already_done'; runId: string; chargedMicros: number | null; state: string };

/** Plain words for each reason, for the Brick to say. Never a provider message, never a price list. */
export const REASON_WORDS: Record<InstantReason, string> = {
  not_set: 'This is not available yet.',
  paused: 'This is paused for now.',
  rule: 'A rule you set says not to run that.',
  not_offered: 'That is not something I can run for you.',
  unbounded: 'I cannot say what that would cost, so I did not run it.',
  too_costly: 'That would cost more than one run may.',
  exposure_full: 'This is not available right now.',
  credit_used_up: 'Your Instant Apps credit does not cover it.',
  credit_unavailable: 'I cannot read your credit right now, so nothing ran.',
  not_owner: 'Only my owner can have me run that.',
  already_checking: 'I am still checking the same request.',
  provider_off: 'This is not available right now.',
  provider_empty: 'This is not available right now.',
  provider_failed: 'It did not work. You were not charged.',
  invalid_request: 'Those details were not accepted, so it did not run. You were not charged.',
  unclear: 'Checking whether it worked.',
};
