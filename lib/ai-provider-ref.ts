import { prisma } from '@/lib/db';

/**
 * A bot's aiProviderRef is the providerId of a BotsAiProvider row. The column has no foreign key,
 * so the write routes check it here: a bot may only point at a provider that exists.
 *
 * An empty or null ref is always allowed (the bot then has no provider). A ref equal to the bot's
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
  const provider = await prisma.botsAiProvider.findUnique({
    where: { providerId: ref },
    select: { providerId: true },
  });
  return provider ? null : `AI provider "${ref}" does not exist`;
}
