import { prisma } from '@/lib/db';

/**
 * "Universe AI" (#374): the one AI choice people see. A bot on it has this as its aiProviderRef, and whenever the bot
 * replies it runs on whichever server provider is the Default right now, so changing the Default moves every bot on it.
 * Bots pinned to a provider by its id keep that provider; a bot with no ref is untouched.
 */
export const UNIVERSE_AI_REF = 'universe-ai';

export const UNIVERSE_AI_MISSING = 'Universe AI has no enabled provider. Enable one on the Universe AI page.';

/**
 * The provider Universe AI runs on: the one marked Default, and if that one is missing or off (a row changed by hand),
 * the first enabled server provider by name, the order bots were always offered them in. Never a personal key.
 * Null when no server provider is enabled.
 */
export async function resolveUniverseAiProvider() {
  const marked = await prisma.botsAiProvider.findFirst({ where: { ownerId: null, isDefault: true } });
  if (marked?.enabled) return marked;
  return prisma.botsAiProvider.findFirst({ where: { ownerId: null, enabled: true }, orderBy: { name: 'asc' } });
}
