import { prisma } from '@/lib/db';
import { UNIVERSE_AI_MISSING, UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';

/**
 * A bot's aiProviderRef is the providerId of a BotsAiProvider row. The column has no foreign key,
 * so the write routes check it here: a bot may only point at a provider that exists.
 *
 * An empty or null ref is always allowed (the bot then has no provider). "universe-ai" is allowed while Universe AI has
 * a provider to run on (#374). A ref equal to the bot's
 * current value is also allowed, so a bot whose provider was deleted can still be saved without
 * changing it.
 *
 * Returns an error message for the caller to send as a 400, or null when the ref is acceptable.
 */
export async function checkAiProviderRef(
  ref: string | null | undefined,
  currentRef?: string | null
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
  // A personal key (#374) is not a provider a bot can be pointed at by its id: lending comes with its own check.
  return provider && !provider.ownerId ? null : `AI provider "${ref}" does not exist`;
}
