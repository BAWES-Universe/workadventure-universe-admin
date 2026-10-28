import { prisma } from '@/lib/db';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { kindInfo } from '@/lib/ai-key-kinds';
import { isIfDown } from '@/lib/ai-key-health';
import { resolveUniverseAiProvider, UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { allowedModels, keyModels, lendModels, modelFactsOf, modelSupportsVision, servedModel } from '@/lib/ai-key-model-list';
import { getServerLimits, keyReplyLimits } from '@/lib/bot-limits';
import type { ReplyLimits } from '@/lib/bot-limit-values';
import { keyVisionModels, readVisionPick, usableVisionKey, type AnotherProblem, type VisionPick } from '@/lib/bot-vision';

/**
 * What the game's bot page offers under "Runs on" for one bot (#374). Nobody is shown the server's provider list: the
 * choices are Universe AI, and the viewer's own keys lent to this bot's universe: anyone who manages a bot may put it on
 * their own key (#709). Someone else's key is never offered; if the bot is on one, it is shown with its owner's name and the
 * provider (never the key's own name, which is the owner's), and the viewer can move the bot off it to Universe AI or a key of theirs.
 * Each key says if it is Working or Down and what its bots do then, so the picker can say that Universe AI answers until it's back.
 * Nobody, super admins included, is offered the server's providers any more: a bot runs on Universe AI, which follows the
 * Default, or on a lent key. A bot still pinned to a provider is shown as it is, and Universe AI can replace it.
 *
 * The page's Vision row (where the bot's images go) is worked out from the same facts, so each key and Universe AI say which
 * model they run and whether it sees images, and each key which models with Vision it could look at images with.
 *
 * Since #575 a bot picks its own model on a key: each of the viewer's keys lists the models the lend here allows, with what
 * the provider says about each (Tools, Vision), and the bot's own pick comes back as `currentModel`.
 *
 * Since #666 Universe AI and each key also say their longest reply and steps, so the bot page can offer only lower ones.
 * Since #673 each model also says the longest reply it can write, when its provider says, so the page can show where it stops.
 */

/** A key's (or Universe AI's) longest reply in tokens and steps in one reply: a bot on it can lower them, never raise them. */
export type BotLimitCeiling = Pick<ReplyLimits, 'reply' | 'steps'>;

const ceilingOf = (limits: ReplyLimits): BotLimitCeiling => ({ reply: limits.reply, steps: limits.steps });
export interface KeyModelOption {
  id: string;
  tools?: boolean;
  vision?: boolean;
  context?: number;
  /** The longest reply it can write, in tokens (#673). */
  output?: number;
}

export interface BotAiOptions {
  /** The bot's current ref ("universe-ai", a provider id, a key id, or null). */
  current: string | null;
  /** The bot's own model on its key (null: the key's check model, or not on a key). */
  currentModel: string | null;
  universeAi: { available: boolean; model: string | null; supportsVision: boolean | null; limits: BotLimitCeiling };
  /** Who made the bot (the viewer, for a bot not made yet). */
  maker: { id: string; name: string | null } | null;
  viewerIsMaker: boolean;
  /** The viewer's own keys lent to this bot's universe. */
  keys: { id: string; name: string; kind: string | null; kindLabel: string; /** The provider's logo file in `public/ai-providers/` (without `.svg`), or what is drawn instead. */ logo: string | null; plainIcon: 'plug' | 'chip' | null; group: 'own-computer' | 'hosted' | null; universeName: string; status: 'working' | 'down'; ifDown: 'universe-ai' | 'stop'; model: string | null; /** The longest reply its check model can write, when known (#673). */ output: number | null; supportsVision: boolean | null; visionModels: string[]; /** The models the lend here allows (null when the provider's list could not be loaded, with why). */ models: KeyModelOption[] | null; modelsProblem: string | null; /** The lend here allows only some models. */ limited: boolean; limits: BotLimitCeiling }[];
  /** The key the bot is on now, when it is a personal key: whose it is and what it is called (its own name for the viewer's own key, "Sara’s DeepSeek" for anyone else's). */
  currentKey: { id: string; name: string; ownerName: string | null; mine: boolean; status: 'working' | 'down'; ifDown: 'universe-ai' | 'stop'; logo: string | null; plainIcon: 'plug' | 'chip' | null; group: 'own-computer' | 'hosted' | null; model: string | null; /** The longest reply the bot's model can write, when known (#673). */ output: number | null; supportsVision: boolean | null; visionModels: string[]; limits: BotLimitCeiling } | null;
  /** What the owner picked for the bot's images (null = nothing picked), and, for "Another model", the key picked and whether it can be used now. */
  vision: { saved: VisionPick | null; savedKey: { name: string; problem: AnotherProblem | null } | null };
  /** Always null now. The field stays so a game build that still reads it shows no pin choice. */
  providers: null;
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
        select: { id: true, roomId: true, aiProviderRef: true, aiModel: true, behaviorConfig: true, createdById: true, createdBy: { select: { id: true, name: true } } },
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

  const [universeAi, ownKeys, current, serverLimits] = await Promise.all([
    resolveUniverseAiProvider(),
    prisma.botsAiProvider.findMany({
      where: { ownerId: input.viewer.id, lends: { some: { universeId: universe.id } } },
      orderBy: { createdAt: 'asc' },
      select: { providerId: true, name: true, endpoint: true, apiKeyEncrypted: true, settings: true, model: true, supportsVision: true, downSince: true, ifDown: true, replyLimits: true, lends: { where: { universeId: universe.id }, select: { models: true } } },
    }),
    bot?.aiProviderRef && bot.aiProviderRef !== UNIVERSE_AI_REF
      ? prisma.botsAiProvider.findUnique({ where: { providerId: bot.aiProviderRef }, select: { providerId: true, name: true, ownerId: true, owner: { select: { name: true } }, settings: true, model: true, supportsVision: true, downSince: true, ifDown: true, replyLimits: true, lends: { where: { universeId: universe.id }, select: { models: true } } } })
      : Promise.resolve(null),
    getServerLimits(),
  ]);

  // Each key's models, asked of its provider (kept a few minutes), then kept to what the lend here allows
  const keyLists = await Promise.all(
    ownKeys.map(async (key) => {
      const lend = lendModels(key.lends[0]?.models);
      const list = await keyModels(key).catch(() => ({ ok: false as const, message: 'Its models could not be loaded. Try again.' }));
      if (!list.ok) return { lend, models: null, problem: list.message };
      return { lend, models: allowedModels(list.models, lend).map((id) => ({ id, ...modelFactsOf(key, id) })), problem: null };
    }),
  );
  const currentLend = current ? lendModels(current.lends[0]?.models) : null;
  const currentModel = current && bot ? servedModel(bot, current, currentLend) : null;

  const saved = readVisionPick(bot?.behaviorConfig);
  const savedKey = saved?.choice === 'another' && bot ? await savedVisionKey(saved, bot, current?.ownerId ?? null) : null;

  return {
    ok: true,
    options: {
      current: bot?.aiProviderRef ?? null,
      currentModel: bot?.aiModel ?? null,
      universeAi: { available: !!universeAi, model: universeAi?.model ?? null, supportsVision: universeAi?.supportsVision ?? null, limits: ceilingOf(serverLimits.universeAi) },
      maker: maker ? { id: maker.id, name: maker.name } : null,
      viewerIsMaker,
      keys: ownKeys.map((key, index) => {
        const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
        const { lend, models, problem } = keyLists[index];
        return { id: key.providerId, name: key.name, kind: info?.kind ?? null, kindLabel: info?.label ?? 'AI', logo: info?.logo ?? null, plainIcon: info?.logo ? null : info?.plainIcon ?? 'chip', group: info?.group ?? null, universeName: universe.name, status: key.downSince ? 'down' : 'working', ifDown: isIfDown(key.ifDown) ? key.ifDown : 'universe-ai', model: key.model, output: key.model ? modelFactsOf(key, key.model).output ?? null : null, supportsVision: key.supportsVision, visionModels: keyVisionModels(key).filter((model) => !lend || lend.includes(model)), models, modelsProblem: problem, limited: !!lend, limits: ceilingOf(keyReplyLimits(key)) };
      }),
      // The model the bot is served, and the key's own Vision models, as the server reads them when it picks one for images
      currentKey:
        current && current.ownerId
          ? { id: current.providerId, name: keyNameFor(current, input.viewer.id), ownerName: current.owner?.name ?? null, mine: current.ownerId === input.viewer.id, status: current.downSince ? 'down' : 'working', ifDown: isIfDown(current.ifDown) ? current.ifDown : 'universe-ai', ...currentIcon(current.settings), group: kindInfo((current.settings as { kind?: unknown } | null)?.kind)?.group ?? null, model: currentModel ?? current.model, output: (currentModel ?? current.model) ? modelFactsOf(current, (currentModel ?? current.model) as string).output ?? null : null, supportsVision: currentModel ? modelSupportsVision(current, currentModel) : current.supportsVision, visionModels: keyVisionModels(current).filter((model) => !currentLend || currentLend.includes(model)), limits: ceilingOf(keyReplyLimits(current)) }
          : null,
      vision: { saved, savedKey },
      providers: null,
    },
  };
}

/** The key picked for "Another model", by name, and why it can't be used now (null when it can). */
async function savedVisionKey(
  saved: Extract<VisionPick, { choice: 'another' }>,
  bot: { id: string; createdById: string | null; roomId: string },
  mainKeyOwnerId: string | null
): Promise<{ name: string; problem: AnotherProblem | null }> {
  const usable = await usableVisionKey(saved, bot, { mainKeyOwnerId });
  return { name: (usable.key?.name ?? 'A key that was removed'), problem: usable.ok ? null : usable.problem };
}

/** What a key's card draws before its name: its provider's logo, else a plug (any server) or a chip. */
function currentIcon(settings: unknown): { logo: string | null; plainIcon: 'plug' | 'chip' | null } {
  const info = kindInfo((settings as { kind?: unknown } | null)?.kind);
  return { logo: info?.logo ?? null, plainIcon: info?.logo ? null : info?.plainIcon ?? 'chip' };
}

/** A key as the viewer sees it on the bot page: their own by its name, anyone else's by whose it is and what it runs on. */
function keyNameFor(key: { name: string; ownerId: string | null; owner: { name: string | null } | null; settings: unknown }, viewerId: string): string {
  if (key.ownerId === viewerId) return key.name;
  const label = kindInfo((key.settings as { kind?: unknown } | null)?.kind)?.label ?? 'AI';
  return `${key.owner?.name ?? 'Someone'}’s ${label}`;
}
