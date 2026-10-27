import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getUniverseAiReplyLimits } from '@/lib/bot-limits';
import { BOT_LIMIT_WINDOW_HOURS } from '@/lib/reply-limits';

/**
 * A bot's usage for the people who manage it (Orbit #491, mock v4 approved 20 Oct 2026): replies a day split into direct
 * messages and nearby chat, who chatted by name with how much and when, guests as one count, what it ran on, and how many
 * people reached a reply limit. Built only from usage rows and reached limits: what anyone said is never read here.
 *
 * Days are the viewer's own days (their time zone). Rows from before the split have no channel and are "Not split";
 * rows from before people were recorded count toward replies but toward nobody.
 */
export const USAGE_RANGES = { today: 1, '7d': 7, '30d': 30 } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

/** Most people one answer lists; the bot page searches and sorts within them. */
export const PEOPLE_LISTED = 500;

/** Cost bases that come with a real amount (see the usage route); anything else is an old estimate or not known. */
const PRICED = ['priced', 'provider', 'override', 'own_computer'];

type Group = {
  day: string;
  channel: string | null;
  person_id: string | null;
  guest: boolean | null;
  guest_id: string | null;
  provider_id: string;
  key_owner_id: string | null;
  replies: number;
  tokens: number;
  cost_micros: number | null;
  unpriced: number;
  first_at: Date;
  last_at: Date;
};

type Split = { dm: number; nearby: number; notSplit: number };
const emptySplit = (): Split => ({ dm: 0, nearby: 0, notSplit: 0 });
const addTo = (split: Split, channel: string | null, n: number) => {
  if (channel === 'dm') split.dm += n;
  else if (channel === 'nearby') split.nearby += n;
  else split.notSplit += n;
};

export function readTimeZone(value: string | null): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

/** The local dates in the range, oldest first, ending today in that time zone. */
export function rangeDays(range: UsageRange, timeZone: string, now: Date = new Date()): string[] {
  const local = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  // Noon UTC of today's local date steps back a whole day at a time without landing on a time zone's changeover
  const noon = new Date(`${local(now)}T12:00:00Z`).getTime();
  const days: string[] = [];
  for (let back = USAGE_RANGES[range] - 1; back >= 0; back--) days.push(new Date(noon - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  return days;
}

export async function botUsageReport(
  bot: { id: string; createdById: string | null },
  options: { range: UsageRange; timeZone: string; viewerId?: string },
  now: Date = new Date(),
) {
  const { range, timeZone } = options;
  const days = rangeDays(range, timeZone, now);
  const first = days[0];
  // A day of slack on the indexed column, then the exact local days
  const roughSince = new Date(now.getTime() - (USAGE_RANGES[range] + 1) * 24 * 60 * 60 * 1000);

  const [groups, anyUsage, hits, settings] = await Promise.all([
    prisma.$queryRaw<Group[]>(Prisma.sql`
      SELECT to_char(("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
             "channel", "talked_person_id" AS person_id, "talked_guest" AS guest,
             CASE WHEN "talked_guest" THEN "talked_user_id" END AS guest_id,
             "provider_id", "key_owner_id",
             count(*)::int AS replies,
             coalesce(sum("tokens_used"), 0)::float8 AS tokens,
             sum("cost_micros") FILTER (WHERE "cost_basis" IN (${Prisma.join(PRICED)}))::float8 AS cost_micros,
             (count(*) FILTER (WHERE "cost_basis" IS NULL OR "cost_basis" NOT IN (${Prisma.join(PRICED)})))::int AS unpriced,
             min("timestamp") AS first_at, max("timestamp") AS last_at
        FROM "bots_ai_usage"
       WHERE "bot_id" = ${bot.id} AND "error" = false AND "timestamp" >= ${roughSince}
         AND to_char(("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') >= ${first}
       GROUP BY 1, 2, 3, 4, 5, 6, 7`),
    prisma.botsAiUsage.findFirst({ where: { botId: bot.id, error: false }, select: { id: true } }),
    prisma.botReplyLimitHit.findMany({
      where: { botId: bot.id, createdAt: { gte: roughSince } },
      select: { kind: true, talkedUserId: true, createdAt: true, askedAt: true },
    }),
    prisma.bot.findUnique({
      where: { id: bot.id },
      select: { dailyReplyCap: true, aiProviderRef: true },
    }),
  ]);

  const inRange = (date: Date) => days.includes(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date));

  const perDay = new Map(days.map((day) => [day, emptySplit()]));
  const channels = emptySplit();
  const guests = { ...emptySplit(), replies: 0 };
  const guestIds = new Set<string>();
  const people = new Map<string, Split & { replies: number; lastAt: Date }>();
  const ranOn = new Map<string, { kind: 'own-key' | 'universe-ai'; providerId: string | null; replies: number; tokens: number; costMicros: number; unpricedReplies: number; firstAt: Date; lastAt: Date }>();
  let replies = 0;
  let tokens = 0;

  for (const g of groups) {
    const split = perDay.get(g.day);
    if (!split) continue;
    addTo(split, g.channel, g.replies);
    addTo(channels, g.channel, g.replies);
    replies += g.replies;
    tokens += g.tokens;

    if (g.person_id) {
      const person = people.get(g.person_id) ?? { ...emptySplit(), replies: 0, lastAt: g.last_at };
      person.replies += g.replies;
      addTo(person, g.channel, g.replies);
      if (g.last_at > person.lastAt) person.lastAt = g.last_at;
      people.set(g.person_id, person);
    } else if (g.guest) {
      guests.replies += g.replies;
      addTo(guests, g.channel, g.replies);
      if (g.guest_id) guestIds.add(g.guest_id);
    }

    // Universe AI is one line whichever server provider it ran on; each personal key is its own
    const key = g.key_owner_id ? g.provider_id : 'universe-ai';
    const line = ranOn.get(key) ?? {
      kind: g.key_owner_id ? ('own-key' as const) : ('universe-ai' as const),
      providerId: g.key_owner_id ? g.provider_id : null,
      replies: 0, tokens: 0, costMicros: 0, unpricedReplies: 0, firstAt: g.first_at, lastAt: g.last_at,
    };
    line.replies += g.replies;
    line.tokens += g.tokens;
    line.costMicros += g.cost_micros ?? 0;
    line.unpricedReplies += g.unpriced;
    if (g.first_at < line.firstAt) line.firstAt = g.first_at;
    if (g.last_at > line.lastAt) line.lastAt = g.last_at;
    ranOn.set(key, line);
  }

  const ownKeyIds = [...ranOn.values()].filter((line) => line.providerId).map((line) => line.providerId!);
  const currentKeyRef = settings?.aiProviderRef && settings.aiProviderRef.startsWith('key-') ? settings.aiProviderRef : null;
  const keyIds = [...new Set([...ownKeyIds, ...(currentKeyRef ? [currentKeyRef] : [])])];
  const [names, keys] = await Promise.all([
    people.size
      ? prisma.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string | null }[]),
    keyIds.length
      ? prisma.botsAiProvider.findMany({ where: { providerId: { in: keyIds } }, select: { providerId: true, name: true, type: true, downSince: true, ifDown: true } })
      : Promise.resolve([] as { providerId: string; name: string; type: string; downSince: Date | null; ifDown: string }[]),
  ]);
  const nameOf = new Map(names.map((user) => [user.id, user.name]));
  const keyOf = new Map(keys.map((key) => [key.providerId, key]));

  const ranOut = { universeAi: new Set<string>(), botLimit: new Set<string>() };
  const asked = new Set<string>();
  for (const hit of hits) {
    if (hit.askedAt && inRange(hit.askedAt)) asked.add(hit.talkedUserId);
    if (!inRange(hit.createdAt)) continue;
    (hit.kind === 'bot' ? ranOut.botLimit : ranOut.universeAi).add(hit.talkedUserId);
  }

  const current = currentKeyRef ? keyOf.get(currentKeyRef) : undefined;
  const limits = await getUniverseAiReplyLimits();

  return {
    range,
    timeZone,
    days,
    hasUsage: !!anyUsage,
    viewerIsMaker: !!options.viewerId && options.viewerId === bot.createdById,
    totals: { replies, people: people.size + guestIds.size, tokens },
    channels,
    perDay: days.map((day) => ({ day, ...perDay.get(day)! })),
    people: [...people.entries()]
      .map(([id, person]) => ({ id, name: nameOf.get(id) ?? null, replies: person.replies, dm: person.dm, nearby: person.nearby, notSplit: person.notSplit, lastAt: person.lastAt.toISOString() }))
      .sort((a, b) => b.replies - a.replies || b.lastAt.localeCompare(a.lastAt))
      .slice(0, PEOPLE_LISTED),
    guests: { count: guestIds.size, replies: guests.replies, dm: guests.dm, nearby: guests.nearby, notSplit: guests.notSplit },
    ranOn: [...ranOn.values()]
      .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime())
      .map((line) => {
        const key = line.providerId ? keyOf.get(line.providerId) : undefined;
        return {
          kind: line.kind,
          name: line.kind === 'own-key' ? (key?.name ?? null) : null,
          keyType: line.kind === 'own-key' ? (key?.type ?? null) : null,
          replies: line.replies,
          tokens: line.tokens,
          // Only a personal key costs its owner anything; Universe AI is free to them. Null when no reply had a price.
          costMicros: line.kind === 'own-key' && line.replies > line.unpricedReplies ? line.costMicros : null,
          unpricedReplies: line.kind === 'own-key' ? line.unpricedReplies : 0,
          firstAt: line.firstAt.toISOString(),
          lastAt: line.lastAt.toISOString(),
        };
      }),
    // The key the bot is set to run on is not working now: what it does meanwhile is its owner's choice
    keyProblem: current?.downSince
      ? { name: current.name, downSince: current.downSince.toISOString(), meanwhile: current.ifDown === 'stop' ? ('stopped' as const) : ('universe-ai' as const) }
      : null,
    limits: {
      universeAi: { signedIn: limits.signedIn, guest: limits.guest, guestPool: limits.guestPool, windowHours: limits.windowHours },
      botLimit: settings?.dailyReplyCap ?? null,
      botLimitWindowHours: BOT_LIMIT_WINDOW_HOURS,
      ranOut: { universeAi: ranOut.universeAi.size, botLimit: ranOut.botLimit.size },
      // People who tapped "Ask <bot>'s maker" on the limit card: a count, never who
      askedMaker: asked.size,
    },
  };
}
