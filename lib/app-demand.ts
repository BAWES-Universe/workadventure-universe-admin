import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { adapterIsOn } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { readRoute, type AppRouteName } from '@/lib/app-routes';
import { ownVersionFor, whyNotReady } from '@/lib/app-routes/own-versions';
import { instantReportingGaps, instantRunsUnsettled } from '@/lib/instant/report';

/**
 * "Apps: use and demand" (spec "Paying for Apps", section 22): which Apps people use, how many people, what each costs us, how
 * often it fails, what it runs on, and which App names people asked for that are not there yet. Everything is read from the
 * meter's books (`meter_events` kind app_use, the outcomes written beside them) and the counted App names; no new tracking in
 * chat, and nothing per person beyond counts.
 */

const DAY = 24 * 60 * 60 * 1000;
export const DEMAND_DEFAULT_DAYS = 30;
export const DEMAND_MAX_DAYS = 366;
/** The Apps shown as asked for, most asked first; the rest are counted, not listed. */
const ASKED_SHOWN = 50;

const toNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

export interface AppRow {
  key: string;
  name: string;
  /** `instant` for an App that works without connecting anything (it takes the person's Instant Apps credit); `own` for an App on the person's own account. */
  kind: 'instant' | 'own';
  uses: number;
  people: number;
  /** What it cost us, in millionths of a dollar: the sum of the priced runs. Null when none of its runs has a price. */
  costMicros: number | null;
  /** Runs with no price yet (counted apart, never as 0). */
  unpriced: number;
  /** Runs whose ending is known, and how many of them failed. A run with no recorded ending is in neither. */
  ended: number;
  failed: number;
  /** What a failed run gave back to the person. Null until a refund is recorded for every failed run; never guessed. */
  refundedMicros: number | null;
  allFailedRefunded: boolean;
  /** Uses and cost by the route the run took. */
  /** Uses and cost per route. `costMicros` is null when none of that route's runs has a price; `unpriced` counts the runs with none, so a partly known cost is never shown as the whole. */
  byRoute: Record<AppRouteName, { uses: number; costMicros: number | null; unpriced: number }>;
  route: AppRouteName;
  routeVersion: number;
  routeChangedAt: string | null;
  /** Our own version: whether the App can move to it, why not when it cannot, when it passed its checks, and its top price per tool run. */
  own: { ready: boolean; why: string[]; passedChecksOn: string | null; topPriceMicros: number | null };
  /** At most what the Composio-route uses of these days would have cost us on our own version; null when there is no own version to price it with. */
  onOwnVersionAtMostMicros: number | null;
}

export interface AskRow {
  name: string;
  times: number;
  people: number;
}

/**
 * How far to trust the cost to us. `measured`: every use is priced with a figure the provider gave. `estimated`: every use is priced, some with our own estimate.
 * `incomplete`: the total is a part of the cost: some uses have no price yet, some runs are not settled with the provider, or a usage event is missing or does not
 * agree with its run yet (the sweep mends those). Said next to the total, so a part is never read as the whole.
 */
export interface CostCompleteness {
  state: 'measured' | 'estimated' | 'incomplete' | 'correcting';
  /** Uses with no price yet. */
  unpriced: number;
  /** Uses priced with an estimate. */
  estimated: number;
  /** Runs the total does not hold yet: not settled with the provider, or settled with no usage event yet. */
  notCounted: number;
  /** Runs the total holds at another cost than the run's own: counted, and being corrected by the sweep. */
  mismatched: number;
}

export interface DemandReport {
  from: string;
  to: string;
  days: number;
  totals: { uses: number; people: number; costMicros: number; asks: number; cost: CostCompleteness };
  apps: AppRow[];
  asked: AskRow[];
  /** Asked-for Apps past the ones listed. */
  askedMore: number;
}

type Group = {
  key: string;
  uses: bigint;
  people: number;
  cost: bigint | null;
  priced: number;
  unpriced: number;
  instant: boolean;
  ended: number;
  failed: number;
  refunded: bigint | null;
  failed_refunded: number;
  composio_uses: bigint;
  composio_cost: bigint | null;
  universe_uses: bigint;
  universe_cost: bigint | null;
  composio_unpriced: number;
  universe_unpriced: number;
};

function completenessOf(input: { unpriced: number; estimated: number; notCounted: number; mismatched: number }): CostCompleteness {
  const state = input.unpriced > 0 || input.notCounted > 0 ? 'incomplete' : input.mismatched > 0 ? 'correcting' : input.estimated > 0 ? 'estimated' : 'measured';
  return { state, ...input };
}

/** The report for the last `days` whole UTC days up to now (today counts). */
export async function demandReport(days: number = DEMAND_DEFAULT_DAYS, now: Date = new Date()): Promise<DemandReport> {
  const span = Math.min(Math.max(Math.floor(days), 1), DEMAND_MAX_DAYS);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today.getTime() - (span - 1) * DAY);
  const inRange = Prisma.sql`e.occurred_at >= ${from} AND e.occurred_at <= ${now}`;

  // The uses, the total and what the total is missing are read from ONE snapshot: a repair that lands between them must not show a cost that was
  // counted before it with a completeness that was read after it (it would read as whole while it is not). All of it is before the repair, or all after.
  const [listed, [groups, totalRows, gaps, unsettled]] = await Promise.all([
    // The App list: the names a use is shown under (always, so the use of an App keeps its name while Apps are off), and the Apps people can pick from
    // (only while Apps are on at all, below)
    readReadyMadeApps(),
    prisma.$transaction(
      async (tx) => {
        // A free lookup is written with quantity 0: it is not a use, so it never counts here (the same rule as the Costs page)
        const byApp = await tx.$queryRaw<Group[]>(Prisma.sql`
      SELECT e.detail->>'toolkit' AS key,
        COALESCE(SUM(e.quantity), 0)::bigint AS uses,
        (COUNT(DISTINCT e.person_key))::int AS people,
        SUM(e.cost_micros)::bigint AS cost,
        (COUNT(*) FILTER (WHERE e.cost_micros IS NOT NULL))::int AS priced,
        (COUNT(*) FILTER (WHERE e.cost_micros IS NULL))::int AS unpriced,
        COALESCE(BOOL_OR(e.detail->>'instant' = 'true'), FALSE) AS instant,
        (COUNT(o.event_id))::int AS ended,
        (COUNT(o.event_id) FILTER (WHERE o.outcome = 'failed'))::int AS failed,
        SUM(o.refunded_micros) FILTER (WHERE o.outcome = 'failed')::bigint AS refunded,
        (COUNT(o.event_id) FILTER (WHERE o.outcome = 'failed' AND o.refunded_micros IS NOT NULL))::int AS failed_refunded,
        COALESCE(SUM(e.quantity) FILTER (WHERE COALESCE(e.detail->>'provider', 'composio') = 'composio'), 0)::bigint AS composio_uses,
        SUM(e.cost_micros) FILTER (WHERE COALESCE(e.detail->>'provider', 'composio') = 'composio')::bigint AS composio_cost,
        (COUNT(*) FILTER (WHERE COALESCE(e.detail->>'provider', 'composio') = 'composio' AND e.cost_micros IS NULL))::int AS composio_unpriced,
        COALESCE(SUM(e.quantity) FILTER (WHERE e.detail->>'provider' = 'universe'), 0)::bigint AS universe_uses,
        SUM(e.cost_micros) FILTER (WHERE e.detail->>'provider' = 'universe')::bigint AS universe_cost,
        (COUNT(*) FILTER (WHERE e.detail->>'provider' = 'universe' AND e.cost_micros IS NULL))::int AS universe_unpriced
      FROM meter_events e LEFT JOIN app_use_outcomes o ON o.event_id = e.event_id
      WHERE e.kind = 'app_use' AND e.quantity > 0 AND e.detail->>'toolkit' IS NOT NULL AND ${inRange}
      GROUP BY e.detail->>'toolkit'`);
        const all = await tx.$queryRaw<{ uses: bigint; people: number; cost: bigint; unpriced: number; estimated: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(e.quantity), 0)::bigint AS uses, (COUNT(DISTINCT e.person_key))::int AS people, COALESCE(SUM(e.cost_micros), 0)::bigint AS cost,
        (COUNT(*) FILTER (WHERE e.cost_micros IS NULL))::int AS unpriced, (COUNT(*) FILTER (WHERE e.cost_micros IS NOT NULL AND e.basis = 'estimated'))::int AS estimated
      FROM meter_events e WHERE e.kind = 'app_use' AND e.quantity > 0 AND ${inRange}`);
        // Instant runs the books do not hold (yet) or hold wrongly: an event no row can show is missing from the count above, so it is looked for in the runs themselves
        const missing = await instantReportingGaps({ from, to: now }, tx);
        const waiting = await instantRunsUnsettled({ from, to: now }, tx);
        return [byApp, all, missing, waiting] as const;
      },
      // Four scans of the books one after the other: the 5 s a transaction gets by default is too short once the books are large, and a report that fails
      // to draw is worse than one that takes a few seconds
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 },
    ),
  ]);

  // Asks for an App that is there now (it was asked for while Apps were off, or before it was added) are not demand any more: they are
  // taken out first, in the query, so what is listed, counted and "more" are all about Apps that are not there (the rule appExists keeps)
  const pickable = adapterIsOn() ? listed : [];
  const there = await availableAsks(pickable);
  const [askRows, askTotals] = await Promise.all([
    prisma.$queryRaw<{ name: string; times: bigint; people: number }[]>(Prisma.sql`
      SELECT (ARRAY_AGG(name ORDER BY day DESC))[1] AS name, SUM(times)::bigint AS times, (COUNT(DISTINCT person_key))::int AS people
      FROM app_asks WHERE day >= ${from}::date AND name_key <> ALL(${there.keys}::text[]) AND regexp_replace(name_key, '[^a-z0-9]+', '', 'g') <> ALL(${there.slugs}::text[])
      GROUP BY name_key ORDER BY SUM(times) DESC, COUNT(DISTINCT person_key) DESC, name_key LIMIT ${ASKED_SHOWN}`),
    prisma.$queryRaw<{ names: number; times: bigint }[]>(Prisma.sql`
      SELECT (COUNT(DISTINCT name_key))::int AS names, COALESCE(SUM(times), 0)::bigint AS times FROM app_asks
      WHERE day >= ${from}::date AND name_key <> ALL(${there.keys}::text[]) AND regexp_replace(name_key, '[^a-z0-9]+', '', 'g') <> ALL(${there.slugs}::text[])`),
  ]);

  const names = new Map(listed.map((app) => [app.key, app.name]));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const keys = new Set<string>([...byKey.keys(), ...pickable.filter((app) => app.enabled).map((app) => app.key)]);

  const apps: AppRow[] = [];
  for (const key of keys) {
    const group = byKey.get(key);
    const state = await readRoute(key);
    const own = ownVersionFor(key);
    const why = whyNotReady(key);
    const composioUses = toNumber(group?.composio_uses);
    apps.push({
      key,
      name: names.get(key) ?? key,
      kind: group?.instant ? 'instant' : 'own',
      uses: toNumber(group?.uses),
      people: group?.people ?? 0,
      costMicros: group && group.priced > 0 ? toNumber(group.cost) : null,
      unpriced: group?.unpriced ?? 0,
      ended: group?.ended ?? 0,
      failed: group?.failed ?? 0,
      refundedMicros: group && group.failed > 0 && group.failed_refunded === group.failed ? toNumber(group.refunded) : null,
      allFailedRefunded: !!group && group.failed > 0 && group.failed_refunded === group.failed,
      byRoute: {
        composio: { uses: composioUses, costMicros: group?.composio_cost == null ? null : toNumber(group.composio_cost), unpriced: group?.composio_unpriced ?? 0 },
        universe: { uses: toNumber(group?.universe_uses), costMicros: group?.universe_cost == null ? null : toNumber(group.universe_cost), unpriced: group?.universe_unpriced ?? 0 },
      },
      route: state.route,
      routeVersion: state.version,
      routeChangedAt: state.changedAt ? state.changedAt.toISOString() : null,
      own: { ready: why.length === 0, why, passedChecksOn: own?.passedChecksOn ?? null, topPriceMicros: own?.topPriceMicros ?? null },
      onOwnVersionAtMostMicros: own && own.topPriceMicros !== null ? composioUses * own.topPriceMicros : null,
    });
  }
  // Most costly to us first; an App with no priced runs after those that have, then the most used, then by name
  apps.sort((a, b) => (b.costMicros ?? -1) - (a.costMicros ?? -1) || b.uses - a.uses || a.name.localeCompare(b.name));

  const asked = askRows.map((row) => ({ name: row.name, times: toNumber(row.times), people: row.people }));
  const totals = totalRows[0];
  return {
    from: from.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
    days: span,
    totals: { uses: toNumber(totals?.uses), people: totals?.people ?? 0, costMicros: toNumber(totals?.cost), asks: toNumber(askTotals[0]?.times), cost: completenessOf({ unpriced: totals?.unpriced ?? 0, estimated: totals?.estimated ?? 0, notCounted: gaps.missing + unsettled, mismatched: gaps.costWrong }) },
    apps,
    asked,
    askedMore: Math.max((askTotals[0]?.names ?? 0) - asked.length, 0),
  };
}

// ---------- "Asked for, not available yet" ----------

/** The longest App name kept, and the most words in one: an App's name is short, so anything longer is a sentence, and a sentence is never kept. */
export const ASK_NAME_MAX = 60;
export const ASK_WORDS_MAX = 5;
/** Per person and day, so one Brick in a loop cannot pump a count: the same App this many times, and this many different Apps. */
const ASK_TIMES_PER_DAY = 25;
const ASK_NAMES_PER_DAY = 20;

const NAME_SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .&'+\-/]*$/u;

/** The App name to count, or null when it is not an App name (empty, too long, a link, an email, or reads like a sentence). */
export function cleanAskName(raw: unknown): { name: string; key: string } | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > ASK_NAME_MAX) return null;
  if (name.split(' ').length > ASK_WORDS_MAX) return null;
  if (!NAME_SHAPE.test(name)) return null;
  if (/https?:|www\.|@/i.test(name)) return null;
  // The key is what asks are grouped by: lower case, and without accents or other marks, so "Café", "CAFÉ" and "cafe" are one App.
  // Lowercasing can make a name longer (İ becomes two characters before its mark is dropped), so the key is also cut to the width
  // of its column, counted in characters (code points), never in the middle of one.
  return { name, key: askKey(name) };
}

/** The grouping key of an App name: lower case, no accents or marks, cut to the column width in whole characters. */
function askKey(name: string): string {
  return Array.from(name.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')).slice(0, ASK_NAME_MAX).join('');
}

const hashOf = (personKey: string) => createHash('sha256').update(`app-ask:${personKey}`).digest('hex').slice(0, 32);

export type AskOutcome = { counted: true } | { counted: false; reason: 'not_a_name' | 'exists' | 'limit' };

/**
 * Counts one ask for an App that is not there. Only the name goes in the books, never anything a person wrote; the person is kept
 * only as a one-way hash so different people can be counted. An App that IS there (listed and on) is not counted, so the page
 * never shows demand for something we already have.
 */
export async function recordAppAsk(input: { name: unknown; personKey: string }, now: Date = new Date()): Promise<AskOutcome> {
  const cleaned = cleanAskName(input.name);
  if (!cleaned) return { counted: false, reason: 'not_a_name' };
  if (await appExists(cleaned.key)) return { counted: false, reason: 'exists' };
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const personKey = hashOf(input.personKey);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`app-ask:${personKey}`}, 0))`;
    const mine = await tx.appAsk.findMany({ where: { day, personKey }, select: { nameKey: true, times: true } });
    const same = mine.find((row) => row.nameKey === cleaned.key);
    if (same ? same.times >= ASK_TIMES_PER_DAY : mine.length >= ASK_NAMES_PER_DAY) return { counted: false as const, reason: 'limit' as const };
    await tx.appAsk.upsert({
      where: { day_nameKey_personKey: { day, nameKey: cleaned.key, personKey } },
      create: { day, nameKey: cleaned.key, name: cleaned.name, personKey },
      update: { times: { increment: 1 } },
    });
    return { counted: true as const };
  });
}

const slugOf = (key: string) => key.replace(/[^a-z0-9]+/g, '');

/**
 * The names (as ask keys) and keys (without marks) of the Apps a person can use now: a ready-made App that is on (only while the
 * provider is: with it off it cannot be used, so asking for one still counts), and an entry of the super admin's list that is on.
 */
async function availableAsks(ready: { name: string; key: string; enabled: boolean }[]): Promise<{ keys: string[]; slugs: string[] }> {
  const entries = await prisma.appCatalogEntry.findMany({ where: { enabled: true }, select: { key: true, name: true } });
  const there = [...ready.filter((app) => app.enabled), ...entries];
  return { keys: there.map((app) => askKey(app.name)), slugs: there.map((app) => slugOf(app.key)) };
}

/** Whether an App of that name or key is already on a list a person can use. */
async function appExists(key: string): Promise<boolean> {
  const there = await availableAsks(adapterIsOn() ? await readReadyMadeApps() : []);
  return there.keys.includes(key) || there.slugs.includes(slugOf(key));
}
