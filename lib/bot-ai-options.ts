import { prisma } from '@/lib/db';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { kindInfo } from '@/lib/ai-key-kinds';
import { isIfDown } from '@/lib/ai-key-health';
import { resolveUniverseAiProvider, UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { keyVisionModels, readVisionPick, usableVisionKey, type AnotherProblem, type VisionPick } from '@/lib/bot-vision';

/**
 * What the game's bot page offers under "Runs on" for one bot (#374). Nobody is shown the server's provider list: the
 * choices are Universe AI, and the viewer's own keys lent to this bot's universe (only when the viewer made the bot).
 * Someone else's key is never offered; if the bot is on one, it is shown as it is and only Universe AI can replace it.
 * Each key says if it is Working or Down and what its bots do then, so the picker can say that Universe AI answers until it's back.
 * A super admin also gets the server's providers, to pin a bot to one as before.
 *
 * The page's Vision row (where the bot's images go) is worked out from the same facts, so each key and Universe AI say which
 * model they run and whether it sees images, and each key which models with Vision it could look at images with.
 */
export interface BotAiOptions {
  /** The bot's current ref ("universe-ai", a provider id, a key id, or null). */
  current: string | null;
  universeAi: { available: boolean; model: string | null; supportsVision: boolean | null };
  /** Who made the bot (the viewer, for a bot not made yet). */
  maker: { id: string; name: string | null } | null;
  viewerIsMaker: boolean;
  /** The viewer's own keys lent to this bot's universe; empty unless the viewer made the bot. */
  keys: { id: string; name: string; kind: string | null; kindLabel: string; group: 'own-computer' | 'hosted' | null; universeName: string; status: 'working' | 'down'; ifDown: 'universe-ai' | 'stop'; model: string | null; supportsVision: boolean | null; visionModels: string[] }[];
  /** The key the bot is on now, when it is a personal key: whose it is and what it is called. */
  currentKey: { id: string; name: string; ownerName: string | null; mine: boolean; status: 'working' | 'down'; ifDown: 'universe-ai' | 'stop'; group: 'own-computer' | 'hosted' | null; model: string | null; supportsVision: boolean | null } | null;
  /** What the owner picked for the bot's images (null = nothing picked), and, for "Another model", the key picked and whether it can be used now. */
  vision: { saved: VisionPick | null; savedKey: { name: string; problem: AnotherProblem | null } | null };
  /** Only for a super admin: the server's own providers, to pin a bot to one. */
  providers: { id: string; name: string; type: string; model: string | null; enabled: boolean }[] | null;
}

export type BotAiOptionsResult = { ok: true; options: BotAiOptions } | { ok: false; status: 403 | 404; error: string };

export async function botAiOptions(input: {
  viewer: { id: string; isSuperAdmin: boolean };
  botId?: string | null;
  roomId?: string | null;
}): Promise<BotAiOptionsResult> {
  const bot = input.botId
    ? await prisma.bot.findUnique({
        where: { id: input.botId },
        select: { id: true, roomId: true, aiProviderRef: true, behaviorConfig: true, createdById: true, createdBy: { select: { id: true, name: true } } },
      })
    : null;
  if (input.botId && !bot) return { ok: false, status: 404, error: 'Bot not found' };
  const roomId = bot?.roomId ?? input.roomId;
  if (!roomId) return { ok: false, status: 404, error: 'Room not found' };

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { world: { select: { universe: { select: { id: true, name: true } } } } },
  });
  if (!room) return { ok: false, status: 404, error: 'Room not found' };
  // Choosing what a bot runs on is part of managing bots there; for a bot that exists, the same bar as reading its
  // configuration, so a bot's own Manage rules also decide who learns whose key it runs on
  const allowed = input.viewer.isSuperAdmin
    || (bot
      ? await canManageThisBot(input.viewer.id, null, { id: bot.id, createdById: bot.createdById, roomId: bot.roomId }, { creatorPasses: false })
      : await canManageBots(input.viewer.id, roomId));
  if (!allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to manage bots in this room' };
  }
  const universe = room.world.universe;

  const viewer = await prisma.user.findUnique({ where: { id: input.viewer.id }, select: { id: true, name: true } });
  const maker = bot ? bot.createdBy : viewer;
  const viewerIsMaker = !!maker && maker.id === input.viewer.id;

  const [universeAi, ownKeys, current, providers] = await Promise.all([
    resolveUniverseAiProvider(),
    viewerIsMaker
      ? prisma.botsAiProvider.findMany({
          where: { ownerId: input.viewer.id, lends: { some: { universeId: universe.id } } },
          orderBy: { createdAt: 'asc' },
          select: { providerId: true, name: true, settings: true, model: true, supportsVision: true, downSince: true, ifDown: true },
        })
      : Promise.resolve([]),
    bot?.aiProviderRef && bot.aiProviderRef !== UNIVERSE_AI_REF
      ? prisma.botsAiProvider.findUnique({ where: { providerId: bot.aiProviderRef }, select: { providerId: true, name: true, ownerId: true, settings: true, model: true, supportsVision: true, downSince: true, ifDown: true } })
      : Promise.resolve(null),
    input.viewer.isSuperAdmin
      ? prisma.botsAiProvider.findMany({
          where: { ownerId: null },
          orderBy: { name: 'asc' },
          select: { providerId: true, name: true, type: true, model: true, enabled: true },
        })
      : Promise.resolve(null),
  ]);

  const saved = readVisionPick(bot?.behaviorConfig);
  const savedKey = saved?.choice === 'another' && bot ? await savedVisionKey(saved, bot) : null;

  return {
    ok: true,
    options: {
      current: bot?.aiProviderRef ?? null,
      universeAi: { available: !!universeAi, model: universeAi?.model ?? null, supportsVision: universeAi?.supportsVision ?? null },
      maker: maker ? { id: maker.id, name: maker.name } : null,
      viewerIsMaker,
      keys: ownKeys.map((key) => {
        const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
        return { id: key.providerId, name: key.name, kind: info?.kind ?? null, kindLabel: info?.label ?? 'AI', group: info?.group ?? null, universeName: universe.name, status: key.downSince ? 'down' : 'working', ifDown: isIfDown(key.ifDown) ? key.ifDown : 'universe-ai', model: key.model, supportsVision: key.supportsVision, visionModels: keyVisionModels(key) };
      }),
      currentKey:
        current && current.ownerId
          ? { id: current.providerId, name: current.name, ownerName: maker?.id === current.ownerId ? maker.name : null, mine: current.ownerId === input.viewer.id, status: current.downSince ? 'down' : 'working', ifDown: isIfDown(current.ifDown) ? current.ifDown : 'universe-ai', group: kindInfo((current.settings as { kind?: unknown } | null)?.kind)?.group ?? null, model: current.model, supportsVision: current.supportsVision }
          : null,
      vision: { saved, savedKey },
      providers: providers ? providers.map((provider) => ({ id: provider.providerId, name: provider.name, type: provider.type, model: provider.model, enabled: provider.enabled })) : null,
    },
  };
}

/** The key picked for "Another model", by name, and why it can't be used now (null when it can). */
async function savedVisionKey(
  saved: Extract<VisionPick, { choice: 'another' }>,
  bot: { createdById: string | null; roomId: string }
): Promise<{ name: string; problem: AnotherProblem | null }> {
  const usable = await usableVisionKey(saved, bot);
  return { name: (usable.key?.name ?? 'A key that was removed'), problem: usable.ok ? null : usable.problem };
}
