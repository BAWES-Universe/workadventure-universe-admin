import { prisma } from '@/lib/db';
import { KEY_FOR_BOT_TEXT, checkKeyForBot } from '@/lib/ai-key-pay';
import { UNIVERSE_AI_MISSING, UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';

export interface BotContext {
  /** Who is saving the bot (null for the bot server's admin token). */
  actorId: string | null;
  /** Who made the bot; for a new bot, the person saving it. */
  makerId: string | null;
  /** The room the bot will stand in. */
  roomId: string;
}

/**
 * A bot's aiProviderRef is the providerId of a BotsAiProvider row. The column has no foreign key,
 * so the write routes check it here: a bot may only point at a provider that exists.
 *
 * An empty or null ref is always allowed (the bot then has no provider). "universe-ai" is allowed while Universe AI has
 * a provider to run on (#374). A personal key is accepted only when the person saving owns it, made the bot, and has
 * lent it to the bot's universe (see lib/ai-key-pay.ts); `bot` says who and where. A ref equal to the bot's
 * current value is also allowed, so a bot whose provider was deleted can still be saved without
 * changing it.
 *
 * Returns an error message for the caller to send as a 400, or null when the ref is acceptable.
 */
export async function checkAiProviderRef(
  ref: string | null | undefined,
  currentRef?: string | null,
  bot?: BotContext
): Promise<string | null> {
  if (ref === undefined || ref === null || ref === '') {
    return null;
  }
  if (currentRef !== undefined && currentRef !== null && ref === currentRef) {
    return null;
  }
  if (ref === UNIVERSE_AI_REF) {
    return (await resolveUniverseAiProvider()) ? null : UNIVERSE_AI_MISSING;
  }
  const provider = await prisma.botsAiProvider.findUnique({
    where: { providerId: ref },
    select: { providerId: true, ownerId: true },
  });
  if (provider && !provider.ownerId) return null;
  // A personal key (#374) runs a bot only for its owner, who made the bot, in a universe it is lent to. Anyone else
  // (and a save with no bot to judge) gets the same "does not exist" as for a key that isn't there.
  if (provider && bot && bot.actorId && provider.ownerId === bot.actorId) {
    if (bot.actorId !== bot.makerId) return KEY_FOR_BOT_TEXT['not-maker'];
    const verdict = await checkKeyForBot({ keyId: ref, keyOwnerId: provider.ownerId, makerId: bot.makerId, roomId: bot.roomId });
    return verdict.ok ? null : KEY_FOR_BOT_TEXT[verdict.reason];
  }
  return `AI provider "${ref}" does not exist`;
}
