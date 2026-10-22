import { prisma } from '@/lib/db';
import { providerPayload } from '@/lib/ai-provider-payload';
import { checkKeyForBot, type KeyForBot } from '@/lib/ai-key-pay';
import { addNotice } from '@/lib/notices';
import { UNIVERSE_AI_MISSING, UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { isTypedEndpoint, kindInfo } from '@/lib/ai-key-kinds';
import { RESTING_LINE, recheckIfDue } from '@/lib/ai-key-health';

/**
 * What the bot server gets when it asks how a bot talks to its AI, by bot id (#374). The bot's own `aiProviderRef` decides:
 *   - a server provider's id: that provider, as always;
 *   - "universe-ai": whichever provider is the Default now;
 *   - a personal key: that key, but only while it may run this bot (see lib/ai-key-pay.ts). When it may not (the maker lost
 *     access, the key was unlent some other way), the bot is moved to Universe AI right here, the universe's owner is told
 *     once, and Universe AI's provider is what comes back. Nobody is ever served a key that may not run the bot.
 * `source` says which of the three it was, so the bot server knows when it is talking through someone's own key.
 * When a personal key is Down, its owner's choice decides: "Use Universe AI" serves Universe AI (`standingInFor` names the
 * key), "Stop replying" serves `source: "resting"` with the one fixed line and no provider at all, so nothing goes to
 * another AI. A Down key is checked again here, when a bot needs it, at most every 5 minutes, and is served again as soon as it answers.
 */
export type BotAiCredentials =
  | { status: 200; body: ReturnType<typeof providerPayload> & { source: 'provider' | 'universe-ai' | 'own-key'; movedFromKey?: string; standingInFor?: string } & Partial<OwnKeyFacts> }
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
  'not-maker': 'The key it ran on isn’t its maker’s.',
  'not-lent': 'The key it ran on is no longer lent to this universe.',
  'no-access': 'Its maker can no longer manage bots here, so it can’t run on their key.',
  'no-room': 'Its room could not be found.',
  gone: 'The key it ran on was removed.',
};

/** Every personal key's id starts with this (app/api/me/ai-keys/route.ts); a server provider's never does. */
const OWN_KEY_PREFIX = 'key-';

export async function credentialsForBot(botId: string): Promise<BotAiCredentials> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      name: true,
      aiProviderRef: true,
      createdById: true,
      roomId: true,
      room: { select: { world: { select: { universe: { select: { id: true, name: true, ownerId: true } } } } } },
    },
  });
  if (!bot) return { status: 404, error: 'Bot not found' };
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

  const verdict = await checkKeyForBot({ keyId: ref, keyOwnerId: provider.ownerId, makerId: bot.createdById, roomId: bot.roomId });
  if (verdict.ok) {
    const health = await recheckIfDue(provider);
    if (health.downSince) {
      if (health.ifDown === 'stop') return { status: 200, body: { source: 'resting', keyOwnerId: provider.ownerId, restingLine: RESTING_LINE } };
      const answer = await universeAi();
      return answer.status === 200 && answer.body.source === 'universe-ai' ? { status: 200, body: { ...answer.body, standingInFor: ref } } : answer;
    }
    const info = kindInfo((provider.settings as { kind?: unknown } | null)?.kind);
    return {
      status: 200,
      body: {
        ...providerPayload(provider),
        source: 'own-key',
        keyOwnerId: provider.ownerId,
        keyKind: info?.kind ?? null,
        keyGroup: info?.group ?? null,
        // A hosted kind sits at its provider's fixed base; anything else is an address the person typed
        keyAddressTyped: isTypedEndpoint(info, provider.endpoint),
      },
    };
  }

  return moveToUniverseAi(bot, ref, verdict.reason);
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
): Promise<BotAiCredentials> {
  const moved = await prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: ref }, data: { aiProviderRef: UNIVERSE_AI_REF } });
  if (moved.count > 0) {
    const universe = bot.room.world.universe;
    try {
      await addNotice({
        userId: universe.ownerId,
        kind: 'ai-key-moved',
        dedupeKey: `moved:${ref}:${bot.id}:${new Date().toISOString()}`,
        title: `${bot.name} moved to Universe AI`,
        body: `${MOVED_BECAUSE[reason]} It now replies on Universe AI.`,
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
