import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { pickRunning } from '@/lib/meter-grants';
import { extraDrawn, monthOf, type GrantWindow } from '@/lib/meter-values';
import { wokaLayersForMany } from '@/lib/woka-avatar';

/**
 * What Universe AI costs us, from the meter's books (game #1999): our count, by person, by Brick, by what a Brick did, guests
 * by universe and by day, who asked for more and what was given. Every figure comes from what was recorded: nothing here is a
 * price from memory, and an event whose price is not known is counted apart, never as 0.
 *
 * "Their figure" is what the provider has settled so far (`settledAt`, set when its settlement covered the event): the books have
 * no feed of a provider's bill itself, so that is the honest thing to put beside our count.
 */

export type Sure = 'Measured' | 'Estimated' | 'Paid by someone else' | 'Unknown';

const toNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

/** How sure a group of figures is: the weakest of what was priced; paid by someone else when that is all there is; unknown when nothing has a price. */
export function sureOf(counts: { measured: number; estimated: number; unpriced: number; others: number }): Sure {
  const ours = counts.measured + counts.estimated + counts.unpriced;
  if (ours === 0) return counts.others > 0 ? 'Paid by someone else' : 'Unknown';
  if (counts.measured + counts.estimated === 0) return 'Unknown';
  if (counts.unpriced > 0 || counts.estimated > 0) return 'Estimated';
  return 'Measured';
}

export interface GoesRow {
  key: 'models' | 'voice' | 'computers' | 'apps' | 'files';
  title: string;
  /** Our count, in millionths of a dollar; null when the price is not known. */
  ourMicros: number | null;
  /** What the provider has settled so far. */
  settledMicros: number | null;
  /** App uses, for the row that counts uses; bytes for the row that keeps files. */
  uses: number | null;
  bytes: number | null;
  /** Events with no price yet. */
  unpriced: number;
  sure: Sure;
}

export interface PersonRow {
  id: string;
  name: string;
  woka: string[];
  costMicros: number;
  bricks: number;
  replies: number;
  appUses: number;
  computerSeconds: number;
  extraUntil: string | null;
}

export interface BrickRow {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  costMicros: number;
  replies: number;
  appUses: number;
  computerSeconds: number;
  /** Replies it ran on someone's own key, which we do not pay. */
  ownKeyReplies: number;
  sure: Sure;
}

export interface WayRow {
  key: 'answered' | 'app' | 'computer';
  title: string;
  costMicros: number;
  replies: number;
  appUses: number;
  jobs: number;
  computerSeconds: number;
}

export interface GuestRow {
  universeKey: string;
  name: string;
  guests: number;
  replies: number;
  costMicros: number;
}

export interface DayRow {
  day: string;
  people: number;
  costMicros: number;
}

export interface AskedRow {
  personId: string;
  name: string;
  woka: string[];
  askedAt: string;
}

export interface GivenRow {
  grantKey: string;
  personId: string;
  name: string;
  woka: string[];
  multiplier: number | null;
  noLimit: boolean;
  startsAt: string;
  endsAt: string;
  ended: boolean;
  givenByName: string;
  settlement: 'gift' | 'to_bill';
  billedAt: string | null;
  note: string | null;
  /** What it has cost us above the usual allowance so far, from computer spending. */
  aboveUsualMicros: number;
}

export interface CostsReport {
  from: string;
  to: string;
  totals: { costMicros: number; people: number; guests: number; bricks: number; computers: number };
  goes: GoesRow[];
  people: { rows: PersonRow[]; total: number; more: { count: number; costMicros: number } };
  bricks: { rows: BrickRow[]; total: number; more: { count: number; costMicros: number } };
  ways: WayRow[];
  guests: GuestRow[];
  days: DayRow[];
  asked: AskedRow[];
  /** How many more are waiting than the list shows. */
  askedMore: number;
  given: GivenRow[];
}

/** How many people and Bricks are listed one by one; the rest are counted in one line. */
/** How many of the grants that already ended the given list keeps, beside the ones running and the ones still to bill. */
export const GIVEN_RECENT = 50;
export const COSTS_LISTED = 10;
/** How many people waiting for more are listed one by one; the rest are counted, and show as these are answered. */
export const ASKED_LISTED = 200;

const DAY = 24 * 60 * 60 * 1000;

/** A date as "2026-11-04" read as the first moment of that day, UTC; null when it is not one. */
export function readDay(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // 2026-02-30 would roll over to 2 March, which is a different day from the one asked for
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

type GrantRow = { grantKey: string; startsAt: Date; endsAt: Date; multiplier: number | null; noLimit: boolean };

const grantWindow = (grant: GrantRow): GrantWindow => ({
  key: grant.grantKey,
  startsAt: grant.startsAt,
  endsAt: grant.endsAt,
  multiplier: grant.noLimit ? null : grant.multiplier,
});

/** The months (UTC) a person's extra usages span, up to now: from the first moment any of them began to the last they ran. */
function grantSpan(grants: GrantRow[], now: Date): { first: Date; last: Date } {
  return {
    first: new Date(Math.min(...grants.map((grant) => grant.startsAt.getTime()))),
    last: new Date(Math.min(now.getTime(), Math.max(...grants.map((grant) => grant.endsAt.getTime())))),
  };
}

/**
 * What each of a person's extra usages has cost us above the usual allowance: the computer spending the allowance drew from
 * it, month by month (the usual allowance starts again each month), worked out by the same walk the allowance uses. `events` are
 * that person's computer costs over the whole span of their grants, read once for everyone (see `costsReport`).
 */
function aboveUsual(base: number | null, grants: GrantRow[], events: { occurredAt: Date; costMicros: bigint | number | null }[], now: Date): number[] {
  if (base === null || grants.length === 0) return grants.map(() => 0);
  const windows = grants.map(grantWindow);
  const { first, last } = grantSpan(grants, now);
  const totals = grants.map(() => 0);
  for (let month = monthOf(first); month.start <= last; month = monthOf(month.end)) {
    const inMonth = events.filter((event) => event.occurredAt >= month.start && event.occurredAt < month.end);
    const drawn = extraDrawn(base, inMonth.map((event) => ({ at: event.occurredAt, micros: toNumber(event.costMicros) })), windows);
    drawn.forEach((micros, index) => (totals[index] += micros));
  }
  return totals;
}

type Group = { kind: string; ours: bigint; settled: bigint; uses: bigint; measured: number; estimated: number; unpriced: number; others: number };

/** The costs page's figures for a range of days (both ends included, UTC). */
export async function costsReport(from: Date, to: Date, now: Date = new Date()): Promise<CostsReport> {
  const until = new Date(to.getTime() + DAY);
  const inRange = Prisma.sql`occurred_at >= ${from} AND occurred_at < ${until}`;

  const [groups, headline, peopleRows, brickRows, ways, guestRows, dayRows, guestDays, kept, settings] = await Promise.all([
    prisma.$queryRaw<Group[]>(Prisma.sql`
      SELECT kind,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe'), 0)::bigint AS ours,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe' AND settled_at IS NOT NULL), 0)::bigint AS settled,
        COALESCE(SUM(quantity) FILTER (WHERE kind = 'app_use'), 0)::bigint AS uses,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND basis = 'measured'))::int AS measured,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND basis = 'estimated'))::int AS estimated,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND cost_micros IS NULL))::int AS unpriced,
        (COUNT(*) FILTER (WHERE payer_kind <> 'universe'))::int AS others
      FROM meter_events WHERE ${inRange} GROUP BY kind`),
    prisma.$queryRaw<{ people: number; guests: number; bricks: number; computers: number }[]>(Prisma.sql`
      SELECT
        (COUNT(DISTINCT person_key) FILTER (WHERE person_key LIKE 'person:%'))::int AS people,
        (COUNT(DISTINCT person_key) FILTER (WHERE person_key LIKE 'guest:%'))::int AS guests,
        (COUNT(DISTINCT bot_id) FILTER (WHERE brick IS TRUE))::int AS bricks,
        (COUNT(DISTINCT bot_id) FILTER (WHERE pool = 'computer' AND brick IS TRUE))::int AS computers
      FROM meter_events WHERE ${inRange}`),
    prisma.$queryRaw<{ person_id: string; cost: bigint; bricks: number; replies: number; uses: bigint; seconds: bigint }[]>(Prisma.sql`
      SELECT person_id,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe'), 0)::bigint AS cost,
        (COUNT(DISTINCT bot_id) FILTER (WHERE brick IS TRUE))::int AS bricks,
        (COUNT(*) FILTER (WHERE kind = 'model_call' AND COALESCE(detail->>'error', 'false') <> 'true' AND COALESCE(detail->>'greeting', 'false') <> 'true'))::int AS replies,
        COALESCE(SUM(quantity) FILTER (WHERE kind = 'app_use'), 0)::bigint AS uses,
        COALESCE(SUM(CASE unit WHEN 'second' THEN quantity WHEN 'minute' THEN quantity * 60 ELSE 0 END) FILTER (WHERE kind = 'computer_time'), 0)::bigint AS seconds
      FROM meter_events WHERE ${inRange} AND person_id IS NOT NULL GROUP BY person_id ORDER BY cost DESC, person_id`),
    prisma.$queryRaw<{ bot_id: string; cost: bigint; replies: number; uses: bigint; seconds: bigint; own: number; measured: number; estimated: number; unpriced: number; others: number }[]>(Prisma.sql`
      SELECT bot_id,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe'), 0)::bigint AS cost,
        (COUNT(*) FILTER (WHERE kind = 'model_call' AND COALESCE(detail->>'error', 'false') <> 'true' AND COALESCE(detail->>'greeting', 'false') <> 'true'))::int AS replies,
        COALESCE(SUM(quantity) FILTER (WHERE kind = 'app_use'), 0)::bigint AS uses,
        COALESCE(SUM(CASE unit WHEN 'second' THEN quantity WHEN 'minute' THEN quantity * 60 ELSE 0 END) FILTER (WHERE kind = 'computer_time'), 0)::bigint AS seconds,
        (COUNT(*) FILTER (WHERE kind = 'model_call' AND payer_kind <> 'universe'))::int AS own,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND basis = 'measured'))::int AS measured,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND basis = 'estimated'))::int AS estimated,
        (COUNT(*) FILTER (WHERE payer_kind = 'universe' AND cost_micros IS NULL))::int AS unpriced,
        (COUNT(*) FILTER (WHERE payer_kind <> 'universe'))::int AS others
      FROM meter_events WHERE ${inRange} AND brick IS TRUE AND bot_id IS NOT NULL GROUP BY bot_id ORDER BY cost DESC, bot_id`),
    prisma.$queryRaw<{ kind: string; cost: bigint; events: number; uses: bigint; jobs: number; seconds: bigint }[]>(Prisma.sql`
      SELECT kind,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe'), 0)::bigint AS cost,
        (COUNT(*) FILTER (WHERE COALESCE(detail->>'error', 'false') <> 'true' AND COALESCE(detail->>'greeting', 'false') <> 'true'))::int AS events,
        COALESCE(SUM(quantity), 0)::bigint AS uses,
        (COUNT(DISTINCT job_id))::int AS jobs,
        COALESCE(SUM(CASE unit WHEN 'second' THEN quantity WHEN 'minute' THEN quantity * 60 ELSE 0 END), 0)::bigint AS seconds
      FROM meter_events WHERE ${inRange} AND brick IS TRUE AND kind IN ('model_call', 'app_use', 'computer_time') GROUP BY kind`),
    prisma.$queryRaw<{ universe_key: string; guests: number; replies: number; cost: bigint }[]>(Prisma.sql`
      SELECT universe_key, (COUNT(DISTINCT guest_key))::int AS guests, (COUNT(*))::int AS replies, COALESCE(SUM(cost_micros), 0)::bigint AS cost
      FROM guest_brick_replies WHERE failed = false AND created_at >= ${from} AND created_at < ${until}
      GROUP BY universe_key ORDER BY cost DESC, universe_key`),
    prisma.$queryRaw<{ day: Date; people: number; cost: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', occurred_at) AS day,
        (COUNT(DISTINCT person_key) FILTER (WHERE person_key LIKE 'person:%'))::int AS people,
        COALESCE(SUM(cost_micros) FILTER (WHERE payer_kind = 'universe'), 0)::bigint AS cost
      FROM meter_events WHERE ${inRange} GROUP BY 1 ORDER BY 1 DESC`),
    // Guests of a Brick are paid for from their own table, so their days are added to the daily figures as well
    prisma.$queryRaw<{ day: Date; cost: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', created_at) AS day, COALESCE(SUM(cost_micros), 0)::bigint AS cost
      FROM guest_brick_replies WHERE failed = false AND created_at >= ${from} AND created_at < ${until} GROUP BY 1`),
    // A disk is a level, not something that adds up: the newest size recorded for each bot, as it stood when the dates end
    prisma.$queryRaw<{ bytes: bigint | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM(latest.quantity), 0)::bigint AS bytes FROM (
        SELECT DISTINCT ON (bot_id) quantity FROM meter_events
        WHERE kind = 'stored_bytes' AND payer_kind = 'universe' AND bot_id IS NOT NULL AND occurred_at < ${until}
        ORDER BY bot_id, occurred_at DESC, recorded_at DESC
      ) latest`),
    getMeterSettings(),
  ]);

  const byKind = new Map(groups.map((group) => [group.kind, group]));
  const sumKinds = (kinds: string[]): Group => {
    const rows = kinds.map((kind) => byKind.get(kind)).filter((row): row is Group => !!row);
    return rows.reduce<Group>(
      (all, row) => ({ kind: 'sum', ours: all.ours + row.ours, settled: all.settled + row.settled, uses: all.uses + row.uses, measured: all.measured + row.measured, estimated: all.estimated + row.estimated, unpriced: all.unpriced + row.unpriced, others: all.others + row.others }),
      { kind: 'sum', ours: BigInt(0), settled: BigInt(0), uses: BigInt(0), measured: 0, estimated: 0, unpriced: 0, others: 0 },
    );
  };
  const row = (key: GoesRow['key'], title: string, kinds: string[]): GoesRow => {
    const sum = sumKinds(kinds);
    const known = sum.measured + sum.estimated > 0;
    return {
      key,
      title,
      // Nothing priced: our count is not known, which is not the same as nothing
      ourMicros: known || (sum.unpriced === 0 && sum.others === 0) ? toNumber(sum.ours) : null,
      settledMicros: known ? toNumber(sum.settled) : null,
      uses: key === 'apps' ? toNumber(sum.uses) : null,
      bytes: null,
      unpriced: sum.unpriced,
      sure: sureOf(sum),
    };
  };
  const bytes = toNumber(kept[0]?.bytes);
  const perGb = settings.storageMicrosPerGbMonth;
  const files: GoesRow = {
    key: 'files',
    title: 'Files we keep',
    ourMicros: perGb === null ? null : Math.ceil((bytes * perGb) / 1_000_000_000),
    settledMicros: null,
    uses: null,
    bytes,
    unpriced: 0,
    sure: perGb === null ? 'Unknown' : 'Estimated',
  };
  const goes: GoesRow[] = [row('models', 'AI models', ['model_call']), row('voice', 'Voice', ['speech']), row('computers', 'Computers', ['computer_time', 'size_change']), row('apps', 'Apps', ['app_use']), files];

  // Guests of a Brick are paid for from their own table, so their cost is added to the headline as well
  const costMicros = [...byKind.values()].reduce((sum, group) => sum + toNumber(group.ours), 0) + guestRows.reduce((sum, guest) => sum + toNumber(guest.cost), 0);

  // Names, Wokas and extra usage for the people and Bricks listed
  const listedPeople = peopleRows.slice(0, COSTS_LISTED);
  const listedBricks = brickRows.slice(0, COSTS_LISTED);
  // The given list is every grant still running or waiting to start, every one still to bill, and the latest few that ended. A cap
  // on all of them would drop a running or unbilled grant once enough newer ones exist.
  const recentIds = (await prisma.meterGrant.findMany({ where: { endsAt: { lte: now } }, orderBy: { createdAt: 'desc' }, take: GIVEN_RECENT, select: { id: true } })).map((grant) => grant.id);
  const [shownGrants, requests, openCount, bots] = await Promise.all([
    prisma.meterGrant.findMany({
      where: { OR: [{ endsAt: { gt: now } }, { settlement: 'to_bill', billedAt: null }, { id: { in: recentIds } }] },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.meterRequest.findMany({ where: { answeredAt: null }, orderBy: { createdAt: 'asc' }, take: ASKED_LISTED }),
    prisma.meterRequest.count({ where: { answeredAt: null } }),
    prisma.bot.findMany({ where: { id: { in: listedBricks.map((brick) => brick.bot_id) } }, select: { id: true, name: true, ownerId: true } }),
  ]);
  // Each person's other grants count too: two that overlap a month share its spending, so the figures need all of a person's grants
  const grants = await prisma.meterGrant.findMany({ where: { personId: { in: [...new Set([...shownGrants.map((grant) => grant.personId), ...listedPeople.map((person) => person.person_id)])] } }, orderBy: { createdAt: 'desc' } });
  const personIds = [...new Set([...listedPeople.map((person) => person.person_id), ...bots.flatMap((bot) => (bot.ownerId ? [bot.ownerId] : [])), ...grants.flatMap((grant) => [grant.personId, grant.givenById]), ...requests.map((request) => request.personId)])];
  const [users, wokas] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, email: true } }),
    wokaLayersForMany(personIds).catch(() => new Map<string, string[]>()),
  ]);
  const nameOf = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || 'Someone']));
  const botOf = new Map(bots.map((bot) => [bot.id, bot]));
  const running = grants.filter((grant) => grant.startsAt <= now && grant.endsAt > now);
  // The same one the person's page reports: the largest running, and the later end of two the same
  const extraOf = new Map<string, Date>();
  for (const personId of new Set(running.map((grant) => grant.personId))) {
    const picked = pickRunning(running.filter((grant) => grant.personId === personId));
    if (picked) extraOf.set(personId, picked.endsAt);
  }

  const people: PersonRow[] = listedPeople.map((person) => ({
    id: person.person_id,
    name: nameOf.get(person.person_id) ?? 'Someone',
    woka: wokas.get(person.person_id) ?? [],
    costMicros: toNumber(person.cost),
    bricks: person.bricks,
    replies: person.replies,
    appUses: toNumber(person.uses),
    computerSeconds: toNumber(person.seconds),
    extraUntil: extraOf.get(person.person_id)?.toISOString() ?? null,
  }));
  const rest = <T extends { cost: bigint }>(rows: T[]) => rows.slice(COSTS_LISTED).reduce((sum, item) => sum + toNumber(item.cost), 0);

  const bricks: BrickRow[] = listedBricks.map((brick) => {
    const bot = botOf.get(brick.bot_id);
    return {
      id: brick.bot_id,
      name: bot?.name ?? 'A deleted Brick',
      ownerId: bot?.ownerId ?? null,
      ownerName: bot?.ownerId ? (nameOf.get(bot.ownerId) ?? null) : null,
      costMicros: toNumber(brick.cost),
      replies: brick.replies,
      appUses: toNumber(brick.uses),
      computerSeconds: toNumber(brick.seconds),
      ownKeyReplies: brick.own,
      sure: sureOf(brick),
    };
  });

  const kindRow = (kind: string) => ways.find((way) => way.kind === kind);
  const answered = kindRow('model_call');
  const app = kindRow('app_use');
  const computer = kindRow('computer_time');
  const wayRows: WayRow[] = [
    { key: 'answered', title: 'Just answered', costMicros: toNumber(answered?.cost), replies: answered?.events ?? 0, appUses: 0, jobs: 0, computerSeconds: 0 },
    { key: 'app', title: 'Used an app', costMicros: toNumber(app?.cost), replies: 0, appUses: toNumber(app?.uses), jobs: 0, computerSeconds: 0 },
    { key: 'computer', title: 'Used its computer', costMicros: toNumber(computer?.cost), replies: 0, appUses: 0, jobs: computer?.jobs ?? 0, computerSeconds: toNumber(computer?.seconds) },
  ];

  const universes = await prisma.universe.findMany({ where: { id: { in: guestRows.map((guest) => guest.universe_key) } }, select: { id: true, name: true } });
  const universeName = new Map(universes.map((universe) => [universe.id, universe.name]));
  const guests: GuestRow[] = guestRows.map((guest) => ({
    universeKey: guest.universe_key,
    name: universeName.get(guest.universe_key) ?? 'Outside any universe',
    guests: guest.guests,
    replies: guest.replies,
    costMicros: toNumber(guest.cost),
  }));

  // Each person's grants are worked out together, so two of them at once share one month's spending the way the allowance does
  const byPerson = new Map<string, typeof grants>();
  for (const grant of grants) {
    const list = byPerson.get(grant.personId);
    if (list) list.push(grant);
    else byPerson.set(grant.personId, [grant]);
  }
  const above = new Map<string, number>();
  // One read for everyone, not one per person and month: the spending of all of them over the whole span of their grants, sorted out
  // by person and month here
  const spans = [...byPerson.values()].map((list) => grantSpan(list, now));
  const spending =
    settings.memberAllowanceMicros === null || byPerson.size === 0
      ? []
      : await prisma.meterEvent.findMany({
          where: {
            pool: 'computer',
            payerKind: 'universe',
            personKey: { in: [...byPerson.keys()].map((personId) => `person:${personId}`) },
            costMicros: { not: null },
            occurredAt: { gte: monthOf(new Date(Math.min(...spans.map((span) => span.first.getTime())))).start, lt: monthOf(new Date(Math.max(...spans.map((span) => span.last.getTime())))).end },
          },
          select: { personKey: true, occurredAt: true, costMicros: true },
        });
  const spendingOf = new Map<string, typeof spending>();
  for (const event of spending) {
    const list = spendingOf.get(event.personKey);
    if (list) list.push(event);
    else spendingOf.set(event.personKey, [event]);
  }
  for (const [personId, list] of byPerson) {
    const figures = aboveUsual(settings.memberAllowanceMicros, list, spendingOf.get(`person:${personId}`) ?? [], now);
    list.forEach((grant, index) => above.set(grant.grantKey, figures[index]));
  }
  const given: GivenRow[] = shownGrants.map((grant) => ({
    grantKey: grant.grantKey,
    personId: grant.personId,
    name: nameOf.get(grant.personId) ?? 'Someone',
    woka: wokas.get(grant.personId) ?? [],
    multiplier: grant.noLimit ? null : grant.multiplier,
    noLimit: grant.noLimit,
    startsAt: grant.startsAt.toISOString(),
    endsAt: grant.endsAt.toISOString(),
    ended: grant.endsAt <= now,
    givenByName: nameOf.get(grant.givenById) ?? 'a super admin',
    settlement: grant.settlement === 'to_bill' ? 'to_bill' : 'gift',
    billedAt: grant.billedAt?.toISOString() ?? null,
    note: grant.note,
    aboveUsualMicros: above.get(grant.grantKey) ?? 0,
  }));
  // Days from the meter and days of guests merged, newest first as before
  const dayMap = new Map<string, DayRow>();
  for (const day of dayRows) dayMap.set(isoDay(day.day), { day: isoDay(day.day), people: day.people, costMicros: toNumber(day.cost) });
  for (const day of guestDays) {
    const key = isoDay(day.day);
    const have = dayMap.get(key);
    if (have) have.costMicros += toNumber(day.cost);
    else dayMap.set(key, { day: key, people: 0, costMicros: toNumber(day.cost) });
  }
  const days = [...dayMap.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const asked: AskedRow[] = requests.map((request) => ({ personId: request.personId, name: nameOf.get(request.personId) ?? 'Someone', woka: wokas.get(request.personId) ?? [], askedAt: request.createdAt.toISOString() }));

  return {
    from: isoDay(from),
    to: isoDay(to),
    totals: { costMicros, people: headline[0]?.people ?? 0, guests: headline[0]?.guests ?? 0, bricks: headline[0]?.bricks ?? 0, computers: headline[0]?.computers ?? 0 },
    goes,
    people: { rows: people, total: peopleRows.length, more: { count: Math.max(0, peopleRows.length - COSTS_LISTED), costMicros: rest(peopleRows) } },
    bricks: { rows: bricks, total: brickRows.length, more: { count: Math.max(0, brickRows.length - COSTS_LISTED), costMicros: rest(brickRows) } },
    ways: wayRows,
    guests,
    days: days,
    asked,
    askedMore: Math.max(0, openCount - requests.length),
    given,
  };
}
