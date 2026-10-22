import { prisma } from '@/lib/db';
import { kindInfo, type AiKeyKind } from '@/lib/ai-key-kinds';
import { isIfDown, type DownReason } from '@/lib/ai-key-health';

export type { AiKeyKind };

/**
 * Personal AI keys (#374). A key is a BotsAiProvider row with an `ownerId`; the rows with none are the server's own
 * providers, which these functions never touch. Kinds are what a person picks (LM Studio, DeepSeek, ...); each one
 * is stored as a provider `type` the bot server already speaks, with its kind kept in `settings.kind`.
 */

/** What the AI keys page shows for one key. Never holds the key, encrypted or not. */
export interface AiKeySummary {
  id: string;
  name: string;
  kind: AiKeyKind | null;
  kindLabel: string;
  model: string | null;
  /** The host of an own-computer key's address, e.g. "lm.example.com"; null for a hosted key. */
  address: string | null;
  /** The last four characters of a hosted key. */
  last4: string | null;
  month: { replies: number; tokens: number };
  /** The universes it is lent to, and the bots running on it there with their replies this month. */
  lentTo: { universeId: string; universeName: string; /** The key's owner owns that universe. */ ownedByYou: boolean; bots: { id: string; name: string; replies: number }[] }[];
  /** "working", or "down" with when it went down (ISO) and why. */
  status: 'working' | 'down';
  downSince: string | null;
  downReason: DownReason | null;
  /** What its bots do while it is down. */
  ifDown: 'universe-ai' | 'stop';
  createdAt: string;
}

const asDownReason = (value: string | null): DownReason => (value === 'rejected' || value === 'errors' || value === 'credit' || value === 'model' ? value : 'stopped');

function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The caller's own keys, oldest first, each with what it spent this month. */
export async function listAiKeys(ownerId: string): Promise<AiKeySummary[]> {
  const rows = await prisma.botsAiProvider.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'asc' },
    select: { providerId: true, name: true, model: true, endpoint: true, apiKeyLast4: true, settings: true, createdAt: true, downSince: true, downReason: true, ifDown: true },
  });
  if (rows.length === 0) return [];
  const usage = await prisma.botsAiUsage.groupBy({
    by: ['providerId'],
    where: { providerId: { in: rows.map((row) => row.providerId) }, error: false, timestamp: { gte: startOfMonth() } },
    _sum: { apiCalls: true, tokensUsed: true },
  });
  const spent = new Map(usage.map((entry) => [entry.providerId, entry._sum]));

  // Where each key is lent, and which bots run on it there (a bot is on a key when its ref is the key's id)
  const ids = rows.map((row) => row.providerId);
  const [lends, bots, perBot] = await Promise.all([
    prisma.aiKeyLend.findMany({
      where: { providerId: { in: ids } },
      orderBy: { lentAt: 'asc' },
      select: { providerId: true, universe: { select: { id: true, name: true, ownerId: true } } },
    }),
    prisma.bot.findMany({
      where: { aiProviderRef: { in: ids } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, aiProviderRef: true, room: { select: { world: { select: { universeId: true } } } } },
    }),
    prisma.botsAiUsage.groupBy({
      by: ['providerId', 'botId'],
      where: { providerId: { in: ids }, error: false, timestamp: { gte: startOfMonth() } },
      _sum: { apiCalls: true },
    }),
  ]);
  const repliesOf = new Map(perBot.map((entry) => [`${entry.providerId}:${entry.botId}`, Number(entry._sum.apiCalls ?? 0)]));
  return rows.map((row) => {
    const settings = (row.settings ?? {}) as { kind?: unknown };
    const info = kindInfo(settings.kind);
    const sum = spent.get(row.providerId);
    return {
      id: row.providerId,
      name: row.name,
      kind: info?.kind ?? null,
      kindLabel: info?.label ?? 'AI',
      model: row.model,
      address: info?.group === 'own-computer' ? hostOf(row.endpoint) : null,
      last4: row.apiKeyLast4,
      month: { replies: Number(sum?.apiCalls ?? 0), tokens: Number(sum?.tokensUsed ?? 0) },
      lentTo: lends
        .filter((lend) => lend.providerId === row.providerId)
        .map((lend) => ({
          universeId: lend.universe.id,
          universeName: lend.universe.name,
          ownedByYou: lend.universe.ownerId === ownerId,
          bots: bots
            .filter((bot) => bot.aiProviderRef === row.providerId && bot.room.world.universeId === lend.universe.id)
            .map((bot) => ({ id: bot.id, name: bot.name, replies: repliesOf.get(`${row.providerId}:${bot.id}`) ?? 0 })),
        })),
      status: row.downSince ? 'down' : 'working',
      downSince: row.downSince ? row.downSince.toISOString() : null,
      downReason: row.downSince ? asDownReason(row.downReason) : null,
      ifDown: isIfDown(row.ifDown) ? row.ifDown : 'universe-ai',
      createdAt: row.createdAt.toISOString(),
    };
  });
}
