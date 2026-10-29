import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { providerPayload } from '@/lib/ai-provider-payload';
import { checkKeyForBot, type KeyForBot } from '@/lib/ai-key-pay';
import { addNotice } from '@/lib/notices';
import { UNIVERSE_AI_MISSING, UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { isTypedEndpoint, kindInfo } from '@/lib/ai-key-kinds';
import { RESTING_LINE, recheckIfDue } from '@/lib/ai-key-health';
import { autoVision, keyVisionModels, readVisionPick, usableVisionKey, type VisionPick } from '@/lib/bot-vision';
import { resolveVisionSupport } from '@/lib/vision-models';
import { lendModels, modelFactsOf, modelSupportsVision, servedModel } from '@/lib/ai-key-model-list';
import { getServerLimits, keyReplyLimits, servedLimits, type ServedLimits } from '@/lib/bot-limits';

/**
 * What the bot server gets when it asks how a bot talks to its AI, by bot id (#374). The bot's own `aiProviderRef` decides:
 *   - a server provider's id: that provider, as always;
 *   - "universe-ai": whichever provider is the Default now;
 *   - a personal key: that key with the bot's own model (#575: `aiModel`, else the key's check model, never one its lend
 *     leaves out), but only while it may run this bot (see lib/ai-key-pay.ts). When it may not (its owner lost
 *     access, the key was unlent some other way), the bot is moved to Universe AI right here, the universe's owner is told
 *     once, and Universe AI's provider is what comes back. Nobody is ever served a key that may not run the bot.
 * `source` says which of the three it was, so the bot server knows when it is talking through someone's own key.
 * When a personal key is Down, its owner's choice decides: "Use Universe AI" serves Universe AI (`standingInFor` names the
 * key), "Stop replying" serves `source: "resting"` with the one fixed line and no provider at all, so nothing goes to
 * another AI. A Down key is checked again here, when a bot needs it, at most every 5 minutes, and is served again as soon as it answers.
 *
 * A bot served from Universe AI or a person's own key also carries `vision` when its images are not left to its own model
 * (see lib/bot-vision.ts): "this" (its own model, or only the link when that can't see), "universe-ai", or "another" with the
 * credentials of the Vision model on that person's key to describe them. No `vision` means: as it always was.
 *
 * Every answer with a provider also carries `limits` (#666): the reply limits of the key it runs on (Universe AI's for a
 * bot on Universe AI, or standing in for a key that is down), lowered by the bot's own, and the artifact limits. The
 * longest reply is also its `maxTokens`.
 */
export type VisionPlan =
  | { choice: 'this'; problem?: 'key' }
  | { choice: 'universe-ai' }
  | { choice: 'another'; credentials: ReturnType<typeof providerPayload> & OwnKeyFacts };

type ServedProvider = ReturnType<typeof providerPayload> & {
  source: 'provider' | 'universe-ai' | 'own-key';
  movedFromKey?: string;
  standingInFor?: string;
  vision?: VisionPlan;
  limits?: ServedLimits;
} & Partial<OwnKeyFacts>;

export type BotAiCredentials =
  | { status: 200; body: ServedProvider }
  | { status: 200; body: { source: 'resting'; keyOwnerId: string; restingLine: string } }
  | { status: 400 | 404 | 503; error: string };

/** What only a personal key's answer carries: whose it is, what kind it is, where it runs, and how the bot server should treat it. */
export interface OwnKeyFacts {
  keyOwnerId: string;
  keyKind: string | null;
  /** "own-computer" keys are reached at an address the person typed (the bot server applies the same address guard); "hosted" ones at the provider's own. */
  keyGroup: 'own-computer' | 'hosted' | null;
  /** True when the person typed the address (an own-computer key, or their own NIM): the bot server must apply the address guard before every call. */
  keyAddressTyped: boolean;
}

/** Why a bot was moved off a key when nobody asked, for the universe owner's notice. */
const MOVED_BECAUSE: Record<Exclude<KeyForBot, { ok: true }>['reason'] | 'gone', string> = {
  'no-owner': 'The key it ran on isn’t anyone’s.',
  'not-lent': 'The key it ran on is no longer lent to this universe.',
  'no-access': 'Its key’s owner can no longer manage it here, so it can’t run on their key.',
  'no-room': 'Its room could not be found.',
  gone: 'The key it ran on was removed.',
};

/** Every personal key's id starts with this (app/api/me/ai-keys/route.ts); a server provider's never does. */
const OWN_KEY_PREFIX = 'key-';

type BotForCredentials = NonNullable<Awaited<ReturnType<typeof loadBot>>>;

const loadBot = (botId: string) =>
  prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      name: true,
      aiProviderRef: true,
      aiModel: true,
      behaviorConfig: true,
      createdById: true,
      roomId: true,
      maxReplyTokens: true,
      maxSteps: true,
      room: { select: { world: { select: { universe: { select: { id: true, name: true, ownerId: true } } } } } },
    },
  });

export async function credentialsForBot(botId: string): Promise<BotAiCredentials> {
  const bot = await loadBot(botId);
  if (!bot) return { status: 404, error: 'Bot not found' };
  const main = await mainCredentials(bot);
  if (main.status !== 200 || main.body.source === 'resting') return main;
  const answer = { status: 200 as const, body: await withLimits(bot, main.body) };
  // Only a bot on Universe AI or a person's own key has its images decided here; a pinned server provider stays as it was
  if (answer.body.source === 'provider') return answer;
  const vision = await visionPlan(bot, answer.body);
  return vision ? { status: 200, body: { ...answer.body, vision } } : answer;
}

/** The bot's limits (#666) on the provider it was given: the key's own on a person's key, Universe AI's on anything else. */
async function withLimits(bot: BotForCredentials, body: ServedProvider): Promise<ServedProvider> {
  const [server, key] = await Promise.all([
    getServerLimits(),
    body.source === 'own-key' ? prisma.botsAiProvider.findUnique({ where: { providerId: body.providerId }, select: { replyLimits: true } }) : null,
  ]);
  const limits = servedLimits(key ? keyReplyLimits(key) : server.universeAi, server, bot);
  return { ...body, maxTokens: limits.replyTokens, limits };
}

/**
 * Where this bot's images go. What the owner picked, or, when nothing is picked, the default (`autoVision`): none of the
 * three says anything new for a bot whose own model sees, or for Universe AI, so those return nothing and behave as before.
 * A key picked for images that can't be used now (taken away, unlent, Down, or its model changed) never falls back to Universe
 * AI on its own: the images are then left to the bot's own model, and `problem: 'key'` says so.
 */
async function visionPlan(bot: BotForCredentials, main: ServedProvider): Promise<VisionPlan | undefined> {
  const picked = readVisionPick(bot.behaviorConfig);
  const own = main.source === 'own-key';
  // Another model on the same key only when the lend there allows it (#575)
  const lend = own && !picked ? await lentModelsHere(main.providerId, bot.room.world.universe.id) : null;
  const mainSees = resolveVisionSupport(main.model ?? '', main.supportsVision);
  // A bot on its own model still has the key's check model to look at images when that one sees (#575)
  const key =
    own && !picked && !mainSees
      ? ((await prisma.botsAiProvider.findUnique({ where: { providerId: main.providerId }, select: { model: true, supportsVision: true, settings: true } })) ?? main)
      : main;
  const choice: VisionPick | null =
    picked ??
    (own
      ? autoVision({
          ownKeyId: main.providerId,
          sees: mainSees,
          sameKeyModel:
            keyVisionModels({ model: key.model, supportsVision: key.supportsVision, settings: key.settings }).find(
              (model) => model !== main.model && (!lend || lend.includes(model)),
            ) ?? null,
        })
      : null);
  if (!choice || (!picked && choice.choice === 'this')) return undefined;
  if (choice.choice !== 'another') return choice;
  const usable = await usableVisionKey(choice, { id: bot.id, createdById: bot.createdById, roomId: bot.roomId }, { recheck: true, mainKeyOwnerId: own ? main.keyOwnerId ?? null : null });
  if (!usable.ok) return { choice: 'this', problem: 'key' };
  const info = kindInfo((usable.key.settings as { kind?: unknown } | null)?.kind);
  return {
    choice: 'another',
    credentials: {
      ...providerPayload({ ...usable.key, model: choice.model, supportsVision: true, visionModel: null }),
      keyOwnerId: usable.key.ownerId!,
      keyKind: info?.kind ?? null,
      keyGroup: info?.group ?? null,
      keyAddressTyped: isTypedEndpoint(info, usable.key.endpoint),
    },
  };
}

/** The models a key's lend to this universe allows (null: all of them). */
async function lentModelsHere(providerId: string, universeId: string): Promise<string[] | null> {
  const lent = await prisma.aiKeyLend.findUnique({ where: { providerId_universeId: { providerId, universeId } }, select: { models: true } });
  return lendModels(lent?.models);
}

async function mainCredentials(bot: BotForCredentials): Promise<BotAiCredentials> {
  const ref = bot.aiProviderRef;
  if (!ref) return { status: 404, error: 'This bot has no AI provider' };

  if (ref === UNIVERSE_AI_REF) return universeAi();

  const provider = await prisma.botsAiProvider.findUnique({ where: { providerId: ref } });
  // A personal key that is gone (revoked while a save put the bot back on it, or its owner's account removed): the bot moves
  // to Universe AI like any bot its key may no longer run, instead of going quiet with nobody told
  if (!provider && ref.startsWith(OWN_KEY_PREFIX)) return moveToUniverseAi(bot, ref, 'gone');
  if (!provider) return { status: 404, error: 'Provider not found' };

  if (!provider.ownerId) {
    if (!provider.enabled) return { status: 400, error: 'Provider is not enabled' };
    return { status: 200, body: { ...providerPayload(provider), source: 'provider' } };
  }

  const verdict = await checkKeyForBot({ keyId: ref, keyOwnerId: provider.ownerId, bot: { id: bot.id, createdById: bot.createdById, roomId: bot.roomId } });
  if (verdict.ok) {
    const health = await recheckIfDue(provider);
    if (health.downSince) {
      if (health.ifDown === 'stop') return { status: 200, body: { source: 'resting', keyOwnerId: provider.ownerId, restingLine: RESTING_LINE } };
      const answer = await universeAi();
      return answer.status === 200 && answer.body.source === 'universe-ai' ? { status: 200, body: { ...answer.body, standingInFor: ref } } : answer;
    }
    // A recheck that just brought the key back may have moved it to a new check model (#575): the bot gets the key as it is now
    const key = health === provider ? provider : ((await prisma.botsAiProvider.findUnique({ where: { providerId: ref } })) ?? provider);
    const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
    // The bot's own model on this key; the bot server reads `model` and `supportsVision`, so it needs nothing new
    const model = servedModel(bot, key, verdict.lendModels) ?? key.model;
    return {
      status: 200,
      body: {
        ...providerPayload({
          ...key,
          model,
          supportsVision: model ? modelSupportsVision(key, model) : key.supportsVision,
          settings: model && model !== key.model ? settingsForModel(key, model) : key.settings,
        }),
        source: 'own-key',
        keyOwnerId: provider.ownerId,
        keyKind: info?.kind ?? null,
        keyGroup: info?.group ?? null,
        // A hosted kind sits at its provider's fixed base; anything else is an address the person typed
        keyAddressTyped: isTypedEndpoint(info, key.endpoint),
      },
    };
  }

  return moveToUniverseAi(bot, ref, verdict.reason, verdict.reason === 'no-access' ? await ownerName(provider.ownerId) : null);
}

/** The key owner's name for the notice: extra, so the bot is moved and served either way. */
async function ownerName(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return user?.name ?? null;
  } catch {
    return null;
  }
}

/** The key's `caps` describe its check model: a bot on another model is told that model's facts instead. */
function settingsForModel(provider: { settings: unknown; model: string | null; supportsVision: boolean | null }, model: string): Prisma.JsonValue {
  const base = provider.settings && typeof provider.settings === 'object' && !Array.isArray(provider.settings) ? (provider.settings as Record<string, unknown>) : {};
  const settings: Record<string, unknown> = { ...base };
  const caps = modelFactsOf(provider, model);
  if (Object.keys(caps).length > 0) settings.caps = caps;
  else delete settings.caps;
  return settings as Prisma.JsonValue;
}

/**
 * The key may no longer run this bot: the bot moves to Universe AI now, and the universe's owner is told once. Only the
 * request that really moved it tells (a second, racing one finds nothing to move), so every move gets its own notice
 * even if the owner dismissed an earlier one for the same bot and key.
 */
async function moveToUniverseAi(
  bot: { id: string; name: string; room: { world: { universe: { id: string; ownerId: string } } } },
  ref: string,
  reason: keyof typeof MOVED_BECAUSE,
  keyOwner: string | null = null,
): Promise<BotAiCredentials> {
  const moved = await prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: ref }, data: { aiProviderRef: UNIVERSE_AI_REF, aiModel: null } });
  if (moved.count > 0) {
    const universe = bot.room.world.universe;
    try {
      await addNotice({
        userId: universe.ownerId,
        kind: 'ai-key-moved',
        dedupeKey: `moved:${ref}:${bot.id}:${new Date().toISOString()}`,
        title: `${bot.name} moved to Universe AI`,
        // Whose key it was, by name, when that person lost Manage for the bot (#709: anyone who manages a bot may put it on their key)
        body: `${keyOwner ? `${keyOwner} can no longer manage ${bot.name}, so it can’t run on ${keyOwner}’s key.` : MOVED_BECAUSE[reason]} It now replies on Universe AI.`,
        href: `/admin/universes/${universe.id}`,
      });
    } catch (error) {
      console.error('[AiKeys] Could not tell the universe owner:', error instanceof Error ? error.message : 'unknown');
    }
  }
  const answer = await universeAi();
  return answer.status === 200 && answer.body.source === 'universe-ai' ? { status: 200, body: { ...answer.body, movedFromKey: ref } } : answer;
}

async function universeAi(): Promise<BotAiCredentials> {
  const provider = await resolveUniverseAiProvider();
  if (!provider) return { status: 503, error: UNIVERSE_AI_MISSING };
  return { status: 200, body: { ...providerPayload(provider), source: 'universe-ai' } };
}
