import { prisma } from '@/lib/db';
import { kindInfo, type AiKeyKind } from '@/lib/ai-key-kinds';
import { isIfDown, type DownReason } from '@/lib/ai-key-health';
import type { ModelFacts } from '@/lib/ai-key-models';
import { cleanFacts, lendModels, modelFactsOf, servedModel } from '@/lib/ai-key-model-list';
import { readReplyLimits, type ReplyLimits } from '@/lib/bot-limit-values';

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
  /** The model the key is checked with (#575). Each bot picks its own; for a provider with no model list it is the only one. */
  model: string | null;
  /** How many models the provider listed when last asked; null when it doesn't list them, or hasn't been asked since #575. */
  modelCount: number | null;
  /** What the provider said about the model when the key was added or its model changed; empty when it said nothing. */
  caps: ModelFacts;
  /** The host of an own-computer key's address, e.g. "lm.example.com"; null for a hosted key. */
  address: string | null;
  /** The last four characters of a hosted key. */
  last4: string | null;
  month: { replies: number; tokens: number };
  /** The universes it is lent to, and the bots running on it there with their replies this month. */
  lentTo: {
    universeId: string;
    universeName: string;
    /** The key's owner owns that universe. */
    ownedByYou: boolean;
    /** Which of the key's models bots there may use (#575): null for all of them. */
    models: string[] | null;
    /**
     * Each bot with the model it replies with (its own pick, else the key's check model, kept to what the lend allows), and
     * the longest reply that model can write when its provider says (#673).
     */
    bots: { id: string; name: string; replies: number; model: string | null; output: number | null }[];
  }[];
  /** "working", or "down" with when it went down (ISO) and why. */
  status: 'working' | 'down';
  downSince: string | null;
  downReason: DownReason | null;
  /** What its bots do while it is down. */
  ifDown: 'universe-ai' | 'stop';
  /** The reply limits of bots on this key (#666), the recommended value for any its owner never changed. */
  limits: ReplyLimits;
  createdAt: string;
}

const asDownReason = (value: string | null): DownReason => (value === 'rejected' || value === 'errors' || value === 'credit' || value === 'model' ? value : 'stopped');

/** The model facts saved on a key (`settings.caps`): only the ones that are well-formed. */
function capsOf(settings: unknown): ModelFacts {
  return cleanFacts(typeof settings === 'object' && settings !== null ? (settings as { caps?: unknown }).caps : null);
}

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
    select: { providerId: true, name: true, model: true, endpoint: true, apiKeyLast4: true, settings: true, createdAt: true, downSince: true, downReason: true, ifDown: true, replyLimits: true },
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
      select: { providerId: true, models: true, universe: { select: { id: true, name: true, ownerId: true } } },
    }),
    prisma.bot.findMany({
      where: { aiProviderRef: { in: ids } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, aiProviderRef: true, aiModel: true, room: { select: { world: { select: { universeId: true } } } } },
    }),
    prisma.botsAiUsage.groupBy({
      by: ['providerId', 'botId'],
      where: { providerId: { in: ids }, error: false, timestamp: { gte: startOfMonth() } },
      _sum: { apiCalls: true },
    }),
  ]);
  const repliesOf = new Map(perBot.map((entry) => [`${entry.providerId}:${entry.botId}`, Number(entry._sum.apiCalls ?? 0)]));
  return rows.map((row) => {
    const settings = (row.settings ?? {}) as { kind?: unknown; modelCount?: unknown };
    const info = kindInfo(settings.kind);
    const sum = spent.get(row.providerId);
    return {
      id: row.providerId,
      name: row.name,
      kind: info?.kind ?? null,
      kindLabel: info?.label ?? 'AI',
      model: row.model,
      modelCount: typeof settings.modelCount === 'number' && settings.modelCount > 0 ? settings.modelCount : null,
      caps: capsOf(row.settings),
      address: info?.group === 'own-computer' ? hostOf(row.endpoint) : null,
      last4: row.apiKeyLast4,
      month: { replies: Number(sum?.apiCalls ?? 0), tokens: Number(sum?.tokensUsed ?? 0) },
      lentTo: lends
        .filter((lend) => lend.providerId === row.providerId)
        .map((lend) => {
          const models = lendModels(lend.models);
          return {
            universeId: lend.universe.id,
            universeName: lend.universe.name,
            ownedByYou: lend.universe.ownerId === ownerId,
            models,
            bots: bots
              .filter((bot) => bot.aiProviderRef === row.providerId && bot.room.world.universeId === lend.universe.id)
              .map((bot) => {
                const model = servedModel(bot, row, models);
                return { id: bot.id, name: bot.name, replies: repliesOf.get(`${row.providerId}:${bot.id}`) ?? 0, model, output: model ? modelFactsOf(row, model).output ?? null : null };
              }),
          };
        }),
      status: row.downSince ? 'down' : 'working',
      downSince: row.downSince ? row.downSince.toISOString() : null,
      downReason: row.downSince ? asDownReason(row.downReason) : null,
      ifDown: isIfDown(row.ifDown) ? row.ifDown : 'universe-ai',
      limits: readReplyLimits(row.replyLimits),
      createdAt: row.createdAt.toISOString(),
    };
  });
}
