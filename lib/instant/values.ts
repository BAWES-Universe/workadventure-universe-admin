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

/** A run that nobody could vouch for when its wait ended: it was let go as failed, and whether it finished is not known (a receipt says that, never "didn't work"). */
export const isUnconfirmedRun = (run: { state: string; reason: string | null }): boolean => run.state === 'failed' && run.reason === 'unclear';

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
type ArgRule = ((value: unknown) => boolean) & {
  /** The same rule as a JSON Schema fragment, laid over the provider's own for that argument when the tool is offered. */
  schema?: Record<string, unknown>;
};

const withSchema = (rule: (value: unknown) => boolean, schema: Record<string, unknown>): ArgRule => Object.assign(rule, { schema });

/** Some character that is not a space: a text of only spaces is no text (`shortText` refuses it), and the length limits alone would let it through. */
const NOT_BLANK = '\\S';

const textArg: ArgRule = withSchema((v) => shortText(v) !== null, { type: 'string', minLength: 1, maxLength: MAX_TEXT, pattern: NOT_BLANK });
const flag = (only?: boolean): ArgRule => withSchema((v) => typeof v === 'boolean' && (only === undefined || v === only), only === undefined ? { type: 'boolean' } : { type: 'boolean', enum: [only] });
const whole = (min: number, max: number): ArgRule => withSchema((v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max, { type: 'integer', minimum: min, maximum: max });
const oneOf = (...allowed: string[]): ArgRule => withSchema((v) => typeof v === 'string' && allowed.includes(v), { type: 'string', enum: allowed });
const textList = (max: number): ArgRule =>
  withSchema((v) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((item) => shortText(item) !== null), { type: 'array', minItems: 1, maxItems: max, items: { type: 'string', minLength: 1, maxLength: MAX_TEXT, pattern: NOT_BLANK } });

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
export function instantAllowedArguments(tool: string): { names: string[]; required: string[]; constraints: Record<string, Record<string, unknown>>; anyOf?: string[][]; together?: { names: [string, string]; max: number } } | null {
  const rules = Object.prototype.hasOwnProperty.call(ALLOWED, tool) ? ALLOWED[tool] : undefined;
  if (rules) {
    const constraints = Object.fromEntries(Object.entries(rules.args).flatMap(([name, rule]) => (rule.schema ? [[name, rule.schema]] : [])));
    return { names: Object.keys(rules.args), required: rules.required, constraints };
  }
  // Exa's contents: pages come from `urls` or `ids` (at least one list, up to the most pages), so one of them is required, however the provider words it
  const pages = { type: 'array', minItems: 1, maxItems: MAX_URLS, items: { type: 'string', minLength: 1, maxLength: MAX_TEXT } };
  return tool === 'EXA_GET_CONTENTS_ACTION' ? { names: [...EXA_CONTENTS_KEYS], required: [], constraints: { urls: pages, ids: pages }, anyOf: [['urls'], ['ids']], together: { names: ['urls', 'ids'], max: MAX_URLS } } : null;
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
  // Each option is a flag or a small plain object, and the live-crawl timeout is a plain number: a long query inside `summary`, or a
  // string where a number goes, is not an argument the price was read for
  const optionOk = (value: unknown): boolean => value === undefined || value === null || typeof value === 'boolean' || (isRecord(value) && JSON.stringify(value).length <= MAX_TEXT);
  if (!['text', 'highlights', 'summary'].every((key) => optionOk(args[key]))) return null;
  if (args.livecrawl !== undefined && (typeof args.livecrawl !== 'string' || args.livecrawl.length > 20)) return null;
  if (args.livecrawl_timeout !== undefined && (typeof args.livecrawl_timeout !== 'number' || !Number.isFinite(args.livecrawl_timeout) || args.livecrawl_timeout < 0 || args.livecrawl_timeout > 120_000)) return null;
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
};

/**
 * The research Apps Universe runs on its own account (spec "Research Apps on by default", 26 Nov 2026). Every tool of the table belongs to one of
 * these, and each is ON for every Brick's owner with nothing to connect and no switch: a Brick searches the web from its first message, paid
 * from its owner's Instant Apps credit. Its name is what people see and connect by (the provider that runs it for Universe never is), and its
 * strength is the one line the Brick picks an App by and the Apps page shows under the name. Which of a person's own Apps is the same App (so
 * their own one wins and this one is not offered next to it) is decided by the one rule of lib/app-same.ts, from the key and the name.
 */
export interface InstantAppInfo {
  name: string;
  /** What kind of App it is, said to the Brick with each tool: only a `research` one gets the "search right away" instructions. */
  kind: 'research';
  strength: string;
}

export const INSTANT_APPS: Record<string, InstantAppInfo> = {
  exa: { name: 'Exa', kind: 'research', strength: 'Papers, companies and people' },
  tavily: { name: 'Tavily', kind: 'research', strength: 'Fresh news and quick facts' },
};

/** The App a toolkit of the table belongs to, or null when it has none (a row without an App is never offered). */
export const instantAppOf = (toolkit: string): InstantAppInfo | null => (Object.prototype.hasOwnProperty.call(INSTANT_APPS, toolkit) ? INSTANT_APPS[toolkit] : null);

/**
 * The call fee Composio adds to a managed-account tool run (its rate card tier for the app) and the direct execution add-on. Every
 * tool of the table is in "all other managed apps" ($0.0005), a settled figure. An app whose rate card figure is only a floor (Google
 * Maps is "from $0.01", varying by API) has no row: a floor is not a top price, and it comes back once Composio states a maximum.
 */
function feeMicros(): number {
  return RATE_MICROS.managed_other + DIRECT_EXECUTION_MICROS;
}

/**
 * What Composio's call fee comes to for one run (the money call of 26 Nov 2026: the fee is counted against the person's own credit). A run whose
 * App charges nothing (a free search, or one during the provider's discount) still costs Universe this fee, so it is taken from the person's
 * Instant Apps credit like any other charge: each person's own credit bounds how many runs they have, and one heavy user can never use up
 * what everyone shares. It is inside every run's top price, so it is always held before the run.
 */
export const instantCallFeeMicros = (): number => feeMicros();

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
  const topMicros = units * row.unitMicros + feeMicros();
  if (!Number.isSafeInteger(topMicros) || topMicros < 1) return { ok: false, reason: 'unbounded' };
  return { ok: true, tool, toolkit: row.toolkit, topMicros, priceVersion: INSTANT_PRICE_VERSION, units };
}

/** What Universe offers: each tool's slug and app, and the most one run of the simplest kind costs (for a list, never for holding a run). */
export function instantCatalog(): { tool: string; toolkit: string; fromMicros: number }[] {
  return Object.entries(TABLE).map(([tool, row]) => ({ tool, toolkit: row.toolkit, fromMicros: row.unitMicros + feeMicros() }));
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
    // The shortest text that reads back as the same number, never rounded to a set number of places (a tiny positive amount stays positive)
    text = plainDecimal(String(value));
  } else if (typeof value === 'string') {
    text = value.trim().replace(/^\$/, '');
  } else return null;
  const match = /^(\d{1,12})(?:\.(\d{1,40}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]) * BigInt(1_000_000);
  const fraction = (match[2] ?? '').padEnd(6, '0');
  const micros = BigInt(fraction.slice(0, 6));
  // Anything at all past the sixth decimal rounds the charge UP
  const rest = /[1-9]/.test(fraction.slice(6)) ? BigInt(1) : BigInt(0);
  const total = whole + micros + rest;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

/** A number's text without an exponent ("1e-13" is "0.0000000000001"), digit for digit. */
function plainDecimal(text: string): string {
  const lower = text.toLowerCase();
  if (!lower.includes('e')) return lower;
  const [mantissa, exponent] = lower.split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** The charge Composio reported for one run, in micros, from the shapes its docs and logs show: an object with an amount, or the amount itself. Null when it is not there or cannot be read (never zero). */
export function readInstantCharge(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (isRecord(value)) {
    // A currency that is there must be USD said in words: a code in any other shape (a number) is not known to be dollars
    const currency = value.currency ?? value.currency_code;
    if (currency !== undefined && currency !== null && (typeof currency !== 'string' || currency.trim().toUpperCase() !== 'USD')) return null;
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

/**
 * What the person is charged for a run that worked: Composio's charge for the tool plus its call fee (`instantCallFeeMicros`), with the markup a
 * super admin set, never more than what was held. The part past the hold is ours. A run that did not work is never charged at all (its hold
 * goes back), so the fee is only ever taken for a run that answered.
 */
export function customerChargeFor(providerMicros: number, holdMicros: number, markupBps: number | null): number {
  const bps = markupBps ?? 0;
  const cost = BigInt(providerMicros) + BigInt(feeMicros());
  const price = Number((cost * BigInt(10_000 + bps) + BigInt(9_999)) / BigInt(10_000));
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
  /**
   * The most Instant runs one question may have (one chat turn: one task), so a Brick that tries another research App on thin results stops
   * somewhere. Empty: no bound per question (each run is still bounded by the person's credit and the ceiling).
   */
  maxRunsPerQuestion: number | null;
  /** How long a run that went out and has no answer is waited for before it is looked up, in minutes. */
  sentWaitMinutes: number;
  /** How long an unclear run is looked up for before it is closed on what is known, in minutes. */
  unclearWaitMinutes: number;
  /** How long a run whose log Composio cannot be asked for is waited on before the person's hold is let go, in minutes. */
  unreachableWaitMinutes: number;
  /** How long a charge not yet reported is waited for before it is settled at the top price, in minutes. */
  chargeWaitMinutes: number;
  /** How long failures are read over for the pause check, in minutes. */
  pauseWindowMinutes: number;
}

export const INSTANT_LIMITS_RECOMMENDED = { sentWaitMinutes: 5, unclearWaitMinutes: 30, unreachableWaitMinutes: 1_440, chargeWaitMinutes: 60, pauseWindowMinutes: 60 };

export const INSTANT_LIMITS_EMPTY: InstantLimits = {
  maxRunMicros: null,
  exposureCeilingMicros: null,
  pauseFailureRateBps: null,
  pauseMinRuns: null,
  goodwillBudgetMicros: null,
  goodwillMaxMicros: null,
  goodwillPerPersonPerMonth: null,
  markupBps: null,
  maxRunsPerQuestion: null,
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
  maxRunsPerQuestion: { label: 'Most research runs for one question', hint: 'A Brick may try another research App when the first answer is thin; it stops here. Counts every run of one chat turn. Empty: no bound per question.', unit: 'count' },
  sentWaitMinutes: { label: 'Wait before looking up a run with no answer', hint: 'Minutes.', unit: 'minutes' },
  unclearWaitMinutes: { label: 'How long an unclear run is looked up for', hint: 'Minutes, from when it went out. After that it is closed on what is known and the person’s hold goes back.', unit: 'minutes' },
  unreachableWaitMinutes: { label: 'How long to wait when Composio’s log cannot be reached', hint: 'Minutes, from when the run went out. After that the person’s hold is given back (they are never charged for it later), the cost is ours, and the Costs report says it was released unconfirmed.', unit: 'minutes' },
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
  maxRunsPerQuestion: { min: 1, max: 1_000 },
  sentWaitMinutes: { min: 1, max: 1_440 },
  // Longer than the 60 seconds a request to Composio may take, so the sweep never closes a run whose answer is still on its way
  unclearWaitMinutes: { min: 2, max: 10_080 },
  // Never shorter than the time an unclear run is looked up for
  unreachableWaitMinutes: { min: 60, max: 43_200 },
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
  | 'credit_not_given' // the person was not given Instant Apps credit this period (the month's budget ran out) and has none
  | 'credit_unavailable' // the credit books could not be read: nothing ran
  | 'not_owner' // only the Brick's owner's own requests run Instant
  | 'already_checking' // the very same ask is still being looked up
  | 'question_limit' // this question already had the most runs one question may have
  | 'no_question' // a bound per question is set and the run named no question, so it could not be counted
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
  credit_not_given: 'Research on Universe’s account isn’t available right now. Your own free account on Apps has no Universe limit.',
  credit_unavailable: 'I cannot read your credit right now, so nothing ran.',
  not_owner: 'Only my owner can have me run that.',
  already_checking: 'I am still checking the same request.',
  question_limit: 'That is as many look-ups as I do for one question.',
  no_question: 'That could not run because it was not asked as part of a question.',
  provider_off: 'This is not available right now.',
  provider_empty: 'This is not available right now.',
  provider_failed: 'It did not work. You were not charged.',
  invalid_request: 'Those details were not accepted, so it did not run. You were not charged.',
  unclear: 'Checking whether it worked.',
};

/** What a run says once the wait to look it up is over and nobody could confirm it: the person's hold is given back, and it is never charged to them later. */
export const UNCONFIRMED_WORDS = 'We couldn’t confirm this one, so you weren’t charged.';

/** Words for a run that ended failed: an unconfirmed one (reason unclear) is not called a failure, and says the person was not charged. */
export function failedWords(reason: InstantReason): string {
  return reason === 'unclear' ? UNCONFIRMED_WORDS : REASON_WORDS[reason];
}
